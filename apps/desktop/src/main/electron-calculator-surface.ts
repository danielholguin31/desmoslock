import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  session,
  WebContentsView,
  type BrowserWindow,
  type Session,
} from "electron";

import {
  calculatorDocumentUrl,
  createAssessmentSessionPolicy,
} from "./assessment-session-policy.js";
import {
  createCalculatorWebPreferences,
  type CalculatorSurface,
  type CalculatorSurfaceBounds,
} from "./calculator-surface.js";
import { createStaticProtocolHandler } from "./static-protocol.js";

const calculatorScheme = "desmoslock-calculator";
const calculatorResourceManifest = [
  { resourceType: "mainFrame", url: calculatorDocumentUrl },
  {
    resourceType: "script",
    url: "desmoslock-calculator://host/host.js",
  },
  {
    resourceType: "stylesheet",
    url: "desmoslock-calculator://host/styles.css",
  },
] as const;

const calculatorContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
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

export interface ElectronCalculatorSurfaceOptions {
  readonly bounds: CalculatorSurfaceBounds;
  readonly outputDirectory: string;
  readonly parent: BrowserWindow;
}

async function registerCalculatorProtocol(
  calculatorSession: Session,
  outputDirectory: string,
): Promise<void> {
  const [document, script, stylesheet] = await Promise.all([
    fs.readFile(path.join(outputDirectory, "calculator", "index.html")),
    fs.readFile(path.join(outputDirectory, "calculator", "host.js")),
    fs.readFile(path.join(outputDirectory, "calculator", "styles.css")),
  ]);
  const handle = createStaticProtocolHandler({
    assets: {
      [calculatorDocumentUrl]: {
        body: Uint8Array.from(document).buffer,
        contentType: "text/html; charset=utf-8",
      },
      "desmoslock-calculator://host/host.js": {
        body: Uint8Array.from(script).buffer,
        contentType: "text/javascript; charset=utf-8",
      },
      "desmoslock-calculator://host/styles.css": {
        body: Uint8Array.from(stylesheet).buffer,
        contentType: "text/css; charset=utf-8",
      },
    },
    contentSecurityPolicy: calculatorContentSecurityPolicy,
  });

  calculatorSession.protocol.handle(calculatorScheme, (request) =>
    handle({ method: request.method, url: request.url }),
  );
}

function installAssessmentSessionPolicy(
  calculatorSession: Session,
  view: WebContentsView,
): void {
  const policy = createAssessmentSessionPolicy({
    allowedResources: calculatorResourceManifest,
    webContentsId: view.webContents.id,
  });

  calculatorSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({
        cancel: !policy.allowsNetworkRequest({
          method: details.method,
          resourceType: details.resourceType,
          url: details.url,
          webContentsId: details.webContentsId,
        }),
      });
    },
  );
  calculatorSession.setPermissionCheckHandler((_webContents, permission) =>
    policy.allowsPermission(permission),
  );
  calculatorSession.setPermissionRequestHandler(
    (_webContents, permission, callback) =>
      callback(policy.allowsPermission(permission)),
  );
  calculatorSession.setDevicePermissionHandler(() => false);
  calculatorSession.setDisplayMediaRequestHandler((_request, callback) =>
    callback({}),
  );
  calculatorSession.setSpellCheckerEnabled(false);
  calculatorSession.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  calculatorSession.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  calculatorSession.on(
    "select-serial-port",
    (event, _ports, _webContents, callback) => {
      event.preventDefault();
      callback("");
    },
  );
  calculatorSession.on("will-download", (event) => {
    if (!policy.allowsDownload()) event.preventDefault();
  });

  const denyNavigation = (event: Electron.Event, url: string): void => {
    if (!policy.allowsNavigation(url)) event.preventDefault();
  };
  view.webContents.on("will-navigate", (event, url) =>
    denyNavigation(event, url),
  );
  view.webContents.on("will-frame-navigate", (event) =>
    denyNavigation(event, event.url),
  );
  view.webContents.on("will-redirect", (event, url) =>
    denyNavigation(event, url),
  );
  view.webContents.on("will-attach-webview", (event) => event.preventDefault());
  view.webContents.on("will-prevent-unload", (event) => event.preventDefault());
  view.webContents.on(
    "select-bluetooth-device",
    (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    },
  );
  view.webContents.setWindowOpenHandler(({ url }) => ({
    action: policy.allowsPopup(url) ? "allow" : "deny",
  }));
  const restoreCalculatorDocument = (): void => {
    if (view.webContents.isDestroyed()) return;
    void view.webContents.loadURL(calculatorDocumentUrl).catch(() => undefined);
  };
  view.webContents.on(
    "did-fail-load",
    (_event, _code, _description, url, isMainFrame) => {
      if (isMainFrame && url !== calculatorDocumentUrl) {
        restoreCalculatorDocument();
      }
    },
  );
  view.webContents.on("did-navigate", (_event, url) => {
    if (url !== calculatorDocumentUrl) restoreCalculatorDocument();
  });
  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && url !== calculatorDocumentUrl) {
      restoreCalculatorDocument();
    }
  });
}

