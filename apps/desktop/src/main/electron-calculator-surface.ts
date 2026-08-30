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
  readonly onCleanupFailure: (error: unknown) => void;
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
  const pendingTeardownFailures: unknown[] = [];

  const teardownWebContentsSynchronously = (): readonly unknown[] => {
    const failures: unknown[] = [];
    if (view === null) return failures;
    if (attached) {
      try {
        if (!options.parent.isDestroyed()) {
          options.parent.contentView.removeChildView(view);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    attached = false;
    let webContentsDestroyed = false;
    try {
      webContentsDestroyed = view.webContents.isDestroyed();
    } catch (error) {
      failures.push(error);
    }
    if (!webContentsDestroyed) {
      try {
        view.webContents.close({ waitForBeforeUnload: false });
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };

  const closeSurface = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closed = true;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });

    const runCleanup = async (): Promise<void> => {
      const synchronousFailures = pendingTeardownFailures.splice(0);
      try {
        synchronousFailures.push(...teardownWebContentsSynchronously());
      } catch (error) {
        synchronousFailures.push(error);
      }

      const uninstallPolicy = uninstallSessionPolicy;
      uninstallSessionPolicy = null;
      const unregisterProtocol = protocolRegistered;
      protocolRegistered = false;
      const cleanupTasks = [
        () => options.parent.removeListener("closed", handleParentClosed),
        ...(uninstallPolicy === null ? [] : [uninstallPolicy]),
        () => calculatorSession.webRequest.onBeforeRequest(null),
        ...(unregisterProtocol
          ? [() => calculatorSession.protocol.unhandle(calculatorScheme)]
          : []),
        () => calculatorSession.clearStorageData(),
        () => calculatorSession.clearCache(),
        () => calculatorSession.clearAuthCache(),
        () => calculatorSession.closeAllConnections(),
      ];

      const outcomes = await Promise.allSettled(
        cleanupTasks.map((cleanup) => Promise.resolve().then(cleanup)),
      );
      const failures = [
        ...synchronousFailures,
        ...outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        ),
      ];
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "CalculatorSurface session cleanup failed",
        );
      }
    };

    void runCleanup().then(resolveClose, rejectClose);
    return closePromise;
  };

  function handleParentClosed(): void {
    parentClosed = true;
    if (initializing) {
      try {
        pendingTeardownFailures.push(...teardownWebContentsSynchronously());
      } catch (error) {
        pendingTeardownFailures.push(error);
      }
      return;
    }
    void closeSurface().catch(options.onCleanupFailure);
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
    try {
      await closeSurface();
    } catch (cleanupError) {
      const cleanupFailures =
        cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupFailures],
        "CalculatorSurface initialization and cleanup both failed",
        { cause: cleanupError },
      );
    }
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
