import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  powerMonitor,
  protocol,
  screen,
  session,
  safeStorage,
  type WebContents,
} from "electron";

import {
  parsePublicBackendConfiguration,
  type RepositoryBuildIdentity,
} from "@desmoslock/contracts";

import { publicDesktopBackendConfiguration } from "./backend-status.js";
import { calculatorScheme } from "./main/calculator-assets.js";
import { createAssessmentProtectionCoordinator } from "./main/assessment-protection-coordinator.js";
import { prepareElectronCalculatorSurface } from "./main/electron-calculator-surface.js";
import { createElectronProtectionWindow } from "./main/electron-protection-window.js";
import { createNativeProtectionAdapter } from "./main/native-protection-adapter.js";
import { createTrustedShellWebPreferences } from "./main/hardened-web-preferences.js";
import {
  assertPackagedLaunchPolicy,
  inspectPackagedLaunchPolicyBoundary,
} from "./main/packaged-launch-policy.js";
import {
  denyByDefaultCapabilityPolicy,
  installSessionDenialPolicy,
  installWebContentsEscapeDenial,
} from "./main/session-denial-policy.js";
import { createStaticProtocolHandler } from "./main/static-protocol.js";
import {
  trustedAssessmentLockChannel,
  studentSessionChannels,
} from "./trusted-bridge.js";
import {
  createStudentSessionCoordinator,
  type StudentSessionCoordinator,
} from "./main/student-session-coordinator.js";
import { createStudentSessionCrypto } from "./main/student-session-crypto.js";
import { readClientBuildIdentity } from "./main/build-identity.js";
import { createStudentSessionTransport } from "./main/student-session-transport.js";
import {
  createStudentSessionStore,
  openNativeStudentRecordStore,
} from "./main/student-session-store.js";
import { createStudentSessionIpc } from "./main/student-session-ipc.js";

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

// Supplement the native fixed-inode lock; a second UI never interprets arguments.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

const shellScheme = "desmoslock-app";
const publicBackendConfiguration = parsePublicBackendConfiguration(
  publicDesktopBackendConfiguration,
);
const shellConnectionAllowlist =
  publicBackendConfiguration === null
    ? "(response-origin);webrtc=block"
    : `(response-origin ${JSON.stringify(
        publicBackendConfiguration.url,
      )});webrtc=block`;
const shellContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'none'",
  publicBackendConfiguration === null
    ? "connect-src 'none'"
    : `connect-src ${publicBackendConfiguration.url}`,
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

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
let shellProtocolRegistered = false;
let shellSessionPolicyInstalled = false;
let nextShellGeneration = 1;
let studentCoordinator: StudentSessionCoordinator | null = null;
let protectionCoordinator: ReturnType<
  typeof createAssessmentProtectionCoordinator
> | null = null;
let studentIpc: ReturnType<typeof createStudentSessionIpc> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;
let startupQuitRequested = false;
const shellGenerations = new WeakMap<BrowserWindow, string>();
const emergencyAccelerator = "Control+Alt+Shift+E";
let shortcutOwned = false;

function isTrustedWindow(window: BrowserWindow): boolean {
  if (window !== mainWindow || window.isDestroyed()) return false;
  const contents = window.webContents;
  const generation = shellGenerations.get(window);
  return (
    generation !== undefined &&
    !contents.isDestroyed() &&
    !contents.mainFrame.isDestroyed() &&
    contents.mainFrame.url === trustedShellUrl &&
    studentIpc?.mayPublish(contents.id, generation) === true &&
    shellProtocolRegistered &&
    shellSessionPolicyInstalled
  );
}

const protectionWindow = createElectronProtectionWindow({
  getWindow: () => mainWindow,
  isTrusted: isTrustedWindow,
  onInvalidated: () => protectionCoordinator?.requestLocalEnd("window_lost"),
});

function closeActiveWindowGate(): void {
  const phase = protectionCoordinator?.readView().protection.phase;
  if (phase === "preflight" || phase === "engaging" || phase === "locked")
    protectionCoordinator?.requestLocalEnd("window_lost");
}

