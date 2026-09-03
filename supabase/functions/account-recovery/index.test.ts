// deno-lint-ignore-file require-await

import {
  type AccountRecoveryDependencies,
  createAccountRecoveryDependencies,
  handleRequest,
} from "./index.ts";

const WEB_ORIGIN = "https://staff.desmoslock.invalid";
const BACKEND_ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected action to reject");
}

function recoveryRequest(
  body: unknown = { email: "Owner@Example.com" },
  overrides: {
    readonly headers?: Record<string, string>;
    readonly method?: string;
    readonly rawBody?: string;
  } = {},
): Request {
  return new Request(`${WEB_ORIGIN}/functions/v1/account-recovery`, {
    body:
      overrides.method === "GET" || overrides.method === "OPTIONS"
        ? undefined
        : (overrides.rawBody ?? JSON.stringify(body)),
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      ...overrides.headers,
    },
    method: overrides.method ?? "POST",
  });
}

function dependencies(
  overrides: Partial<AccountRecoveryDependencies> = {},
): AccountRecoveryDependencies {
  return {
    allowedOrigin: WEB_ORIGIN,
    requestRecovery: async () => "accepted",
    settleResponseTime: async () => undefined,
    ...overrides,
  };
}

Deno.test(
  "account recovery returns the exact public acceptance contract",
  async () => {
    const emails: string[] = [];
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: async (email) => {
          emails.push(email);
          return "accepted";
        },
      }),
    );
    assertEquals(response.status, 202);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(
      response.headers.get("access-control-allow-origin"),
      WEB_ORIGIN,
    );
    assertEquals(await response.json(), { code: "recovery_requested" });
    assertEquals(emails, ["owner@example.com"]);
  },
);

Deno.test("account recovery validates exact CORS preflight", async () => {
  const valid = await handleRequest(
    recoveryRequest(undefined, {
      headers: {
        "access-control-request-headers": "Content-Type",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
    }),
    dependencies(),
  );
  assertEquals(valid.status, 204);
  assertEquals(
    valid.headers.get("access-control-allow-headers"),
    "content-type",
  );

  const wrongMethod = await handleRequest(
    recoveryRequest(undefined, {
      headers: {
        "access-control-request-headers": "content-type",
        "access-control-request-method": "PUT",
      },
      method: "OPTIONS",
    }),
    dependencies(),
  );
  assertEquals(wrongMethod.status, 400);
  assertEquals(await wrongMethod.json(), { code: "invalid_request" });
});

Deno.test(
  "account recovery rejects wrong method and exact origin",
  async () => {
    const methodResponse = await handleRequest(
      recoveryRequest(undefined, { method: "GET" }),
      dependencies(),
    );
    assertEquals(methodResponse.status, 405);
    assertEquals(methodResponse.headers.get("allow"), "POST, OPTIONS");

    const originResponse = await handleRequest(
      recoveryRequest(undefined, {
        headers: { origin: "https://attacker.invalid" },
      }),
      dependencies(),
    );
    assertEquals(originResponse.status, 403);
    assertEquals(
      originResponse.headers.get("access-control-allow-origin"),
      null,
    );
    assertEquals(await originResponse.json(), { code: "forbidden" });
  },
);

Deno.test(
  "account recovery rejects content type, oversized body, malformed JSON, and extra keys",
  async () => {
    const invalidRequests = [
      recoveryRequest(undefined, { headers: { "content-type": "text/plain" } }),
      recoveryRequest(undefined, {
        headers: { "content-type": "application/ json" },
      }),
      recoveryRequest(undefined, { rawBody: "{" }),
      recoveryRequest(undefined, {
        rawBody: JSON.stringify({ padding: "x".repeat(4_096) }),
      }),
      recoveryRequest({ email: "owner@example.com", extra: true }),
      recoveryRequest({ email: "not-an-email" }),
    ];
    let calls = 0;
    for (const request of invalidRequests) {
      const response = await handleRequest(
        request,
        dependencies({
          requestRecovery: async () => {
            calls += 1;
            return "accepted";
          },
        }),
      );
      assertEquals(response.status, 400);
      assertEquals(await response.json(), { code: "invalid_request" });
    }
    assertEquals(calls, 0);
  },
);

Deno.test(
  "account recovery rejects an already-consumed request body",
  async () => {
    const request = recoveryRequest();
    await request.text();
    const response = await handleRequest(request, dependencies());
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { code: "invalid_request" });
  },
);

Deno.test(
  "account recovery maps only stable rate and dependency failures",
  async () => {
    const rateLimited = await handleRequest(
      recoveryRequest(),
      dependencies({ requestRecovery: async () => "rate_limited" }),
    );
    assertEquals(rateLimited.status, 429);
    assertEquals(await rateLimited.json(), { code: "rate_limited" });

    const dependencyFailure = await handleRequest(
      recoveryRequest(),
      dependencies({ requestRecovery: async () => "dependency_unavailable" }),
    );
    assertEquals(dependencyFailure.status, 503);
    assertEquals(await dependencyFailure.json(), {
      code: "dependency_unavailable",
    });
  },
);

