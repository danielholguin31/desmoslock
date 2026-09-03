// deno-lint-ignore-file require-await

import {
  createStaffInvitationDependencies,
  handleRequest,
  type StaffInvitationDependencies,
} from "./index.ts";

const WEB_ORIGIN = "https://staff.desmoslock.invalid";
const BACKEND_ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";
const INVITATION_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000002";
const WORKSPACE_ID = "30000000-0000-0000-0000-000000000003";
const JWT = "synthetic-header.synthetic-payload.synthetic-signature";

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

function invitationRequest(
  body: unknown = {
    email: "Teacher@Example.com",
    role: "teacher",
    workspaceId: WORKSPACE_ID,
  },
  overrides: {
    readonly headers?: Record<string, string>;
    readonly method?: string;
    readonly rawBody?: string;
  } = {},
): Request {
  return new Request(`${WEB_ORIGIN}/functions/v1/staff-invitations`, {
    body:
      overrides.method === "GET" || overrides.method === "OPTIONS"
        ? undefined
        : (overrides.rawBody ?? JSON.stringify(body)),
    headers: {
      authorization: `Bearer ${JWT}`,
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      ...overrides.headers,
    },
    method: overrides.method ?? "POST",
  });
}

function dependencies(
  overrides: Partial<StaffInvitationDependencies> = {},
): StaffInvitationDependencies {
  return {
    allowedOrigin: WEB_ORIGIN,
    authorizeInvitation: async () => ({
      code: "invitation_pending",
      invitationId: INVITATION_ID,
    }),
    completeInvitation: async () => "invitation_usable",
    deliverInvitation: async () => ({ code: "user_created", userId: USER_ID }),
    failInvitation: async () => "invitation_delivery_failed",
    now: () => Date.UTC(2026, 7, 30, 12),
    ...overrides,
  };
}

Deno.test(
  "staff invitation completes only after caller authorization and delivery",
  async () => {
    const calls: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        authorizeInvitation: async (jwt, input) => {
          calls.push(["authorize", jwt, input]);
          return { code: "invitation_pending", invitationId: INVITATION_ID };
        },
        deliverInvitation: async (email) => {
          calls.push(["deliver", email]);
          return { code: "user_created", userId: USER_ID };
        },
        completeInvitation: async (invitationId, userId, expiresAt) => {
          calls.push(["complete", invitationId, userId, expiresAt]);
          return "invitation_usable";
        },
      }),
    );

    assertEquals(response.status, 201);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(
      response.headers.get("access-control-allow-origin"),
      WEB_ORIGIN,
    );
    assertEquals(await response.json(), { code: "invitation_created" });
    assertEquals(calls, [
      [
        "authorize",
        JWT,
        {
          email: "teacher@example.com",
          role: "teacher",
          workspaceId: WORKSPACE_ID,
        },
      ],
      ["deliver", "teacher@example.com"],
      ["complete", INVITATION_ID, USER_ID, "2026-08-31T12:00:00.000Z"],
    ]);
  },
);