export async function createElectronCalculatorSurface(
  options: ElectronCalculatorSurfaceOptions,
): Promise<CalculatorSurface> {
  const partition = `desmoslock-calculator-${randomUUID()}`;
  const calculatorSession = session.fromPartition(partition, { cache: false });
  if (
    calculatorSession.isPersistent() ||
    calculatorSession.getStoragePath() !== null
  ) {
    throw new Error("CalculatorSurface received a persistent Electron session");
  }

  let view: WebContentsView | null = null;
  let closed = false;
  let attached = false;
  let initializing = true;
  let parentClosed = options.parent.isDestroyed();
  let policyInstalled = false;
  let protocolRegistered = false;
  let closePromise: Promise<void> | null = null;

  const teardownWebContentsSynchronously = (): void => {
    if (view === null) return;
    if (attached && !options.parent.isDestroyed()) {
      try {
        options.parent.contentView.removeChildView(view);
      } catch {
        // A concurrent parent teardown already owns the view hierarchy.
      }
    }
    attached = false;
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Treat an already-disposing WebContents as closed.
      }
    }
  };

  const closeSurface = async (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closed = true;
    options.parent.removeListener("closed", handleParentClosed);
    teardownWebContentsSynchronously();

    if (policyInstalled) {
      try {
        calculatorSession.webRequest.onBeforeRequest(null);
        calculatorSession.setPermissionCheckHandler(null);
        calculatorSession.setPermissionRequestHandler(null);
        calculatorSession.setDevicePermissionHandler(null);
        calculatorSession.setDisplayMediaRequestHandler(null);
        calculatorSession.removeAllListeners();
      } catch {
        // Continue into independent session cleanup tasks.
      }
    }
    if (protocolRegistered) {
      try {
        calculatorSession.protocol.unhandle(calculatorScheme);
      } catch {
        // The dedicated session is still cleared below.
      }
    }

    closePromise = Promise.allSettled([
      Promise.resolve().then(() => calculatorSession.clearStorageData()),
      Promise.resolve().then(() => calculatorSession.clearCache()),
      Promise.resolve().then(() => calculatorSession.clearAuthCache()),
      Promise.resolve().then(() => calculatorSession.closeAllConnections()),
    ]).then(() => undefined);
    return closePromise;
  };

  function handleParentClosed(): void {
    parentClosed = true;
    teardownWebContentsSynchronously();
    if (!initializing) void closeSurface();
  }

  const requireLiveParent = (): void => {
    if (parentClosed || options.parent.isDestroyed()) {
      throw new Error("CalculatorSurface parent closed during initialization");
    }
  };

  options.parent.once("closed", handleParentClosed);

  try {
    requireLiveParent();
    await registerCalculatorProtocol(
      calculatorSession,
      options.outputDirectory,
    );
    protocolRegistered = true;
    requireLiveParent();
    await calculatorSession.setProxy({
      mode: "fixed_servers",
      proxyBypassRules: "<-loopback>",
      proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9",
    });
    requireLiveParent();
    view = new WebContentsView({
      webPreferences: createCalculatorWebPreferences(partition),
    });
    policyInstalled = true;
    installAssessmentSessionPolicy(calculatorSession, view);
    view.setBounds(options.bounds);
    view.webContents.setAudioMuted(true);
    view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    requireLiveParent();
    options.parent.contentView.addChildView(view);
    attached = true;
    await view.webContents.loadURL(calculatorDocumentUrl);
    requireLiveParent();
    await view.webContents.setVisualZoomLevelLimits(1, 1);
    requireLiveParent();
    initializing = false;
    requireLiveParent();
  } catch (error) {
    initializing = false;
    await closeSurface();
    throw error;
  }

  return Object.freeze({
    partition,
    webContentsId: view.webContents.id,
    close: closeSurface,
    setBounds(bounds: CalculatorSurfaceBounds) {
      if (!closed && view !== null && !view.webContents.isDestroyed()) {
        view.setBounds(bounds);
      }
    },
  });
}
