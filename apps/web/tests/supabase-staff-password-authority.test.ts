import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseStaffAuthPort } from "../src/auth/supabase-staff-auth-adapter.js";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backendUrl = "https://backend.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const accountA = "a1000000-0000-4000-8000-000000000001";
const accountB = "a1000000-0000-4000-8000-000000000002";
const invitationId = "41000000-0000-4000-8000-000000000001";
const operationId = "51000000-0000-4000-8000-000000000001";
const password = "synthetic replacement password only";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function responseAt(url: string, body: unknown, status = 200): Response {
  const response =
    status === 204
      ? new Response(null, { status })
      : Response.json(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function capture(port: SupabaseStaffAuthPort, accountId = accountA) {
  const handle = await port.capturePasswordAuthority(accountId);
  expect(typeof handle).toBe("string");
  if (handle === null) throw new Error("Synthetic authority was not captured");
  cleanups.push(() => port.releasePasswordAuthority(handle));
  return handle;
}

function harness() {
  let currentAccount = accountA;
  const unavailable = vi.fn(async () => ({ data: null, error: {} }));
  const getSession = vi.fn(async () => ({
    data: {
      session: { access_token: `synthetic-token-${currentAccount}` },
    },
    error: null,
  }));
  const sdkSignOut = vi.fn(async () => ({ error: null }));
  const setSession = vi.fn<SupabaseStaffAuthClient["auth"]["setSession"]>(
    async (session) => ({
      data: { session, user: { id: accountA } },
      error: null,
    }),
  );
  const client: SupabaseStaffAuthClient = {
    auth: {
      exchangeCodeForSession: unavailable,
      getSession,
      getUser: unavailable,
      mfa: {
        challenge: unavailable,
        enroll: unavailable,
        getAuthenticatorAssuranceLevel: unavailable,
        listFactors: unavailable,
        unenroll: unavailable,
        verify: unavailable,
      },
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => undefined } },
      }),
      resend: unavailable,
      setSession,
      signInWithPassword: unavailable,
      signOut: sdkSignOut,
      updateUser: unavailable,
      verifyOtp: unavailable,
    },
    functions: { invoke: unavailable },
    schema: () => ({ rpc: unavailable }),
  };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const bearer = new Headers(init?.headers).get("authorization");
    const id =
      bearer === `Bearer synthetic-token-${accountA}` ? accountA : accountB;
    if (url.includes("/logout?")) return responseAt(url, null, 204);
    if (url.includes("/rest/v1/")) return responseAt(url, [{ ok: true }]);
    return responseAt(url, { id });
  });
  const port = createSupabaseStaffAuthPort({
    client,
    fetch: request,
    origin: "https://app.example.test",
    publishableKey,
    url: backendUrl,
  });
  return {
    getSession,
    port,
    request,
    sdkSignOut,
    setSession,
    switchAccount: () => {
      currentAccount = accountB;
    },
    unavailable,
  };
}