Deno.test("staff invitation validates exact CORS preflight", async () => {
  const valid = await handleRequest(
    invitationRequest(undefined, {
      headers: {
        "access-control-request-headers": "Content-Type, Authorization",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
    }),
    dependencies(),
  );
  assertEquals(valid.status, 204);
  assertEquals(
    valid.headers.get("access-control-allow-headers"),
    "authorization, content-type",
  );

  const extraHeader = await handleRequest(
    invitationRequest(undefined, {
      headers: {
        "access-control-request-headers":
          "authorization, content-type, x-extra",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
    }),
    dependencies(),
  );
  assertEquals(extraHeader.status, 400);
  assertEquals(await extraHeader.json(), { code: "invalid_request" });
});

Deno.test(
  "staff invitation rejects the wrong method and exact origin",
  async () => {
    const methodResponse = await handleRequest(
      invitationRequest(undefined, { method: "GET" }),
      dependencies(),
    );
    assertEquals(methodResponse.status, 405);
    assertEquals(methodResponse.headers.get("allow"), "POST, OPTIONS");

    const originResponse = await handleRequest(
      invitationRequest(undefined, {
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
  "staff invitation requires a syntactically valid JWT before authorization",
  async () => {
    let calls = 0;
    for (const authorization of [
      "",
      "Bearer opaque-token",
      "bearer a.b.c",
      "Basic a.b.c",
    ]) {
      const response = await handleRequest(
        invitationRequest(undefined, { headers: { authorization } }),
        dependencies({
          authorizeInvitation: async () => {
            calls += 1;
            return { code: "invitation_pending", invitationId: INVITATION_ID };
          },
        }),
      );
      assertEquals(response.status, 401);
      assertEquals(await response.json(), { code: "unauthenticated" });
    }
    assertEquals(calls, 0);
  },
);

Deno.test(
  "staff invitation rejects content type, oversized body, and malformed JSON",
  async () => {
    const invalidRequests = [
      invitationRequest(undefined, {
        headers: { "content-type": "text/plain" },
      }),
      invitationRequest(undefined, {
        headers: { "content-type": "application/ json" },
      }),
      invitationRequest(undefined, { rawBody: "{" }),
      invitationRequest(undefined, {
        rawBody: JSON.stringify({ padding: "x".repeat(4_096) }),
      }),
    ];
    for (const request of invalidRequests) {
      const response = await handleRequest(request, dependencies());
      assertEquals(response.status, 400);
      assertEquals(await response.json(), { code: "invalid_request" });
    }
  },
);

Deno.test(
  "staff invitation accepts only the exact schema and admin or teacher roles",
  async () => {
    let calls = 0;
    const invalidBodies = [
      {
        email: "teacher@example.com",
        role: "owner",
        workspaceId: WORKSPACE_ID,
      },
      {
        email: "teacher@example.com",
        role: "student",
        workspaceId: WORKSPACE_ID,
      },
      { email: "not-an-email", role: "teacher", workspaceId: WORKSPACE_ID },
      {
        email: "teacher@example.com",
        extra: true,
        role: "teacher",
        workspaceId: WORKSPACE_ID,
      },
      {
        email: "teacher@example.com",
        role: "teacher",
        workspaceId: "not-a-uuid",
      },
    ];
    for (const body of invalidBodies) {
      const response = await handleRequest(
        invitationRequest(body),
        dependencies({
          authorizeInvitation: async () => {
            calls += 1;
            return { code: "invitation_pending", invitationId: INVITATION_ID };
          },
        }),
      );
      assertEquals(response.status, 400);
    }
    assertEquals(calls, 0);
  },
);

Deno.test(
  "staff invitation never calls Auth Admin before database authorization",
  async () => {
    let deliveries = 0;
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        authorizeInvitation: async () => ({ code: "forbidden" }),
        deliverInvitation: async () => {
          deliveries += 1;
          return { code: "user_created", userId: USER_ID };
        },
      }),
    );
    assertEquals(response.status, 403);
    assertEquals(await response.json(), { code: "forbidden" });
    assertEquals(deliveries, 0);
  },
);

Deno.test(
  "staff invitation maps stable caller authorization failures",
  async () => {
    const cases = [
      ["email_unverified", 403],
      ["membership_inactive", 403],
      ["step_up_required", 403],
      ["session_expired", 401],
      ["session_revoked", 401],
      ["rate_limited", 429],
      ["conflict", 409],
    ] as const;
    for (const [code, status] of cases) {
      const response = await handleRequest(
        invitationRequest(),
        dependencies({ authorizeInvitation: async () => ({ code }) }),
      );
      assertEquals(response.status, status);
      assertEquals(await response.json(), { code });
    }
  },
);

Deno.test(
  "staff invitation records every provider failure before returning",
  async () => {
    for (const [providerCode, expectedStatus] of [
      ["conflict", 409],
      ["rate_limited", 429],
      ["dependency_unavailable", 503],
    ] as const) {
      const failures: unknown[] = [];
      const response = await handleRequest(
        invitationRequest(),
        dependencies({
          deliverInvitation: async () => ({ code: providerCode }),
          failInvitation: async (invitationId, reasonCode) => {
            failures.push([invitationId, reasonCode]);
            return "invitation_delivery_failed";
          },
        }),
      );
      assertEquals(response.status, expectedStatus);
      assertEquals(await response.json(), { code: providerCode });
      assertEquals(failures, [[INVITATION_ID, providerCode]]);
    }
  },
);

Deno.test(
  "staff invitation fails closed when failure recording is unavailable",
  async () => {
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        deliverInvitation: async () => ({ code: "conflict" }),
        failInvitation: async () => "unexpected",
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
  },
);

Deno.test(
  "staff invitation failure after Auth creation never reports usable membership",
  async () => {
    const failures: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        completeInvitation: async () => "conflict",
        failInvitation: async (invitationId, reasonCode) => {
          failures.push([invitationId, reasonCode]);
          return "invitation_delivery_failed";
        },
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
    assertEquals(failures, [[INVITATION_ID, "dependency_unavailable"]]);
  },
);

Deno.test(
  "staff invitation fails closed on an invalid server clock",
  async () => {
    const failures: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        failInvitation: async (invitationId, reasonCode) => {
          failures.push([invitationId, reasonCode]);
          return "invitation_delivery_failed";
        },
        now: () => Number.MAX_SAFE_INTEGER,
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
    assertEquals(failures, [[INVITATION_ID, "dependency_unavailable"]]);
  },
);

Deno.test(
  "staff invitation sanitizes thrown provider details and secrets",
  async () => {
    const sentinel = "credential-shaped-sentinel-value";
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        deliverInvitation: () =>
          Promise.reject(new Error(`provider ${sentinel}`)),
      }),
    );
    const body = await response.text();
    assertEquals(response.status, 503);
    assertEquals(body, JSON.stringify({ code: "dependency_unavailable" }));
    assert(!body.includes(sentinel), "Provider detail leaked");
  },
);

