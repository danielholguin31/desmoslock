import {
  createBackendHealthReader,
  type BackendHealthFetch,
  type BackendObservation,
} from "@desmoslock/contracts";

import { observeWebBackend } from "../backend-status.js";
import {
  isPublicWebConfigurationForRuntime,
  parsePublicWebConfiguration,
  type PublicWebConfiguration,
} from "../public-config.js";
import {
  createStaffAuthController,
  type StaffAuthAdapter,
  type StaffAuthController,
  type StaffAuthOperationIdSource,
  type StaffAuthPendingCallback,
} from "./staff-auth-controller.js";
import {
  createStaffRecoveryFlowStore,
  type StaffRecoveryFlowStorage,
  type StaffRecoveryFlowLock,
} from "./staff-recovery-flow-store.js";
import {
  createSupabaseStaffAuthAdapter,
  type SupabaseStaffAuthAdapter,
} from "./supabase-staff-auth-adapter.js";
import { createProductionSupabaseStaffAuthPort } from "./supabase-staff-auth-port.js";
import { bindStaffAuthView } from "./staff-auth-view.js";

const sensitiveCallbackKeys = new Set([
  "access_token",
  "auth",
  "code",
  "error",
  "error_code",
  "error_description",
  "flow",
  "refresh_token",
  "sb_flow_id",
  "state",
  "token",
  "token_hash",
  "type",
]);

const sensitiveSerializedCallbackParameter =
  /(?:^|[?&#])(?:access_token|auth|code|error(?:_code|_description)?|flow|refresh_token|sb_flow_id|state|token(?:_hash)?|type)(?:=|&|$)/iu;

function containsSensitiveSerializedCallbackParameter(value: string): boolean {
  if (sensitiveSerializedCallbackParameter.test(value)) return true;
  try {
    return sensitiveSerializedCallbackParameter.test(decodeURIComponent(value));
  } catch {
    return false;
  }
}

export type DetectedStaffAuthCallback =
  "email-verification" | "invite" | "recovery";

export interface StaffAuthApplicationAdapter extends StaffAuthAdapter {
  dispose(): void;
}

export interface StaffAuthApplicationElements {
  readonly authRoot: HTMLElement;
  readonly protectedSchoolDataRoot: HTMLElement;
  readonly status: HTMLElement;
}

export interface StaffAuthApplicationLifecycleHandlers {
  dispose(): void;
  resume(): Promise<void>;
  suspend(): void;
}

export interface StaffAuthApplicationLifecycle {
  register(handlers: StaffAuthApplicationLifecycleHandlers): () => void;
}

export interface StaffAuthApplicationDependencies {
  readonly callbackHistoryMarkerPresent?: boolean;
  readonly callbackUrl: string;
  readonly callbackWasScrubbed?: boolean;
  readonly clock: { readonly now: () => number };
  readonly configuration: unknown;
  readonly elements: StaffAuthApplicationElements;
  readonly fetch: BackendHealthFetch;
  readonly history: {
    replaceState(data: unknown, unused: string, url: string): void;
  };
  readonly lifecycle: StaffAuthApplicationLifecycle;
  readonly operationIds: StaffAuthOperationIdSource;
  readonly navigate?: (url: string) => void;
  readonly recoveryFlowLock?: StaffRecoveryFlowLock;
  readonly recoveryCrypto: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly runtimeOrigin: string;
  readonly storage: StaffRecoveryFlowStorage;
}

export const staffAuthCallbackHistoryMarker = Object.freeze({
  desmoslockStaffAuthCallback: "pending-v1",
});

export interface StaffAuthApplicationFactories {
  readonly bindView: (
    root: HTMLElement,
    controller: StaffAuthController,
  ) => () => void;
  readonly createAdapter: (
    configuration: PublicWebConfiguration,
    operationIds: StaffAuthOperationIdSource,
  ) => StaffAuthApplicationAdapter;
  readonly observeHealth: (
    configuration: PublicWebConfiguration,
    fetchImplementation: BackendHealthFetch,
  ) => Promise<BackendObservation>;
}

export interface StartedStaffAuthApplication extends StaffAuthApplicationLifecycleHandlers {
  readonly ready: Promise<void>;
}

/**
 * Detects only the callback family. Credential material is never returned,
 * rendered, logged, or retained by the composition layer.
 */
export function detectStaffAuthCallback(
  callbackUrl: unknown,
): DetectedStaffAuthCallback | null {
  if (typeof callbackUrl !== "string") return null;

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return containsSensitiveSerializedCallbackParameter(callbackUrl)
      ? "recovery"
      : null;
  }

  let sensitive = containsSensitiveSerializedCallbackParameter(url.hash);
  let invite = false;
  let emailVerification = false;
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase();
    if (!sensitiveCallbackKeys.has(normalizedKey)) continue;
    sensitive = true;
    if (normalizedKey === "token" || normalizedKey === "token_hash") {
      invite = true;
    }
  }
  for (const auth of url.searchParams.getAll("auth")) {
    if (auth === "invite") invite = true;
    if (auth === "email-verification") emailVerification = true;
  }
  return sensitive
    ? invite
      ? "invite"
      : emailVerification
        ? "email-verification"
        : "recovery"
    : null;
}

