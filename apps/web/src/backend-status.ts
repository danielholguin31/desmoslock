import {
  createBackendHealthReader,
  observeBackend,
  type BackendHealthFetch,
  type BackendHealthReader,
  type BackendObservation,
} from "@desmoslock/contracts";

declare const __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: string;
declare const __DESMOSLOCK_PUBLIC_BACKEND_URL__: string;

export const publicWebBackendConfiguration: unknown = {
  environment:
    typeof __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__ === "string"
      ? __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__
      : undefined,
  url:
    typeof __DESMOSLOCK_PUBLIC_BACKEND_URL__ === "string"
      ? __DESMOSLOCK_PUBLIC_BACKEND_URL__
      : undefined,
};

export function observeWebBackend(
  configuration: unknown,
  healthReader: BackendHealthReader,
): Promise<BackendObservation> {
  return observeBackend(configuration, healthReader);
}

export async function updateWebBackendStatus(
  status: HTMLElement,
  fetchHealth: BackendHealthFetch,
): Promise<BackendObservation> {
  const observation = await observeWebBackend(
    publicWebBackendConfiguration,
    createBackendHealthReader(fetchHealth),
  );
  status.dataset.backendStatus = observation.status;
  status.textContent =
    observation.status === "ready"
      ? "Synthetic backend ready"
      : `Synthetic backend unavailable (${observation.reason})`;
  return observation;
}
