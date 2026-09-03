// deno-lint-ignore-file require-await

import {
  createStaffInvitationDependencies,
  handleRequest,
  type StaffInvitationDeliveryTransport,
  type StaffInvitationDependencies,
} from "./index.ts";

const WEB_ORIGIN = "https://staff.desmoslock.invalid";
const BACKEND_ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";
const CALLBACK = `${WEB_ORIGIN}/auth/invitation`;
const INVITATION_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000002";
const WORKSPACE_ID = "30000000-0000-0000-0000-000000000003";
const JWT = "synthetic-header.synthetic-payload.synthetic-signature";
const ACTION_TOKEN_SENTINEL = "synthetic-action-token-sentinel";
const ACTION_LINK =
  `${BACKEND_ORIGIN}/auth/v1/verify?token=${ACTION_TOKEN_SENTINEL}` +
  `&type=invite&redirect_to=${encodeURIComponent(CALLBACK)}`;

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
    deliverInvitation: async () => "delivered",
    failInvitation: async () => "invitation_delivery_failed",
    generateInviteLink: async () => ({
      actionLink: ACTION_LINK,
      code: "link_generated",
      userId: USER_ID,
    }),
    inviteLifetimeSeconds: 3_600,
    now: () => Date.UTC(2026, 7, 30, 12),
    prepareInvitation: async () => "invitation_delivery_ready",
    publishInvitation: async () => "invitation_usable",
    ...overrides,
  };
}

Deno.test(
  "staff invitation sequences authorize, generate, prepare, deliver, then publish",
  async () => {
    const calls: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        authorizeInvitation: async (jwt, input) => {
          calls.push(["authorize", jwt, input]);
          return { code: "invitation_pending", invitationId: INVITATION_ID };
        },
        generateInviteLink: async (email) => {
          calls.push(["generate", email]);
          return {
            actionLink: ACTION_LINK,
            code: "link_generated",
            userId: USER_ID,
          };
        },
        deliverInvitation: async (message) => {
          calls.push(["deliver", message]);
          return "delivered";
        },
        prepareInvitation: async (invitationId, userId, expiresAt) => {
          calls.push(["prepare", invitationId, userId, expiresAt]);
          return "invitation_delivery_ready";
        },
        publishInvitation: async (invitationId) => {
          calls.push(["publish", invitationId]);
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
      ["generate", "teacher@example.com"],
      ["prepare", INVITATION_ID, USER_ID, "2026-08-30T13:00:00.000Z"],
      [
        "deliver",
        {
          actionLink: ACTION_LINK,
          expiresAt: "2026-08-30T13:00:00.000Z",
          recipientEmail: "teacher@example.com",
        },
      ],
      ["publish", INVITATION_ID],
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
    let generatedLinks = 0;
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        authorizeInvitation: async () => ({ code: "forbidden" }),
        generateInviteLink: async () => {
          generatedLinks += 1;
          return {
            actionLink: ACTION_LINK,
            code: "link_generated",
            userId: USER_ID,
          };
        },
      }),
    );
    assertEquals(response.status, 403);
    assertEquals(await response.json(), { code: "forbidden" });
    assertEquals(generatedLinks, 0);
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
  "staff invitation records generated-link failures before returning",
  async () => {
    for (const [generatorCode, expectedStatus] of [
      ["conflict", 409],
      ["rate_limited", 429],
      ["dependency_unavailable", 503],
    ] as const) {
      const failures: unknown[] = [];
      const response = await handleRequest(
        invitationRequest(),
        dependencies({
          failInvitation: async (invitationId, reasonCode) => {
            failures.push([invitationId, reasonCode]);
            return "invitation_delivery_failed";
          },
          generateInviteLink: async () => ({ code: generatorCode }),
        }),
      );
      assertEquals(response.status, expectedStatus);
      assertEquals(await response.json(), { code: generatorCode });
      assertEquals(failures, [[INVITATION_ID, generatorCode]]);
    }
  },
);

Deno.test(
  "staff invitation retries an ambiguous idempotent preparation before delivery",
  async () => {
    const calls: string[] = [];
    let preparations = 0;
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        prepareInvitation: async () => {
          preparations += 1;
          calls.push(`prepare-${preparations}`);
          if (preparations === 1) {
            throw new Error("lost response after possible commit");
          }
          return "invitation_delivery_ready";
        },
        deliverInvitation: async () => {
          calls.push("deliver");
          return "delivered";
        },
        publishInvitation: async () => {
          calls.push("publish");
          return "invitation_usable";
        },
      }),
    );
    assertEquals(response.status, 201);
    assertEquals(calls, ["prepare-1", "prepare-2", "deliver", "publish"]);
  },
);

