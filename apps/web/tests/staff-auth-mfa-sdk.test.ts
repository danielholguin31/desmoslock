import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";
import { createStaffAuthSessionStorageFixture } from "./helpers/staff-auth-session-storage-fixture.js";

const backend = "https://mfa-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-mfa-transactional-session";
const accountA = "a1000000-0000-4000-8000-000000000001";
const accountB = "a1000000-0000-4000-8000-000000000002";
const sessionA = "b1000000-0000-4000-8000-000000000001";
const sessionB = "b1000000-0000-4000-8000-000000000002";
const sessionA2 = "b1000000-0000-4000-8000-000000000003";
const factorId = "51000000-0000-4000-8000-000000000001";
const challengeId = "61000000-0000-4000-8000-000000000001";
const verification = { challengeId, factorId, code: "123456" };
const userPath = "/auth/v1/user";
const verifyPath = `/auth/v1/factors/${factorId}/verify`;
const contextPath = "/rest/v1/rpc/current_staff_context";
const readMethods = [
  ["readCurrentContext", contextPath],
  ["readCurrentInvitations", "/rest/v1/rpc/current_staff_invitations"],
  ["readManageableStaff", "/rest/v1/rpc/current_manageable_staff"],
  [
    "readManageableInvitations",
    "/rest/v1/rpc/current_manageable_staff_invitations",
  ],
] as const;

function jwt(claims: Record<string, unknown>) {
  return [{ alg: "HS256", typ: "JWT" }, claims, "synthetic-signature"]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
}

function syntheticSession(
  accountId: string,
  providerSessionId: string,
  aal: "aal1" | "aal2",
  version: string,
) {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    aal,
    amr:
      aal === "aal2"
        ? [
            { method: "password", timestamp: now },
            { method: "totp", timestamp: now },
          ]
        : [{ method: "password", timestamp: now }],
    aud: "authenticated",
    exp: now + 3_600,
    iat: now,
    jti: version,
    role: "authenticated",
    session_id: providerSessionId,
    sub: accountId,
  };
  return {
    access_token: jwt(claims),
    refresh_token: `synthetic-refresh-${version}`,
    expires_at: claims.exp,
    expires_in: 3_600,
    token_type: "bearer",
    user: {
      id: accountId,
      aud: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-09-01T00:00:00.000Z",
      email:
        accountId === accountA
          ? "owner-a@example.test"
          : "owner-b@example.test",
      email_confirmed_at: "2026-09-01T00:00:00.000Z",
      factors: [
        {
          id: factorId,
          factor_type: "totp",
          friendly_name: "Synthetic factor",
          status: "verified",
        },
      ],
    },
  };
}

function capturedRead(value: unknown): string {
  expect(value).toMatchObject({
    status: "ready",
    authorityHandle: expect.any(String),
  });
  if (
    typeof value !== "object" ||
    value === null ||
    !("authorityHandle" in value) ||
    typeof value.authorityHandle !== "string"
  )
    throw new Error("Missing synthetic read authority");
  return value.authorityHandle;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0)) cleanup();
  } finally {
    vi.useRealTimers();
  }
});

