import type { WorkspaceSummary } from "@desmoslock/contracts";

export const internalWorkspacePreview: readonly WorkspaceSummary[] = [];

const status =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-v2-status]");

if (status !== null) {
  status.textContent =
    "Internal foundation only — customer flows are not enabled";
}