/**
 * Starts one web auth application. Callback material is scrubbed synchronously
 * and retained only by a one-shot private capability. Provider consumption is
 * impossible until the controller receives explicit confirmation.
 */
export function startStaffAuthApplication(
  dependencies: StaffAuthApplicationDependencies,
  factories: StaffAuthApplicationFactories,
): StartedStaffAuthApplication {
  const {
    callbackHistoryMarkerPresent = false,
    callbackUrl,
    callbackWasScrubbed = false,
    clock,
    configuration,
    elements,
    fetch: fetchImplementation,
    history,
    lifecycle,
    operationIds,
    navigate,
    recoveryFlowLock,
    recoveryCrypto,
    runtimeOrigin,
    storage,
  } = dependencies;
  const callback = detectStaffAuthCallback(callbackUrl);
  const pendingCallback =
    callback === null
      ? null
      : createPrivatePendingCallback(callbackUrl, callback);
  let callbackHistory = history;
  if (callback !== null) {
    try {
      if (!callbackWasScrubbed) {
        history.replaceState(staffAuthCallbackHistoryMarker, "", "/");
      }
    } catch {
      pendingCallback?.discard();
      // A callback credential that cannot be removed from the address bar must
      // never coexist with provider construction, rendering, or network work.
      scrubStaffAuthApplicationRoots(elements);
      return createInertStaffAuthApplication(elements);
    }
    callbackHistory = { replaceState() {} };
  }

  return startScrubbedStaffAuthApplication(
    {
      callbackHistory,
      clearCallbackHistory: () => history.replaceState(null, "", "/"),
      clock,
      configuration,
      elements,
      fetchImplementation,
      initialCallbackDetected: callback !== null,
      initialCallbackLost: callback === null && callbackHistoryMarkerPresent,
      initialPendingCallback: pendingCallback,
      lifecycle,
      operationIds,
      ...(navigate === undefined ? {} : { navigate }),
      ...(recoveryFlowLock === undefined ? {} : { recoveryFlowLock }),
      recoveryCrypto,
      resumeCallbackLost: callback !== null || callbackHistoryMarkerPresent,
      runtimeOrigin,
      storage,
    },
    factories,
  );
}

interface PrivateStaffAuthPendingCallback {
  readonly capability: StaffAuthPendingCallback;
  discard(): void;
}