// Real installed SDK + real port over one linearizable, versioned memory store.
// All HTTP is intercepted. Native IndexedDB transactions, browser persistence,
// and cross-tab delivery have separate storage/browser acceptance gates.
async function harness() {
  const sessions = {
    A: syntheticSession(accountA, sessionA, "aal1", "A"),
    A2: syntheticSession(accountA, sessionA2, "aal1", "A2"),
    AR: syntheticSession(accountA, sessionA, "aal1", "AR"),
    B: syntheticSession(accountB, sessionB, "aal1", "B"),
    upgraded: syntheticSession(accountA, sessionA, "aal2", "upgraded"),
    refreshed: syntheticSession(accountA, sessionA, "aal2", "refreshed"),
  };
  type Variant = keyof typeof sessions;
  const values = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const storage = createStaffAuthSessionStorageFixture(storageKey, values);
  const originalPublish = storage.compareAndPublish.bind(storage);
  const publish = vi.spyOn(storage, "compareAndPublish");
  const requests: Array<{
    path: string;
    method: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  const unexpected: string[] = [];
  let verifyResponse: unknown = sessions.upgraded;
  let verifyStatus = 200;
  let upgradedUser: unknown = sessions.upgraded.user;
  let upgradedUserStatus = 200;
  let originalUserStatus = 200;
  let originalUser: unknown = sessions.A.user;
  const gates: Array<{
    path: string;
    stage: "headers" | "body";
    entered: ReturnType<typeof Promise.withResolvers<AbortSignal>>;
    released: ReturnType<typeof Promise.withResolvers<void>>;
    cancelled: ReturnType<typeof vi.fn<() => void>>;
    finishBody?: () => void;
    release(): void;
  }> = [];
  let held: (typeof gates)[number] | undefined;
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const variant = (Object.keys(sessions) as Variant[]).find(
      (key) => authorization === `Bearer ${sessions[key].access_token}`,
    );
    const candidateToken =
      typeof verifyResponse === "object" &&
      verifyResponse !== null &&
      "access_token" in verifyResponse
        ? verifyResponse.access_token
        : null;
    const isUpgrade =
      typeof candidateToken === "string" &&
      authorization === `Bearer ${candidateToken}`;
    const isRefresh =
      url.pathname === "/auth/v1/token" &&
      url.search === "?grant_type=refresh_token" &&
      request.method === "POST";
    const knownRead =
      readMethods.some(([, path]) => path === url.pathname) &&
      request.method === "POST";
    const knownMfa =
      (url.pathname === "/auth/v1/factors" && request.method === "POST") ||
      (url.pathname === `/auth/v1/factors/${factorId}` &&
        request.method === "DELETE") ||
      ([verifyPath, `/auth/v1/factors/${factorId}/challenge`].includes(
        url.pathname,
      ) &&
        request.method === "POST");
    if (
      url.origin !== backend ||
      (!isRefresh && variant === undefined && !isUpgrade) ||
      !(
        isRefresh ||
        knownRead ||
        knownMfa ||
        (url.pathname === userPath && request.method === "GET")
      )
    ) {
      unexpected.push(`${request.method} ${url.href}`);
      throw new Error("Unexpected synthetic MFA request");
    }
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      authorization,
      body:
        request.method === "GET"
          ? null
          : await request.json().catch(() => null),
    });
    let body: unknown;
    let status = 200;
    if (isRefresh) body = sessions.refreshed;
    else if (url.pathname === userPath) {
      body = isUpgrade
        ? upgradedUser
        : variant === "A"
          ? originalUser
          : sessions[variant!].user;
      status = isUpgrade
        ? upgradedUserStatus
        : variant === "A"
          ? originalUserStatus
          : 200;
    } else if (url.pathname === verifyPath) {
      body = verifyResponse;
      status = verifyStatus;
    } else if (url.pathname.endsWith("/challenge"))
      body = {
        id: challengeId,
        type: "totp",
        expires_at: Math.floor(Date.now() / 1_000) + 300,
      };
    else if (url.pathname === "/auth/v1/factors")
      body = { id: factorId, type: "totp", totp: { qr_code: "<svg/>" } };
    else if (request.method === "DELETE") body = { id: factorId };
    else
      body = [
        {
          code: "ok",
          synthetic_account: variant === "B" ? accountB : accountA,
        },
      ];
    const gate = held?.path === url.pathname ? held : undefined;
    if (gate !== undefined) {
      held = undefined;
      if (gate.stage === "headers") {
        gate.entered.resolve(request.signal);
        // Ignore abort to require the port to discard late server responses.
        await gate.released.promise;
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
      }
    }
    const raw = JSON.stringify(body);
    let responseBody: BodyInit = raw;
    if (gate?.stage === "body") {
      let cancelled = false;
      responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw.slice(0, 1)));
          gate.finishBody = () => {
            if (cancelled) return;
            controller.enqueue(new TextEncoder().encode(raw.slice(1)));
            controller.close();
          };
        },
        cancel() {
          cancelled = true;
          gate.cancelled();
        },
      });
      gate.entered.resolve(request.signal);
    }
    const response = new Response(responseBody, {
      status,
      headers: {
        "content-type": "application/json",
        "x-supabase-api-version": "2024-01-01",
      },
    });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  const clients: Array<{ readonly auth: { stopAutoRefresh(): void } }> = [];
  function makeClient() {
    const client = createClient(backend, publishableKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true,
        storage,
        storageKey: storage.storageKey,
      },
      global: { fetch: intercepted },
    });
    clients.push(client);
    return client;
  }
  const client = makeClient();
  await client.auth.getSession();
  const getUser = vi.spyOn(client.auth, "getUser");
  const setSession = vi.spyOn(client.auth, "setSession");
  const sdkVerify = vi.spyOn(client.auth.mfa, "verify");
  const sdkChallenge = vi.spyOn(client.auth.mfa, "challenge");
  const sdkEnroll = vi.spyOn(client.auth.mfa, "enroll");
  const sdkRemove = vi.spyOn(client.auth.mfa, "unenroll");
  const sdkFactors = vi.spyOn(client.auth.mfa, "listFactors");
  const sdkAssurance = vi.spyOn(
    client.auth.mfa,
    "getAuthenticatorAssuranceLevel",
  );
  const database = client.schema("desmoslock_v2");
  const sdkRpc = vi.spyOn(database, "rpc");
  vi.spyOn(client, "schema").mockReturnValue(database);
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: intercepted,
    origin: "https://app.example.test",
    publishableKey,
    url: backend,
    sessionStorage: storage,
  });
  cleanups.push(() => {
    port.clearPrivateAuthContinuations();
    for (const candidate of clients) candidate.auth.stopAutoRefresh();
    for (const gate of gates) gate.release();
    storage.dispose();
    expect(unexpected).toEqual([]);
    for (const spy of [
      getUser,
      setSession,
      sdkVerify,
      sdkChallenge,
      sdkEnroll,
      sdkRemove,
      sdkFactors,
      sdkAssurance,
      sdkRpc,
    ])
      expect(spy).not.toHaveBeenCalled();
  });
  return {
    client,
    makeClient,
    port,
    publish,
    originalPublish,
    storage,
    sessions,
    requests,
    async replace(variant: Variant) {
      await storage.setItem(storageKey, JSON.stringify(sessions[variant]));
    },
    unchanged: (variant: Variant) =>
      values.get(storageKey) === JSON.stringify(sessions[variant]),
    async captureRead() {
      return capturedRead(await port.captureAuthReadAuthority());
    },
    async captureMfa() {
      const handle = await port.captureMfaAuthority(accountA, sessionA);
      expect(handle).toBeTypeOf("string");
      if (handle === null) throw new Error("Missing synthetic MFA authority");
      return handle;
    },
    setVerifyResponse(value: unknown, status = 200) {
      verifyResponse = value;
      verifyStatus = status;
    },
    setUpgradedUser(value: unknown, status = 200) {
      upgradedUser = value;
      upgradedUserStatus = status;
    },
    setOriginalUser(value: unknown, status = 200) {
      originalUser = value;
      originalUserStatus = status;
    },
    hold(path: string, stage: "headers" | "body" = "headers") {
      const gate: (typeof gates)[number] = {
        path,
        stage,
        entered: Promise.withResolvers<AbortSignal>(),
        released: Promise.withResolvers<void>(),
        cancelled: vi.fn<() => void>(),
        release() {
          this.released.resolve();
          this.finishBody?.();
        },
      };
      gates.push(gate);
      held = gate;
      return gate;
    },
  };
}

