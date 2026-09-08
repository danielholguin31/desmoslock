import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
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
const connectionAllowlistOverride =
  "OverrideConnectionAllowlistOriginTrial" as const;
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
let shellProtocolRegistered = false;
let shellSessionPolicyInstalled = false;
let nextShellGeneration = 1;
let studentCoordinator: StudentSessionCoordinator | null = null;
let studentIpc: ReturnType<typeof createStudentSessionIpc> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;

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
]) {
  ipcMain.handle(
    channel,
    (event, ...args: readonly unknown[]) =>
      studentIpc?.request(channel, event, ...args) ?? null,
  );
}
app.on("second-instance", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

async function initializeStudentSession(): Promise<void> {
  if (publicBackendConfiguration === null || studentCoordinator !== null)
    return;
  const crypto = createStudentSessionCrypto(publicBackendConfiguration);
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
  });
  studentIpc = createStudentSessionIpc(studentCoordinator);
  await studentCoordinator.initialize();
  maintenanceTimer = setInterval(() => {
    if (
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible()
    )
      void studentCoordinator?.refresh();
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
  const contents = window.webContents;
  registerTrustedShell(contents, generation);
  const unsubscribe = studentCoordinator?.subscribe((view) => {
    if (
      !window.isDestroyed() &&
      !contents.isDestroyed() &&
      studentIpc?.mayPublish(contents.id, generation) &&
      !contents.mainFrame.isDestroyed() &&
      contents.mainFrame.url === trustedShellUrl
    )
      contents.send(studentSessionChannels.changed, view);
  });
  window.once("closed", () => {
    unsubscribe?.();
    studentIpc?.revoke(contents.id);
    if (mainWindow === window) mainWindow = null;
  });
  try {
    await window.loadURL(trustedShellUrl);
    if (window.isDestroyed()) throw new Error("Desktop closed during startup");
    // Admission is separate from native protection. Until a real protection
    // adapter passes its gates, no calculator WebContentsView is attached.
    mainWindow = window;
    window.show();
    return window;
  } catch (error) {
    unsubscribe?.();
    studentIpc?.revoke(contents.id);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

void app
  .whenReady()
  .then(async () => {
    await initializeStudentSession();
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

app.on("before-quit", (event) => {
  if (quitting || studentCoordinator === null) return;
  event.preventDefault();
  quitting = true;
  if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
  // If drain fails, the native descriptor stays owned until app.exit releases
  // it through process termination. No explicit close is forced on timeout.
  void studentCoordinator.dispose().then(
    () => app.exit(0),
    () => app.exit(1),
  );
});