// The old intent receipt never constitutes assessment protection.
ipcMain.handle(trustedAssessmentLockChannel, () => ({
  ok: false,
  reason: "native-protection-unavailable",
}));
for (const channel of [
  studentSessionChannels.read,
  studentSessionChannels.join,
  studentSessionChannels.recover,
  studentSessionChannels.retry,
  studentSessionChannels.refresh,
  studentSessionChannels.forfeit,
  studentSessionChannels.start,
  studentSessionChannels.emergencyReview,
  studentSessionChannels.emergencyCancel,
  studentSessionChannels.emergencyConfirm,
]) {
  ipcMain.handle(
    channel,
    (event, ...args: readonly unknown[]) =>
      studentIpc?.request(channel, event, ...args) ?? null,
  );
}
app.on("second-instance", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (protectionCoordinator?.hasRetainedAttempt()) {
    // Recovery presentation belongs to the owner that can confirm calculator
    // teardown. A second launch cannot bypass an uncertain close by showing it.
    if (mainWindow.isMinimized() || !mainWindow.isVisible())
      protectionCoordinator.requestLocalEnd("window_lost");
    else mainWindow.focus();
    return;
  }
  if (mainWindow.isMinimized() || !mainWindow.isVisible())
    closeActiveWindowGate();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

async function initializeStudentSession(): Promise<void> {
  if (publicBackendConfiguration === null || studentCoordinator !== null)
    return;
  const crypto = createStudentSessionCrypto(publicBackendConfiguration);
  const identity = readClientBuildIdentity();
  const ownedDirectory = path.join(app.getPath("userData"), "student-session");
  const store = createStudentSessionStore({
    apiOrigin: publicBackendConfiguration.url,
    openNativeStore: () => openNativeStudentRecordStore(ownedDirectory),
    codec: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  });
  studentCoordinator = createStudentSessionCoordinator({
    apiOrigin: publicBackendConfiguration.url,
    store,
    crypto,
    transport: createStudentSessionTransport(publicBackendConfiguration),
    originBuild:
      identity === null
        ? { kind: "unverified_build" }
        : { kind: "build", identity },
  });
  await studentCoordinator.initialize();
  if (startupQuitRequested) return;
  protectionCoordinator = createAssessmentProtectionCoordinator({
    student: studentCoordinator,
    native: createNativeProtectionAdapter(),
    window: protectionWindow,
    prepareCalculator: async () => {
      const parent = mainWindow;
      if (
        parent === null ||
        !isTrustedWindow(parent) ||
        !protectionWindow.isReady()
      )
        throw new Error("Trusted calculator window unavailable");
      return prepareElectronCalculatorSurface({
        parent,
        bounds: protectionWindow.calculatorBounds(),
        outputDirectory: path.dirname(fileURLToPath(import.meta.url)),
        onCleanupFailure: () =>
          protectionCoordinator?.requestLocalEnd("window_lost"),
      });
    },
    shortcuts: {
      register(listener) {
        if (shortcutOwned || globalShortcut.isRegistered(emergencyAccelerator))
          return false;
        shortcutOwned = globalShortcut.register(emergencyAccelerator, listener);
        // Return the ownership acknowledgment; the coordinator independently
        // checks current registration and still cleans up an acknowledged one.
        return shortcutOwned;
      },
      isRegistered: () =>
        shortcutOwned && globalShortcut.isRegistered(emergencyAccelerator),
      unregister() {
        if (!shortcutOwned) return;
        globalShortcut.unregister(emergencyAccelerator);
        if (globalShortcut.isRegistered(emergencyAccelerator))
          throw new Error("Owned emergency shortcut restoration unconfirmed");
        shortcutOwned = false;
      },
    },
  });
  studentIpc = createStudentSessionIpc(protectionCoordinator, () =>
    protectionCoordinator?.requestLocalEnd("renderer_lost"),
  );
  maintenanceTimer = setInterval(() => {
    const protection = protectionCoordinator;
    const student = studentCoordinator;
    if (quitting || protection === null || student === null) return;
    // Historical reports remain eligible after the trusted window closes.
    // Live maintenance, when needed, still precedes delivery on this one timer.
    const maintenanceNeeded =
      protection.hasRetainedAttempt() ||
      (mainWindow !== null &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible());
    const maintenance = maintenanceNeeded
      ? protection.refresh()
      : Promise.resolve();
    void maintenance.then(
      async () => {
        if (
          quitting ||
          protectionCoordinator !== protection ||
          studentCoordinator !== student
        )
          return;
        try {
          await student.flushEvidence();
        } catch {
          // Expected delivery failures resolve as finite queue status. An
          // unexpected shared-record failure cannot sustain native authority.
          protection.requestLocalEnd("persistence_unavailable");
        }
      },
      () => protection.requestLocalEnd("backend_unavailable"),
    );
  }, 15_000);
}

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
    connectionAllowlist: shellConnectionAllowlist,
    contentSecurityPolicy: shellContentSecurityPolicy,
  });
  session.defaultSession.protocol.handle(shellScheme, (request) =>
    handle({ method: request.method, url: request.url }),
  );
  shellProtocolRegistered = true;
}