interface ScrubbedStaffAuthApplicationDependencies {
  readonly callbackHistory: StaffAuthApplicationDependencies["history"];
  readonly clearCallbackHistory: () => void;
  readonly clock: StaffAuthApplicationDependencies["clock"];
  readonly configuration: unknown;
  readonly elements: StaffAuthApplicationElements;
  readonly fetchImplementation: BackendHealthFetch;
  readonly initialCallbackDetected: boolean;
  readonly initialCallbackLost: boolean;
  readonly initialPendingCallback: PrivateStaffAuthPendingCallback | null;
  readonly lifecycle: StaffAuthApplicationLifecycle;
  readonly operationIds: StaffAuthOperationIdSource;
  readonly navigate?: (url: string) => void;
  readonly recoveryFlowLock?: StaffRecoveryFlowLock;
  readonly recoveryCrypto: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly resumeCallbackLost: boolean;
  readonly runtimeOrigin: string;
  readonly storage: StaffRecoveryFlowStorage;
}

interface StaffAuthApplicationGeneration {
  readonly adapter: StaffAuthApplicationAdapter;
  readonly controller: StaffAuthController;
  readonly initialization: Promise<unknown>;
  disposeView: (() => void) | null;
  disposed: boolean;
}

function startScrubbedStaffAuthApplication(
  dependencies: ScrubbedStaffAuthApplicationDependencies,
  factories: StaffAuthApplicationFactories,
): StartedStaffAuthApplication {
  const {
    callbackHistory,
    clearCallbackHistory,
    clock,
    configuration,
    elements,
    fetchImplementation,
    initialCallbackDetected,
    initialCallbackLost,
    lifecycle,
    operationIds,
    navigate,
    recoveryFlowLock,
    recoveryCrypto,
    resumeCallbackLost,
    runtimeOrigin,
    storage,
  } = dependencies;
  let initialPendingCallback = dependencies.initialPendingCallback;
  let callbackLostOnResume = resumeCallbackLost;
  const parsedConfiguration = parsePublicWebConfiguration(configuration);
  const runtimeConfiguration =
    parsedConfiguration !== null &&
    isPublicWebConfigurationForRuntime(parsedConfiguration, runtimeOrigin)
      ? parsedConfiguration
      : null;
  const routeOrigin =
    parsedConfiguration?.origin ??
    canonicalRuntimeOrigin(runtimeOrigin) ??
    "https://invalid.invalid";
  let terminallyDisposed = false;
  let suspended = false;
  let currentGeneration: StaffAuthApplicationGeneration | null = null;
  let resumeInFlight: Promise<void> | null = null;
  let unregisterLifecycle: () => void = () => undefined;

  function createGeneration(options: {
    readonly bootstrap: boolean;
    readonly callbackLost: boolean;
    readonly pendingCallback: PrivateStaffAuthPendingCallback | null;
  }): StaffAuthApplicationGeneration {
    const adapter =
      runtimeConfiguration === null
        ? createUnavailableAdapter()
        : factories.createAdapter(runtimeConfiguration, operationIds);
    try {
      const flows = createStaffRecoveryFlowStore({
        clock,
        crypto: recoveryCrypto,
        ...(recoveryFlowLock === undefined ? {} : { lock: recoveryFlowLock }),
        storage,
      });
      const controller = createStaffAuthController({
        adapter,
        callback: {
          ...(runtimeConfiguration === null
            ? {}
            : { backendOrigin: runtimeConfiguration.url }),
          ...(navigate === undefined ? {} : { navigate }),
          flows,
          history: callbackHistory,
          lost: options.callbackLost,
          ...(options.pendingCallback === null
            ? {}
            : { pending: options.pendingCallback.capability }),
          resetPending() {
            initialPendingCallback?.discard();
            initialPendingCallback = null;
            callbackLostOnResume = false;
            clearCallbackHistory();
          },
          route: { origin: routeOrigin, pathname: "/" },
        },
        clock,
        operationIds,
        protectedSchoolData: {
          clear() {
            clearProtectedSchoolDataRoot(elements.protectedSchoolDataRoot);
          },
        },
      });
      return {
        adapter,
        controller,
        disposeView: null,
        disposed: false,
        initialization: options.bootstrap
          ? controller.dispatch({ type: "bootstrap" })
          : Promise.resolve(controller.getSnapshot()),
      };
    } catch (error) {
      try {
        adapter.dispose();
      } catch {
        // Construction failure must still tear down the provider boundary.
      }
      throw error;
    }
  }

  function generationIsCurrent(
    generation: StaffAuthApplicationGeneration,
  ): boolean {
    return (
      !terminallyDisposed &&
      !suspended &&
      !generation.disposed &&
      currentGeneration === generation
    );
  }

  function disposeGeneration(
    generation: StaffAuthApplicationGeneration | null,
  ): void {
    if (generation === null || generation.disposed) return;
    generation.disposed = true;
    const disposeView = generation.disposeView;
    generation.disposeView = null;
    if (disposeView !== null) {
      try {
        disposeView();
      } catch {
        // Continue through the remaining security-boundary teardown.
      }
    }
    try {
      generation.controller.dispose();
    } catch {
      // The provider still must be disposed if controller teardown fails.
    }
    try {
      generation.adapter.dispose();
    } catch {
      // A teardown failure cannot make this generation current again.
    }
  }

  async function activateGeneration(
    generation: StaffAuthApplicationGeneration,
  ): Promise<void> {
    try {
      await generation.initialization.catch(() =>
        generation.controller.getSnapshot(),
      );
      if (!generationIsCurrent(generation)) return;
      const disposeView = factories.bindView(
        elements.authRoot,
        generation.controller,
      );
      if (!generationIsCurrent(generation)) {
        try {
          disposeView();
        } catch {
          // The stale view remains hidden and detached from authority.
        }
        return;
      }
      generation.disposeView = disposeView;
      revealFreshStaffAuthRoot(elements.authRoot);
      if (runtimeConfiguration === null) {
        renderBackendObservation(elements.status, {
          reason: "configuration_invalid",
          status: "unavailable",
        });
        return;
      }
      const observation = await factories.observeHealth(
        runtimeConfiguration,
        fetchImplementation,
      );
      if (generationIsCurrent(generation)) {
        renderBackendObservation(elements.status, observation);
      }
    } catch {
      if (generationIsCurrent(generation)) {
        renderBackendObservation(elements.status, {
          reason: "service_unavailable",
          status: "unavailable",
        });
      }
    }
  }

  function suspend(): void {
    if (terminallyDisposed || suspended) return;
    suspended = true;
    scrubStaffAuthApplicationRoots(elements);
    initialPendingCallback?.discard();
    initialPendingCallback = null;
    const generation = currentGeneration;
    currentGeneration = null;
    disposeGeneration(generation);
  }

  function resume(): Promise<void> {
    if (terminallyDisposed) return Promise.resolve();
    if (!suspended) return resumeInFlight ?? Promise.resolve();
    scrubStaffAuthApplicationRoots(elements);
    suspended = false;
    let generation: StaffAuthApplicationGeneration;
    try {
      generation = createGeneration({
        bootstrap: true,
        callbackLost: callbackLostOnResume,
        pendingCallback: null,
      });
    } catch {
      suspended = true;
      renderBackendObservation(elements.status, {
        reason: "service_unavailable",
        status: "unavailable",
      });
      return Promise.resolve();
    }
    currentGeneration = generation;
    const activation = activateGeneration(generation);
    resumeInFlight = activation;
    void activation.then(() => {
      if (resumeInFlight === activation) resumeInFlight = null;
    });
    return activation;
  }

  function dispose(): void {
    if (terminallyDisposed) return;
    terminallyDisposed = true;
    suspended = true;
    scrubStaffAuthApplicationRoots(elements);
    initialPendingCallback?.discard();
    initialPendingCallback = null;
    const generation = currentGeneration;
    currentGeneration = null;
    try {
      unregisterLifecycle();
    } catch {
      // Teardown continues even if listener removal fails.
    }
    disposeGeneration(generation);
  }

  scrubStaffAuthApplicationRoots(elements);
  try {
    currentGeneration = createGeneration({
      bootstrap: !initialCallbackDetected,
      callbackLost: initialCallbackLost,
      pendingCallback: initialPendingCallback,
    });
  } catch {
    initialPendingCallback?.discard();
    initialPendingCallback = null;
    renderBackendObservation(elements.status, {
      reason: "service_unavailable",
      status: "unavailable",
    });
    return createInertStaffAuthApplication(elements);
  }
  const ready = activateGeneration(currentGeneration);
  const application: StartedStaffAuthApplication = {
    dispose,
    ready,
    resume,
    suspend,
  };
  unregisterLifecycle = lifecycle.register(application);

  return application;
}

