import { createClient, isAuthSessionMissingError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createSupabaseStaffAuthAdapter } from "../src/auth/supabase-staff-auth-adapter.js";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backendUrl = "https://logout-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-logout-sdk-session";
const accountIds = {
  A: "a1000000-0000-4000-8000-000000000001",
  B: "a1000000-0000-4000-8000-000000000002",
} as const;
type Account = keyof typeof accountIds;
type Scope = "local" | "all";
type RequestPhase = "account" | "application" | "provider";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function syntheticSession(account: Account) {
  const now = Math.floor(Date.now() / 1_000);
  const user = {
    app_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-01T00:00:00.000Z",
    email: `teacher-${account.toLowerCase()}@example.test`,
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    factors: [],
    id: accountIds[account],
    role: "authenticated",
    user_metadata: {},
  };
  // Deliberately unsigned synthetic data. Every SDK and direct-port request is
  // intercepted below, and no test has a network fallback.
  const accessToken = [
    { alg: "HS256", typ: "JWT" },
    {
      aal: "aal1",
      amr: [{ method: "password", timestamp: now }],
      aud: "authenticated",
      exp: now + 3_600,
      iat: now,
      role: "authenticated",
      session_id: `b1000000-0000-4000-8000-00000000000${account === "A" ? "1" : "2"}`,
      sub: user.id,
    },
    "synthetic-signature",
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    access_token: accessToken,
    expires_at: now + 3_600,
    expires_in: 3_600,
    refresh_token: `synthetic-refresh-${account}`,
    token_type: "bearer",
    user,
  };
}