Deno.test(
  "staff invitation never delivers when preparation cannot be confirmed",
  async () => {
    let preparations = 0;
    let deliveries = 0;
    const failures: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        prepareInvitation: async () => {
          preparations += 1;
          return "dependency_unavailable";
        },
        deliverInvitation: async () => {
          deliveries += 1;
          return "delivered";
        },
        failInvitation: async (invitationId, reasonCode) => {
          failures.push([invitationId, reasonCode]);
          return "invitation_delivery_failed";
        },
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
    assertEquals(preparations, 2);
    assertEquals(deliveries, 0);
    assertEquals(failures, [[INVITATION_ID, "dependency_unavailable"]]);
  },
);

Deno.test(
  "staff invitation treats an explicit preparation failure as closed",
  async () => {
    let preparations = 0;
    let deliveries = 0;
    const failures: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        prepareInvitation: async () => {
          preparations += 1;
          return "conflict";
        },
        deliverInvitation: async () => {
          deliveries += 1;
          return "delivered";
        },
        failInvitation: async (invitationId, reasonCode) => {
          failures.push([invitationId, reasonCode]);
          return "invitation_delivery_failed";
        },
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
    assertEquals(preparations, 1);
    assertEquals(deliveries, 0);
    assertEquals(failures, [[INVITATION_ID, "dependency_unavailable"]]);
  },
);

Deno.test(
  "staff invitation leaves delivery-ready non-consumable after delivery failure",
  async () => {
    const calls: unknown[] = [];
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        prepareInvitation: async () => {
          calls.push("prepare");
          return "invitation_delivery_ready";
        },
        deliverInvitation: async () => {
          calls.push("deliver");
          return "dependency_unavailable";
        },
        failInvitation: async (invitationId, reasonCode) => {
          calls.push(["fail", invitationId, reasonCode]);
          return "invitation_delivery_failed";
        },
        publishInvitation: async () => {
          calls.push("publish");
          return "invitation_usable";
        },
      }),
    );
    assertEquals(response.status, 503);
    assertEquals(await response.json(), { code: "dependency_unavailable" });
    assertEquals(calls, [
      "prepare",
      "deliver",
      ["fail", INVITATION_ID, "dependency_unavailable"],
    ]);
  },
);

Deno.test(
  "SMTP sent-then-throw remains non-consumable even when failure recording fails",
  async () => {
    for (const failureOutcome of ["throws", "unexpected"] as const) {
      const events: unknown[] = [];
      let deliveries = 0;
      let publications = 0;
      const diagnosticSentinel = "smtp-provider-diagnostic-sentinel";
      const response = await handleRequest(
        invitationRequest(),
        dependencies({
          deliverInvitation: async () => {
            deliveries += 1;
            events.push("smtp-sent-then-threw");
            throw new Error(diagnosticSentinel);
          },
          failInvitation: async (invitationId, reasonCode) => {
            events.push(["fail", invitationId, reasonCode]);
            if (failureOutcome === "throws") {
              throw new Error("failure-rpc-diagnostic-sentinel");
            }
            return "unexpected_result";
          },
          prepareInvitation: async () => {
            events.push("ready");
            return "invitation_delivery_ready";
          },
          publishInvitation: async () => {
            publications += 1;
            events.push("publish");
            return "invitation_usable";
          },
        }),
      );
      const body = await response.text();
      assertEquals(response.status, 503);
      assertEquals(body, JSON.stringify({ code: "dependency_unavailable" }));
      assertEquals(deliveries, 1);
      assertEquals(publications, 0);
      assertEquals(events, [
        "ready",
        "smtp-sent-then-threw",
        ["fail", INVITATION_ID, "dependency_unavailable"],
      ]);
      assert(!body.includes(ACTION_TOKEN_SENTINEL), "Action token leaked");
      assert(!body.includes("teacher@example.com"), "Recipient email leaked");
      assert(!body.includes(diagnosticSentinel), "Provider error leaked");
    }
  },
);