function createPrivatePendingCallback(
  callbackUrl: string,
  kind: DetectedStaffAuthCallback,
): PrivateStaffAuthPendingCallback {
  let rawCallbackUrl: string | null = callbackUrl;
  const capability: StaffAuthPendingCallback = Object.freeze({
    discard() {
      rawCallbackUrl = null;
    },
    kind,
    take() {
      const claimed = rawCallbackUrl;
      rawCallbackUrl = null;
      return claimed;
    },
  });
  return Object.freeze({
    capability,
    discard() {
      capability.discard();
    },
  });
}

function createInertStaffAuthApplication(
  elements: StaffAuthApplicationElements,
): StartedStaffAuthApplication {
  const keepInert = () => scrubStaffAuthApplicationRoots(elements);
  return {
    dispose: keepInert,
    ready: Promise.resolve(),
    resume() {
      keepInert();
      return Promise.resolve();
    },
    suspend: keepInert,
  };
}

function clearProtectedSchoolDataRoot(root: HTMLElement): void {
  try {
    root.hidden = true;
  } catch {
    // Continue clearing all reachable protected content.
  }
  try {
    root.inert = true;
  } catch {
    // Older DOM implementations can omit inert; hidden still fails closed.
  }
  try {
    root.replaceChildren();
  } catch {
    try {
      root.textContent = "";
    } catch {
      // The root remains hidden even if a hostile DOM implementation throws.
    }
  }
}

