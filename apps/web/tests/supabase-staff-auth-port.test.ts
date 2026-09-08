import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { prepareStaffRecoveryCallback } from "../src/auth/staff-auth-callback.js";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backendUrl = "https://backend.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const schoolId = "11000000-0000-4000-8000-000000000001";
const profileId = "21000000-0000-4000-8000-000000000001";
const invitationId = "41000000-0000-4000-8000-000000000001";
const accountId = "a1000000-0000-4000-8000-000000000001";
const recoveryTokenUrl = `${backendUrl}/auth/v1/token?grant_type=pkce`;

function recoveryResponse(
  body: BodyInit | null,
  init: ResponseInit,
  options: { readonly redirected?: boolean; readonly url?: string } = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", {
    configurable: false,
    enumerable: true,
    value: options.url ?? recoveryTokenUrl,
  });
  if (options.redirected !== undefined) {
    Object.defineProperty(response, "redirected", {
      configurable: false,
      enumerable: true,
      value: options.redirected,
    });
  }
  return response;
}

function authError(code: string): object {
  const error = { code };
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("provider message must not be inspected");
    },
  });
  return error;
}

function externalFailure(): { readonly data: null; readonly error: object } {
  return { data: null, error: { code: "unexpected_provider_failure" } };
}

function fakeClient(
  overrides: {
    readonly auth?: Partial<Omit<SupabaseStaffAuthClient["auth"], "mfa">> & {
      readonly mfa?: Partial<SupabaseStaffAuthClient["auth"]["mfa"]>;
    };
    readonly functions?: Partial<SupabaseStaffAuthClient["functions"]>;
    readonly schema?: SupabaseStaffAuthClient["schema"];
  } = {},
): SupabaseStaffAuthClient {
  const unsubscribe = vi.fn();
  const { mfa: mfaOverrides, ...authOverrides } = overrides.auth ?? {};
  const mfa: SupabaseStaffAuthClient["auth"]["mfa"] = {
    challenge: async () => externalFailure(),
    enroll: async () => externalFailure(),
    getAuthenticatorAssuranceLevel: async () => externalFailure(),
    listFactors: async () => externalFailure(),
    unenroll: async () => externalFailure(),
    verify: async () => externalFailure(),
    ...mfaOverrides,
  };
  const auth: SupabaseStaffAuthClient["auth"] = {
    exchangeCodeForSession: async () => externalFailure(),
    getSession: async () => externalFailure(),
    getUser: async () => externalFailure(),
    mfa,
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }),
    resend: async () => externalFailure(),
    setSession: async () => externalFailure(),
    signInWithPassword: async () => externalFailure(),
    signOut: async () => ({ error: { code: "unexpected_provider_failure" } }),
    updateUser: async () => externalFailure(),
    verifyOtp: async () => externalFailure(),
    ...authOverrides,
  };
  return {
    auth,
    functions: {
      invoke: async () => externalFailure(),
      ...overrides.functions,
    },
    schema:
      overrides.schema ??
      (() => ({
        rpc: async () => externalFailure(),
      })),
  };
}

function createPort(
  client: SupabaseStaffAuthClient,
  recoveryFetch: typeof fetch = async () => new Response(null, { status: 503 }),
) {
  return createSupabaseStaffAuthPort({
    client,
    fetch: recoveryFetch,
    origin: "https://app.example.test",
    publishableKey,
    url: backendUrl,
  });
}

async function captureSignOutHandle(port: ReturnType<typeof createPort>) {
  const authority = await port.captureSignOutAuthority(accountId);
  expect(authority).toEqual({
    authorityHandle: expect.any(String),
    status: "ready",
  });
  if (
    typeof authority !== "object" ||
    authority === null ||
    !("authorityHandle" in authority) ||
    typeof authority.authorityHandle !== "string"
  ) {
    throw new Error("Missing captured authority");
  }
  return authority.authorityHandle;
}

async function captureManagementHandle(port: ReturnType<typeof createPort>) {
  const authority = await port.captureStaffManagementAuthority(accountId);
  expect(authority).toEqual({
    authorityHandle: expect.any(String),
    status: "ready",
  });
  if (
    typeof authority !== "object" ||
    authority === null ||
    !("authorityHandle" in authority) ||
    typeof authority.authorityHandle !== "string"
  ) {
    throw new Error("Missing captured management authority");
  }
  return authority.authorityHandle;
}

const invitationRequest = {
  email: "teacher@example.test",
  role: "teacher" as const,
  schoolId,
};
const membershipRequest = { expectedRoleRevision: 7, profileId, schoolId };

function accountSession() {
  return {
    data: {
      session: {
        access_token: "synthetic-account-a-token",
        user: { id: accountId },
      },
    },
    error: null,
  };
}

const authorityReadCases = [
  {
    method: "readCurrentContext",
    data: [{ code: "ok" }],
    expected: [{ code: "ok" }],
    failed: null,
  },
  {
    method: "readCurrentInvitations",
    data: [{ code: "ok" }],
    expected: [{ code: "ok" }],
    failed: null,
  },
  {
    method: "readManageableStaff",
    data: [{ code: "ok" }],
    expected: [{ code: "ok" }],
    failed: null,
  },
  {
    method: "readManageableInvitations",
    data: [{ code: "ok" }],
    expected: [{ code: "ok" }],
    failed: null,
  },
  {
    method: "readSession",
    data: accountSession().data,
    expected: { status: "authenticated" },
    failed: { status: "unavailable" },
  },
  {
    method: "readAssurance",
    data: {
      currentAuthenticationMethods: ["password", "totp"],
      currentLevel: "aal2",
      nextLevel: "aal2",
    },
    expected: {
      currentAuthenticationMethods: ["password", "totp"],
      currentLevel: "aal2",
      nextLevel: "aal2",
    },
    failed: null,
  },
  {
    method: "readTotpFactors",
    data: { all: [] },
    expected: { factors: [] },
    failed: null,
  },
] as const;

function authorityReadClient(
  read: () => PromiseLike<{ readonly data: unknown; readonly error: unknown }>,
) {
  return fakeClient({
    auth: {
      getSession: read,
      mfa: { getAuthenticatorAssuranceLevel: read, listFactors: read },
    },
    schema: () => ({ rpc: read }),
  });
}

