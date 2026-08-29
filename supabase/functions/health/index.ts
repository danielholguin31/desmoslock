export interface BaselineStatus {
  readonly capabilities: readonly ["auth", "database", "rest"];
  readonly fixtureDigest: string;
  readonly fixtureValid: true;
  readonly fixtureVersion: "internal-baseline-v1";
  readonly schemaGeneration: 3;
}

export type BaselineProbe = () => Promise<BaselineStatus>;

export type BackendProbeTimeoutSignal = () => AbortSignal;

const INTERNAL_BASELINE_FIXTURE_DIGEST =
  "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca";
const INTERNAL_MIGRATION_SET_SHA256 =
  "06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49";

const publicResponseHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;

type ProbeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const observedKeys = Object.keys(value);
  const observedSet = new Set(observedKeys);
  return (
    observedKeys.length === expectedKeys.length &&
    observedSet.size === observedKeys.length &&
    expectedKeys.every((key) => observedSet.has(key))
  );
}

export function createBackendProbe(
  configuration: unknown,
  probeFetch: ProbeFetch,
  createTimeoutSignal: BackendProbeTimeoutSignal = () =>
    AbortSignal.timeout(5_000),
): BaselineProbe {
  return async () => {
    if (
      !isRecord(configuration) ||
      !hasExactKeys(configuration, [
        "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_URL",
      ])
    ) {
      throw new Error("Backend probe configuration is invalid");
    }
    const serviceRoleKey = configuration.SUPABASE_SERVICE_ROLE_KEY;
    const url = configuration.SUPABASE_URL;
    const expectedOrigin = configuration.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN;
    if (
      typeof serviceRoleKey !== "string" ||
      serviceRoleKey.length === 0 ||
      typeof url !== "string" ||
      typeof expectedOrigin !== "string"
    ) {
      throw new Error("Backend probe configuration is invalid");
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(url);
    } catch {
      throw new Error("Backend probe configuration is invalid");
    }
    const allowedLocalHost =
      baseUrl.hostname === "127.0.0.1" ||
      baseUrl.hostname === "[::1]" ||
      baseUrl.hostname === "host.docker.internal" ||
      baseUrl.hostname === "kong";
    const isLocalOrigin =
      baseUrl.protocol === "http:" &&
      allowedLocalHost &&
      expectedOrigin === baseUrl.origin;
    const isPinnedHostedOrigin =
      baseUrl.protocol === "https:" &&
      baseUrl.port === "" &&
      /^[a-z0-9]{20}\.supabase\.co$/u.test(baseUrl.hostname) &&
      expectedOrigin === baseUrl.origin;
    if (
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.pathname !== "/" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== "" ||
      (!isLocalOrigin && !isPinnedHostedOrigin)
    ) {
      throw new Error("Backend probe configuration is invalid");
    }

    const timeoutSignal = createTimeoutSignal();
    const [authResponse, baselineResponse] = await Promise.all([
      probeFetch(new URL("/auth/v1/health", baseUrl).href, {
        headers: { apikey: serviceRoleKey },
        method: "GET",
        redirect: "error",
        signal: timeoutSignal,
      }),
      probeFetch(
        new URL("/rest/v1/rpc/internal_baseline_status", baseUrl).href,
        {
          body: "{}",
          headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${serviceRoleKey}`,
            "content-profile": "desmoslock_v2",
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: timeoutSignal,
        },
      ),
    ]);
    if (!authResponse.ok || !baselineResponse.ok) {
      throw new Error("Backend dependency is unavailable");
    }

    const payload: unknown = await baselineResponse.json();
    if (!Array.isArray(payload) || payload.length !== 1) {
      throw new Error("Backend baseline is incompatible");
    }
    const [baseline] = payload;
    if (
      !isRecord(baseline) ||
      !hasExactKeys(baseline, [
        "fixture_digest",
        "fixture_valid",
        "fixture_version",
        "migration_set_sha256",
        "schema_generation",
      ]) ||
      baseline.schema_generation !== 3 ||
      baseline.fixture_version !== "internal-baseline-v1" ||
      baseline.fixture_valid !== true ||
      baseline.fixture_digest !== INTERNAL_BASELINE_FIXTURE_DIGEST ||
      baseline.migration_set_sha256 !== INTERNAL_MIGRATION_SET_SHA256
    ) {
      throw new Error("Backend baseline is incompatible");
    }

    return {
      capabilities: ["auth", "database", "rest"],
      fixtureDigest: baseline.fixture_digest,
      fixtureValid: true,
      fixtureVersion: "internal-baseline-v1",
      schemaGeneration: 3,
    };
  };
}

async function probeConfiguredBackend(): Promise<BaselineStatus> {
  return await createBackendProbe(
    {
      DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get(
        "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
      ),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
    },
    globalThis.fetch,
  )();
}

export async function handleRequest(
  request: Request,
  probe: BaselineProbe = probeConfiguredBackend,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      headers: {
        allow: "GET",
        ...publicResponseHeaders,
      },
      status: 405,
    });
  }

  let baseline: BaselineStatus;
  try {
    baseline = await probe();
  } catch {
    return Response.json(
      {
        reason: "dependency_unavailable",
        service: "desmoslock-v2",
        status: "unavailable",
      },
      {
        headers: {
          ...publicResponseHeaders,
        },
        status: 503,
      },
    );
  }
  return Response.json(
    { ...baseline, service: "desmoslock-v2", status: "ready" },
    {
      headers: {
        ...publicResponseHeaders,
      },
    },
  );
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