function revealFreshStaffAuthRoot(root: HTMLElement): void {
  try {
    root.inert = false;
    root.hidden = false;
  } catch {
    // Failure leaves the application hidden rather than exposing stale state.
    try {
      root.hidden = true;
    } catch {
      // Best-effort fail closed for non-browser test doubles.
    }
  }
}

function scrubStaffAuthApplicationRoots(
  elements: StaffAuthApplicationElements,
): void {
  const roots = [elements.authRoot, elements.protectedSchoolDataRoot];
  for (const root of roots) {
    try {
      root.hidden = true;
    } catch {
      // Continue hiding the other protected root.
    }
    try {
      root.inert = true;
    } catch {
      // Hidden remains the baseline on DOMs without inert support.
    }
  }
  for (const root of roots) scrubStaffAuthElementTree(root);
}

function scrubStaffAuthElementTree(root: HTMLElement): void {
  let descendants: Element[] = [];
  try {
    descendants = Array.from(root.querySelectorAll("*"));
  } catch {
    // The root itself is still scrubbed below.
  }
  for (let index = descendants.length - 1; index >= 0; index -= 1) {
    const descendant = descendants[index];
    if (descendant !== undefined) scrubStaffAuthElement(descendant);
  }
  scrubStaffAuthElement(root);
  try {
    root.replaceChildren();
  } catch {
    try {
      root.textContent = "";
    } catch {
      // The root was hidden before scrubbing began.
    }
  }
}