Deno.test(
  "staff invitation reconciles an ambiguous idempotent publish without resending SMTP",
  async () => {
    const calls: string[] = [];
    let publications = 0;
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        deliverInvitation: async () => {
          calls.push("deliver");
          return "delivered";
        },
        prepareInvitation: async () => {
          calls.push("ready");
          return "invitation_delivery_ready";
        },
        publishInvitation: async () => {
          publications += 1;
          calls.push(`publish-${publications}`);
          if (publications === 1) {
            throw new Error("lost publish response after possible commit");
          }
          return "invitation_usable";
        },
      }),
    );
    assertEquals(response.status, 201);
    assertEquals(await response.json(), { code: "invitation_created" });
    assertEquals(calls, ["ready", "deliver", "publish-1", "publish-2"]);
  },
);

Deno.test(
  "staff invitation never resends SMTP when publish reconciliation stays ambiguous",
  async () => {
    let deliveries = 0;
    let failureWrites = 0;
    let publications = 0;
    const diagnosticSentinel = "publish-timeout-diagnostic-sentinel";
    const response = await handleRequest(
      invitationRequest(),
      dependencies({
        deliverInvitation: async () => {
          deliveries += 1;
          return "delivered";
        },
        failInvitation: async () => {
          failureWrites += 1;
          return "invitation_delivery_failed";
        },
        publishInvitation: async () => {
          publications += 1;
          if (publications === 1) {
            return "dependency_unavailable";
          }
          throw new Error(diagnosticSentinel);
        },
      }),
    );
    const body = await response.text();
    assertEquals(response.status, 503);
    assertEquals(body, JSON.stringify({ code: "dependency_unavailable" }));
    assertEquals(deliveries, 1);
    assertEquals(publications, 2);
    assertEquals(failureWrites, 0);
    assert(!body.includes(ACTION_TOKEN_SENTINEL), "Action token leaked");
    assert(!body.includes("teacher@example.com"), "Recipient email leaked");
    assert(!body.includes(diagnosticSentinel), "Publish error leaked");
  },
);

Deno.test(
  "staff invitation never leaks the generated action token",
  async () => {
    const response = await handleRequest(invitationRequest(), dependencies());
    const body = await response.text();
    assertEquals(response.status, 201);
    assertEquals(body, JSON.stringify({ code: "invitation_created" }));
    assert(!body.includes(ACTION_TOKEN_SENTINEL), "Action token leaked");
  },
);

Deno.test(
  "staff invitation fails closed on invalid configured lifetime or clock",
  async () => {
    for (const overrides of [
      { inviteLifetimeSeconds: 0 },
      { inviteLifetimeSeconds: 86_401 },
      { now: () => Number.MAX_SAFE_INTEGER },
    ]) {
      let deliveries = 0;
      const response = await handleRequest(
        invitationRequest(),
        dependencies({
          ...overrides,
          deliverInvitation: async () => {
            deliveries += 1;
            return "delivered";
          },
        }),
      );
      assertEquals(response.status, 503);
      assertEquals(deliveries, 0);
    }
  },
);

function runtimeConfiguration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
    DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: BACKEND_ORIGIN,
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: BACKEND_ORIGIN,
    DESMOSLOCK_STAFF_INVITATION_CALLBACK: CALLBACK,
    DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS: "3600",
    SUPABASE_ANON_KEY: "synthetic-publishable-sentinel",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-sentinel",
    SUPABASE_URL: BACKEND_ORIGIN,
    ...overrides,
  };
}

function generatedProviderResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action_link: ACTION_LINK,
    email: "teacher@example.com",
    email_confirmed_at: null,
    id: USER_ID,
    identities: [
      {
        identity_data: { email_verified: false },
        provider: "email",
      },
    ],
    invited_at: "2026-08-30T12:00:00.000Z",
    is_anonymous: false,
    ...overrides,
  };
}

