import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  type WebContents,
} from "electron";

import type { RepositoryBuildIdentity } from "@desmoslock/contracts";

import type { CalculatorSurface } from "./main/calculator-surface.js";
import { calculatorScheme } from "./main/calculator-assets.js";
import { createElectronCalculatorSurface } from "./main/electron-calculator-surface.js";
import { createTrustedShellWebPreferences } from "./main/hardened-web-preferences.js";
import {
  assertPackagedLaunchPolicy,
  inspectPackagedLaunchPolicyBoundary,
} from "./main/packaged-launch-policy.js";
import { createPrivilegedRequestRouter } from "./main/privileged-request-router.js";
import {
  denyByDefaultCapabilityPolicy,
  installSessionDenialPolicy,
  installWebContentsEscapeDenial,
} from "./main/session-denial-policy.js";
import { createStaticProtocolHandler } from "./main/static-protocol.js";
import { createTrustedRequestHandler } from "./main/trusted-request-handler.js";
import { trustedAssessmentLockChannel } from "./trusted-bridge.js";

export const desktopBuild: RepositoryBuildIdentity = {
  sourceCommit: "development",
  sourceRepository: "danielholguin31/desmoslock",
  version: "2.0.0",
};

export const desktopChannel = "internal-v2" as const;
export const trustedShellUrl = "desmoslock-app://shell/index.html" as const;

const packagedLaunchControls = {
  arguments: process.argv,
  commandLine: app.commandLine,
  environment: process.env,
};
try {
  assertPackagedLaunchPolicy(app.isPackaged, packagedLaunchControls);
} catch {
  process.stderr.write(
    "Packaged runtime rejected a forbidden launch control.\n",
  );
  process.stderr.write(
    `Packaged runtime policy boundary: ${JSON.stringify(
      inspectPackagedLaunchPolicyBoundary(
        app.isPackaged,
        packagedLaunchControls,
      ),
    )}\n`,
  );
  process.exit(78);
}

const shellScheme = "desmoslock-app";
const shellBarHeight = 140;
const connectionAllowlistOverride =
  "OverrideConnectionAllowlistOriginTrial" as const;
const shellContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const existingChromiumFeatures = app.commandLine
  .getSwitchValue("enable-features")
  .split(",")
  .map((feature) => feature.trim())
  .filter((feature) => feature.length > 0);
if (!existingChromiumFeatures.includes(connectionAllowlistOverride)) {
  app.commandLine.appendSwitch(
    "enable-features",
    [...existingChromiumFeatures, connectionAllowlistOverride].join(","),
  );
}

protocol.registerSchemesAsPrivileged(
  [shellScheme, calculatorScheme].map((scheme) => ({
    privileges: {
      allowExtensions: false,
      allowServiceWorkers: false,
      bypassCSP: false,
      codeCache: false,
      corsEnabled: false,
      secure: true,
      standard: true,
      stream: false,
      supportFetchAPI: false,
    },
    scheme,
  })),
);

let mainWindow: BrowserWindow | null = null;
let calculatorSurface: CalculatorSurface | null = null;
let shellProtocolRegistered = false;
let shellSessionPolicyInstalled = false;
let nextAssessmentGeneration = 1;
const assessmentStates = new Map<
  number,
  {
    readonly generation: string;
    lockIntentAccepted: boolean;
    readonly testLifecycle: "open";
  }
>();

const privilegedRouter = createPrivilegedRequestRouter({
  engageLock: async (webContentsId) => {
    // This is intentionally an intent receipt only. Native lock and recovery
    // authority belong to issue #35.
    const state = assessmentStates.get(webContentsId);
    if (state === undefined) {
      throw new Error("Assessment state is unavailable");
    }
    state.lockIntentAccepted = true;
  },
  readState: (webContentsId) => {
    const state = assessmentStates.get(webContentsId);
    return state === undefined
      ? undefined
      : {
          generation: state.generation,
          lockState: state.lockIntentAccepted ? "locked" : "unlocked",
          testLifecycle: state.testLifecycle,
        };
  },
});

ipcMain.handle(
  trustedAssessmentLockChannel,
  createTrustedRequestHandler(privilegedRouter),
);

