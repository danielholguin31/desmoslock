import {
  codeResponse,
  handlePreflight,
  isExactRecord,
  methodNotAllowedResponse,
  parseCanonicalEmail,
  parseExactCallback,
  parseExactOrigin,
  readStrictJson,
  validateRequestOrigin,
} from "../_shared/http.ts";
import {
  createSupabaseHttpClient,
  type ServiceFetch,
} from "../_shared/supabase-http.ts";

export type RequestLifetimeWaitUntil = (task: () => Promise<void>) => void;

export interface AccountRecoveryDependencies {
  readonly allowedOrigin: string;
  requestRecovery(email: string): Promise<void>;
  waitUntil: RequestLifetimeWaitUntil;
}

interface EdgeRuntimeWaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

function runtimeWaitUntil(task: () => Promise<void>): void {
  const edgeRuntime = (
    globalThis as typeof globalThis & { EdgeRuntime?: EdgeRuntimeWaitUntil }
  ).EdgeRuntime;
  if (
    edgeRuntime === undefined ||
    typeof edgeRuntime.waitUntil !== "function"
  ) {
    throw new Error("Request-lifetime background execution is unavailable");
  }
  edgeRuntime.waitUntil(Promise.resolve().then(task));
}

export function createAccountRecoveryDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
  waitUntil: RequestLifetimeWaitUntil = runtimeWaitUntil,
): AccountRecoveryDependencies {
  if (
    !isExactRecord(configuration, [
      "DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK",
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
      "SUPABASE_ANON_KEY",
      "SUPABASE_URL",
    ])
  ) {
    throw new Error("Account recovery configuration is invalid");
  }
  const allowedOrigin = parseExactOrigin(
    configuration.DESMOSLOCK_ALLOWED_WEB_ORIGIN,
  );
  const callback =
    allowedOrigin === null
      ? null
      : parseExactCallback(
          configuration.DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK,
          allowedOrigin,
        );
  const expectedSupabaseOrigin =
    configuration.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN;
  const supabaseUrl = configuration.SUPABASE_URL;
  if (
    allowedOrigin === null ||
    callback === null ||
    typeof supabaseUrl !== "string" ||
    (expectedSupabaseOrigin !== undefined &&
      typeof expectedSupabaseOrigin !== "string")
  ) {
    throw new Error("Account recovery configuration is invalid");
  }
  const client = createSupabaseHttpClient(
    {
      expectedOrigin: expectedSupabaseOrigin,
      publishableKey: String(configuration.SUPABASE_ANON_KEY),
      supabaseUrl,
    },
    serviceFetch,
  );

  return {
    allowedOrigin,
    waitUntil,
    async requestRecovery(email) {
      const providerUrl = new URL("/auth/v1/recover", `${client.origin}/`);
      providerUrl.searchParams.set("redirect_to", callback);
      await client.request(providerUrl.href, {
        body: JSON.stringify({ email }),
        headers: {
          apikey: client.publishableKey,
          authorization: `Bearer ${client.publishableKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
    },
  };
}

function runtimeDependencies(): AccountRecoveryDependencies {
  return createAccountRecoveryDependencies({
    DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK: Deno.env.get(
      "DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK",
    ),
    DESMOSLOCK_ALLOWED_WEB_ORIGIN: Deno.env.get(
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
    ),
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get(
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
    ),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  });
}

export async function handleRequest(
  request: Request,
  injectedDependencies?: AccountRecoveryDependencies,
): Promise<Response> {
  let dependencies: AccountRecoveryDependencies;
  try {
    dependencies = injectedDependencies ?? runtimeDependencies();
  } catch {
    return codeResponse("service_unavailable", 503);
  }
  const corsPolicy = {
    allowedHeaders: ["content-type"],
    allowedOrigin: dependencies.allowedOrigin,
  } as const;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, corsPolicy);
  }
  if (!validateRequestOrigin(request, dependencies.allowedOrigin)) {
    return codeResponse("invalid_request", 403);
  }
  if (request.method !== "POST") {
    return methodNotAllowedResponse(dependencies.allowedOrigin);
  }
  const body = await readStrictJson(request);
  if (!isExactRecord(body, ["email"])) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }
  const email = parseCanonicalEmail(body.email);
  if (email === null) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }

  const recoveryTask = async (): Promise<void> => {
    try {
      await dependencies.requestRecovery(email);
    } catch {
      // Provider outcomes are intentionally absorbed to preserve the public
      // non-enumeration contract. This path must never log provider details.
    }
  };
  // Integration gate: any future externally visible abuse control must be
  // durable, account-independent, and complete before provider lookup.
  try {
    dependencies.waitUntil(recoveryTask);
  } catch {
    // Scheduling failures are also hidden from the public response.
  }
  return codeResponse("recovery_requested", 202, dependencies.allowedOrigin);
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