function registerTrustedShell(
  webContents: WebContents,
  generation: string,
): void {
  const revoke = (): void => studentIpc?.revoke(webContents.id);
  webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame) revoke();
  });
  webContents.on("did-navigate", (_event, url) => {
    if (url !== trustedShellUrl || webContents.mainFrame.isDestroyed()) return;
    studentIpc?.register({
      generation,
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

async function createWindow(): Promise<BrowserWindow> {
  const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
  await ensureShellProtocol(outputDirectory);
  const window = new BrowserWindow({
    backgroundColor: "#e8edf5",
    height: 720,
    minHeight: 560,
    minWidth: 860,
    show: false,
    width: 1080,
    webPreferences: createTrustedShellWebPreferences(
      path.join(outputDirectory, "preload.cjs"),
    ),
  });
  installWebContentsEscapeDenial(
    window.webContents,
    `${shellScheme}:`,
    denyByDefaultCapabilityPolicy,
  );
  const generation = `internal-shell-${nextShellGeneration++}`;
  shellGenerations.set(window, generation);
  const contents = window.webContents;
  registerTrustedShell(contents, generation);
  const disposeZoomControls = protectionWindow.installZoomControls(window);
  const unsubscribe = protectionCoordinator?.subscribe((view) => {
    if (
      !window.isDestroyed() &&
      !contents.isDestroyed() &&
      studentIpc?.mayPublish(contents.id, generation) &&
      !contents.mainFrame.isDestroyed() &&
      contents.mainFrame.url === trustedShellUrl
    )
      contents.send(studentSessionChannels.changed, view);
  });
  window.on("close", (event) => {
    if (!protectionCoordinator?.hasRetainedAttempt()) return;
    event.preventDefault();
    protectionCoordinator.requestLocalEnd("window_lost");
  });
  window.on("minimize", closeActiveWindowGate);
  window.on("hide", closeActiveWindowGate);
  window.on("leave-full-screen", closeActiveWindowGate);
  window.once("closed", () => {
    unsubscribe?.();
    disposeZoomControls();
    studentIpc?.revoke(contents.id);
    if (mainWindow === window) mainWindow = null;
  });
  try {
    await window.loadURL(trustedShellUrl);
    if (window.isDestroyed()) throw new Error("Desktop closed during startup");
    // Loading the trusted shell never attaches calculator content. Only the
    // explicit Start pipeline can attach after all private gates settle.
    mainWindow = window;
    window.show();
    return window;
  } catch (error) {
    unsubscribe?.();
    disposeZoomControls();
    studentIpc?.revoke(contents.id);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

void app
  .whenReady()
  .then(async () => {
    await initializeStudentSession();
    if (startupQuitRequested) return;
    await createWindow();
    powerMonitor.on("suspend", () =>
      protectionCoordinator?.requestLocalEnd("suspend"),
    );
    powerMonitor.on("resume", () =>
      protectionCoordinator?.requestLocalEnd("suspend"),
    );
    const displayChanged = (): void =>
      protectionCoordinator?.requestLocalEnd("display_changed");
    screen.on("display-added", displayChanged);
    screen.on("display-removed", displayChanged);
    screen.on("display-metrics-changed", displayChanged);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch(() => {
          if (protectionCoordinator?.hasRetainedAttempt())
            protectionCoordinator.requestLocalEnd("window_lost");
          else app.exit(1);
        });
      }
    });
  })
  .catch(() => {
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (studentCoordinator === null) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (protectionCoordinator === null) startupQuitRequested = true;
  // Retained native ownership cannot be bypassed by a second quit request.
  // The composed owner drains Student only after its own cleanup completes.
  const shutdown =
    protectionCoordinator === null
      ? studentCoordinator
          .dispose()
          .then((complete) => (complete ? "complete" : "retained"))
      : protectionCoordinator.shutdown();
  void shutdown.then(
    (outcome) => {
      if (outcome === "complete") {
        if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
        app.exit(0);
      } else quitting = false;
    },
    () => {
      quitting = false;
    },
  );
});
