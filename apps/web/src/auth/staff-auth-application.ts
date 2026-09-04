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
} from "./staff-auth-controller.js";
import {
  createStaffRecoveryFlowStore,
  type StaffRecoveryFlowStorage,
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

export interface StaffAuthApplicationLifecycle {
  register(dispose: () => void): () => void;
}

export interface StaffAuthApplicationDependencies {
  readonly callbackUrl: string;
  readonly clock: { readonly now: () => number };
  readonly configuration: unknown;
  readonly elements: StaffAuthApplicationElements;
  readonly fetch: BackendHealthFetch;
  readonly history: {
    replaceState(data: null, unused: string, url: string): void;
  };
  readonly lifecycle: StaffAuthApplicationLifecycle;
  readonly operationIds: StaffAuthOperationIdSource;
  readonly recoveryCrypto: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly runtimeOrigin: string;
  readonly storage: StaffRecoveryFlowStorage;
}

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

export interface StartedStaffAuthApplication {
  readonly ready: Promise<void>;
  dispose(): void;
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
 * Starts one web auth application. Calling this function synchronously starts
 * callback consumption, which scrubs the address bar before `ready` can await
 * provider work, render the auth view, or fetch backend health.
 */
export function startStaffAuthApplication(
  dependencies: StaffAuthApplicationDependencies,
  factories: StaffAuthApplicationFactories,
): StartedStaffAuthApplication {
  const callback = detectStaffAuthCallback(dependencies.callbackUrl);
  let callbackHistory = dependencies.history;
  if (callback !== null) {
    try {
      dependencies.history.replaceState(null, "", "/");
    } catch {
      // A callback credential that cannot be removed from the address bar must
      // never coexist with provider construction, rendering, or network work.
      try {
        dependencies.elements.authRoot.replaceChildren();
        dependencies.elements.authRoot.hidden = true;
        dependencies.elements.protectedSchoolDataRoot.replaceChildren();
        dependencies.elements.protectedSchoolDataRoot.hidden = true;
      } catch {
        // The document starts hidden; cleanup remains best-effort fail-closed.
      }
      return { dispose() {}, ready: Promise.resolve() };
    }
    callbackHistory = { replaceState() {} };
  }
  const parsedConfiguration = parsePublicWebConfiguration(
    dependencies.configuration,
  );
  const runtimeConfiguration =
    parsedConfiguration !== null &&
    isPublicWebConfigurationForRuntime(
      parsedConfiguration,
      dependencies.runtimeOrigin,
    )
      ? parsedConfiguration
      : null;
  const routeOrigin =
    parsedConfiguration?.origin ??
    canonicalRuntimeOrigin(dependencies.runtimeOrigin) ??
    "https://invalid.invalid";
  const adapter =
    runtimeConfiguration === null
      ? createUnavailableAdapter()
      : factories.createAdapter(
          runtimeConfiguration,
          dependencies.operationIds,
        );
  const flows = createStaffRecoveryFlowStore({
    clock: dependencies.clock,
    crypto: dependencies.recoveryCrypto,
    storage: dependencies.storage,
  });
  const controller = createStaffAuthController({
    adapter,
    callback: {
      flows,
      history: callbackHistory,
      route: { origin: routeOrigin, pathname: "/" },
    },
    clock: dependencies.clock,
    operationIds: dependencies.operationIds,
    protectedSchoolData: {
      clear() {
        dependencies.elements.protectedSchoolDataRoot.replaceChildren();
        dependencies.elements.protectedSchoolDataRoot.hidden = true;
      },
    },
  });
  const initialization = controller.dispatch(
    callback === "invite"
      ? {
          callbackUrl: dependencies.callbackUrl,
          type: "inspect_invitation",
        }
      : callback === "recovery"
        ? {
            callbackUrl: dependencies.callbackUrl,
            type: "consume_recovery_callback",
          }
        : callback === "email-verification"
          ? {
              callbackUrl: dependencies.callbackUrl,
              type: "consume_email_verification_callback",
            }
          : { type: "bootstrap" },
  );

  let disposed = false;
  let disposeView: (() => void) | null = null;
  let unregisterLifecycle: () => void = () => undefined;

  const application: StartedStaffAuthApplication = {
    dispose() {
      if (disposed) return;
      disposed = true;
      unregisterLifecycle();
      if (disposeView === null) {
        controller.dispose();
      } else {
        disposeView();
        disposeView = null;
      }
      adapter.dispose();
    },
    ready: Promise.resolve(),
  };
  unregisterLifecycle = dependencies.lifecycle.register(() =>
    application.dispose(),
  );

  const ready = initialization
    .catch(() => controller.getSnapshot())
    .then(async () => {
      if (disposed) return;
      disposeView = factories.bindView(
        dependencies.elements.authRoot,
        controller,
      );
      dependencies.elements.authRoot.hidden = false;
      if (runtimeConfiguration === null) {
        renderBackendObservation(dependencies.elements.status, {
          reason: "configuration_invalid",
          status: "unavailable",
        });
        return;
      }
      const observation = await factories.observeHealth(
        runtimeConfiguration,
        dependencies.fetch,
      );
      if (!disposed) {
        renderBackendObservation(dependencies.elements.status, observation);
      }
    })
    .catch(() => {
      if (!disposed) {
        renderBackendObservation(dependencies.elements.status, {
          reason: "service_unavailable",
          status: "unavailable",
        });
      }
    });

  return { dispose: () => application.dispose(), ready };
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
