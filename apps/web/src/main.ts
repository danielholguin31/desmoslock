import type { WorkspaceSummary } from "@desmoslock/contracts";

import {
  createProductionStaffAuthApplicationFactories,
  startStaffAuthApplication,
  type StartedStaffAuthApplication,
} from "./auth/staff-auth-application.js";
import { publicWebConfiguration } from "./public-config.js";

export const internalWorkspacePreview: readonly WorkspaceSummary[] = [];

export function registerWebApplicationLifecycle(
  runtime: Window,
  dispose: () => void,
): () => void {
  const handlePageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) dispose();
  };
  runtime.addEventListener("pagehide", handlePageHide);
  return () => runtime.removeEventListener("pagehide", handlePageHide);
}

export function mountWebApplication(
  documentRoot: Document,
  runtime: Window,
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
      callbackUrl: runtime.location.href,
      clock,
      configuration: publicWebConfiguration,
      elements: { authRoot, protectedSchoolDataRoot, status },
      fetch: fetchImplementation,
      history: runtime.history,
      lifecycle: {
        register: (dispose) =>
          registerWebApplicationLifecycle(runtime, dispose),
      },
      operationIds: { next: () => runtime.crypto.randomUUID() },
      recoveryCrypto: runtime.crypto,
      runtimeOrigin: runtime.location.origin,
      storage: {
        getItem(key) {
          return runtime.sessionStorage.getItem(key);
        },
        setItem(key, value) {
          runtime.sessionStorage.setItem(key, value);
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

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const application = mountWebApplication(document, window);
  if (application !== null) {
    void application.ready;
  }
}