describe("installed SDK bound reads and conditional MFA publication", () => {
  it.each(["A2", "B"] as const)(
    "rejects replacement %s before MFA capture without a mutation",
    async (variant) => {
      const h = await harness();
      await h.replace(variant);
      await expect(
        h.port.captureMfaAuthority(accountA, sessionA),
      ).resolves.toBeNull();
      expect(h.requests.every(({ method }) => method === "GET")).toBe(true);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged(variant)).toBe(true);
    },
  );

  it("accepts renewed tokens in the expected SID at capture", async () => {
    const h = await harness();
    await h.replace("AR");
    const handle = await h.captureMfa();
    await expect(h.port.challengeTotp(factorId, handle)).resolves.toEqual({
      status: "challenged",
      challengeId,
    });
    expect(
      h.requests.every(
        ({ authorization }) =>
          authorization === `Bearer ${h.sessions.AR.access_token}`,
      ),
    ).toBe(true);
  });

  it.each(["auth_read", "mfa"] as const)(
    "abandons %s capture if replacement B arrives during direct user verification",
    async (purpose) => {
      const h = await harness();
      const gate = h.hold(userPath);
      const pending =
        purpose === "auth_read"
          ? h.port.captureAuthReadAuthority()
          : h.port.captureMfaAuthority(accountA, sessionA);
      await gate.entered.promise;
      await h.replace("B");
      gate.release();
      expect(await pending).toEqual(
        purpose === "auth_read" ? { status: "unavailable" } : null,
      );
      expect(h.requests).toHaveLength(1);
      expect(h.unchanged("B")).toBe(true);
    },
  );

  it.each(readMethods)(
    "%s never returns mixed authority if B replaces storage during the captured A read",
    async (method, path) => {
      const h = await harness();
      const handle = await h.captureRead();
      const gate = h.hold(path);
      const pending = h.port[method](handle);
      await gate.entered.promise;
      await h.replace("B");
      gate.release();
      await expect(pending).resolves.toBeNull();
      await expect(h.port.readAssurance(handle)).resolves.toBeNull();
      await expect(h.port.readTotpFactors(handle)).resolves.toBeNull();
      await expect(h.port.isAuthReadAuthorityCurrent(handle)).resolves.toBe(
        false,
      );
      expect(h.requests).toHaveLength(2);
      expect(
        h.requests.every(
          ({ authorization }) =>
            authorization === `Bearer ${h.sessions.A.access_token}`,
        ),
      ).toBe(true);
      expect(h.unchanged("B")).toBe(true);
      const fresh = await h.captureRead();
      await expect(h.port[method](fresh)).resolves.toEqual([
        { code: "ok", synthetic_account: accountB },
      ]);
    },
  );

  it("preserves B when original A's direct capture verification reports an ended session", async () => {
    const h = await harness();
    h.setOriginalUser(
      { code: "session_not_found", message: "Synthetic ended session" },
      403,
    );
    const gate = h.hold(userPath);
    const pending = h.port.captureAuthReadAuthority();
    await gate.entered.promise;
    await h.replace("B");
    gate.release();
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(h.requests).toHaveLength(1);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.unchanged("B")).toBe(true);
  });

  it("reads assurance and factors from the verified captured token/user without SDK recapture", async () => {
    const h = await harness();
    const handle = await h.captureRead();
    await expect(h.port.readAssurance(handle)).resolves.toMatchObject({
      currentLevel: "aal1",
      nextLevel: "aal2",
      currentAuthenticationMethods: ["password"],
    });
    await expect(h.port.readTotpFactors(handle)).resolves.toEqual({
      factors: [
        { factorId, friendlyName: "Synthetic factor", status: "verified" },
      ],
    });
    expect(h.requests).toHaveLength(1);
  });

  it.each(["A2", "B"] as const)(
    "does not send an MFA request if %s replaces storage after capture",
    async (variant) => {
      const h = await harness();
      const handle = await h.captureMfa();
      await h.replace(variant);
      await expect(h.port.verifyTotp(verification, handle)).resolves.toEqual({
        status: "unavailable",
      });
      expect(h.requests).toHaveLength(1);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged(variant)).toBe(true);
    },
  );

  it.each(["A2", "B"] as const)(
    "discards a successful old-A verify response when %s replaces storage while it is in flight",
    async (variant) => {
      const h = await harness();
      const handle = await h.captureMfa();
      const gate = h.hold(verifyPath);
      const pending = h.port.verifyTotp(verification, handle);
      await gate.entered.promise;
      await h.replace(variant);
      gate.release();
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(h.requests).toHaveLength(2);
      expect(
        h.requests.every(
          ({ authorization }) =>
            authorization === `Bearer ${h.sessions.A.access_token}`,
        ),
      ).toBe(true);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged(variant)).toBe(true);
    },
  );

  it("preserves B when the upgraded token's direct user verification reports an ended session", async () => {
    const h = await harness();
    const handle = await h.captureMfa();
    h.setUpgradedUser(
      { code: "session_not_found", message: "Synthetic ended session" },
      403,
    );
    const gate = h.hold(userPath);
    const pending = h.port.verifyTotp(verification, handle);
    await gate.entered.promise;
    await h.replace("B");
    gate.release();
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(h.requests).toHaveLength(3);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.unchanged("B")).toBe(true);
  });

  it("discards a successful upgraded user response when B replaces storage during verification", async () => {
    const h = await harness();
    const handle = await h.captureMfa();
    const gate = h.hold(userPath);
    const pending = h.port.verifyTotp(verification, handle);
    await gate.entered.promise;
    await h.replace("B");
    gate.release();
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2]?.authorization).toBe(
      `Bearer ${h.sessions.upgraded.access_token}`,
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.unchanged("B")).toBe(true);
  });

  it.each(["A2", "AR", "B", "remove-and-restore-A"] as const)(
    "CAS refuses publication if %s wins after the final HTTP check",
    async (variant) => {
      const h = await harness();
      const handle = await h.captureMfa();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      h.publish.mockImplementationOnce(async (snapshot, value) => {
        entered.resolve();
        await gate.promise;
        return h.originalPublish(snapshot, value);
      });
      const pending = h.port.verifyTotp(verification, handle);
      await entered.promise;
      if (variant === "remove-and-restore-A") {
        await h.storage.removeItem(storageKey);
        await h.replace("A");
      } else await h.replace(variant);
      gate.resolve();
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(h.publish).toHaveBeenCalledOnce();
      await expect(h.publish.mock.results[0]?.value).resolves.toBe(false);
      expect(
        h.unchanged(variant === "remove-and-restore-A" ? "A" : variant),
      ).toBe(true);
      expect(h.requests).toHaveLength(3);
    },
  );

  it("publishes own AAL2 session once, survives SDK reload, and refreshes through the same storage", async () => {
    const h = await harness();
    const handle = await h.captureMfa();
    const before = await h.storage.readSessionSnapshot();
    const committed = vi.fn<() => void>();
    const unsubscribe = h.storage.subscribe(committed);
    await expect(h.port.verifyTotp(verification, handle)).resolves.toEqual({
      status: "verified",
    });
    const after = await h.storage.readSessionSnapshot();
    expect(after.version).toBe(before.version + 1);
    expect(after.storeGeneration).toBe(before.storeGeneration);
    expect(committed).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect((await h.client.auth.getSession()).data.session).toMatchObject({
      access_token: h.sessions.upgraded.access_token,
      refresh_token: h.sessions.upgraded.refresh_token,
      user: h.sessions.upgraded.user,
    });
    const reloaded = h.makeClient();
    expect((await reloaded.auth.getSession()).data.session?.access_token).toBe(
      h.sessions.upgraded.access_token,
    );
    const freshRead = await h.captureRead();
    await expect(h.port.readAssurance(freshRead)).resolves.toMatchObject({
      currentLevel: "aal2",
      nextLevel: "aal2",
    });
    const refreshed = await reloaded.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.access_token).toBe(
      h.sessions.refreshed.access_token,
    );
    expect(h.unchanged("refreshed")).toBe(true);
    expect((await h.client.auth.getSession()).data.session?.access_token).toBe(
      h.sessions.refreshed.access_token,
    );
    expect(
      h.requests.filter(({ path }) =>
        path.includes("grant_type=refresh_token"),
      ),
    ).toMatchObject([
      {
        method: "POST",
        body: { refresh_token: h.sessions.upgraded.refresh_token },
      },
    ]);
    const writes = h.requests.filter(({ path }) => path === verifyPath);
    expect(writes).toEqual([
      {
        path: verifyPath,
        method: "POST",
        authorization: `Bearer ${h.sessions.A.access_token}`,
        body: { challenge_id: challengeId, code: "123456" },
      },
    ]);
    unsubscribe();
  });

  it("uses exact captured authority for enroll, challenge and removal", async () => {
    const h = await harness();
    const handle = await h.captureMfa();
    await expect(h.port.enrollTotp(handle)).resolves.toMatchObject({
      status: "enrolled",
      factorId,
    });
    await expect(h.port.challengeTotp(factorId, handle)).resolves.toEqual({
      status: "challenged",
      challengeId,
    });
    await expect(h.port.removeTotpFactor(factorId, handle)).resolves.toEqual({
      status: "removed",
    });
    expect(h.requests.slice(1)).toEqual([
      {
        path: "/auth/v1/factors",
        method: "POST",
        authorization: `Bearer ${h.sessions.A.access_token}`,
        body: { factor_type: "totp" },
      },
      {
        path: `/auth/v1/factors/${factorId}/challenge`,
        method: "POST",
        authorization: `Bearer ${h.sessions.A.access_token}`,
        body: { factorId },
      },
      {
        path: `/auth/v1/factors/${factorId}`,
        method: "DELETE",
        authorization: `Bearer ${h.sessions.A.access_token}`,
        body: null,
      },
    ]);
  });

  it.each(["enroll", "challenge", "remove"] as const)(
    "discards a late %s response after B replaces storage",
    async (operation) => {
      const h = await harness();
      const handle = await h.captureMfa();
      const path =
        operation === "enroll"
          ? "/auth/v1/factors"
          : operation === "challenge"
            ? `/auth/v1/factors/${factorId}/challenge`
            : `/auth/v1/factors/${factorId}`;
      const gate = h.hold(path);
      const pending =
        operation === "enroll"
          ? h.port.enrollTotp(handle)
          : operation === "challenge"
            ? h.port.challengeTotp(factorId, handle)
            : h.port.removeTotpFactor(factorId, handle);
      await gate.entered.promise;
      await h.replace("B");
      gate.release();
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(h.requests).toHaveLength(2);
      expect(
        h.requests.every(
          ({ authorization }) =>
            authorization === `Bearer ${h.sessions.A.access_token}`,
        ),
      ).toBe(true);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged("B")).toBe(true);
    },
  );

  it.each([
    "missing",
    "unknown",
    "released",
    "expired",
    "reset",
    "password",
    "auth_read",
  ] as const)(
    "makes %s MFA handles inert with no SDK or HTTP fallback",
    async (kind) => {
      const h = await harness();
      vi.useFakeTimers();
      let handle: string | undefined;
      if (kind === "unknown") handle = "unknown";
      else if (kind === "password")
        handle = (await h.port.capturePasswordAuthority(accountA, sessionA))!;
      else if (kind === "auth_read") handle = await h.captureRead();
      else if (kind !== "missing") {
        handle = await h.captureMfa();
        if (kind === "released") h.port.releaseMfaAuthority(handle);
        if (kind === "reset") h.port.clearPrivateAuthContinuations();
        if (kind === "expired") await vi.advanceTimersByTimeAsync(60_000);
      }
      h.requests.length = 0;
      for (const [method, args] of [
        [h.port.enrollTotp, [handle]],
        [h.port.challengeTotp, [factorId, handle]],
        [h.port.removeTotpFactor, [factorId, handle]],
        [h.port.verifyTotp, [verification, handle]],
      ] as const) {
        await expect(Reflect.apply(method, h.port, args)).resolves.toEqual({
          status: "unavailable",
        });
      }
      expect(h.requests).toEqual([]);
      expect(h.publish).not.toHaveBeenCalled();
    },
  );

  it("keeps MFA-purpose handles out of all bound read selectors", async () => {
    const h = await harness();
    const handle = await h.captureMfa();
    h.requests.length = 0;
    for (const [method] of readMethods)
      await expect(h.port[method](handle)).resolves.toBeNull();
    await expect(h.port.readAssurance(handle)).resolves.toBeNull();
    await expect(h.port.readTotpFactors(handle)).resolves.toBeNull();
    expect(h.requests).toEqual([]);
  });

  it.each([
    "unknown field",
    "missing refresh",
    "wrong account",
    "wrong token subject",
    "wrong SID",
    "wrong AAL",
    "expired",
    "fractional expiry",
    "missing SID",
    "noncanonical SID",
    "expiry disagreement",
  ] as const)(
    "never publishes a malformed upgraded response: %s",
    async (kind) => {
      const h = await harness();
      const handle = await h.captureMfa();
      const body: Record<string, unknown> = { ...h.sessions.upgraded };
      const claims: Record<string, unknown> = JSON.parse(
        Buffer.from(
          h.sessions.upgraded.access_token.split(".")[1]!,
          "base64url",
        ).toString(),
      );
      if (kind === "unknown field") body.extra = true;
      if (kind === "missing refresh") delete body.refresh_token;
      if (kind === "wrong account") body.user = h.sessions.B.user;
      if (kind === "wrong token subject") claims.sub = accountB;
      if (kind === "wrong SID") claims.session_id = sessionA2;
      if (kind === "wrong AAL") claims.aal = "aal1";
      if (kind === "expired") claims.exp = Math.floor(Date.now() / 1_000) - 1;
      if (kind === "fractional expiry")
        claims.exp = Math.floor(Date.now() / 1_000) + 3_600.5;
      if (kind === "missing SID") delete claims.session_id;
      if (kind === "noncanonical SID") claims.session_id = "not-a-session";
      if (kind === "expiry disagreement")
        body.expires_at = Number(body.expires_at) + 1;
      body.access_token = jwt(claims);
      h.setVerifyResponse(body);
      await expect(h.port.verifyTotp(verification, handle)).resolves.toEqual({
        status: "unavailable",
      });
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged("A")).toBe(true);
      expect(h.requests.filter(({ path }) => path === verifyPath)).toHaveLength(
        1,
      );
    },
  );

  it.each([
    "id",
    "email",
    "aud",
    "created_at",
    "app_metadata",
    "user_metadata",
  ] as const)(
    "requires upgraded /user field %s before publication",
    async (field) => {
      const h = await harness();
      const handle = await h.captureMfa();
      const user: Record<string, unknown> = { ...h.sessions.upgraded.user };
      delete user[field];
      h.setUpgradedUser(user);
      await expect(h.port.verifyTotp(verification, handle)).resolves.toEqual({
        status: "unavailable",
      });
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged("A")).toBe(true);
    },
  );

  it.each([
    [422, "mfa_verification_failed", "rejected"],
    [503, "unexpected_error", "unavailable"],
  ] as const)(
    "reports HTTP %s verify failure without publishing or retrying",
    async (status, code, outcome) => {
      const h = await harness();
      const handle = await h.captureMfa();
      h.setVerifyResponse(
        { code, message: "private synthetic diagnostic" },
        status,
      );
      await expect(h.port.verifyTotp(verification, handle)).resolves.toEqual({
        status: outcome,
      });
      expect(h.requests).toHaveLength(2);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.unchanged("A")).toBe(true);
    },
  );

  describe.each(["headers", "body"] as const)(
    "bounded %s response",
    (stage) => {
      it.each(["capture", "context", "verify", "upgraded user"] as const)(
        "fails closed after five seconds for %s and discards late completion",
        async (operation) => {
          const h = await harness();
          vi.useFakeTimers();
          const handle =
            operation === "capture"
              ? null
              : operation === "context"
                ? await h.captureRead()
                : await h.captureMfa();
          const path =
            operation === "context"
              ? contextPath
              : operation === "verify"
                ? verifyPath
                : userPath;
          const gate = h.hold(path, stage);
          const pending =
            operation === "capture"
              ? h.port.captureAuthReadAuthority()
              : operation === "context"
                ? h.port.readCurrentContext(handle!)
                : h.port.verifyTotp(verification, handle!);
          const settled = vi.fn<() => void>();
          void pending.then(settled);
          if (stage === "body") await vi.advanceTimersByTimeAsync(4_000);
          const signal = await gate.entered.promise;
          await vi.advanceTimersByTimeAsync(stage === "body" ? 999 : 4_999);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await expect(pending).resolves.toEqual(
            operation === "context" ? null : { status: "unavailable" },
          );
          expect(signal.aborted).toBe(true);
          if (stage === "body") expect(gate.cancelled).toHaveBeenCalledOnce();
          expect(h.publish).not.toHaveBeenCalled();
          await h.replace("B");
          const previousRequests = h.requests.length;
          gate.release();
          await vi.advanceTimersByTimeAsync(0);
          expect(h.requests).toHaveLength(previousRequests);
          expect(h.unchanged("B")).toBe(true);
          expect(h.publish).not.toHaveBeenCalled();
          await h.replace("A");
          const fresh = await h.captureRead();
          await expect(h.port.readCurrentContext(fresh)).resolves.toEqual([
            { code: "ok", synthetic_account: accountA },
          ]);
          expect(
            h.requests.filter(
              ({ path: requested }) => requested === verifyPath,
            ),
          ).toHaveLength(
            operation === "verify" || operation === "upgraded user" ? 1 : 0,
          );
        },
      );
    },
  );
});