Deno.test(
  "staff invitation runtime pins Auth Admin generation and callback origins",
  async () => {
    const serviceRoleSentinel = "synthetic-service-role-sentinel";
    const publishableSentinel = "synthetic-publishable-sentinel";
    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const deliveryMessages: unknown[] = [];
    const transport: StaffInvitationDeliveryTransport = {
      deliver: async (message) => {
        deliveryMessages.push(message);
        return "delivered";
      },
    };
    const service = createStaffInvitationDependencies(
      runtimeConfiguration({
        SUPABASE_ANON_KEY: publishableSentinel,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleSentinel,
      }),
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
        if (url.includes("/auth/v1/admin/generate_link")) {
          return Response.json(generatedProviderResponse());
        }
        if (url.includes("internal_prepare_staff_invitation")) {
          return Response.json([{ code: "invitation_delivery_ready" }]);
        }
        return Response.json([{ code: "invitation_usable" }]);
      },
      () => Date.UTC(2026, 7, 30, 12),
      transport,
    );

    const authorization = await service.authorizeInvitation(JWT, {
      email: "teacher@example.com",
      role: "teacher",
      workspaceId: WORKSPACE_ID,
    });
    const generated = await service.generateInviteLink("teacher@example.com");
    const prepared = await service.prepareInvitation(
      INVITATION_ID,
      USER_ID,
      "2026-08-30T13:00:00.000Z",
    );
    const published = await service.publishInvitation(INVITATION_ID);
    assertEquals(authorization, {
      code: "invitation_pending",
      invitationId: INVITATION_ID,
    });
    assertEquals(generated, {
      actionLink: ACTION_LINK,
      code: "link_generated",
      userId: USER_ID,
    });
    assertEquals(prepared, "invitation_delivery_ready");
    assertEquals(published, "invitation_usable");
    assertEquals(requests.length, 4);
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
    assertEquals(providerUrl.pathname, "/auth/v1/admin/generate_link");
    assertEquals(providerUrl.searchParams.get("redirect_to"), CALLBACK);
    assertEquals(JSON.parse(requests[1].body), {
      email: "teacher@example.com",
      type: "invite",
    });
    assertEquals(
      requests[1].headers.get("authorization"),
      `Bearer ${serviceRoleSentinel}`,
    );
    assertEquals(
      new URL(requests[2].url).pathname,
      "/rest/v1/rpc/internal_prepare_staff_invitation",
    );
    assertEquals(JSON.parse(requests[2].body), {
      expires_at: "2026-08-30T13:00:00.000Z",
      invitation_id: INVITATION_ID,
      invited_user_id: USER_ID,
    });
    assertEquals(
      requests[2].headers.get("authorization"),
      `Bearer ${serviceRoleSentinel}`,
    );
    assertEquals(
      new URL(requests[3].url).pathname,
      "/rest/v1/rpc/internal_publish_staff_invitation",
    );
    assertEquals(JSON.parse(requests[3].body), {
      invitation_id: INVITATION_ID,
    });
    assertEquals(
      requests[3].headers.get("authorization"),
      `Bearer ${serviceRoleSentinel}`,
    );

    await service.deliverInvitation({
      actionLink: ACTION_LINK,
      expiresAt: "2026-08-30T13:00:00.000Z",
      recipientEmail: "teacher@example.com",
    });
    assertEquals(deliveryMessages.length, 1);
  },
);

Deno.test(
  "staff invitation separates internal egress from the public action-link origin",
  async () => {
    const internalOrigin = "http://kong:8000";
    const publicActionLinkOrigin = "http://127.0.0.1:54321";
    const publicActionLink =
      `${publicActionLinkOrigin}/auth/v1/verify?token=${ACTION_TOKEN_SENTINEL}` +
      `&type=invite&redirect_to=${encodeURIComponent(CALLBACK)}`;
    const requests: string[] = [];
    const service = createStaffInvitationDependencies(
      runtimeConfiguration({
        DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: publicActionLinkOrigin,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: internalOrigin,
        SUPABASE_URL: internalOrigin,
      }),
      async (input) => {
        requests.push(String(input));
        return Response.json(
          generatedProviderResponse({ action_link: publicActionLink }),
        );
      },
    );

    assertEquals(await service.generateInviteLink("teacher@example.com"), {
      actionLink: publicActionLink,
      code: "link_generated",
      userId: USER_ID,
    });
    assertEquals(requests.length, 1);
    assertEquals(new URL(requests[0]).origin, internalOrigin);
    assert(
      !requests[0].includes(ACTION_TOKEN_SENTINEL),
      "Token entered egress URL",
    );
  },
);