describe("Supabase staff auth port", () => {
  it.each(authorityReadCases)(
    "bounds a stalled $method, ignores its late result and permits a fresh read",
    async ({ method, data, expected, failed }) => {
      vi.useFakeTimers();
      try {
        let complete:
          | ((value: {
              readonly data: unknown;
              readonly error: unknown;
            }) => void)
          | undefined;
        const read = vi
          .fn<
            () => Promise<{ readonly data: unknown; readonly error: unknown }>
          >()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                complete = resolve;
              }),
          )
          .mockResolvedValue({ data, error: null });
        const providerFetch = vi.fn<typeof fetch>();
        const port = createPort(authorityReadClient(read), providerFetch);
        const published = vi.fn();
        const pending = port[method]().then(published);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(published).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(published).toHaveBeenCalledExactlyOnceWith(failed);
        expect(vi.getTimerCount()).toBe(0);
        complete?.({ data, error: null });
        await vi.advanceTimersByTimeAsync(0);
        expect(published).toHaveBeenCalledExactlyOnceWith(failed);
        expect(read).toHaveBeenCalledOnce();
        await expect(port[method]()).resolves.toEqual(expected);
        expect(read).toHaveBeenCalledTimes(2);
        expect(providerFetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(authorityReadCases)(
    "contains early and late $method rejection without retaining a timer or retrying",
    async ({ method, failed }) => {
      vi.useFakeTimers();
      try {
        let rejectRead: ((reason?: unknown) => void) | undefined;
        const read = vi
          .fn<
            () => Promise<{ readonly data: unknown; readonly error: unknown }>
          >()
          .mockRejectedValueOnce(new Error("synthetic early read failure"))
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectRead = reject;
              }),
          );
        const providerFetch = vi.fn<typeof fetch>();
        const port = createPort(authorityReadClient(read), providerFetch);
        await expect(port[method]()).resolves.toEqual(failed);
        expect(vi.getTimerCount()).toBe(0);
        const pending = port[method]();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toEqual(failed);
        rejectRead?.(new Error("synthetic late read failure"));
        await vi.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toEqual(failed);
        expect(read).toHaveBeenCalledTimes(2);
        expect(providerFetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["readCurrentContext", "current_staff_context"],
    ["readCurrentInvitations", "current_staff_invitations"],
    ["readManageableStaff", "current_manageable_staff"],
    ["readManageableInvitations", "current_manageable_staff_invitations"],
  ] as const)(
    "cancels a stalled %s PostgREST request when the builder provides abortSignal",
    async (method, name) => {
      vi.useFakeTimers();
      try {
        const response = new Promise<{
          readonly data: unknown;
          readonly error: unknown;
        }>(() => undefined);
        const abortSignal = vi.fn((signal: AbortSignal) => {
          expect(signal.aborted).toBe(false);
          return response;
        });
        const request = Object.assign(response, { abortSignal });
        const rpc = vi.fn(() => request);
        const port = createPort(fakeClient({ schema: () => ({ rpc }) }));
        const pending = port[method]();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(rpc).toHaveBeenCalledExactlyOnceWith(name);
        expect(abortSignal).toHaveBeenCalledOnce();
        expect(abortSignal.mock.calls[0]?.[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBeNull();
        expect(abortSignal.mock.calls[0]?.[0].aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uses only the desmoslock_v2 schema for authority reads", async () => {
    const rpc = vi.fn(
      async (name: string, args?: Readonly<Record<string, unknown>>) => ({
        data: [{ args: args ?? null, name }],
        error: null,
      }),
    );
    const schema = vi.fn(() => ({ rpc }));
    const port = createPort(fakeClient({ schema }));

    await expect(port.readCurrentContext()).resolves.toEqual([
      { args: null, name: "current_staff_context" },
    ]);
    await port.readCurrentInvitations();
    await port.readManageableStaff();
    await port.readManageableInvitations();

    expect(schema).toHaveBeenCalledTimes(1);
    expect(schema).toHaveBeenCalledWith("desmoslock_v2");
    expect(rpc.mock.calls).toEqual([
      ["current_staff_context"],
      ["current_staff_invitations"],
      ["current_manageable_staff"],
      ["current_manageable_staff_invitations"],
    ]);
  });

  it("invokes the recovery Edge function and returns only parsed product responses", async () => {
    const recoveryRequest = {
      codeChallenge: "c".repeat(43),
      email: "teacher@example.test",
      flowId: "flow-1",
      state: "state-1",
    };
    const invoke = vi.fn(async () => ({
      data: { code: "recovery_requested", ok: true },
      error: null,
    }));
    const port = createPort(fakeClient({ functions: { invoke } }));

    await expect(port.invokeRecovery(recoveryRequest)).resolves.toEqual({
      code: "recovery_requested",
      ok: true,
    });
    expect(invoke.mock.calls).toEqual([
      ["account-recovery", { body: recoveryRequest }],
    ]);
  });

  it("recovers only sanitized non-2xx Edge envelopes and rejects malformed bodies", async () => {
    const invoke = vi
      .fn<SupabaseStaffAuthClient["functions"]["invoke"]>()
      .mockResolvedValueOnce({
        data: null,
        error: { context: "not exposed" },
        response: new Response(
          JSON.stringify({ code: "rate_limited", ok: false }),
          {
            headers: { "content-type": "application/json" },
            status: 429,
          },
        ),
      })
      .mockResolvedValueOnce({
        data: null,
        error: { context: "not exposed" },
        response: new Response(
          JSON.stringify({
            code: "recovery_requested",
            ok: true,
            providerDebug: "must not escape",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        ),
      });
    const port = createPort(fakeClient({ functions: { invoke } }));

    await expect(
      port.invokeRecovery({
        codeChallenge: "c".repeat(43),
        email: "teacher@example.test",
        flowId: "flow-1",
        state: "state-1",
      }),
    ).resolves.toEqual({ code: "rate_limited", ok: false });
    await expect(
      port.invokeRecovery({
        codeChallenge: "c".repeat(43),
        email: "teacher@example.test",
        flowId: "flow-1",
        state: "state-1",
      }),
    ).resolves.toEqual({ code: "service_unavailable", ok: false });
  });

  it("binds every management write to the captured account across a real SDK storage replacement", async () => {
    const storageKey = "synthetic-management-port-session";
    const session = (id: string, accessToken: string) => ({
      access_token: accessToken,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      expires_in: 3_600,
      refresh_token: `synthetic-refresh-${id}`,
      token_type: "bearer",
      user: { id },
    });
    const first = session(accountId, "synthetic-management-a-token");
    const replacement = session("account-b", "synthetic-management-b-token");
    const storage = new Map([[storageKey, JSON.stringify(first)]]);
    let finishVerification: (() => void) | undefined;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const isVerification = url === `${backendUrl}/auth/v1/user`;
      if (isVerification) {
        await new Promise<void>((resolve) => {
          finishVerification = resolve;
        });
      }
      return recoveryResponse(
        JSON.stringify(
          isVerification
            ? { id: accountId }
            : url.includes("/functions/")
              ? { code: "invitation_created", ok: true }
              : [{ code: "ok" }],
        ),
        { headers: { "content-type": "application/json" }, status: 200 },
        { url },
      );
    });
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
      global: { fetch: providerFetch },
    });
    await client.auth.getSession();
    const getSession = vi.spyOn(client.auth, "getSession");
    const getUser = vi.spyOn(client.auth, "getUser");
    const invoke = vi.spyOn(client.functions, "invoke");
    const sdkRpc = vi.spyOn(client, "rpc");
    const port = createPort(
      client as unknown as SupabaseStaffAuthClient,
      providerFetch,
    );
    const capture = captureManagementHandle(port);
    await vi.waitFor(() => expect(finishVerification).toBeTypeOf("function"));
    storage.set(storageKey, JSON.stringify(replacement));
    finishVerification?.();
    const handle = await capture;
    try {
      await expect(
        port.invokeInvitation(invitationRequest, handle),
      ).resolves.toEqual({
        code: "invitation_created",
        ok: true,
      });
      await expect(
        port.revokeInvitation({ invitationId }, handle),
      ).resolves.toEqual([{ code: "ok" }]);
      await expect(
        port.revokeMembership(membershipRequest, handle),
      ).resolves.toEqual([{ code: "ok" }]);
      for (const role of ["administrator", "teacher"] as const) {
        await expect(
          port.changeMembershipRole({ ...membershipRequest, role }, handle),
        ).resolves.toEqual([{ code: "ok" }]);
      }
      expect(
        providerFetch.mock.calls.map(([input, init]) => [
          String(input),
          init?.body === undefined
            ? null
            : (JSON.parse(String(init.body)) as unknown),
        ]),
      ).toEqual([
        [`${backendUrl}/auth/v1/user`, null],
        [`${backendUrl}/functions/v1/staff-invitations`, invitationRequest],
        [
          `${backendUrl}/rest/v1/rpc/revoke_staff_invitation`,
          { invitation_id: invitationId },
        ],
        [
          `${backendUrl}/rest/v1/rpc/revoke_membership`,
          {
            expected_role_revision: 7,
            profile_id: profileId,
            workspace_id: schoolId,
          },
        ],
        [
          `${backendUrl}/rest/v1/rpc/change_membership_role`,
          {
            expected_role_revision: 7,
            profile_id: profileId,
            role: "admin",
            workspace_id: schoolId,
          },
        ],
        [
          `${backendUrl}/rest/v1/rpc/change_membership_role`,
          {
            expected_role_revision: 7,
            profile_id: profileId,
            role: "teacher",
            workspace_id: schoolId,
          },
        ],
      ]);
      for (const [input, init] of providerFetch.mock.calls) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${first.access_token}`,
        );
        expect(new Headers(init?.headers).get("apikey")).toBe(publishableKey);
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("error");
        expect(init?.referrerPolicy).toBe("no-referrer");
        if (String(input).includes("/rest/")) {
          expect(new Headers(init?.headers).get("content-profile")).toBe(
            "desmoslock_v2",
          );
        } else if (String(input).includes("/functions/")) {
          expect([...new Headers(init?.headers).keys()].sort()).toEqual([
            "apikey",
            "authorization",
            "content-type",
            "x-client-info",
          ]);
        }
      }
      expect(getSession).toHaveBeenCalledOnce();
      expect(getUser).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(sdkRpc).not.toHaveBeenCalled();
      expect(storage.get(storageKey)).toBe(JSON.stringify(replacement));
    } finally {
      port.releaseStaffManagementAuthority(handle);
    }
  });

  it.each([
    "missing",
    "released",
    "expired",
    "cleared",
    "password",
    "logout",
  ] as const)(
    "rejects %s management authority without any SDK or direct mutation fallback",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const rpc = vi.fn(async () => externalFailure());
        const invoke = vi.fn(async () => externalFailure());
        const getSession = vi.fn(async () => accountSession());
        const providerFetch = vi.fn<typeof fetch>(async (input) =>
          recoveryResponse(
            JSON.stringify({ id: accountId }),
            { headers: { "content-type": "application/json" }, status: 200 },
            { url: String(input) },
          ),
        );
        const port = createPort(
          fakeClient({
            auth: { getSession },
            functions: { invoke },
            schema: () => ({ rpc }),
          }),
          providerFetch,
        );
        const handle =
          kind === "password"
            ? await port.capturePasswordAuthority(accountId)
            : kind === "logout"
              ? await captureSignOutHandle(port)
              : await captureManagementHandle(port);
        if (handle === null) throw new Error("Missing fixture authority");
        if (kind === "released") port.releaseStaffManagementAuthority(handle);
        if (kind === "cleared") port.clearPrivateAuthContinuations();
        if (kind === "expired") await vi.advanceTimersByTimeAsync(60_000);
        const args = kind === "missing" ? [] : [handle];
        await expect(
          Reflect.apply(port.invokeInvitation, port, [
            invitationRequest,
            ...args,
          ]),
        ).resolves.toEqual({ code: "service_unavailable", ok: false });
        await expect(
          Reflect.apply(port.revokeInvitation, port, [
            { invitationId },
            ...args,
          ]),
        ).resolves.toBeNull();
        await expect(
          Reflect.apply(port.revokeMembership, port, [
            membershipRequest,
            ...args,
          ]),
        ).resolves.toBeNull();
        await expect(
          Reflect.apply(port.changeMembershipRole, port, [
            { ...membershipRequest, role: "teacher" },
            ...args,
          ]),
        ).resolves.toBeNull();
        expect(getSession).toHaveBeenCalledOnce();
        expect(providerFetch).toHaveBeenCalledOnce();
        expect(rpc).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        port.clearPrivateAuthContinuations();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("prevents a management handle from authorizing password, recovery, invitation acceptance or logout", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input) =>
      recoveryResponse(
        JSON.stringify({ id: accountId }),
        { headers: { "content-type": "application/json" }, status: 200 },
        { url: String(input) },
      ),
    );
    const port = createPort(
      fakeClient({ auth: { getSession: async () => accountSession() } }),
      providerFetch,
    );
    const handle = await captureManagementHandle(port);
    try {
      await expect(
        port.acceptInvitation({ displayName: "Teacher", invitationId }, handle),
      ).resolves.toBeNull();
      await expect(
        port.beginPasswordRecovery("operation-1", handle),
      ).resolves.toBeNull();
      await expect(
        port.finishPasswordRecovery("operation-1", handle),
      ).resolves.toBeNull();
      await expect(
        port.updatePassword("synthetic-password", handle),
      ).resolves.toEqual({ status: "unavailable" });
      await expect(port.signOut("all", handle)).resolves.toEqual({
        status: "unavailable",
      });
      await expect(port.revokeAllStaffSessions(handle)).resolves.toBeNull();
      await expect(port.revokeCurrentStaffSession(handle)).resolves.toBeNull();
      expect(providerFetch).toHaveBeenCalledOnce();
    } finally {
      port.releaseStaffManagementAuthority(handle);
    }
  });

  it.each([
    [
      200,
      { code: "invitation_created", ok: true },
      { code: "invitation_created", ok: true },
    ],
    [
      429,
      { code: "rate_limited", ok: false },
      { code: "rate_limited", ok: false },
    ],
    [
      403,
      { code: "authorization_denied", ok: false },
      { code: "authorization_denied", ok: false },
    ],
    [
      503,
      { code: "invitation_created", ok: true },
      { code: "service_unavailable", ok: false },
    ],
    [
      200,
      { code: "invitation_created", ok: true, debug: "private" },
      { code: "service_unavailable", ok: false },
    ],
    [
      500,
      { code: "unexpected_provider_failure", message: "private" },
      { code: "service_unavailable", ok: false },
    ],
  ] as const)(
    "parses only exact captured-authority invitation envelopes for HTTP %s",
    async (status, body, expected) => {
      const providerFetch = vi.fn<typeof fetch>(async (input) => {
        const verification = String(input).endsWith("/user");
        return recoveryResponse(
          JSON.stringify(verification ? { id: accountId } : body),
          {
            headers: { "content-type": "application/json" },
            status: verification ? 200 : status,
          },
          { url: String(input) },
        );
      });
      const port = createPort(
        fakeClient({ auth: { getSession: async () => accountSession() } }),
        providerFetch,
      );
      const handle = await captureManagementHandle(port);
      try {
        await expect(
          port.invokeInvitation(invitationRequest, handle),
        ).resolves.toEqual(expected);
        expect(providerFetch).toHaveBeenCalledTimes(2);
      } finally {
        port.releaseStaffManagementAuthority(handle);
      }
    },
  );

  it.each([
    ["snapshot mismatch", "account-b", 200, { id: accountId }, "rejected"],
    ["provider mismatch", accountId, 200, { id: "account-b" }, "rejected"],
    [
      "ended session",
      accountId,
      403,
      { code: "session_not_found", message: "synthetic" },
      "ended",
    ],
    [
      "expired session",
      accountId,
      401,
      { code: "session_expired", message: "synthetic" },
      "ended",
    ],
    [
      "unverified authority",
      accountId,
      503,
      { code: "session_expired" },
      "unavailable",
    ],
    ["malformed account", accountId, 200, {}, "unavailable"],
  ] as const)(
    "returns a bounded management capture result for %s",
    async (_label, expectedAccountId, status, body, expectedStatus) => {
      const providerFetch = vi.fn<typeof fetch>(async (input) =>
        recoveryResponse(
          JSON.stringify(body),
          { headers: { "content-type": "application/json" }, status },
          { url: String(input) },
        ),
      );
      const getUser = vi.fn(async () => externalFailure());
      const port = createPort(
        fakeClient({
          auth: { getSession: async () => accountSession(), getUser },
        }),
        providerFetch,
      );
      await expect(
        port.captureStaffManagementAuthority(expectedAccountId),
      ).resolves.toEqual({ status: expectedStatus });
      expect(providerFetch).toHaveBeenCalledTimes(
        expectedAccountId === accountId ? 1 : 0,
      );
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it("invalidates a pending management capture when private continuations are cleared", async () => {
    let finishVerification: (() => void) | undefined;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      await new Promise<void>((resolve) => {
        finishVerification = resolve;
      });
      return recoveryResponse(
        JSON.stringify({ id: accountId }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
        { url: String(input) },
      );
    });
    const port = createPort(
      fakeClient({ auth: { getSession: async () => accountSession() } }),
      providerFetch,
    );
    const capture = port.captureStaffManagementAuthority(accountId);
    await vi.waitFor(() => expect(finishVerification).toBeTypeOf("function"));
    port.clearPrivateAuthContinuations();
    finishVerification?.();
    await expect(capture).resolves.toEqual({ status: "unavailable" });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each(["invitation", "role change"] as const)(
    "bounds a stalled management %s without mutation retry",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const providerFetch = vi.fn<typeof fetch>(async (input) => {
          if (!String(input).endsWith("/user"))
            return new Promise<Response>(() => undefined);
          return recoveryResponse(
            JSON.stringify({ id: accountId }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
            { url: String(input) },
          );
        });
        const port = createPort(
          fakeClient({ auth: { getSession: async () => accountSession() } }),
          providerFetch,
        );
        const handle = await captureManagementHandle(port);
        const operation =
          kind === "invitation"
            ? port.invokeInvitation(invitationRequest, handle)
            : port.changeMembershipRole(
                { ...membershipRequest, role: "teacher" },
                handle,
              );
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(operation).resolves.toEqual(
          kind === "invitation"
            ? { code: "service_unavailable", ok: false }
            : null,
        );
        expect(providerFetch).toHaveBeenCalledTimes(2);
        expect(providerFetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
        port.releaseStaffManagementAuthority(handle);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("normalizes session and trusted account reads without returning SDK objects", async () => {
    const sdkSession = {
      access_token: "synthetic-session-token",
      user: { id: accountId },
    };
    const sdkUser = {
      email: "teacher@example.test",
      email_confirmed_at: "2026-09-03T12:00:00Z",
      id: accountId,
      privateMetadata: "must not escape",
    };
    const getSession = vi.fn(async () => ({
      data: { session: sdkSession },
      error: null,
    }));
    const getUser = vi.fn(async () => ({
      data: { user: sdkUser },
      error: null,
    }));
    const providerFetch = vi.fn<typeof fetch>(async () =>
      recoveryResponse(
        JSON.stringify(sdkUser),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
        { url: `${backendUrl}/auth/v1/user` },
      ),
    );
    const port = createPort(
      fakeClient({ auth: { getSession, getUser } }),
      providerFetch,
    );

    await expect(port.readSession()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(port.readAccount()).resolves.toEqual({
      accountId,
      email: "teacher@example.test",
      emailVerified: true,
    });
    expect(getSession).toHaveBeenCalledWith();
    expect(getUser).not.toHaveBeenCalled();
    expect(
      new Headers(providerFetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer synthetic-session-token");
  });

  it("maps absent and expired sessions to signed out and unknown failures to unavailable", async () => {
    const getSession = vi
      .fn<SupabaseStaffAuthClient["auth"]["getSession"]>()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: { session: null },
        error: authError("session_expired"),
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { getSession } }));

    await expect(port.readSession()).resolves.toEqual({
      status: "signed_out",
    });
    await expect(port.readSession()).resolves.toEqual({
      status: "signed_out",
    });
    await expect(port.readSession()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps sign-in errors only by stable auth code and sends exact credentials", async () => {
    const signInWithPassword = vi
      .fn<SupabaseStaffAuthClient["auth"]["signInWithPassword"]>()
      .mockResolvedValueOnce({
        data: { session: {}, user: {} },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("email_not_confirmed"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("invalid_credentials"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { signInWithPassword } }));
    const credentials = {
      email: "teacher@example.test",
      password: "synthetic password only",
    };

    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "authenticated",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "email_verification_required",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "unavailable",
    });
    expect(signInWithPassword).toHaveBeenCalledTimes(4);
    expect(signInWithPassword).toHaveBeenNthCalledWith(1, credentials);
  });

  it("maps resend and invitation verification to exact SDK calls and sanitized statuses", async () => {
    const resend = vi.fn(async () => ({ data: {}, error: null }));
    const verifyOtp = vi
      .fn<SupabaseStaffAuthClient["auth"]["verifyOtp"]>()
      .mockResolvedValueOnce({
        data: {
          session: { access_token: "synthetic-session-token" },
          user: { email: "teacher@example.test", id: accountId },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("otp_expired"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("invite_not_found"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { resend, verifyOtp } }));
    const tokenHash = "a".repeat(56);

    await expect(
      port.resendEmailVerification("teacher@example.test"),
    ).resolves.toEqual({ status: "sent" });
    expect(resend).toHaveBeenCalledWith({
      email: "teacher@example.test",
      options: {
        emailRedirectTo: "https://app.example.test/?auth=email-verification",
      },
      type: "signup",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      accountId,
      email: "teacher@example.test",
      status: "verified",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "expired",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "invalid",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "unavailable",
    });
    expect(verifyOtp).toHaveBeenNthCalledWith(1, {
      token_hash: tokenHash,
      type: "invite",
    });
  });

  it("exchanges email verification through the exact SDK-owned PKCE flow slot", async () => {
    const authorizationCode = "synthetic-email-verification-code";
    const flowId = "0123456789abcdef0123456789abcdef";
    const exchangeCodeForSession = vi
      .fn<SupabaseStaffAuthClient["auth"]["exchangeCodeForSession"]>()
      .mockResolvedValueOnce({
        data: { redirectType: null, session: {}, user: { id: accountId } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("flow_state_already_used"),
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("pkce_code_verifier_not_found"),
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("unexpected_failure"),
      });
    const port = createPort(fakeClient({ auth: { exchangeCodeForSession } }));

    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "rejected" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "rejected" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(exchangeCodeForSession).toHaveBeenNthCalledWith(
      1,
      authorizationCode,
      { flowId },
    );
  });

  it.each(["local", "all"] as const)(
    "binds %s database revocation and logout to the account captured before an SDK switch",
    async (scope) => {
      const firstSession = {
        access_token: "synthetic-account-a-token",
        user: { id: accountId },
      };
      const nextSession = {
        access_token: "synthetic-account-b-token",
        user: { id: "account-b" },
      };
      let currentSession = firstSession;
      const getSession = vi.fn(async () => ({
        data: { session: currentSession },
        error: null,
      }));
      const getUser = vi.fn(async () => externalFailure());
      const signOut = vi.fn(async () => ({ error: null }));
      const setSession = vi.fn(async () => externalFailure());
      const rpc = vi.fn(async () => externalFailure());
      let releaseVerification: ((response: Response) => void) | undefined;
      const providerFetch = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/auth/v1/user")) {
          return new Promise<Response>((resolve) => {
            releaseVerification = resolve;
          });
        }
        return recoveryResponse(
          url.includes("/rest/v1/")
            ? JSON.stringify({ code: "session_revoked", ok: true })
            : null,
          url.includes("/rest/v1/")
            ? { headers: { "content-type": "application/json" }, status: 200 }
            : { status: 204 },
          { url },
        );
      });
      const port = createPort(
        fakeClient({
          auth: { getSession, getUser, signOut, setSession },
          schema: () => ({ rpc }),
        }),
        providerFetch,
      );
      const capture = port.captureSignOutAuthority(accountId);
      await vi.waitFor(() =>
        expect(releaseVerification).toBeTypeOf("function"),
      );
      currentSession = nextSession;
      releaseVerification?.(
        recoveryResponse(
          JSON.stringify({ id: accountId }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
          { url: `${backendUrl}/auth/v1/user` },
        ),
      );
      const authority = await capture;
      expect(authority).toEqual({
        authorityHandle: expect.any(String),
        status: "ready",
      });
      if (
        typeof authority !== "object" ||
        authority === null ||
        !("authorityHandle" in authority) ||
        typeof authority.authorityHandle !== "string"
      )
        throw new Error("Missing captured authority");
      try {
        await expect(
          scope === "all"
            ? port.revokeAllStaffSessions(authority.authorityHandle)
            : port.revokeCurrentStaffSession(authority.authorityHandle),
        ).resolves.toEqual({ code: "session_revoked", ok: true });
        await expect(
          port.signOut(scope, authority.authorityHandle),
        ).resolves.toEqual({ status: "signed_out" });
        expect(
          providerFetch.mock.calls.map(([input]) => String(input)),
        ).toEqual([
          `${backendUrl}/auth/v1/user`,
          `${backendUrl}/rest/v1/rpc/${scope === "all" ? "revoke_all_current_user_staff_sessions" : "revoke_current_staff_session"}`,
          `${backendUrl}/auth/v1/logout?scope=${scope === "all" ? "global" : "local"}`,
        ]);
        for (const [, init] of providerFetch.mock.calls) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${firstSession.access_token}`,
          );
          expect(init?.credentials).toBe("omit");
          expect(init?.redirect).toBe("error");
        }
        expect(providerFetch.mock.calls[1]?.[1]?.body).toBe("{}");
        expect(
          new Headers(providerFetch.mock.calls[1]?.[1]?.headers).get(
            "content-profile",
          ),
        ).toBe("desmoslock_v2");
        expect(getSession).toHaveBeenCalledOnce();
        expect(getUser).not.toHaveBeenCalled();
        expect(signOut).not.toHaveBeenCalled();
        expect(setSession).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        expect(currentSession).toBe(nextSession);
      } finally {
        port.releasePasswordAuthority(authority.authorityHandle);
      }
    },
  );

  it.each([
    ["absent session", { data: { session: null }, error: null }, "ended"],
    ["missing session field", { data: {}, error: null }, "unavailable"],
    [
      "malformed session",
      { data: { session: {} }, error: null },
      "unavailable",
    ],
    [
      "snapshot error",
      { data: { session: null }, error: { code: "session_expired" } },
      "unavailable",
    ],
    [
      "missing account",
      {
        data: { session: { access_token: "synthetic-account-a-token" } },
        error: null,
      },
      "unavailable",
    ],
    [
      "empty token",
      {
        data: { session: { access_token: "", user: { id: accountId } } },
        error: null,
      },
      "unavailable",
    ],
  ] as const)(
    "distinguishes %s without provider egress",
    async (_label, result, status) => {
      const getUser = vi.fn(async () => externalFailure());
      const signOut = vi.fn(async () => ({ error: null }));
      const providerFetch = vi.fn<typeof fetch>();
      const port = createPort(
        fakeClient({
          auth: { getSession: async () => result, getUser, signOut },
        }),
        providerFetch,
      );
      await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
        status,
      });
      await expect(port.readAccount()).resolves.toEqual(
        status === "ended" ? { status: "signed_out" } : null,
      );
      expect(providerFetch).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
    },
  );

  it("does not evaluate malformed session accessors or inherited identities", async () => {
    const getter = vi.fn(() => "synthetic-account-a-token");
    const inheritedUser = Object.create({ id: accountId }) as object;
    const getSession = vi
      .fn<SupabaseStaffAuthClient["auth"]["getSession"]>()
      .mockResolvedValueOnce({
        data: {
          session: Object.defineProperty(
            { user: { id: accountId } },
            "access_token",
            { get: getter },
          ),
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: "synthetic-account-a-token",
            user: inheritedUser,
          },
        },
        error: null,
      });
    const providerFetch = vi.fn<typeof fetch>();
    const port = createPort(
      fakeClient({ auth: { getSession } }),
      providerFetch,
    );
    await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(port.readAccount()).resolves.toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a snapshot-account mismatch before egress and provider-account mismatch after inert verification", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input) =>
      recoveryResponse(
        JSON.stringify({ id: "other-account", email: "other@example.test" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
        { url: String(input) },
      ),
    );
    const port = createPort(
      fakeClient({ auth: { getSession: async () => accountSession() } }),
      providerFetch,
    );
    await expect(
      port.captureSignOutAuthority("other-account"),
    ).resolves.toEqual({ status: "rejected" });
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.readAccount()).resolves.toBeNull();
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(
      providerFetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });

  it.each([
    [
      "missing session",
      403,
      JSON.stringify({ code: "session_not_found", message: "synthetic" }),
      true,
    ],
    [
      "expired session",
      401,
      JSON.stringify({ error_code: "session_expired", msg: "synthetic" }),
      true,
    ],
    [
      "generic unauthorized",
      401,
      JSON.stringify({ code: "bad_jwt", message: "synthetic" }),
      false,
    ],
    [
      "generic forbidden",
      403,
      JSON.stringify({ code: "unexpected", message: "synthetic" }),
      false,
    ],
    [
      "rate-limited ended-shaped error",
      429,
      JSON.stringify({ code: "session_not_found", message: "synthetic" }),
      false,
    ],
    [
      "unsupported client-error status",
      400,
      JSON.stringify({ code: "session_expired", message: "synthetic" }),
      false,
    ],
    [
      "refresh failure",
      400,
      JSON.stringify({ code: "refresh_token_not_found", message: "synthetic" }),
      false,
    ],
    [
      "server failure",
      500,
      JSON.stringify({ code: "session_not_found", message: "synthetic" }),
      false,
    ],
    [
      "success-shaped failure",
      200,
      JSON.stringify({ code: "session_expired", message: "synthetic" }),
      false,
    ],
    [
      "extra error field",
      403,
      JSON.stringify({
        code: "session_not_found",
        message: "synthetic",
        extra: true,
      }),
      false,
    ],
    [
      "missing message",
      403,
      JSON.stringify({ code: "session_not_found" }),
      false,
    ],
    ["malformed body", 403, "not-json", false],
    [
      "oversized body",
      403,
      JSON.stringify({ code: "session_not_found", message: "x".repeat(4097) }),
      false,
    ],
  ] as const)(
    "treats %s as ended only with an exact authoritative error",
    async (_label, httpStatus, body, ended) => {
      const getUser = vi.fn(async () => externalFailure());
      const signOut = vi.fn(async () => ({ error: null }));
      const providerFetch = vi.fn<typeof fetch>(async (input) =>
        recoveryResponse(
          body,
          {
            headers: { "content-type": "application/json" },
            status: httpStatus,
          },
          { url: String(input) },
        ),
      );
      const port = createPort(
        fakeClient({
          auth: { getSession: async () => accountSession(), getUser, signOut },
        }),
        providerFetch,
      );
      await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
        status: ended ? "ended" : "unavailable",
      });
      await expect(port.readAccount()).resolves.toEqual(
        ended ? { status: "signed_out" } : null,
      );
      expect(getUser).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
    },
  );

  it.each([
    { redirected: true },
    { url: "https://unexpected.example.test/auth/v1/user" },
  ])(
    "does not treat an out-of-bound provider response as ended",
    async (options) => {
      const port = createPort(
        fakeClient({ auth: { getSession: async () => accountSession() } }),
        async () =>
          recoveryResponse(
            JSON.stringify({ code: "session_not_found", message: "synthetic" }),
            {
              headers: { "content-type": "application/json" },
              status: 403,
            },
            { url: `${backendUrl}/auth/v1/user`, ...options },
          ),
      );
      await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
        status: "unavailable",
      });
      await expect(port.readAccount()).resolves.toBeNull();
    },
  );

  it("does not remove a replacement SDK account when captured account verification has ended or failed", async () => {
    const nextSession = {
      access_token: "synthetic-account-b-token",
      user: { id: "account-b" },
    };
    let currentSession = accountSession().data.session;
    const getSession = vi.fn(async () => ({
      data: { session: currentSession },
      error: null,
    }));
    const getUser = vi.fn(async () => {
      currentSession = nextSession;
      return externalFailure();
    });
    const signOut = vi.fn(async () => {
      currentSession = nextSession;
      return { error: null };
    });
    let status = 403;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      currentSession = nextSession;
      if (status === 0) throw new Error("synthetic network failure");
      return recoveryResponse(
        JSON.stringify({ code: "session_not_found", message: "synthetic" }),
        {
          headers: { "content-type": "application/json" },
          status,
        },
        { url: String(input) },
      );
    });
    const port = createPort(
      fakeClient({ auth: { getSession, getUser, signOut } }),
      providerFetch,
    );
    await expect(port.readAccount()).resolves.toEqual({ status: "signed_out" });
    expect(currentSession).toBe(nextSession);
    currentSession = accountSession().data.session;
    status = 0;
    await expect(port.captureSignOutAuthority(accountId)).resolves.toEqual({
      status: "unavailable",
    });
    expect(currentSession).toBe(nextSession);
    expect(
      providerFetch.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer synthetic-account-a-token",
      ),
    ).toBe(true);
    expect(getUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it.each(["capture", "read"] as const)(
    "bounds a stalled %s session snapshot and ignores its late resolution",
    async (operation) => {
      vi.useFakeTimers();
      try {
        let release:
          ((result: ReturnType<typeof accountSession>) => void) | undefined;
        const getSession = vi.fn(
          () =>
            new Promise<ReturnType<typeof accountSession>>((resolve) => {
              release = resolve;
            }),
        );
        const providerFetch = vi.fn<typeof fetch>();
        const port = createPort(
          fakeClient({ auth: { getSession } }),
          providerFetch,
        );
        const outcome =
          operation === "capture"
            ? port.captureSignOutAuthority(accountId)
            : port.readAccount();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(outcome).resolves.toEqual(
          operation === "capture" ? { status: "unavailable" } : null,
        );
        release?.(accountSession());
        await vi.runAllTimersAsync();
        expect(providerFetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["capture", 200],
    ["capture", 403],
    ["read", 200],
    ["read", 403],
  ] as const)(
    "bounds %s verification across delayed headers and a stalled HTTP %s body",
    async (operation, status) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const providerFetch = vi.fn<typeof fetch>(
          (input) =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve(
                    recoveryResponse(
                      new ReadableStream({
                        start(controller) {
                          controller.enqueue(
                            new TextEncoder().encode('{"id":'),
                          );
                        },
                        cancel,
                      }),
                      {
                        headers: { "content-type": "application/json" },
                        status,
                      },
                      { url: String(input) },
                    ),
                  ),
                4_000,
              );
            }),
        );
        const port = createPort(
          fakeClient({ auth: { getSession: async () => accountSession() } }),
          providerFetch,
        );
        const outcome =
          operation === "capture"
            ? port.captureSignOutAuthority(accountId)
            : port.readAccount();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(outcome).resolves.toEqual(
          operation === "capture" ? { status: "unavailable" } : null,
        );
        expect(cancel).toHaveBeenCalledOnce();
        expect(providerFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(providerFetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["released", "expired", "cleared"] as const)(
    "rejects %s and missing logout authorities without unbound fallback",
    async (end) => {
      vi.useFakeTimers();
      try {
        const signOut = vi.fn(async () => ({ error: null }));
        const rpc = vi.fn(async () => externalFailure());
        const providerFetch = vi.fn<typeof fetch>(async (input) =>
          recoveryResponse(
            JSON.stringify({ id: accountId }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
            { url: String(input) },
          ),
        );
        const port = createPort(
          fakeClient({
            auth: { getSession: async () => accountSession(), signOut },
            schema: () => ({ rpc }),
          }),
          providerFetch,
        );
        const handle = await captureSignOutHandle(port);
        if (end === "released") port.releasePasswordAuthority(handle);
        else if (end === "cleared") port.clearPrivateAuthContinuations();
        else await vi.advanceTimersByTimeAsync(60_000);
        await expect(port.signOut("local", handle)).resolves.toEqual({
          status: "unavailable",
        });
        await expect(
          port.revokeCurrentStaffSession(handle),
        ).resolves.toBeNull();
        await expect(port.revokeAllStaffSessions(handle)).resolves.toBeNull();
        await expect(
          Reflect.apply(port.signOut, port, ["all"]),
        ).resolves.toEqual({ status: "unavailable" });
        expect(providerFetch).toHaveBeenCalledOnce();
        expect(signOut).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    [403, { code: "session_not_found", message: "synthetic" }, "unavailable"],
    [401, { error_code: "session_expired", msg: "synthetic" }, "unavailable"],
    [401, { code: "bad_jwt", message: "synthetic" }, "unavailable"],
    [503, { code: "session_not_found", message: "synthetic" }, "unavailable"],
    [429, { code: "session_not_found", message: "synthetic" }, "unavailable"],
  ] as const)(
    "does not claim logout succeeded when the captured token receives HTTP %s",
    async (status, body, expectedStatus) => {
      const providerFetch = vi.fn<typeof fetch>(async (input) =>
        recoveryResponse(
          JSON.stringify(
            String(input).endsWith("/user") ? { id: accountId } : body,
          ),
          {
            headers: { "content-type": "application/json" },
            status: String(input).endsWith("/user") ? 200 : status,
          },
          { url: String(input) },
        ),
      );
      const signOut = vi.fn(async () => ({ error: null }));
      const port = createPort(
        fakeClient({
          auth: { getSession: async () => accountSession(), signOut },
        }),
        providerFetch,
      );
      const handle = await captureSignOutHandle(port);
      try {
        for (const scope of ["local", "all"] as const) {
          await expect(port.signOut(scope, handle)).resolves.toEqual({
            status: expectedStatus,
          });
        }
        expect(signOut).not.toHaveBeenCalled();
      } finally {
        port.releasePasswordAuthority(handle);
      }
    },
  );

  it("normalizes assurance, all TOTP factors, enrollment, challenge, verification, and removal", async () => {
    const factorId = "61000000-0000-4000-8000-000000000001";
    const unverifiedFactorId = "61000000-0000-4000-8000-000000000002";
    const challengeId = "71000000-0000-4000-8000-000000000001";
    const getAuthenticatorAssuranceLevel = vi.fn(async () => ({
      data: {
        currentAuthenticationMethods: [
          { method: "password", timestamp: 1_788_300_000 },
        ],
        currentLevel: "aal1",
        nextLevel: "aal2",
      },
      error: null,
    }));
    const listFactors = vi.fn(async () => ({
      data: {
        all: [
          {
            factor_type: "totp",
            id: factorId,
            status: "verified",
            updated_at: "not returned",
          },
          {
            factor_type: "totp",
            id: unverifiedFactorId,
            status: "unverified",
          },
          {
            factor_type: "phone",
            id: "61000000-0000-4000-8000-000000000003",
            status: "verified",
          },
        ],
        phone: [],
        totp: [],
        webauthn: [],
      },
      error: null,
    }));
    const enroll = vi.fn(async () => ({
      data: {
        id: unverifiedFactorId,
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E",
          secret: "synthetic-secret-must-not-escape",
          uri: "otpauth://synthetic-must-not-escape",
        },
        type: "totp",
      },
      error: null,
    }));
    const challenge = vi.fn(async () => ({
      data: { expires_at: 1_788_300_300, id: challengeId, type: "totp" },
      error: null,
    }));
    const verify = vi.fn(async () => ({
      data: {
        access_token: "synthetic-access-token-must-not-escape",
        expires_at: 1_788_303_600,
        expires_in: 3600,
        refresh_token: "synthetic-refresh-token-must-not-escape",
        token_type: "bearer",
        user: { id: accountId },
      },
      error: null,
    }));
    const unenroll = vi.fn(async () => ({
      data: { id: unverifiedFactorId },
      error: null,
    }));
    const port = createPort(
      fakeClient({
        auth: {
          mfa: {
            challenge,
            enroll,
            getAuthenticatorAssuranceLevel,
            listFactors,
            unenroll,
            verify,
          },
        },
      }),
    );

    await expect(port.readAssurance()).resolves.toEqual({
      currentAuthenticationMethods: ["password"],
      currentLevel: "aal1",
      nextLevel: "aal2",
    });
    await expect(port.readTotpFactors()).resolves.toEqual({
      factors: [
        { factorId, friendlyName: null, status: "verified" },
        {
          factorId: unverifiedFactorId,
          friendlyName: null,
          status: "unverified",
        },
      ],
    });
    await expect(port.enrollTotp()).resolves.toEqual({
      factorId: unverifiedFactorId,
      qrCode: "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E",
      status: "enrolled",
    });
    await expect(port.challengeTotp(factorId)).resolves.toEqual({
      challengeId,
      status: "challenged",
    });
    await expect(
      port.verifyTotp({ challengeId, code: "123456", factorId }),
    ).resolves.toEqual({ status: "verified" });
    await expect(port.removeTotpFactor(unverifiedFactorId)).resolves.toEqual({
      status: "removed",
    });

    expect(enroll).toHaveBeenCalledWith({ factorType: "totp" });
    expect(challenge).toHaveBeenCalledWith({ factorId });
    expect(verify).toHaveBeenCalledWith({
      challengeId,
      code: "123456",
      factorId,
    });
    expect(unenroll).toHaveBeenCalledWith({ factorId: unverifiedFactorId });
  });

  it.each([
    {
      currentAuthenticationMethods: ["password", "recovery"],
      label: "string methods",
    },
    {
      currentAuthenticationMethods: [
        { method: "password", timestamp: 1_788_300_000.25 },
        { method: "recovery", timestamp: 1_788_300_001 },
      ],
      label: "structured methods",
    },
  ])("strictly normalizes homogeneous $label", async (data) => {
    const port = createPort(
      fakeClient({
        auth: {
          mfa: {
            getAuthenticatorAssuranceLevel: async () => ({
              data: {
                currentAuthenticationMethods: data.currentAuthenticationMethods,
                currentLevel: "aal1",
                nextLevel: "aal2",
              },
              error: null,
            }),
          },
        },
      }),
    );

    await expect(port.readAssurance()).resolves.toEqual({
      currentAuthenticationMethods: ["password", "recovery"],
      currentLevel: "aal1",
      nextLevel: "aal2",
    });
  });

  it.each([
    ["mixed", ["password", { method: "recovery", timestamp: 1 }]],
    ["missing timestamp", [{ method: "recovery" }]],
    ["extra object key", [{ extra: true, method: "recovery", timestamp: 1 }]],
    ["invalid timestamp", [{ method: "recovery", timestamp: -1 }]],
    ["control text", ["recovery\n"]],
    ["excess methods", Array.from({ length: 33 }, () => "password")],
  ] as const)("rejects %s authentication methods", async (_label, methods) => {
    const port = createPort(
      fakeClient({
        auth: {
          mfa: {
            getAuthenticatorAssuranceLevel: async () => ({
              data: {
                currentAuthenticationMethods: methods,
                currentLevel: "aal1",
                nextLevel: "aal2",
              },
              error: null,
            }),
          },
        },
      }),
    );

    await expect(port.readAssurance()).resolves.toBeNull();
  });

  it("maps known MFA verification failures to rejected and unknowns to unavailable", async () => {
    const verify = vi
      .fn<SupabaseStaffAuthClient["auth"]["mfa"]["verify"]>()
      .mockResolvedValueOnce({
        data: null,
        error: authError("mfa_verification_failed"),
      })
      .mockResolvedValueOnce({
        data: null,
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { mfa: { verify } } }));
    const input = {
      challengeId: "71000000-0000-4000-8000-000000000001",
      code: "123456",
      factorId: "61000000-0000-4000-8000-000000000001",
    };

    await expect(port.verifyTotp(input)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.verifyTotp(input)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("exchanges an exact transient PKCE verifier once and installs only a decoded session", async () => {
    const accessToken = "synthetic-access-token";
    const refreshToken = "synthetic-refresh-token";
    const authorizationCode = "synthetic-authorization-code";
    const verifier = "v".repeat(43);
    const recoveryFetch = vi.fn(async () =>
      recoveryResponse(
        JSON.stringify({
          access_token: accessToken,
          expires_at: 1_788_303_600,
          expires_in: 3600,
          refresh_token: refreshToken,
          token_type: "bearer",
          user: { id: accountId },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );
    const setSession = vi.fn(async () => ({
      data: {
        session: { access_token: "sdk-session-must-not-escape" },
        user: { id: accountId },
      },
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({ authorizationCode, verifier }),
    ).resolves.toEqual({ status: "ready" });
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(recoveryFetch).toHaveBeenCalledWith(
      "https://backend.example.test/auth/v1/token?grant_type=pkce",
      {
        body: JSON.stringify({
          auth_code: authorizationCode,
          code_verifier: verifier,
        }),
        headers: {
          apikey: publishableKey,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
    expect(setSession).toHaveBeenCalledWith({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    port.clearPrivateAuthContinuations();
  });

  it("bounds a stalled recovery fetch and never installs a late response", async () => {
    vi.useFakeTimers();
    try {
      let releaseFetch: ((response: Response) => void) | undefined;
      const recoveryFetch = vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            releaseFetch = resolve;
          }),
      );
      const setSession = vi.fn(async () => ({
        data: { session: {}, user: {} },
        error: null,
      }));
      const port = createPort(
        fakeClient({ auth: { setSession } }),
        recoveryFetch,
      );
      const outcome = port.exchangeRecoveryCode({
        authorizationCode: "synthetic-authorization-code",
        verifier: "v".repeat(43),
      });
      const settled = vi.fn();
      void outcome.then(settled);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toEqual({ status: "unavailable" });
      expect(recoveryFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const cancel = vi.fn();
      releaseFetch?.(
        recoveryResponse(new ReadableStream({ cancel }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
      await vi.runAllTimersAsync();
      expect(cancel).toHaveBeenCalledOnce();
      expect(setSession).not.toHaveBeenCalled();
      expect(recoveryFetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([200, 400])(
    "shares one deadline across delayed headers and a stalled %s body",
    async (status) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const recoveryFetch = vi.fn<typeof fetch>(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve(
                    recoveryResponse(
                      new ReadableStream({
                        start(controller) {
                          controller.enqueue(
                            new TextEncoder().encode('{"unfinished":'),
                          );
                        },
                        cancel,
                      }),
                      {
                        headers: { "content-type": "application/json" },
                        status,
                      },
                    ),
                  ),
                4_000,
              );
            }),
        );
        const setSession = vi.fn(async () => ({
          data: { session: {}, user: {} },
          error: null,
        }));
        const port = createPort(
          fakeClient({ auth: { setSession } }),
          recoveryFetch,
        );
        const outcome = port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(outcome).resolves.toEqual({ status: "unavailable" });
        expect(cancel).toHaveBeenCalledOnce();
        expect(recoveryFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(setSession).not.toHaveBeenCalled();
        expect(recoveryFetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([null, "synthetic-session-access-token"])(
    "matches recovery preflight sets to installed SDK headers with access token %s",
    async (accessToken) => {
      const requests: Headers[] = [];
      const client = createClient(backendUrl, publishableKey, {
        accessToken: async () => accessToken,
        global: {
          fetch: async (_input, init) => {
            requests.push(new Headers(init?.headers));
            return Response.json({ code: "recovery_requested", ok: true });
          },
        },
      });
      await client.functions.invoke("account-recovery", {
        body: {
          codeChallenge: "c".repeat(43),
          email: "synthetic@example.test",
          flowId: "f".repeat(22),
          state: "s".repeat(43),
        },
      });
      expect(requests).toHaveLength(1);
      expect([...requests[0]!.keys()].sort()).toEqual(
        accessToken === null
          ? ["apikey", "content-type", "x-client-info"]
          : ["apikey", "authorization", "content-type", "x-client-info"],
      );
      expect(requests[0]!.get("authorization")).toBe(
        accessToken === null ? null : `Bearer ${accessToken}`,
      );
    },
  );

  it("wires the recovery email template to an inert fragment callback accepted by the receiver", async () => {
    const template = readFileSync(
      new URL("../../../supabase/templates/recovery-v1.html", import.meta.url),
      "utf8",
    );
    const config = readFileSync(
      new URL("../../../supabase/config.toml", import.meta.url),
      "utf8",
    );
    expect(config).toContain(
      '[auth.email.template.recovery]\nsubject = "Reset your DesmosLock password"\ncontent_path = "./supabase/templates/recovery-v1.html"',
    );
    expect(template).not.toMatch(
      /ConfirmationURL|\.Token\s|\.SiteURL|<script|<img|<form/iu,
    );
    const links = [...template.matchAll(/href="([^"]+)"/gu)];
    expect(links).toHaveLength(1);
    const flowId = "f".repeat(22);
    const state = "s".repeat(43);
    const tokenHash = `pkce_${"a".repeat(56)}`;
    const redirectTo = `https://app.example.test/?auth=recovery&flow=${flowId}&state=${state}`;
    // Substitute only the constrained template data, then decode the HTML
    // attribute as an email client does. Hosted renderer/client QA is separate.
    const firstHop = links[0]![1]!
      .replace("{{ .RedirectTo }}", redirectTo.replaceAll("&", "&amp;"))
      .replace("{{ .TokenHash }}", tokenHash)
      .replaceAll("&amp;", "&");
    expect(firstHop).toBe(
      `${redirectTo}#token_hash=${tokenHash}&type=recovery`,
    );
    expect(new URL(firstHop).search).not.toContain(tokenHash);
    const navigate = vi.fn();
    const exchange = vi.fn(async () => undefined);
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin: backendUrl,
      exchange,
      history: { replaceState: vi.fn() },
      navigate,
      route: { origin: "https://app.example.test", pathname: "/" },
    });
    expect(prepared.status).toBe("confirmation_required");
    expect(navigate).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared)).not.toContain(tokenHash);
    if (prepared.status !== "confirmation_required")
      throw new Error("Template callback rejected");
    await prepared.confirm();
    const verification = new URL(navigate.mock.calls[0]![0] as string);
    expect(verification.origin).toBe(backendUrl);
    expect(verification.pathname).toBe("/auth/v1/verify");
    expect([...verification.searchParams]).toEqual([
      ["token", tokenHash],
      ["type", "recovery"],
      ["redirect_to", redirectTo],
    ]);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects known PKCE failures and treats malformed, extra, or failed session results as unavailable", async () => {
    const validTokenBody = {
      access_token: "synthetic-access-token",
      expires_in: 3600,
      refresh_token: "synthetic-refresh-token",
      token_type: "bearer",
      user: { id: accountId },
    };
    const recoveryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({
            error_code: "bad_code_verifier",
            msg: "synthetic",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({ ...validTokenBody, provider_debug: "not allowed" }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        recoveryResponse(JSON.stringify(validTokenBody), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({
            error_code: "unexpected_failure",
            msg: "synthetic",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        ),
      );
    const setSession = vi.fn(async () => ({
      data: { session: {}, user: {} },
      debug: "unexpected SDK field",
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );
    const input = {
      authorizationCode: "synthetic-authorization-code",
      verifier: "v".repeat(43),
    };

    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    expect(setSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["flow_state_not_found", 404],
    ["flow_state_expired", 422],
    ["flow_state_already_used", 400],
  ] as const)(
    "treats stable %s PKCE failures as terminal regardless of HTTP status",
    async (errorCode, status) => {
      const recoveryFetch = vi.fn(async () =>
        recoveryResponse(
          JSON.stringify({ error_code: errorCode, msg: "synthetic" }),
          { headers: { "content-type": "application/json" }, status },
        ),
      );
      const setSession = vi.fn(async () => ({
        data: { session: {}, user: {} },
        error: null,
      }));
      const port = createPort(
        fakeClient({ auth: { setSession } }),
        recoveryFetch,
      );

      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "rejected" });
      expect(recoveryFetch).toHaveBeenCalledOnce();
      expect(setSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    [JSON.stringify({ error_code: "unknown_failure", msg: "synthetic" }), 400],
    [JSON.stringify({ code: "flow_state_expired" }), 422],
    ["not-json", 404],
    [
      JSON.stringify({
        error_code: "flow_state_expired",
        msg: "x".repeat(4_097),
      }),
      422,
    ],
  ] as const)(
    "keeps malformed or unknown PKCE failure payloads retryable",
    async (body, status) => {
      const port = createPort(
        fakeClient(),
        vi.fn(async () =>
          recoveryResponse(body, {
            headers: { "content-type": "application/json" },
            status,
          }),
        ),
      );
      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "unavailable" });
    },
  );

  it.each([
    { url: "https://redirected.example.test/auth/v1/token?grant_type=pkce" },
    { redirected: true },
  ])(
    "rejects a PKCE response outside the exact final URL boundary",
    async (options) => {
      const setSession = vi.fn(async () => ({
        data: { session: {}, user: {} },
        error: null,
      }));
      const port = createPort(
        fakeClient({ auth: { setSession } }),
        vi.fn(async () =>
          recoveryResponse(
            JSON.stringify({
              access_token: "synthetic-access-token",
              expires_in: 3600,
              refresh_token: "synthetic-refresh-token",
              token_type: "bearer",
              user: { id: accountId },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
            options,
          ),
        ),
      );
      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "unavailable" });
      expect(setSession).not.toHaveBeenCalled();
    },
  );

  it("maps stable setSession authentication failures without retaining returned tokens", async () => {
    const recoveryFetch = vi.fn(async () =>
      recoveryResponse(
        JSON.stringify({
          access_token: "synthetic-access-token",
          expires_in: 3600,
          refresh_token: "synthetic-refresh-token",
          token_type: "bearer",
          user: { id: accountId },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );
    const setSession = vi.fn(async () => ({
      data: { session: null, user: null },
      error: authError("bad_jwt"),
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({
        authorizationCode: "synthetic-authorization-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("refuses PKCE redirects without retrying or installing a returned session", async () => {
    const recoveryFetch = vi.fn(
      async (...request: [RequestInfo | URL, RequestInit?]) => {
        void request;
        throw new TypeError("redirect mode is error");
      },
    );
    const setSession = vi.fn(async () => ({
      data: { session: {}, user: {} },
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({
        authorizationCode: "synthetic-authorization-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(recoveryFetch).toHaveBeenCalledOnce();
    expect(recoveryFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(setSession).not.toHaveBeenCalled();
  });

  it("forwards auth state changes without event data and unsubscribes exactly once", () => {
    const unsubscribe = vi.fn();
    let sdkListener: ((event: unknown, session: unknown) => void) | undefined;
    const onAuthStateChange = vi.fn(
      (listener: (event: unknown, session: unknown) => void) => {
        sdkListener = listener;
        return { data: { subscription: { unsubscribe } } };
      },
    );
    const listener = vi.fn();
    const port = createPort(fakeClient({ auth: { onAuthStateChange } }));

    const stop = port.onAuthStateChange(listener);
    sdkListener?.("SIGNED_IN", { access_token: "must not escape" });
    expect(listener).toHaveBeenCalledWith();
    stop();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
