import { randomUUID } from "node:crypto";

import {
  session,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
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
const destructionAcknowledgementTimeoutMs = 15_000;

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
    connectionAllowlist: "(response-origin);webrtc=block",
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

export async function prepareElectronCalculatorSurface(
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
  let contents: WebContents | null = null;
  let closed = false;
  let invalidated = false;
  let attached = false;
  let initializing = true;
  let parentClosed = options.parent.isDestroyed();
  let uninstallSessionPolicy: (() => void) | null = null;
  let protocolRegistered = false;
  let closePromise: Promise<void> | null = null;
  let destructionCompletion: Promise<readonly unknown[]> | null = null;
  let destructionConfirmed = true;
  const pendingTeardownFailures: unknown[] = [];

  const detachChildSynchronously = (ownedView: WebContentsView): void => {
    const wasAttached = attached;
    attached = false;
    if (wasAttached && !options.parent.isDestroyed()) {
      options.parent.contentView.removeChildView(ownedView);
    }
  };

  const teardownWebContentsSynchronously = (): readonly unknown[] => {
    const failures: unknown[] = [];
    invalidated = true;
    if (view === null) return failures;
    const ownedView = view;
    // Electron clears WebContentsView.webContents during destruction. Keep the
    // direct emitter for acknowledgement and listener cleanup across that event.
    const ownedContents = contents ?? ownedView.webContents;
    view = null;
    let completeDestruction!: (failures: readonly unknown[]) => void;
    // A result-valued promise also covers parent loss during a held load: it
    // cannot reject unobserved before initialization reaches closeSurface().
    destructionCompletion = new Promise((resolve) => {
      completeDestruction = resolve;
    });
    let settled = false;
    let listening = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finishDestruction = (error?: Error): void => {
      if (settled) return;
      settled = true;
      destructionConfirmed = error === undefined;
      const acknowledgementFailures: unknown[] =
        error === undefined ? [] : [error];
      if (timer !== null) clearTimeout(timer);
      if (listening) {
        try {
          ownedContents.removeListener("destroyed", handleDestroyed);
        } catch (listenerError) {
          acknowledgementFailures.push(listenerError);
        }
      }
      completeDestruction(acknowledgementFailures);
    };
    const handleDestroyed = (): void => finishDestruction();
    const observeDestroyed = (): void => {
      try {
        if (ownedContents.isDestroyed()) handleDestroyed();
      } catch (error) {
        failures.push(error);
      }
    };
    observeDestroyed();
    if (!settled) {
      timer = setTimeout(
        () =>
          finishDestruction(
            new Error(
              `CalculatorSurface destruction was not acknowledged within ${destructionAcknowledgementTimeoutMs}ms`,
            ),
          ),
        destructionAcknowledgementTimeoutMs,
      );
      timer.unref?.();
      try {
        listening = true;
        ownedContents.once("destroyed", handleDestroyed);
      } catch (error) {
        failures.push(error);
      }
    }
    // Cache and subscribe before detach: native removal may re-enter close or
    // destroy the renderer. close(false) itself only requests asynchronous end.
    try {
      detachChildSynchronously(ownedView);
    } catch (error) {
      failures.push(error);
    }
    observeDestroyed();
    if (!destructionConfirmed) {
      try {
        ownedContents.close({ waitForBeforeUnload: false });
      } catch (error) {
        failures.push(error);
      }
    }
    observeDestroyed();
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
      const destructionFailures = await (destructionCompletion ??
        Promise.resolve([]));

      // Unknown destruction never relaxes the still-live renderer's denial
      // policy. Independent session clearing remains best-effort on failure.
      const uninstallPolicy = destructionConfirmed
        ? uninstallSessionPolicy
        : null;
      if (destructionConfirmed) uninstallSessionPolicy = null;
      const unregisterProtocol = destructionConfirmed && protocolRegistered;
      if (destructionConfirmed) protocolRegistered = false;
      const cleanupTasks = [
        () => options.parent.removeListener("closed", handleParentClosed),
        ...(uninstallPolicy === null ? [] : [uninstallPolicy]),
        ...(destructionConfirmed
          ? [() => calculatorSession.webRequest.onBeforeRequest(null)]
          : []),
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
        ...destructionFailures,
        ...pendingTeardownFailures.splice(0),
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
    contents = view.webContents;
    destructionConfirmed = false;
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
    await view.webContents.loadURL(calculatorDocumentUrl);
    requireLiveParent();
    await view.webContents.setVisualZoomLevelLimits(1, 1);
    requireLiveParent();
    if (view.webContents.isDestroyed()) {
      throw new Error(
        "CalculatorSurface renderer closed during initialization",
      );
    }
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

  const liveView = view;
  const liveContents = contents;
  if (liveView === null || liveContents === null) {
    throw new Error("CalculatorSurface closed before initialization completed");
  }

  return Object.freeze({
    partition,
    webContentsId: liveContents.id,
    attach(): void {
      let attachmentAttempted = false;
      try {
        if (
          closed ||
          invalidated ||
          parentClosed ||
          options.parent.isDestroyed() ||
          liveContents.isDestroyed()
        ) {
          throw new Error("CalculatorSurface is closed or invalidated");
        }
        if (attached) return;
        // Claim ownership before the native call: a throw or reentrant close
        // must still remove a partially attached child and destroy its renderer.
        attached = true;
        attachmentAttempted = true;
        options.parent.contentView.addChildView(liveView);
        if (
          closed ||
          invalidated ||
          parentClosed ||
          options.parent.isDestroyed() ||
          liveContents.isDestroyed()
        ) {
          throw new Error("CalculatorSurface invalidated during attachment");
        }
      } catch (error) {
        if (attachmentAttempted && view !== null) attached = true;
        pendingTeardownFailures.push(...teardownWebContentsSynchronously());
        throw error;
      }
    },
    detach(): void {
      // Detachment is terminal even before first attachment. A new attempt
      // requires a newly prepared surface; this object cannot reopen content.
      invalidated = true;
      if (view === null) return;
      try {
        detachChildSynchronously(view);
      } catch (error) {
        pendingTeardownFailures.push(
          error,
          ...teardownWebContentsSynchronously(),
        );
        throw error;
      }
    },
    close: closeSurface,
    setBounds(bounds: CalculatorSurfaceBounds) {
      if (!closed && !invalidated && !liveContents.isDestroyed()) {
        liveView.setBounds(bounds);
      }
    },
  });
}