Deno.test(
  "staff invitation rejects the internal origin when it is not the public action-link origin",
  async () => {
    const internalOrigin = "http://kong:8000";
    const publicActionLinkOrigin = "http://127.0.0.1:54321";
    const hostileLink =
      `${internalOrigin}/auth/v1/verify?token=${ACTION_TOKEN_SENTINEL}` +
      `&type=invite&redirect_to=${encodeURIComponent(CALLBACK)}`;
    const service = createStaffInvitationDependencies(
      runtimeConfiguration({
        DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: publicActionLinkOrigin,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: internalOrigin,
        SUPABASE_URL: internalOrigin,
      }),
      async () =>
        Response.json(generatedProviderResponse({ action_link: hostileLink })),
    );

    const result = await service.generateInviteLink("teacher@example.com");
    assertEquals(result, { code: "dependency_unavailable" });
    assert(
      !JSON.stringify(result).includes(ACTION_TOKEN_SENTINEL),
      "Rejected token leaked",
    );
  },
);

Deno.test(
  "staff invitation runtime rejects a provider-confirmed existing user",
  async () => {
    const service = createStaffInvitationDependencies(
      runtimeConfiguration(),
      async () =>
        Response.json(
          generatedProviderResponse({
            email_confirmed_at: "2026-08-30T11:00:00.000Z",
            identities: [
              {
                identity_data: { email_verified: true },
                provider: "email",
              },
            ],
          }),
        ),
    );
    assertEquals(await service.generateInviteLink("teacher@example.com"), {
      code: "conflict",
    });
  },
);

Deno.test(
  "staff invitation runtime sanitizes Auth Admin HTTP failures",
  async () => {
    const sentinel = "provider-diagnostic-sentinel";
    for (const [status, expectedCode] of [
      [400, "conflict"],
      [404, "conflict"],
      [409, "conflict"],
      [422, "conflict"],
      [429, "rate_limited"],
      [500, "dependency_unavailable"],
      [503, "dependency_unavailable"],
    ] as const) {
      const service = createStaffInvitationDependencies(
        runtimeConfiguration(),
        async () => Response.json({ diagnostic: sentinel }, { status }),
      );
      const result = await service.generateInviteLink("teacher@example.com");
      assertEquals(result, { code: expectedCode });
      assert(
        !JSON.stringify(result).includes(sentinel),
        "Provider diagnostic leaked",
      );
    }
  },
);

Deno.test(
  "staff invitation runtime rejects an off-origin generated action link",
  async () => {
    const service = createStaffInvitationDependencies(
      runtimeConfiguration(),
      async () =>
        Response.json(
          generatedProviderResponse({
            action_link:
              "https://attacker.invalid/auth/v1/verify?token=synthetic&type=invite" +
              `&redirect_to=${encodeURIComponent(CALLBACK)}`,
          }),
        ),
    );
    assertEquals(await service.generateInviteLink("teacher@example.com"), {
      code: "dependency_unavailable",
    });
  },
);

Deno.test(
  "staff invitation runtime fails closed without an approved delivery transport",
  async () => {
    const service = createStaffInvitationDependencies(runtimeConfiguration());
    assertEquals(
      await service.deliverInvitation({
        actionLink: ACTION_LINK,
        expiresAt: "2026-08-30T13:00:00.000Z",
        recipientEmail: "teacher@example.com",
      }),
      "dependency_unavailable",
    );
  },
);

Deno.test(
  "staff invitation runtime requires a bounded explicit lifetime",
  async () => {
    for (const value of [undefined, "", "0", "59", "86401", "3600.5"]) {
      await assertRejects(async () => {
        createStaffInvitationDependencies(
          runtimeConfiguration({
            DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS: value,
          }),
        );
      });
    }
  },
);

Deno.test(
  "staff invitation runtime requires an exact public Auth action-link origin",
  async () => {
    for (const origin of [
      undefined,
      "http://kong:8000",
      "https://attacker.invalid",
      `${BACKEND_ORIGIN}/path`,
      `${BACKEND_ORIGIN}?query=value`,
      `${BACKEND_ORIGIN}#fragment`,
    ]) {
      await assertRejects(async () => {
        createStaffInvitationDependencies(
          runtimeConfiguration({
            DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: origin,
          }),
        );
      });
    }
  },
);

Deno.test(
  "staff invitation runtime rejects mismatched callback configuration before egress",
  async () => {
    let requests = 0;
    await assertRejects(async () => {
      createStaffInvitationDependencies(
        runtimeConfiguration({
          DESMOSLOCK_STAFF_INVITATION_CALLBACK:
            "https://attacker.invalid/callback",
        }),
        async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
      );
    });
    assertEquals(requests, 0);
  },
);