async function harness() {
  const sessions = { A: syntheticSession("A"), B: syntheticSession("B") };
  const storage = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const requests: Array<{
    readonly account: Account | "unknown";
    readonly method: string;
    readonly path: string;
  }> = [];
  const ended = new Set<Account>();
  let hold:
    | {
        readonly phase: RequestPhase;
        readonly entered: ReturnType<typeof deferred>;
        readonly released: ReturnType<typeof deferred>;
      }
    | undefined;
  let failedPhase: RequestPhase | undefined;
  let networkUnavailable = false;

  const interceptedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const respond = (body: unknown, status = 200) => {
      // auth-js recognizes modern body.code values only with this version
      // header. In particular, session_not_found otherwise misses the SDK's
      // destructive _getUser cache-removal branch this suite guards against.
      const headers = url.pathname.startsWith("/auth/v1/")
        ? { "x-supabase-api-version": "2024-01-01" }
        : {};
      const response =
        status === 204
          ? new Response(null, { headers, status })
          : Response.json(body, { headers, status });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    };
    const authorization = request.headers.get("authorization");
    const account =
      authorization === `Bearer ${sessions.A.access_token}`
        ? "A"
        : authorization === `Bearer ${sessions.B.access_token}`
          ? "B"
          : "unknown";
    const path = `${url.pathname}${url.search}`;
    requests.push({ account, method: request.method, path });
    const phase: RequestPhase | undefined =
      url.pathname === "/auth/v1/user" && request.method === "GET"
        ? "account"
        : url.pathname === "/auth/v1/logout" && request.method === "POST"
          ? "provider"
          : /^\/rest\/v1\/rpc\/revoke_(?:all_current_user_staff_sessions|current_staff_session)$/u.test(
                url.pathname,
              ) && request.method === "POST"
            ? "application"
            : undefined;
    if (url.origin !== backendUrl || account === "unknown") {
      throw new Error("Unexpected synthetic SDK request authority");
    }
    if (phase !== undefined && hold?.phase === phase) {
      const captured = hold;
      hold = undefined;
      captured.entered.resolve();
      await captured.released.promise;
    }
    if (phase !== undefined && failedPhase === phase) {
      if (networkUnavailable)
        throw new TypeError("Synthetic network unavailable");
      return respond({ code: "unexpected_provider_failure" }, 503);
    }
    if (phase === "account") {
      return ended.has(account)
        ? respond(
            { code: "session_not_found", message: "Synthetic session ended" },
            403,
          )
        : respond(sessions[account].user);
    }
    if (phase === "application") {
      return respond([{ code: "ok" }]);
    }
    if (phase === "provider") {
      ended.add(account);
      return respond(null, 204);
    }
    if (
      url.pathname === "/rest/v1/rpc/current_staff_context" &&
      request.method === "POST"
    ) {
      return respond([
        {
          code: "ok",
          display_name: "Synthetic Teacher",
          membership_role: "teacher",
          profile_id: `21000000-0000-4000-8000-00000000000${account === "A" ? "1" : "2"}`,
          role_revision: 1,
          school_id: "11000000-0000-4000-8000-000000000001",
          school_name: "Synthetic School",
          school_settings_revision: 1,
          school_slug: "synthetic-school",
        },
      ]);
    }
    throw new Error("Unexpected synthetic SDK endpoint");
  };

  const client = createClient(backendUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => {
          storage.delete(key);
        },
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      storageKey,
    },
    global: { fetch: interceptedFetch },
  });
  // Settle SDK initialization before observing adapter state-change events.
  await client.auth.getSession();
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: interceptedFetch,
    origin: "https://app.example.test",
    publishableKey,
    url: backendUrl,
  });
  let sequence = 1;
  const operationId = () =>
    `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  const adapters: Array<ReturnType<typeof createSupabaseStaffAuthAdapter>> = [];
  function createAdapter() {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.now() },
      createBlobUrl: () => {
        throw new Error("Unexpected presentation creation");
      },
      operationIds: { next: operationId },
      port,
      revokeBlobUrl: () => undefined,
    });
    adapters.push(adapter);
    return adapter;
  }
  const adapter = createAdapter();
  const authority = await adapter.read();
  expect(authority.kind).toBe("access_granted");
  expect(
    authority.kind === "access_granted" &&
      authority.identity.accountId === accountIds.A,
  ).toBe(true);
  requests.length = 0;

  return {
    adapter,
    cached(account: Account) {
      return storage.get(storageKey) === JSON.stringify(sessions[account]);
    },
    createAdapter,
    dispose() {
      hold?.released.resolve();
      for (const instance of adapters) instance.dispose();
      port.clearPrivateAuthContinuations();
      client.auth.stopAutoRefresh();
    },
    ended,
    fail(phase: RequestPhase | undefined, networkFailure = false) {
      failedPhase = phase;
      networkUnavailable = networkFailure;
    },
    hold(phase: RequestPhase) {
      const gate = { entered: deferred(), phase, released: deferred() };
      hold = gate;
      return gate;
    },
    operationId,
    port,
    async readAccountThroughSdk() {
      const result = await client.auth.getUser();
      return { ended: isAuthSessionMissingError(result.error) };
    },
    replaceWith(account: Account) {
      // Models another tab replacing persistence while the first tab awaits
      // an external request; using setSession here would add an SDK lock.
      storage.set(storageKey, JSON.stringify(sessions[account]));
    },
    requests,
  };
}

function expectedMutations(scope: Scope) {
  return [
    {
      account: "A",
      method: "POST",
      path:
        scope === "all"
          ? "/rest/v1/rpc/revoke_all_current_user_staff_sessions"
          : "/rest/v1/rpc/revoke_current_staff_session",
    },
    {
      account: "A",
      method: "POST",
      path: `/auth/v1/logout?scope=${scope === "all" ? "global" : "local"}`,
    },
  ];
}

describe("normal logout with the installed Supabase SDK, real port and adapter", () => {
  it("control reproduces stale SDK account verification erasing replacement B", async () => {
    const fixture = await harness();
    const gate = fixture.hold("account");
    try {
      fixture.ended.add("A");
      const pending = fixture.readAccountThroughSdk();
      await gate.entered.promise;
      fixture.replaceWith("B");
      gate.released.resolve();
      expect(await pending).toEqual({ ended: true });
      expect(fixture.cached("B")).toBe(false);
      expect(fixture.cached("A")).toBe(false);
      expect(fixture.requests).toEqual([
        { account: "A", method: "GET", path: "/auth/v1/user" },
      ]);
    } finally {
      gate.released.resolve();
      fixture.dispose();
    }
  });

  it.each<Scope>(["local", "all"])(
    "binds both %s logout phases to A without erasing shared SDK storage",
    async (scope) => {
      const fixture = await harness();
      try {
        const result = await fixture.adapter.perform({
          operationId: fixture.operationId(),
          scope,
          type: "sign_out",
        });
        expect(result.result).toEqual({ kind: "sign_out_complete", scope });
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toEqual(expectedMutations(scope));
        expect(fixture.cached("A")).toBe(true);
        expect(fixture.ended.has("A")).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(
    (["local", "all"] as const).flatMap((scope) =>
      (["application", "provider"] as const).map((phase) => ({ phase, scope })),
    ),
  )(
    "preserves B when storage changes during $scope $phase logout",
    async ({ phase, scope }) => {
      const fixture = await harness();
      const gate = fixture.hold(phase);
      try {
        const pending = fixture.adapter.perform({
          operationId: fixture.operationId(),
          scope,
          type: "sign_out",
        });
        await gate.entered.promise;
        fixture.replaceWith("B");
        gate.released.resolve();
        expect((await pending).result).toEqual({
          kind: "sign_out_complete",
          scope,
        });
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toEqual(expectedMutations(scope));
        expect(fixture.cached("B")).toBe(true);
        expect(fixture.ended.has("B")).toBe(false);
      } finally {
        gate.released.resolve();
        fixture.dispose();
      }
    },
  );

  it("leaves replacement B intact when stale A account verification returns session_not_found", async () => {
    const fixture = await harness();
    const gate = fixture.hold("account");
    try {
      fixture.ended.add("A");
      const pending = fixture.port.readAccount();
      await gate.entered.promise;
      fixture.replaceWith("B");
      gate.released.resolve();
      expect(await pending).toEqual({ status: "signed_out" });
      expect(fixture.cached("B")).toBe(true);
      expect(fixture.requests).toEqual([
        { account: "A", method: "GET", path: "/auth/v1/user" },
      ]);
    } finally {
      gate.released.resolve();
      fixture.dispose();
    }
  });

  it("reloads retained A as signed out only after authoritative provider rejection", async () => {
    const fixture = await harness();
    try {
      await fixture.adapter.perform({
        operationId: fixture.operationId(),
        scope: "local",
        type: "sign_out",
      });
      expect(fixture.cached("A")).toBe(true);
      const reloaded = fixture.createAdapter();
      fixture.requests.length = 0;
      expect(await reloaded.read()).toEqual({ kind: "signed_out" });
      expect(fixture.cached("A")).toBe(true);
      // INITIAL_SESSION may invalidate the first read of the new adapter.
      expect(fixture.requests.length).toBeGreaterThanOrEqual(1);
      expect(fixture.requests.length).toBeLessThanOrEqual(2);
      expect(
        fixture.requests.every(
          (request) =>
            request.account === "A" &&
            request.method === "GET" &&
            request.path === "/auth/v1/user",
        ),
      ).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { failure: "HTTP 503", networkFailure: false },
    { failure: "network loss", networkFailure: true },
  ])(
    "keeps $failure distinct from a confirmed ended session on reload",
    async ({ networkFailure }) => {
      const fixture = await harness();
      try {
        fixture.fail("account", networkFailure);
        expect(await fixture.port.readAccount()).toBeNull();
        const reloaded = fixture.createAdapter();
        await expect(reloaded.read()).rejects.toThrow("unavailable");
        expect(fixture.cached("A")).toBe(true);
        expect(
          fixture.requests.every((request) => request.method === "GET"),
        ).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("resets to sign-in with no provider, application or factor network mutation", async () => {
    const fixture = await harness();
    try {
      fixture.replaceWith("B");
      const result = await fixture.adapter.perform({
        operationId: fixture.operationId(),
        type: "reset_to_sign_in",
      });
      expect(result.result).toEqual({ kind: "reset_to_sign_in_complete" });
      expect(fixture.requests).toEqual([]);
      expect(fixture.cached("B")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it.each<RequestPhase>(["application", "provider"])(
    "cannot recapture B when retrying an operation after unknown %s failure",
    async (phase) => {
      const fixture = await harness();
      try {
        const request = {
          operationId: fixture.operationId(),
          scope: "all" as const,
          type: "sign_out" as const,
        };
        fixture.fail(phase);
        await expect(fixture.adapter.perform(request)).rejects.toThrow(
          "unavailable",
        );
        fixture.replaceWith("B");
        fixture.fail(undefined);
        // Even an explicit fresh authority read must not make the old command
        // eligible to act as B after its original outcome became unknown.
        expect((await fixture.adapter.read()).kind).toBe("access_granted");
        fixture.requests.length = 0;
        await expect(fixture.adapter.perform(request)).rejects.toThrow(
          "re-entry",
        );
        expect(fixture.requests).toEqual([]);
        expect(fixture.cached("B")).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );
});