describe("operation-local password authority", () => {
  it("cancels an earlier recovery expiry when overlapping installations establish a later binding", async () => {
    vi.useFakeTimers();
    const test = harness();
    const tokens = {
      access_token: `synthetic-token-${accountA}`,
      expires_in: 3_600,
      refresh_token: "synthetic-refresh-token",
      token_type: "bearer",
      user: { id: accountA },
    };
    let installFirst: (() => void) | undefined;
    let installSecond: (() => void) | undefined;
    const installed = {
      data: { session: tokens, user: tokens.user },
      error: null,
    };
    test.setSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          installFirst = () => resolve(installed);
        }),
    );
    test.setSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          installSecond = () => resolve(installed);
        }),
    );
    test.request.mockImplementationOnce(async (url) =>
      responseAt(String(url), tokens),
    );
    test.request.mockImplementationOnce(async (url) =>
      responseAt(String(url), tokens),
    );
    const first = test.port.exchangeRecoveryCode({
      authorizationCode: "synthetic-first",
      verifier: "v".repeat(43),
    });
    const second = test.port.exchangeRecoveryCode({
      authorizationCode: "synthetic-second",
      verifier: "v".repeat(43),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(installFirst).toBeTypeOf("function");
    expect(installSecond).toBeTypeOf("function");
    installFirst?.();
    await expect(first).resolves.toEqual({ status: "ready" });
    await vi.advanceTimersByTimeAsync(1_000);
    installSecond?.();
    await expect(second).resolves.toEqual({ status: "ready" });
    await vi.advanceTimersByTimeAsync(299_000);
    const handle = await test.port.capturePasswordAuthority();
    expect(handle).toBeTypeOf("string");
    if (handle === null)
      throw new Error("Later recovery binding was cleared early");
    test.port.releasePasswordAuthority(handle);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(test.port.capturePasswordAuthority()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps invitation acceptance, password and global cleanup on the verified captured account", async () => {
    const test = harness();
    const handle = await capture(test.port, accountA);
    test.switchAccount();
    await expect(
      test.port.acceptInvitation(
        { displayName: "Taylor", invitationId },
        handle,
      ),
    ).resolves.toEqual([{ ok: true }]);
    await expect(test.port.updatePassword(password, handle)).resolves.toEqual({
      status: "updated",
    });
    await expect(test.port.signOut("all", handle)).resolves.toEqual({
      status: "signed_out",
    });
    expect(test.getSession).toHaveBeenCalledOnce();
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.sdkSignOut).not.toHaveBeenCalled();
    expect(
      test.request.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      [`${backendUrl}/auth/v1/user`, "GET"],
      [`${backendUrl}/rest/v1/rpc/accept_staff_invitation`, "POST"],
      [`${backendUrl}/auth/v1/user`, "PUT"],
      [`${backendUrl}/auth/v1/logout?scope=global`, "POST"],
    ]);
    for (const [, init] of test.request.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        `Bearer synthetic-token-${accountA}`,
      );
      expect(headers.get("apikey")).toBe(publishableKey);
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    }
    const invitationRequest = test.request.mock.calls[1]![1]!;
    expect(new Headers(invitationRequest.headers).get("content-profile")).toBe(
      "desmoslock_v2",
    );
    expect(JSON.parse(String(invitationRequest.body))).toEqual({
      display_name: "Taylor",
      invitation_id: invitationId,
    });
    expect(JSON.parse(String(test.request.mock.calls[2]![1]!.body))).toEqual({
      password,
    });
    expect(handle).not.toContain(accountA);
    expect(handle).not.toContain("synthetic-token");
  });

  it("binds recovery begin, password, finish and local cleanup across an account switch", async () => {
    const test = harness();
    test.request.mockImplementationOnce(async (url) =>
      responseAt(String(url), {
        access_token: `synthetic-token-${accountA}`,
        expires_in: 3_600,
        refresh_token: "synthetic-refresh-token",
        token_type: "bearer",
        user: { id: accountA },
      }),
    );
    await expect(
      test.port.exchangeRecoveryCode({
        authorizationCode: "synthetic-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "ready" });
    test.request.mockClear();
    const handle = await test.port.capturePasswordAuthority();
    if (handle === null)
      throw new Error("Synthetic recovery authority missing");
    cleanups.push(() => test.port.releasePasswordAuthority(handle));
    test.switchAccount();
    await expect(
      test.port.beginPasswordRecovery(operationId, handle),
    ).resolves.toEqual([{ ok: true }]);
    await expect(test.port.updatePassword(password, handle)).resolves.toEqual({
      status: "updated",
    });
    await expect(
      test.port.finishPasswordRecovery(operationId, handle),
    ).resolves.toEqual([{ ok: true }]);
    await expect(test.port.signOut("local", handle)).resolves.toEqual({
      status: "signed_out",
    });
    expect(test.request.mock.calls[1]![0]).toBe(
      `${backendUrl}/rest/v1/rpc/begin_staff_password_recovery`,
    );
    expect(JSON.parse(String(test.request.mock.calls[1]![1]!.body))).toEqual({
      requested_operation_id: operationId,
    });
    expect(test.request.mock.calls[3]![0]).toBe(
      `${backendUrl}/rest/v1/rpc/finish_staff_password_recovery`,
    );
    expect(JSON.parse(String(test.request.mock.calls[3]![1]!.body))).toEqual({
      operation_id: operationId,
    });
    for (const [, init] of test.request.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer synthetic-token-${accountA}`,
      );
    }
    expect(test.sdkSignOut).not.toHaveBeenCalled();
    expect(test.unavailable).not.toHaveBeenCalled();
  });

  it("requires verified expected invitation identity before allowing writes", async () => {
    const test = harness();
    test.switchAccount();
    await expect(
      test.port.capturePasswordAuthority(accountA),
    ).resolves.toBeNull();
    expect(test.request).toHaveBeenCalledOnce();
    expect(test.request.mock.calls[0]![1]!.method).toBe("GET");
    expect(test.unavailable).not.toHaveBeenCalled();
  });

  it("makes released, expired and unknown handles inert without SDK fallbacks", async () => {
    vi.useFakeTimers();
    const test = harness();
    const released = await capture(test.port);
    test.port.releasePasswordAuthority(released);
    const expired = await capture(test.port);
    await vi.advanceTimersByTimeAsync(60_000);
    test.request.mockClear();
    for (const handle of [released, expired, "unknown"]) {
      await expect(test.port.updatePassword(password, handle)).resolves.toEqual(
        { status: "unavailable" },
      );
      await expect(
        test.port.acceptInvitation(
          { displayName: "Taylor", invitationId },
          handle,
        ),
      ).resolves.toBeNull();
      await expect(
        test.port.beginPasswordRecovery(operationId, handle),
      ).resolves.toBeNull();
      await expect(
        test.port.finishPasswordRecovery(operationId, handle),
      ).resolves.toBeNull();
      await expect(test.port.signOut("all", handle)).resolves.toEqual({
        status: "unavailable",
      });
    }
    expect(test.request).not.toHaveBeenCalled();
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.sdkSignOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permits only one password attempt per handle, including concurrent calls", async () => {
    const test = harness();
    const handle = await capture(test.port);
    const outcomes = await Promise.all([
      test.port.updatePassword(password, handle),
      test.port.updatePassword("a different synthetic password", handle),
    ]);
    expect(outcomes).toEqual([
      { status: "updated" },
      { status: "unavailable" },
    ]);
    expect(
      test.request.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
  });

  it.each([
    [
      {
        code: "weak_password",
        message: "not exposed",
        weak_password: { reasons: ["length"] },
      },
      422,
      "rejected",
    ],
    [{ code: "same_password", message: "not exposed" }, 422, "rejected"],
    [{ code: "unexpected_error", message: "not exposed" }, 503, "unavailable"],
    [{ id: accountB }, 200, "unavailable"],
    [{ user: { id: accountA } }, 200, "updated"],
  ] as const)(
    "sanitizes password responses and checks the returned account (%s)",
    async (body, status, expected) => {
      const test = harness();
      const handle = await capture(test.port);
      test.request.mockImplementationOnce(async (url) =>
        responseAt(String(url), body, status),
      );
      await expect(test.port.updatePassword(password, handle)).resolves.toEqual(
        { status: expected },
      );
    },
  );

  it.each([200, 204, 401, 403, 503])(
    "reports direct logout success only from successful HTTP status %s",
    async (status) => {
      const test = harness();
      const handle = await capture(test.port);
      test.request.mockImplementationOnce(async (url) =>
        responseAt(String(url), { code: "session_not_found" }, status),
      );
      await expect(test.port.signOut("all", handle)).resolves.toEqual({
        status: status < 300 ? "signed_out" : "unavailable",
      });
      expect(test.sdkSignOut).not.toHaveBeenCalled();
    },
  );

  it("settles a stalled password body at the deadline and never performs late SDK mutation", async () => {
    vi.useFakeTimers();
    const test = harness();
    const handle = await capture(test.port);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", {
      value: `${backendUrl}/auth/v1/user`,
    });
    test.request.mockResolvedValueOnce(response);
    const pending = test.port.updatePassword(password, handle);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(cancelled).toBe(true);
    expect(test.unavailable).not.toHaveBeenCalled();
    test.port.releasePasswordAuthority(handle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized or redirected authority responses", async () => {
    const test = harness();
    test.request.mockImplementationOnce(async (url) => {
      const response = responseAt(String(url), { id: accountA });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    await expect(
      test.port.capturePasswordAuthority(accountA),
    ).resolves.toBeNull();
    test.request.mockImplementationOnce(async (url) => {
      const response = responseAt(String(url), { id: accountA });
      response.headers.set("content-length", "65537");
      return response;
    });
    await expect(
      test.port.capturePasswordAuthority(accountA),
    ).resolves.toBeNull();
  });
});

function syntheticSdkSession(accountId: string) {
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  const payload = Buffer.from(
    JSON.stringify({ exp: expiresAt, sub: accountId }),
  ).toString("base64url");
  return {
    access_token: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${payload}.synthetic-signature`,
    expires_at: expiresAt,
    expires_in: 3_600,
    refresh_token: `synthetic-refresh-${accountId}`,
    token_type: "bearer",
    user: {
      aud: "authenticated",
      email: "synthetic@example.test",
      id: accountId,
    },
  };
}

function installedSdkHarness() {
  const storageKey = "desmoslock-password-authority-synthetic";
  const sessionA = syntheticSdkSession(accountA);
  const sessionB = syntheticSdkSession(accountB);
  const memory = new Map<string, string>([
    [storageKey, JSON.stringify(sessionA)],
  ]);
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/logout?")) return responseAt(url, null, 204);
    const token = new Headers(init?.headers).get("authorization");
    return responseAt(url, {
      id: token === `Bearer ${sessionA.access_token}` ? accountA : accountB,
    });
  });
  const client = createClient(backendUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        removeItem: (key) => {
          memory.delete(key);
        },
        setItem: (key, value) => {
          memory.set(key, value);
        },
      },
      storageKey,
    },
    global: { fetch: request },
  });
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: request,
    origin: "https://app.example.test",
    publishableKey,
    url: backendUrl,
  });
  return {
    memory,
    port,
    request,
    sessionA,
    sessionB,
    storageKey,
    switchAccount: () => {
      memory.set(storageKey, JSON.stringify(sessionB));
    },
  };
}

