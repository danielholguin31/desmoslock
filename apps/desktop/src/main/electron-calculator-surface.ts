import { randomUUID } from "node:crypto";

import {
  session,
  WebContentsView,
  type BrowserWindow,
  type Session,
} from "electron";

import { createAssessmentSessionPolicy } from "./assessment-session-policy.js";
import {
  calculatorDocumentUrl,
  calculatorResourceManifest,
  calculatorScheme,
  loadCalculatorProtocolAssets,
} from "./calculator-assets.js";
import type {
  CalculatorSurface,
  CalculatorSurfaceBounds,
} from "./calculator-surface.js";
import { createCalculatorWebPreferences } from "./hardened-web-preferences.js";
import {
  installWebContentsEscapeDenial,
  installSessionDenialPolicy,
} from "./session-denial-policy.js";
import { createStaticProtocolHandler } from "./static-protocol.js";

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
  const handle = createStaticProtocolHandler({
    assets: await loadCalculatorProtocolAssets(outputDirectory),
    contentSecurityPolicy: calculatorContentSecurityPolicy,
  });

  calculatorSession.protocol.handle(calculatorScheme, (request) =>
    handle({ method: request.method, url: request.url }),
  );
}

function installAssessmentSessionPolicy(
  calculatorSession: Session,
  view: WebContentsView,
  policy: ReturnType<typeof createAssessmentSessionPolicy>,
): () => void {
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
  const uninstallSessionPolicy = installSessionDenialPolicy(
    calculatorSession,
    policy,
  );

  installWebContentsEscapeDenial(
    view.webContents,
    `${calculatorScheme}:`,
    policy,
  );
  view.webContents.on("will-prevent-unload", (event) => event.preventDefault());
  view.webContents.on(
    "select-bluetooth-device",
    (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    },
  );
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
  return uninstallSessionPolicy;
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
  let uninstallSessionPolicy: (() => void) | null = null;
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

    if (uninstallSessionPolicy !== null) {
      uninstallSessionPolicy();
      uninstallSessionPolicy = null;
    }
    try {
      calculatorSession.webRequest.onBeforeRequest(null);
    } catch {
      // Continue into independent session cleanup tasks.
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
    const assessmentPolicy = createAssessmentSessionPolicy({
      allowedResources: calculatorResourceManifest,
      webContentsId: view.webContents.id,
    });
    if (!assessmentPolicy.allowsInitialDocument(calculatorDocumentUrl)) {
      throw new Error("Calculator initial document is not allowed");
    }
    uninstallSessionPolicy = installAssessmentSessionPolicy(
      calculatorSession,
      view,
      assessmentPolicy,
    );
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
