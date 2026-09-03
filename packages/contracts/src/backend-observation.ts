export type InternalBackendEnvironment = "local" | "staging";

export const INTERNAL_BASELINE_FIXTURE_DIGEST =
  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201";

export interface PublicBackendConfiguration {
  readonly environment: InternalBackendEnvironment;
  readonly url: string;
}

export interface BackendHealthReader {
  readHealth(baseUrl: URL): Promise<{
    readonly body: unknown;
    readonly status: number;
  }>;
}

export type BackendHealthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export type BackendHealthTimeoutSignal = () => AbortSignal;

const operationalBackendCapabilities = ["auth", "database", "rest"] as const;

export type BackendObservation =
  | {
      readonly environment: InternalBackendEnvironment;
      readonly fixtureDigest: string;
      readonly fixtureVersion: "internal-baseline-v2";
      readonly schemaGeneration: 4;
      readonly status: "ready";
    }
  | {
      readonly reason:
        | "configuration_invalid"
        | "contract_incompatible"
        | "service_unavailable";
      readonly status: "unavailable";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePublicBackendConfiguration(
  configuration: unknown,
): PublicBackendConfiguration | null {
  if (!isRecord(configuration)) return null;
  const configurationKeys = Object.keys(configuration);
  const configurationKeySet = new Set(configurationKeys);
  if (
    configurationKeys.length !== 2 ||
    configurationKeySet.size !== configurationKeys.length ||
    !configurationKeySet.has("environment") ||
    !configurationKeySet.has("url")
  ) {
    return null;
  }

  const environment = configuration.environment;
  const url = configuration.url;
  if (environment !== "local" && environment !== "staging") return null;
  if (typeof url !== "string") return null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(url);
  } catch {
    return null;
  }

  if (
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    return null;
  }

  const isNumericLoopback =
    baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "[::1]";
  const normalizedHostname = baseUrl.hostname.endsWith(".")
    ? baseUrl.hostname.slice(0, -1)
    : baseUrl.hostname;
  const isLocalhostNamespace =
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost");
  const isNumericOrLocalHostname =
    isNumericLoopback ||
    isLocalhostNamespace ||
    /^[0-9.]+$/u.test(baseUrl.hostname) ||
    baseUrl.hostname.startsWith("[");
  if (
    (environment === "local" &&
      (baseUrl.protocol !== "http:" || !isNumericLoopback)) ||
    (environment === "staging" &&
      (baseUrl.protocol !== "https:" ||
        isNumericOrLocalHostname ||
        (baseUrl.port !== "" && baseUrl.port !== "443")))
  ) {
    return null;
  }

  return {
    environment,
    url: baseUrl.origin,
  };
}

export function createBackendHealthReader(
  fetchHealth: BackendHealthFetch,
  createTimeoutSignal: BackendHealthTimeoutSignal = () =>
    AbortSignal.timeout(5_000),
): BackendHealthReader {
  return {
    async readHealth(baseUrl) {
      const endpoint = new URL("/functions/v1/health", baseUrl);
      const response = await fetchHealth(endpoint.href, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: createTimeoutSignal(),
      });

      return {
        body: await response.json(),
        status: response.status,
      };
    },
  };
}

export async function observeBackend(
  configuration: unknown,
  healthReader: BackendHealthReader,
): Promise<BackendObservation> {
  const parsedConfiguration = parsePublicBackendConfiguration(configuration);
  if (parsedConfiguration === null) {
    return { reason: "configuration_invalid", status: "unavailable" };
  }
  const { environment } = parsedConfiguration;
  const baseUrl = new URL(parsedConfiguration.url);

  let response: Awaited<ReturnType<BackendHealthReader["readHealth"]>>;
  try {
    response = await healthReader.readHealth(baseUrl);
  } catch {
    return { reason: "service_unavailable", status: "unavailable" };
  }
  if (response.status !== 200 || !isRecord(response.body)) {
    return { reason: "service_unavailable", status: "unavailable" };
  }

  const body = response.body;
  if (
    body.status !== "ready" ||
    body.service !== "desmoslock-v2" ||
    body.schemaGeneration !== 4 ||
    body.fixtureVersion !== "internal-baseline-v2" ||
    body.fixtureValid !== true ||
    body.fixtureDigest !== INTERNAL_BASELINE_FIXTURE_DIGEST ||
    !Array.isArray(body.capabilities) ||
    body.capabilities.length !== operationalBackendCapabilities.length ||
    body.capabilities.some(
      (capability, index) =>
        capability !== operationalBackendCapabilities[index],
    )
  ) {
    return { reason: "contract_incompatible", status: "unavailable" };
  }

  return {
    environment,
    fixtureDigest: body.fixtureDigest,
    fixtureVersion: body.fixtureVersion,
    schemaGeneration: body.schemaGeneration,
    status: "ready",
  };
}