async function ensureShellProtocol(outputDirectory: string): Promise<void> {
  if (!shellSessionPolicyInstalled) {
    installSessionDenialPolicy(
      session.defaultSession,
      denyByDefaultCapabilityPolicy,
    );
    shellSessionPolicyInstalled = true;
  }
  if (shellProtocolRegistered) return;

  const [document, script, stylesheet] = await Promise.all([
    fs.readFile(path.join(outputDirectory, "index.html")),
    fs.readFile(path.join(outputDirectory, "renderer.js")),
    fs.readFile(path.join(outputDirectory, "styles.css")),
  ]);
  const handle = createStaticProtocolHandler({
    assets: {
      [trustedShellUrl]: {
        body: Uint8Array.from(document).buffer,
        contentType: "text/html; charset=utf-8",
      },
      "desmoslock-app://shell/renderer.js": {
        body: Uint8Array.from(script).buffer,
        contentType: "text/javascript; charset=utf-8",
      },
      "desmoslock-app://shell/styles.css": {
        body: Uint8Array.from(stylesheet).buffer,
        contentType: "text/css; charset=utf-8",
      },
    },
    contentSecurityPolicy: shellContentSecurityPolicy,
  });
  session.defaultSession.protocol.handle(shellScheme, (request) =>
    handle({ method: request.method, url: request.url }),
  );
  shellProtocolRegistered = true;
}

function registerTrustedShell(
  webContents: WebContents,
  assessmentGeneration: string,
): void {
  const revoke = (): void =>
    privilegedRouter.revokeTrustedCaller(webContents.id);

  webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame) revoke();
  });
  webContents.on("did-navigate", (_event, url) => {
    if (url !== trustedShellUrl || webContents.mainFrame.isDestroyed()) return;
    privilegedRouter.registerTrustedCaller({
      generation: assessmentGeneration,
      mainFrameProcessId: webContents.mainFrame.processId,
      mainFrameRoutingId: webContents.mainFrame.routingId,
      trustedUrl: trustedShellUrl,
      webContentsId: webContents.id,
    });
  });
  webContents.on("did-navigate-in-page", revoke);
  webContents.on("render-process-gone", revoke);
  webContents.on("destroyed", revoke);
}

function calculatorBounds(window: BrowserWindow) {
  const size = window.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;
  return {
    height: Math.max(0, height - shellBarHeight),
    width,
    x: 0,
    y: shellBarHeight,
  };
}

async function createWindow(): Promise<BrowserWindow> {
  const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
  await ensureShellProtocol(outputDirectory);
  let ownedCalculatorSurface: CalculatorSurface | null = null;

  const window = new BrowserWindow({
    backgroundColor: "#e8edf5",
    height: 720,
    minHeight: 560,
    minWidth: 860,
    show: false,
    webPreferences: createTrustedShellWebPreferences(
      path.join(outputDirectory, "preload.cjs"),
    ),
    width: 1080,
  });
  installWebContentsEscapeDenial(
    window.webContents,
    `${shellScheme}:`,
    denyByDefaultCapabilityPolicy,
  );
  const trustedWebContentsId = window.webContents.id;
  const assessmentState = {
    generation: `internal-assessment-${nextAssessmentGeneration}`,
    lockIntentAccepted: false,
    testLifecycle: "open" as const,
  };
  nextAssessmentGeneration += 1;
  assessmentStates.set(trustedWebContentsId, assessmentState);
  registerTrustedShell(window.webContents, assessmentState.generation);
  window.once("closed", () => {
    const surface = ownedCalculatorSurface;
    ownedCalculatorSurface = null;
    if (calculatorSurface === surface) calculatorSurface = null;
    if (surface !== null) void surface.close().catch(() => app.exit(1));
    assessmentStates.delete(trustedWebContentsId);
    privilegedRouter.revokeTrustedCaller(trustedWebContentsId);
    if (mainWindow === window) mainWindow = null;
  });
  window.on("resize", () =>
    ownedCalculatorSurface?.setBounds(calculatorBounds(window)),
  );

  try {
    await window.loadURL(trustedShellUrl);
    ownedCalculatorSurface = await createElectronCalculatorSurface({
      bounds: calculatorBounds(window),
      onCleanupFailure: () => app.exit(1),
      outputDirectory,
      parent: window,
    });
    if (window.isDestroyed()) {
      throw new Error("Desktop window closed during calculator startup");
    }
    calculatorSurface = ownedCalculatorSurface;
    mainWindow = window;
    window.show();
    return window;
  } catch (error) {
    assessmentStates.delete(trustedWebContentsId);
    privilegedRouter.revokeTrustedCaller(trustedWebContentsId);
    const cleanupFailures: unknown[] = [];
    if (ownedCalculatorSurface !== null) {
      const surface = ownedCalculatorSurface;
      ownedCalculatorSurface = null;
      if (calculatorSurface === surface) calculatorSurface = null;
      try {
        await surface.close();
      } catch (cleanupError) {
        cleanupFailures.push(
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        );
      }
    }
    if (mainWindow === window) mainWindow = null;
    if (!window.isDestroyed()) {
      try {
        window.destroy();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Desktop window startup and cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  }
}

void app
  .whenReady()
  .then(async () => {
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch(() => app.exit(1));
      }
    });
  })
  .catch(() => {
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
