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
import { createElectronCalculatorSurface } from "./main/electron-calculator-surface.js";
import { createPrivilegedRequestRouter } from "./main/privileged-request-router.js";
import { createStaticProtocolHandler } from "./main/static-protocol.js";
import { createTrustedRequestHandler } from "./main/trusted-request-handler.js";
import { trustedRequestLockChannel } from "./trusted-bridge.js";

export const desktopBuild: RepositoryBuildIdentity = {
  sourceCommit: "development",
  sourceRepository: "danielholguin31/desmoslock",
  version: "2.0.0",
};

export const desktopChannel = "internal-v2" as const;
export const trustedShellUrl = "desmoslock-app://shell/index.html" as const;

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
  [shellScheme, "desmoslock-calculator"].map((scheme) => ({
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
let nextSyntheticAssessmentGeneration = 1;
const syntheticAssessmentStates = new Map<
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
    const state = syntheticAssessmentStates.get(webContentsId);
    if (state === undefined) {
      throw new Error("Synthetic assessment state is unavailable");
    }
    state.lockIntentAccepted = true;
  },
  readState: (webContentsId) => {
    const state = syntheticAssessmentStates.get(webContentsId);
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
  trustedRequestLockChannel,
  createTrustedRequestHandler(privilegedRouter),
);

async function ensureShellProtocol(outputDirectory: string): Promise<void> {
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

function denyShellEscape(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event) => event.preventDefault());
  webContents.on("will-frame-navigate", (event) => event.preventDefault());
  webContents.on("will-redirect", (event) => event.preventDefault());
  webContents.on("will-attach-webview", (event) => event.preventDefault());
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
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      disableDialogs: true,
      enableWebSQL: false,
      experimentalFeatures: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      preload: path.join(outputDirectory, "preload.cjs"),
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    },
    width: 1080,
  });
  denyShellEscape(window.webContents);
  const trustedWebContentsId = window.webContents.id;
  const syntheticAssessmentState = {
    generation: `synthetic-internal-assessment-${nextSyntheticAssessmentGeneration}`,
    lockIntentAccepted: false,
    testLifecycle: "open" as const,
  };
  nextSyntheticAssessmentGeneration += 1;
  syntheticAssessmentStates.set(trustedWebContentsId, syntheticAssessmentState);
  registerTrustedShell(window.webContents, syntheticAssessmentState.generation);
  window.once("closed", () => {
    const surface = ownedCalculatorSurface;
    ownedCalculatorSurface = null;
    if (calculatorSurface === surface) calculatorSurface = null;
    if (surface !== null) void surface.close().catch(() => undefined);
    syntheticAssessmentStates.delete(trustedWebContentsId);
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
      outputDirectory,
      parent: window,
    });
    if (window.isDestroyed()) {
      await ownedCalculatorSurface.close();
      ownedCalculatorSurface = null;
      throw new Error("Desktop window closed during calculator startup");
    }
    calculatorSurface = ownedCalculatorSurface;
    mainWindow = window;
    window.show();
    return window;
  } catch (error) {
    syntheticAssessmentStates.delete(trustedWebContentsId);
    privilegedRouter.revokeTrustedCaller(trustedWebContentsId);
    if (ownedCalculatorSurface !== null) {
      await ownedCalculatorSurface.close();
      ownedCalculatorSurface = null;
    }
    if (!window.isDestroyed()) window.destroy();
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