Deno.test(
  "staff invitation runtime pins backend and callback origins",
  async () => {
    const serviceRoleSentinel = "synthetic-service-role-sentinel";
    const publishableSentinel = "synthetic-publishable-sentinel";
    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const service = createStaffInvitationDependencies(
      {
        DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
        DESMOSLOCK_STAFF_INVITATION_CALLBACK: `${WEB_ORIGIN}/auth/invitation`,
        SUPABASE_ANON_KEY: publishableSentinel,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleSentinel,
        SUPABASE_URL: BACKEND_ORIGIN,
      },
      async (input, init) => {
        const url = String(input);
        requests.push({
          body: String(init?.body ?? ""),
          headers: new Headers(init?.headers),
          url,
        });
        if (url.includes("begin_staff_invitation")) {
          return Response.json([
            { code: "invitation_pending", invitation_id: INVITATION_ID },
          ]);
        }
        if (url.includes("/auth/v1/invite")) {
          return Response.json({
            confirmation_sent_at: "2026-08-30T12:00:00.000Z",
            confirmed_at: null,
            email: "teacher@example.com",
            email_confirmed_at: null,
            id: USER_ID,
            invited_at: "2026-08-30T12:00:00.000Z",
            is_anonymous: false,
          });
        }
        return Response.json([{ code: "invitation_usable" }]);
      },
      () => Date.UTC(2026, 7, 30, 12),
    );

    const authorization = await service.authorizeInvitation(JWT, {
      email: "teacher@example.com",
      role: "teacher",
      workspaceId: WORKSPACE_ID,
    });
    const delivery = await service.deliverInvitation("teacher@example.com");
    assertEquals(authorization, {
      code: "invitation_pending",
      invitationId: INVITATION_ID,
    });
    assertEquals(delivery, { code: "user_created", userId: USER_ID });
    assertEquals(requests.length, 2);
    assert(requests.every(({ url }) => new URL(url).origin === BACKEND_ORIGIN));
    assert(requests.every(({ url }) => !url.includes(serviceRoleSentinel)));
    assert(requests.every(({ url }) => !url.includes(publishableSentinel)));
    assertEquals(JSON.parse(requests[0].body), {
      email: "teacher@example.com",
      role: "teacher",
      workspace_id: WORKSPACE_ID,
    });
    assertEquals(requests[0].headers.get("authorization"), `Bearer ${JWT}`);
    assertEquals(requests[0].headers.get("apikey"), publishableSentinel);
    const providerUrl = new URL(requests[1].url);
    assertEquals(providerUrl.pathname, "/auth/v1/invite");
    assertEquals(
      providerUrl.searchParams.get("redirect_to"),
      `${WEB_ORIGIN}/auth/invitation`,
    );
    assertEquals(
      requests[1].headers.get("authorization"),
      `Bearer ${serviceRoleSentinel}`,
    );
  },
);

Deno.test(
  "staff invitation runtime rejects a provider-confirmed existing user",
  async () => {
    const service = createStaffInvitationDependencies(
      {
        DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
        DESMOSLOCK_STAFF_INVITATION_CALLBACK: `${WEB_ORIGIN}/auth/invitation`,
        SUPABASE_ANON_KEY: "synthetic-publishable-sentinel",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-sentinel",
        SUPABASE_URL: BACKEND_ORIGIN,
      },
      async () =>
        Response.json({
          email: "teacher@example.com",
          email_confirmed_at: "2026-08-30T11:00:00.000Z",
          id: USER_ID,
        }),
    );
    assertEquals(await service.deliverInvitation("teacher@example.com"), {
      code: "conflict",
    });
  },
);

Deno.test(
  "staff invitation runtime accepts the documented wrapped user shape",
  async () => {
    const service = createStaffInvitationDependencies(
      {
        DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
        DESMOSLOCK_STAFF_INVITATION_CALLBACK: `${WEB_ORIGIN}/auth/invitation`,
        SUPABASE_ANON_KEY: "synthetic-publishable-sentinel",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-sentinel",
        SUPABASE_URL: BACKEND_ORIGIN,
      },
      async () =>
        Response.json({
          user: {
            confirmation_sent_at: "2026-08-30T12:00:00.000Z",
            email: "teacher@example.com",
            email_confirmed_at: null,
            id: USER_ID,
            invited_at: "2026-08-30T12:00:00.000Z",
            is_anonymous: false,
          },
        }),
    );
    assertEquals(await service.deliverInvitation("teacher@example.com"), {
      code: "user_created",
      userId: USER_ID,
    });
  },
);

Deno.test(
  "staff invitation runtime rejects mismatched callback configuration before egress",
  async () => {
    let requests = 0;
    await assertRejects(async () => {
      createStaffInvitationDependencies(
        {
          DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
          DESMOSLOCK_STAFF_INVITATION_CALLBACK:
            "https://attacker.invalid/callback",
          SUPABASE_ANON_KEY: "synthetic-publishable-sentinel",
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-sentinel",
          SUPABASE_URL: BACKEND_ORIGIN,
        },
        async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
      );
    });
    assertEquals(requests, 0);
  },
);
