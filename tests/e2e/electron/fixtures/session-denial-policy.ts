import fs from "node:fs/promises";

import { app, BrowserWindow, session, type Session } from "electron";

import {
  denyByDefaultCapabilityPolicy,
  installSessionDenialPolicy,
} from "../../../../apps/desktop/src/main/session-denial-policy.js";

type PermissionRequestHandler = NonNullable<
  Parameters<Session["setPermissionRequestHandler"]>[0]
>;

interface ExternalPermissionEvidence {
  callbackInvocations: number;
  deniedBeforeObservers: boolean;
  observerAttempts: number;
  observerFailures: number;
  observerSuccesses: number;
  permission: string;
  scheme: string;
}

function requiredArgument(offset: number): string {
  const value = process.argv.at(offset);
  if (value === undefined) {
    throw new Error("Session policy fixture requires a result path");
  }
  return value;
}

function schemeOnly(url: string): string {
  try {
    return new URL(url).protocol.toLowerCase();
  } catch {
    return "invalid:";
  }
}

function installWithNativePermissionEvidence(
  targetSession: Session,
  evidence: ExternalPermissionEvidence,
): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    targetSession,
    "setPermissionRequestHandler",
  );
  const setNativePermissionRequestHandler =
    targetSession.setPermissionRequestHandler.bind(targetSession);
  const observers = [
    () => {
      throw new Error("observer failure");
    },
    () => {
      evidence.observerSuccesses += 1;
    },
  ];
  const instrumentedSetter: Session["setPermissionRequestHandler"] = (
    handler,
  ) => {
    if (handler === null) {
      setNativePermissionRequestHandler(null);
      return;
    }
    const instrumentedHandler: PermissionRequestHandler = (
      webContents,
      permission,
      callback,
      details,
    ) => {
      handler(
        webContents,
        permission,
        (allowed) => {
          callback(allowed);
          if (permission !== "openExternal") return;

          evidence.callbackInvocations += 1;
          evidence.permission = permission;
          evidence.scheme = schemeOnly(
            "externalURL" in details ? (details.externalURL ?? "") : "",
          );
          evidence.deniedBeforeObservers &&= allowed === false;
          for (const observer of observers) {
            evidence.observerAttempts += 1;
            try {
              observer();
            } catch {
              evidence.observerFailures += 1;
            }
          }
        },
        details,
      );
    };
    setNativePermissionRequestHandler(instrumentedHandler);
  };

  Object.defineProperty(targetSession, "setPermissionRequestHandler", {
    configurable: true,
    value: instrumentedSetter,
    writable: true,
  });
  try {
    return installSessionDenialPolicy(
      targetSession,
      denyByDefaultCapabilityPolicy,
    );
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(targetSession, "setPermissionRequestHandler");
    } else {
      Object.defineProperty(
        targetSession,
        "setPermissionRequestHandler",
        originalDescriptor,
      );
    }
  }
}

const resultPath = requiredArgument(-1);

async function runProbe(): Promise<void> {
  await app.whenReady();
  app.on("window-all-closed", () => undefined);

  const externalPermission: ExternalPermissionEvidence = {
    callbackInvocations: 0,
    deniedBeforeObservers: true,
    observerAttempts: 0,
    observerFailures: 0,
    observerSuccesses: 0,
    permission: "unobserved",
    scheme: "unobserved:",
  };
  let observedDownloadDefaultPrevented = false;

  installWithNativePermissionEvidence(
    session.defaultSession,
    externalPermission,
  );
  session.defaultSession.on("will-download", (event) => {
    observedDownloadDefaultPrevented ||= event.defaultPrevented;
    event.preventDefault();
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(
    `data:text/html,${encodeURIComponent(`<!doctype html>
      <a id="download" download="blocked.txt" href="data:text/plain,blocked">download</a>
      <a id="external" href="desmoslock-unregistered://attacker.invalid">external</a>`)}`,
  );
  const initialLocation = window.webContents.getURL();
  const permission = await window.webContents.executeJavaScript(`(async () => {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    document.querySelector("#download").click();
    document.querySelector("#external").click();
    return permission.state;
  })()`);

  const deadline = Date.now() + 1_000;
  while (
    (!observedDownloadDefaultPrevented ||
      externalPermission.callbackInvocations === 0) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const result = {
    externalPermission,
    locationUnchanged: window.webContents.getURL() === initialLocation,
    observedDownloadDefaultPrevented,
    permission,
  };
  window.destroy();
  await fs.writeFile(resultPath, JSON.stringify(result));
}

void runProbe().catch(async (error: unknown) => {
  await fs.writeFile(
    resultPath,
    JSON.stringify({ fixtureError: String(error) }),
  );
});
