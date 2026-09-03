// deno-lint-ignore-file require-await

import {
  type AccountRecoveryDependencies,
  createAccountRecoveryDependencies,
  handleRequest,
  type RequestLifetimeWaitUntil,
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
  body: unknown = { email: "owner@example.com" },
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
    requestRecovery: async () => undefined,
    waitUntil: (task) => {
      void task();
    },
    ...overrides,
  };
}

async function publicSnapshot(response: Response): Promise<unknown> {
  return {
    accessControlAllowOrigin: response.headers.get(
      "access-control-allow-origin",
    ),
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    status: response.status,
    vary: response.headers.get("vary"),
  };
}

Deno.test(
  "account recovery returns the exact public contract while scheduling canonical email",
  async () => {
    const emails: string[] = [];
    let background: Promise<void> | undefined;
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: async (email) => {
          emails.push(email);
        },
        waitUntil: (task) => {
          background = task();
        },
      }),
    );
    assertEquals(await publicSnapshot(response), {
      accessControlAllowOrigin: WEB_ORIGIN,
      body: JSON.stringify({ code: "recovery_requested", ok: true }),
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      status: 202,
      vary: "Origin",
    });
    await background;
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
  assertEquals(await wrongMethod.json(), {
    code: "invalid_request",
    ok: false,
  });

  const wrongOrigin = await handleRequest(
    recoveryRequest(undefined, {
      headers: {
        "access-control-request-headers": "content-type",
        "access-control-request-method": "POST",
        origin: "https://attacker.invalid",
      },
      method: "OPTIONS",
    }),
    dependencies(),
  );
  assertEquals(wrongOrigin.status, 403);
  assertEquals(wrongOrigin.headers.get("access-control-allow-origin"), null);
  assertEquals(await wrongOrigin.json(), {
    code: "invalid_request",
    ok: false,
  });
});

Deno.test({
  name: "account recovery config failure returns the exact product response",
  permissions: { env: false },
  fn: async () => {
    const response = await handleRequest(recoveryRequest());
    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      code: "service_unavailable",
      ok: false,
    });
  },
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
    assertEquals(await methodResponse.json(), {
      code: "invalid_request",
      ok: false,
    });

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
    assertEquals(await originResponse.json(), {
      code: "invalid_request",
      ok: false,
    });
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
      recoveryRequest({ email: "Owner@Example.com" }),
      recoveryRequest({ email: "owner`tag@example.com" }),
    ];
    let schedules = 0;
    for (const request of invalidRequests) {
      const response = await handleRequest(
        request,
        dependencies({
          waitUntil: () => {
            schedules += 1;
          },
        }),
      );
      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        code: "invalid_request",
        ok: false,
      });
    }
    assertEquals(schedules, 0);
  },
);

Deno.test(
  "account recovery rejects an already-consumed request body",
  async () => {
    const request = recoveryRequest();
    await request.text();
    const response = await handleRequest(request, dependencies());
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { code: "invalid_request", ok: false });
  },
);

Deno.test(
  "every provider HTTP outcome has an identical immediate public response",
  async () => {
    const snapshots: unknown[] = [];
    for (const status of [200, 400, 404, 422, 429, 500, 503]) {
      let background: Promise<void> | undefined;
      const service = createAccountRecoveryDependencies(
        runtimeConfiguration(),
        async () => new Response("{}", { status }),
        (task) => {
          background = task();
        },
      );
      const response = await handleRequest(recoveryRequest(), service);
      snapshots.push(await publicSnapshot(response));
      await background;
    }
    assertEquals(
      new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))).size,
      1,
    );
    assertEquals(snapshots[0], {
      accessControlAllowOrigin: WEB_ORIGIN,
      body: JSON.stringify({ code: "recovery_requested", ok: true }),
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      status: 202,
      vary: "Origin",
    });
  },
);

Deno.test(
  "account recovery response completes before delayed provider work",
  async () => {
    let finishProvider: (() => void) | undefined;
    let providerFinished = false;
    let background: Promise<void> | undefined;
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: () =>
          new Promise((resolve) => {
            finishProvider = () => {
              providerFinished = true;
              resolve();
            };
          }),
        waitUntil: (task) => {
          background = task();
        },
      }),
    );
    assertEquals(response.status, 202);
    assert(!providerFinished, "Public response waited for the provider");
    assert(finishProvider !== undefined, "Provider work was not scheduled");
    finishProvider();
    await background;
    assert(providerFinished);
  },
);

Deno.test(
  "account recovery absorbs timeout and provider errors without leakage",
  async () => {
    const sentinel = "credential-shaped-provider-sentinel";
    let background: Promise<void> | undefined;
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        requestRecovery: () => Promise.reject(new Error(sentinel)),
        waitUntil: (task) => {
          background = task();
        },
      }),
    );
    const snapshot = await publicSnapshot(response);
    await background;
    assertEquals(snapshot, {
      accessControlAllowOrigin: WEB_ORIGIN,
      body: JSON.stringify({ code: "recovery_requested", ok: true }),
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      status: 202,
      vary: "Origin",
    });
    assert(
      !JSON.stringify(snapshot).includes(sentinel),
      "Provider detail leaked",
    );
  },
);

Deno.test(
  "account recovery hides request-lifetime scheduler failures",
  async () => {
    const response = await handleRequest(
      recoveryRequest(),
      dependencies({
        waitUntil: () => {
          throw new Error("scheduler diagnostic must stay private");
        },
      }),
    );
    assertEquals(await publicSnapshot(response), {
      accessControlAllowOrigin: WEB_ORIGIN,
      body: JSON.stringify({ code: "recovery_requested", ok: true }),
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      status: 202,
      vary: "Origin",
    });
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
    const createService = (providerStatus: number) => {
      let background: Promise<void> | undefined;
      const service = createAccountRecoveryDependencies(
        runtimeConfiguration(),
        async () => new Response("{}", { status: providerStatus }),
        (task) => {
          background = task();
        },
      );
      return { getBackground: () => background, service };
    };
    const knownService = createService(200);
    const unknownService = createService(400);
    const known = await handleRequest(
      recoveryRequest({ email: "known@example.com" }),
      knownService.service,
    );
    const unknown = await handleRequest(
      recoveryRequest({ email: "unknown@example.com" }),
      unknownService.service,
    );
    const knownSnapshot = await publicSnapshot(known);
    const unknownSnapshot = await publicSnapshot(unknown);
    await Promise.all([
      knownService.getBackground(),
      unknownService.getBackground(),
    ]);
    assertEquals(knownSnapshot, unknownSnapshot);
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
        return new Response("{}", { status: 500 });
      },
      (() => undefined) as RequestLifetimeWaitUntil,
    );
    assertEquals(
      await service.requestRecovery("unknown@example.com"),
      undefined,
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
  "account recovery accepts the exact CLI kong origin when its independent pin is absent",
  async () => {
    const requests: string[] = [];
    const service = createAccountRecoveryDependencies(
      {
        ...runtimeConfiguration(),
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: undefined,
        SUPABASE_URL: "http://kong:8000",
      },
      async (input) => {
        requests.push(String(input));
        return new Response("{}", { status: 200 });
      },
      (() => undefined) as RequestLifetimeWaitUntil,
    );

    await service.requestRecovery("unknown@example.com");
    assertEquals(requests.length, 1);
    assertEquals(new URL(requests[0]).origin, "http://kong:8000");
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
        (() => undefined) as RequestLifetimeWaitUntil,
      );
    });
    assertEquals(requests, 0);
  },
);