Deno.test(
  "account recovery sanitizes thrown provider details and secrets",
  async () => {
    const sentinel = "credential-shaped-provider-sentinel";
    let delayFinished = false;
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: () =>
          Promise.reject(new Error(`provider ${sentinel}`)),
        settleResponseTime: () =>
          new Promise((resolve) =>
            setTimeout(() => {
              delayFinished = true;
              resolve();
            }, 1),
          ),
      }),
    );
    const body = await response.text();
    assertEquals(response.status, 503);
    assertEquals(body, JSON.stringify({ code: "dependency_unavailable" }));
    assert(!body.includes(sentinel), "Provider detail leaked");
    assert(
      delayFinished,
      "Rejected provider response bypassed the minimum response time",
    );
  },
);

Deno.test(
  "account recovery waits for both provider and minimum response time",
  async () => {
    let providerFinished = false;
    let delayFinished = false;
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: async () => {
          await Promise.resolve();
          providerFinished = true;
          return "accepted";
        },
        settleResponseTime: async () => {
          await Promise.resolve();
          delayFinished = true;
        },
      }),
    );
    assertEquals(response.status, 202);
    assert(providerFinished && delayFinished);
  },
);

function runtimeConfiguration(): Record<string, string> {
  return {
    DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK: `${WEB_ORIGIN}/auth/recovery`,
    DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
    SUPABASE_ANON_KEY: "synthetic-publishable-sentinel",
    SUPABASE_URL: BACKEND_ORIGIN,
  };
}

Deno.test(
  "known and unknown account provider outcomes have an identical response",
  async () => {
    const createService = (providerStatus: number) =>
      createAccountRecoveryDependencies(
        runtimeConfiguration(),
        async () => new Response("{}", { status: providerStatus }),
        async () => undefined,
      );
    const known = await handleRequest(
      recoveryRequest({ email: "known@example.com" }),
      createService(200),
    );
    const unknown = await handleRequest(
      recoveryRequest({ email: "unknown@example.com" }),
      createService(400),
    );
    assertEquals(known.status, 202);
    assertEquals(unknown.status, 202);
    assertEquals(
      await known.text(),
      JSON.stringify({ code: "recovery_requested" }),
    );
    assertEquals(
      await unknown.text(),
      JSON.stringify({ code: "recovery_requested" }),
    );
  },
);

Deno.test(
  "account recovery runtime pins provider and callback origins without URL key leakage",
  async () => {
    const publishableSentinel = "synthetic-publishable-sentinel";
    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const service = createAccountRecoveryDependencies(
      { ...runtimeConfiguration(), SUPABASE_ANON_KEY: publishableSentinel },
      async (input, init) => {
        requests.push({
          body: String(init?.body ?? ""),
          headers: new Headers(init?.headers),
          url: String(input),
        });
        return new Response("{}", { status: 200 });
      },
      async () => undefined,
    );
    assertEquals(
      await service.requestRecovery("unknown@example.com"),
      "accepted",
    );
    assertEquals(requests.length, 1);
    const request = requests[0];
    const url = new URL(request.url);
    assertEquals(url.origin, BACKEND_ORIGIN);
    assertEquals(url.pathname, "/auth/v1/recover");
    assertEquals(
      url.searchParams.get("redirect_to"),
      `${WEB_ORIGIN}/auth/recovery`,
    );
    assert(
      !request.url.includes(publishableSentinel),
      "Publishable value leaked into URL",
    );
    assertEquals(request.headers.get("apikey"), publishableSentinel);
    assertEquals(
      request.headers.get("authorization"),
      `Bearer ${publishableSentinel}`,
    );
    assertEquals(JSON.parse(request.body), { email: "unknown@example.com" });
  },
);

Deno.test(
  "account recovery runtime maps provider rate and dependency states",
  async () => {
    for (const [status, expected] of [
      [429, "rate_limited"],
      [500, "dependency_unavailable"],
      [401, "dependency_unavailable"],
    ] as const) {
      const service = createAccountRecoveryDependencies(
        runtimeConfiguration(),
        async () => new Response("{}", { status }),
        async () => undefined,
      );
      assertEquals(
        await service.requestRecovery("owner@example.com"),
        expected,
      );
    }
  },
);

Deno.test(
  "account recovery runtime rejects mismatched callback before egress",
  async () => {
    let requests = 0;
    await assertRejects(async () => {
      createAccountRecoveryDependencies(
        {
          ...runtimeConfiguration(),
          DESMOSLOCK_ACCOUNT_RECOVERY_CALLBACK:
            "https://attacker.invalid/recovery",
        },
        async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
        async () => undefined,
      );
    });
    assertEquals(requests, 0);
  },
);
