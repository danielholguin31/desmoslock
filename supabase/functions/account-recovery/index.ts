import {
  codeResponse,
  handlePreflight,
  isExactRecord,
  methodNotAllowedResponse,
  parseEmail,
  parseExactCallback,
  parseExactOrigin,
  readStrictJson,
  validateRequestOrigin,
} from "../_shared/http.ts";
import {
  createSupabaseHttpClient,
  type ServiceFetch,
} from "../_shared/supabase-http.ts";

const MINIMUM_RESPONSE_MILLISECONDS = 300;

export type RecoveryRequestResult =
  "accepted" | "dependency_unavailable" | "rate_limited";

export interface AccountRecoveryDependencies {
  readonly allowedOrigin: string;
  requestRecovery(email: string): Promise<RecoveryRequestResult>;
  settleResponseTime(): Promise<void>;
}

export function createAccountRecoveryDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
  settleResponseTime: () => Promise<void> = () =>
    new Promise((resolve) =>
      setTimeout(resolve, MINIMUM_RESPONSE_MILLISECONDS),
    ),
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
  if (allowedOrigin === null || callback === null) {
    throw new Error("Account recovery configuration is invalid");
  }
  const client = createSupabaseHttpClient(
    {
      expectedOrigin: String(configuration.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN),
      publishableKey: String(configuration.SUPABASE_ANON_KEY),
      supabaseUrl: String(configuration.SUPABASE_URL),
    },
    serviceFetch,
  );

  return {
    allowedOrigin,
    settleResponseTime,
    async requestRecovery(email) {
      const providerUrl = new URL("/auth/v1/recover", `${client.origin}/`);
      providerUrl.searchParams.set("redirect_to", callback);
      const response = await client.request(providerUrl.href, {
        body: JSON.stringify({ email }),
        headers: {
          apikey: client.publishableKey,
          authorization: `Bearer ${client.publishableKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      if (response.status === 429) {
        return "rate_limited";
      }
      if (response.ok || [400, 404, 422].includes(response.status)) {
        return "accepted";
      }
      return "dependency_unavailable";
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
    return codeResponse("dependency_unavailable", 503);
  }
  const corsPolicy = {
    allowedHeaders: ["content-type"],
    allowedOrigin: dependencies.allowedOrigin,
  } as const;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, corsPolicy);
  }
  if (!validateRequestOrigin(request, dependencies.allowedOrigin)) {
    return codeResponse("forbidden", 403);
  }
  if (request.method !== "POST") {
    return methodNotAllowedResponse(dependencies.allowedOrigin);
  }
  const body = await readStrictJson(request);
  if (!isExactRecord(body, ["email"])) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }
  const email = parseEmail(body.email);
  if (email === null) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }

  const [providerOutcome, delayOutcome] = await Promise.allSettled([
    dependencies.requestRecovery(email),
    dependencies.settleResponseTime(),
  ]);
  if (
    providerOutcome.status === "rejected" ||
    delayOutcome.status === "rejected"
  ) {
    return codeResponse(
      "dependency_unavailable",
      503,
      dependencies.allowedOrigin,
    );
  }
  const result = providerOutcome.value;
  if (result === "accepted") {
    return codeResponse("recovery_requested", 202, dependencies.allowedOrigin);
  }
  if (result === "rate_limited") {
    return codeResponse("rate_limited", 429, dependencies.allowedOrigin);
  }
  return codeResponse(
    "dependency_unavailable",
    503,
    dependencies.allowedOrigin,
  );
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