function scrubStaffAuthElement(element: Element): void {
  let tagName = "";
  try {
    const candidate = Reflect.get(element, "tagName");
    if (typeof candidate === "string") tagName = candidate.toLowerCase();
  } catch {
    // Generic roots can still have their text and children cleared.
  }
  if (tagName === "input" || tagName === "textarea") {
    safelySetElementProperty(element, "value", "");
    safelySetElementProperty(element, "defaultValue", "");
    safelyRemoveElementAttribute(element, "value");
  }
  if (tagName === "select") {
    let options: unknown[] = [];
    try {
      const candidate = Reflect.get(element, "options");
      if (candidate !== null && typeof candidate === "object") {
        options = Array.from(candidate as ArrayLike<unknown>);
      }
    } catch {
      // Descendant option elements are also scrubbed independently.
    }
    for (const option of options) {
      if (typeof option === "object" && option !== null) {
        scrubStaffAuthOption(option);
      }
    }
    safelySetElementProperty(element, "value", "");
    safelySetElementProperty(element, "selectedIndex", -1);
  }
  if (tagName === "option") scrubStaffAuthOption(element);
  if (tagName === "img") {
    safelyRemoveElementAttribute(element, "src");
    safelyRemoveElementAttribute(element, "srcset");
    safelySetElementProperty(element, "alt", "");
    safelyRemoveElementAttribute(element, "alt");
  }
  try {
    element.textContent = "";
  } catch {
    // Other element-specific properties were already cleared above.
  }
}

function scrubStaffAuthOption(option: object): void {
  safelySetElementProperty(option, "selected", false);
  safelySetElementProperty(option, "value", "");
  safelySetElementProperty(option, "label", "");
  safelySetElementProperty(option, "text", "");
  safelySetElementProperty(option, "textContent", "");
  safelyRemoveElementAttribute(option, "value");
}

function safelySetElementProperty(
  element: object,
  property: PropertyKey,
  value: unknown,
): void {
  try {
    Reflect.set(element, property, value);
  } catch {
    // Continue scrubbing remaining properties and nodes.
  }
}

function safelyRemoveElementAttribute(element: object, name: string): void {
  try {
    const removeAttribute = Reflect.get(element, "removeAttribute");
    if (typeof removeAttribute === "function") {
      Reflect.apply(removeAttribute, element, [name]);
    }
  } catch {
    // Property clearing and root removal provide the remaining defense.
  }
}

export function createProductionStaffAuthApplicationFactories(dependencies: {
  readonly clock: { readonly now: () => number };
  readonly createBlobUrl: (blob: Blob) => string;
  readonly fetch: BackendHealthFetch;
  readonly revokeBlobUrl: (url: string) => void;
}): StaffAuthApplicationFactories {
  return {
    bindView: bindStaffAuthView,
    createAdapter(configuration, operationIds): SupabaseStaffAuthAdapter {
      return createSupabaseStaffAuthAdapter({
        clock: dependencies.clock,
        createBlobUrl: dependencies.createBlobUrl,
        operationIds,
        port: createProductionSupabaseStaffAuthPort(
          configuration,
          dependencies.fetch,
        ),
        revokeBlobUrl: dependencies.revokeBlobUrl,
      });
    },
    observeHealth(configuration, fetchImplementation) {
      return observeWebBackend(
        {
          environment: configuration.environment,
          url: configuration.url,
        },
        createBackendHealthReader(fetchImplementation),
      );
    },
  };
}

function createUnavailableAdapter(): StaffAuthApplicationAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error("Staff authentication configuration is unavailable");
  };
  return {
    dispose() {},
    perform() {
      return unavailable();
    },
    read() {
      return unavailable();
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function canonicalRuntimeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "[::1]";
  return origin.origin === value &&
    origin.pathname === "/" &&
    origin.search === "" &&
    origin.hash === "" &&
    origin.username === "" &&
    origin.password === "" &&
    (origin.protocol === "https:" || (origin.protocol === "http:" && loopback))
    ? origin.origin
    : null;
}

function renderBackendObservation(
  status: HTMLElement,
  observation: BackendObservation,
): void {
  status.dataset.backendStatus = observation.status;
  status.textContent =
    observation.status === "ready"
      ? "Synthetic backend ready"
      : `Synthetic backend unavailable (${observation.reason})`;
}
