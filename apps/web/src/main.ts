import type { WorkspaceSummary } from "@desmoslock/contracts";

import { updateWebBackendStatus } from "./backend-status.js";

export const internalWorkspacePreview: readonly WorkspaceSummary[] = [];

const status =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-v2-status]");

if (status !== null) {
  void updateWebBackendStatus(status, globalThis.fetch.bind(globalThis));
}