describe("installed Supabase SDK account-switch regression (intercepted fetch only)", () => {
  it("requires an established recovery exchange before no-argument capture", async () => {
    const test = installedSdkHarness();
    await expect(test.port.capturePasswordAuthority()).resolves.toBeNull();
    expect(test.request).not.toHaveBeenCalled();
  });

  it("rejects account B replacing the recovery session before capture without waiting for an auth event", async () => {
    vi.useFakeTimers();
    const test = installedSdkHarness();
    test.request.mockImplementationOnce(async (url) =>
      responseAt(String(url), test.sessionA),
    );
    await expect(
      test.port.exchangeRecoveryCode({
        authorizationCode: "synthetic-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "ready" });
    test.switchAccount();
    test.request.mockClear();
    await expect(test.port.capturePasswordAuthority()).resolves.toBeNull();
    expect(test.request).not.toHaveBeenCalled();
    expect(JSON.parse(test.memory.get(test.storageKey)!)).toEqual(
      test.sessionB,
    );
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures only the original recovery session and expires its private provenance", async () => {
    vi.useFakeTimers();
    const test = installedSdkHarness();
    test.request.mockImplementationOnce(async (url) =>
      responseAt(String(url), test.sessionA),
    );
    await expect(
      test.port.exchangeRecoveryCode({
        authorizationCode: "synthetic-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "ready" });
    const handle = await test.port.capturePasswordAuthority();
    expect(typeof handle).toBe("string");
    if (handle === null)
      throw new Error("Synthetic recovery authority missing");
    test.port.releasePasswordAuthority(handle);
    await vi.advanceTimersByTimeAsync(300_000);
    test.request.mockClear();
    await expect(test.port.capturePasswordAuthority()).resolves.toBeNull();
    expect(test.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not change password or erase account B after capturing account A", async () => {
    const test = installedSdkHarness();
    const handle = await capture(test.port, accountA);
    test.switchAccount();
    await expect(test.port.updatePassword(password, handle)).resolves.toEqual({
      status: "updated",
    });
    await expect(test.port.signOut("all", handle)).resolves.toEqual({
      status: "signed_out",
    });
    expect(JSON.parse(test.memory.get(test.storageKey)!)).toEqual(
      test.sessionB,
    );
    expect(
      test.request.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("authorization"),
      ),
    ).toEqual(Array(3).fill(`Bearer ${test.sessionA.access_token}`));
    expect(test.request.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "POST",
    ]);
  });

  it("does not erase switched SDK state when captured account A is rejected as missing", async () => {
    const test = installedSdkHarness();
    test.request.mockImplementationOnce(async (url) => {
      test.switchAccount();
      return responseAt(
        String(url),
        { code: "session_not_found", message: "Synthetic expired session" },
        403,
      );
    });
    await expect(
      test.port.capturePasswordAuthority(accountA),
    ).resolves.toBeNull();
    expect(JSON.parse(test.memory.get(test.storageKey)!)).toEqual(
      test.sessionB,
    );
    expect(test.request).toHaveBeenCalledOnce();
  });
});
