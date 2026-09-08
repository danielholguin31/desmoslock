import type { WorkspaceSummary } from "@desmoslock/contracts";

import {
  createProductionStaffAuthApplicationFactories,
  startStaffAuthApplication,
  staffAuthCallbackHistoryMarker,
  type StartedStaffAuthApplication,
} from "./auth/staff-auth-application.js";
import { publicWebConfiguration } from "./public-config.js";

export const internalWorkspacePreview: readonly WorkspaceSummary[] = [];

export const STAFF_AUTH_CALLBACK_HISTORY_MARKER =
  staffAuthCallbackHistoryMarker;

export interface EarlyWebApplicationBootstrap {
  readonly callbackUrl: string | null;
  readonly callbackWasScrubbed: boolean;
}

function isPlainExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    return (
      ownKeys.length === expectedKeys.length &&
      ownKeys.every(
        (key) => typeof key === "string" && expectedKeys.includes(key),
      ) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      })
    );
  } catch {
    return false;
  }
}

export function isStaffAuthCallbackHistoryMarker(value: unknown): boolean {
  return (
    isPlainExactRecord(value, ["desmoslockStaffAuthCallback"]) &&
    value.desmoslockStaffAuthCallback === "pending-v1"
  );
}

function parseEarlyWebApplicationBootstrap(
  value: unknown,
): EarlyWebApplicationBootstrap | null {
  if (!isPlainExactRecord(value, ["callbackUrl", "callbackWasScrubbed"])) {
    return null;
  }
  const callbackUrl = value.callbackUrl;
  const callbackWasScrubbed = value.callbackWasScrubbed;
  if (callbackWasScrubbed === true) {
    return typeof callbackUrl === "string" && callbackUrl.length > 0
      ? { callbackUrl, callbackWasScrubbed: true }
      : null;
  }
  return callbackWasScrubbed === false && callbackUrl === null
    ? { callbackUrl: null, callbackWasScrubbed: false }
    : null;
}

function callbackHistoryMarkerPresent(runtime: Window): boolean {
  try {
    return isStaffAuthCallbackHistoryMarker(runtime.history.state);
  } catch {
    return false;
  }
}

export function registerWebApplicationLifecycle(
  runtime: Window,
  application: Pick<
    StartedStaffAuthApplication,
    "dispose" | "resume" | "suspend"
  >,
): () => void {
  const handlePageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      application.suspend();
    } else {
      application.dispose();
    }
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      void application.resume().catch(() => undefined);
    }
  };
  runtime.addEventListener("pagehide", handlePageHide);
  runtime.addEventListener("pageshow", handlePageShow);
  return () => {
    runtime.removeEventListener("pagehide", handlePageHide);
    runtime.removeEventListener("pageshow", handlePageShow);
  };
}

export function mountWebApplication(
  documentRoot: Document,
  runtime: Window,
  bootstrap: EarlyWebApplicationBootstrap = {
    callbackUrl: null,
    callbackWasScrubbed: false,
  },
): StartedStaffAuthApplication | null {
  const authRoot = documentRoot.querySelector<HTMLElement>(
    "[data-staff-auth-root]",
  );
  const protectedSchoolDataRoot = documentRoot.querySelector<HTMLElement>(
    "[data-protected-school-data]",
  );
  const status = documentRoot.querySelector<HTMLElement>("[data-v2-status]");
  if (
    authRoot === null ||
    protectedSchoolDataRoot === null ||
    status === null
  ) {
    return null;
  }

  const clock = { now: () => Date.now() };
  const fetchImplementation = globalThis.fetch.bind(globalThis);
  return startStaffAuthApplication(
    {
      callbackHistoryMarkerPresent: callbackHistoryMarkerPresent(runtime),
      callbackUrl: bootstrap.callbackUrl ?? runtime.location.href,
      callbackWasScrubbed: bootstrap.callbackWasScrubbed,
      clock,
      configuration: publicWebConfiguration,
      elements: { authRoot, protectedSchoolDataRoot, status },
      fetch: fetchImplementation,
      history: runtime.history,
      lifecycle: {
        register: (application) =>
          registerWebApplicationLifecycle(runtime, application),
      },
      navigate: (url) => runtime.location.assign(url),
      operationIds: { next: () => runtime.crypto.randomUUID() },
      recoveryCrypto: runtime.crypto,
      recoveryFlowLock: {
        async request<T>(name: string, callback: () => Promise<T> | T) {
          if (runtime.navigator.locks === undefined) {
            throw new Error("Recovery flow locking is unavailable.");
          }
          return runtime.navigator.locks.request(name, () => callback());
        },
      },
      runtimeOrigin: runtime.location.origin,
      storage: {
        getItem(key) {
          return runtime.localStorage.getItem(key);
        },
        setItem(key, value) {
          runtime.localStorage.setItem(key, value);
        },
      },
    },
    createProductionStaffAuthApplicationFactories({
      clock,
      createBlobUrl: (blob) => globalThis.URL.createObjectURL(blob),
      fetch: fetchImplementation,
      revokeBlobUrl: (url) => globalThis.URL.revokeObjectURL(url),
    }),
  );
}

export function bootWebApplication(
  privateBootstrap: unknown,
  documentRoot: Document = document,
  runtime: Window = window,
): void {
  let bootstrap = parseEarlyWebApplicationBootstrap(privateBootstrap);
  if (bootstrap === null) {
    documentRoot.documentElement.hidden = true;
  } else {
    const mount = () => {
      const claimedBootstrap = bootstrap;
      bootstrap = null;
      if (claimedBootstrap === null) return;
      try {
        const application = mountWebApplication(
          documentRoot,
          runtime,
          claimedBootstrap,
        );
        if (application !== null) void application.ready;
      } catch {
        documentRoot.documentElement.hidden = true;
      }
    };
    if (documentRoot.readyState === "loading") {
      documentRoot.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }
}
