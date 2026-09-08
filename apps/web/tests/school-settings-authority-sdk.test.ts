import { createStaffAuthSessionStorageFixture } from "./helpers/staff-auth-session-storage-fixture.js";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backend = "https://school-settings-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-school-settings-sdk-session";
const accounts = {
  A: "a1000000-0000-4000-8000-000000000001",
  B: "a1000000-0000-4000-8000-000000000002",
} as const;
type Account = keyof typeof accounts;
const providerSessionIds: Record<Account, string> = {
  A: "b1000000-0000-4000-8000-000000000001",
  B: "b1000000-0000-4000-8000-000000000002",
};
const replacementSessionId = "b1000000-0000-4000-8000-000000000003";
type SessionVariant = Account | "A2" | "AR";
const settingsPath = "/rest/v1/rpc/update_school_display_name";
const request = {
  displayName: "École North",
  expectedSettingsRevision: 7,
  schoolId: "11000000-0000-4000-8000-000000000001",
};

function session(
  account: Account,
  providerSessionId = providerSessionIds[account],
  tokenVersion = 0,
) {
  const accessToken = [
    { alg: "HS256", typ: "JWT" },
    {
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      sub: accounts[account],
      session_id: providerSessionId,
      jti: String(tokenVersion),
    },
    "synthetic-signature",
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    access_token: accessToken,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
    refresh_token: `synthetic-school-settings-${account}-refresh`,
    token_type: "bearer",
    user: { id: accounts[account] },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

// Installed SDK and real port, with memory-only sessions and intercepted HTTP.
// These checks prove transport/account binding, not live database authorization.
async function harness() {
  const sessions = {
    A: session("A"),
    B: session("B"),
    A2: session("A", replacementSessionId),
    AR: session("A", providerSessionIds.A, 1),
  };
  const storage = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const requests: Array<{ account: Account; request: Request; body: unknown }> =
    [];
  const unexpectedRequests: string[] = [];
  let verification: { body: unknown; status: number } | undefined;
  let outcome:
    | "updated"
    | "unchanged"
    | "conflict"
    | "lost"
    | "bad_json"
    | "http_error"
    | "redirected" = "updated";
  type Gate = {
    path: string;
    entered: ReturnType<typeof Promise.withResolvers<AbortSignal>>;
    released: ReturnType<typeof Promise.withResolvers<void>>;
  };
  const gates: Gate[] = [];
  let hold: Gate | undefined;
  const intercepted: typeof fetch = async (input, init) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    const variant = (Object.keys(sessions) as SessionVariant[]).find(
      (key) =>
        fetched.headers.get("authorization") ===
        `Bearer ${sessions[key].access_token}`,
    );
    const account = variant === undefined ? null : variant === "B" ? "B" : "A";
    if (
      url.origin !== backend ||
      account === null ||
      !(
        (url.pathname === "/auth/v1/user" && fetched.method === "GET") ||
        (url.pathname === settingsPath && fetched.method === "POST")
      )
    ) {
      unexpectedRequests.push(url.href);
      throw new Error("Unexpected synthetic School settings request");
    }
    requests.push({
      account,
      request: fetched,
      body: fetched.method === "GET" ? null : await fetched.json(),
    });
    if (hold?.path === url.pathname) {
      const gate = hold;
      hold = undefined;
      gate.entered.resolve(fetched.signal);
      // Deliberately ignore abort so the consumer must discard late responses.
      await gate.released.promise;
    }
    if (url.pathname === settingsPath && outcome === "lost")
      throw new Error("Synthetic response lost");
    const code =
      outcome === "unchanged"
        ? "school_display_name_unchanged"
        : outcome === "conflict"
          ? "school_settings_revision_conflict"
          : "school_display_name_updated";
    const body =
      url.pathname === "/auth/v1/user"
        ? JSON.stringify(verification?.body ?? sessions[account].user)
        : outcome === "bad_json"
          ? "{"
          : JSON.stringify([{ code }]);
    const status =
      url.pathname === "/auth/v1/user"
        ? (verification?.status ?? 200)
        : outcome === "http_error"
          ? 503
          : 200;
    const response = new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url.href });
    if (url.pathname === settingsPath && outcome === "redirected") {
      Object.defineProperty(response, "redirected", { value: true });
    }
    return response;
  };
  const sessionStorage = createStaffAuthSessionStorageFixture(
    storageKey,
    storage,
  );
  const client = createClient(backend, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey,
      storage: sessionStorage,
    },
    global: { fetch: intercepted },
  });
  await client.auth.getSession();
  const getSession = vi.spyOn(client.auth, "getSession");
  const getUser = vi.spyOn(client.auth, "getUser");
  const database = client.schema("desmoslock_v2");
  const sdkRpc = vi.spyOn(database, "rpc");
  const schema = vi.spyOn(client, "schema").mockReturnValue(database);
  const port = createSupabaseStaffAuthPort({
    sessionStorage,
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: intercepted,
    origin: "https://app.example.test",
    publishableKey,
    url: backend,
  });
  cleanups.push(() => {
    port.clearPrivateAuthContinuations();
    client.auth.stopAutoRefresh();
    for (const gate of gates) gate.released.resolve();
    expect(unexpectedRequests).toEqual([]);
    expect(getUser).not.toHaveBeenCalled();
    expect(sdkRpc).not.toHaveBeenCalled();
    expect(schema).not.toHaveBeenCalled();
  });
  return {
    getSession,
    sessions,
    replaceSession(variant: SessionVariant) {
      storage.set(storageKey, JSON.stringify(sessions[variant]));
    },
    sessionUnchanged: (variant: SessionVariant) =>
      storage.get(storageKey) === JSON.stringify(sessions[variant]),
    port,
    requests,
    setVerification(body: unknown, status: number) {
      verification = { body, status };
    },
    setOutcome(value: typeof outcome) {
      outcome = value;
    },
    replaceAccount() {
      storage.set(storageKey, JSON.stringify(sessions.B));
    },
    replacementUnchanged: () =>
      storage.get(storageKey) === JSON.stringify(sessions.B),
    mutations: () =>
      requests.filter(
        ({ request }) => new URL(request.url).pathname === settingsPath,
      ),
    hold(path: string) {
      const gate = {
        path,
        entered: Promise.withResolvers<AbortSignal>(),
        released: Promise.withResolvers<void>(),
      };
      gates.push(gate);
      hold = gate;
      return gate;
    },
    async capture() {
      const result = await port.captureSchoolSettingsAuthority(
        accounts.A,
        providerSessionIds.A,
      );
      expect(result).toEqual({
        status: "ready",
        authorityHandle: expect.any(String),
      });
      if (
        typeof result !== "object" ||
        result === null ||
        !("authorityHandle" in result) ||
        typeof result.authorityHandle !== "string"
      ) {
        throw new Error("Missing captured School settings authority");
      }
      return result.authorityHandle;
    },
  };
}

describe("installed SDK School settings authority", () => {
  it("rejects the same account's replacement session before capture, then accepts a fresh matching session", async () => {
    const h = await harness();
    h.replaceSession("A2");
    await expect(
      h.port.captureSchoolSettingsAuthority(accounts.A, providerSessionIds.A),
    ).resolves.toEqual({ status: "rejected" });
    expect(h.mutations()).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.request.headers.get("authorization")).toBe(
      `Bearer ${h.sessions.A2.access_token}`,
    );
    expect(h.sessionUnchanged("A2")).toBe(true);
    const fresh = await h.port.captureSchoolSettingsAuthority(
      accounts.A,
      replacementSessionId,
    );
    expect(fresh).toMatchObject({ status: "ready" });
  });

  it("accepts a renewed token for the expected session and freezes it through egress", async () => {
    const h = await harness();
    h.replaceSession("AR");
    const handle = await h.capture();
    h.replaceSession("A2");
    await expect(
      h.port.updateSchoolDisplayName(request, handle),
    ).resolves.toEqual([{ code: "school_display_name_updated" }]);
    expect(h.requests).toHaveLength(2);
    expect(
      h.requests.every(
        ({ request }) =>
          request.headers.get("authorization") ===
          `Bearer ${h.sessions.AR.access_token}`,
      ),
    ).toBe(true);
    expect(h.sessionUnchanged("A2")).toBe(true);
  });

  it.each(["during verification", "after capture"] as const)(
    "keeps original S1 when same-account S2 enters storage %s",
    async (timing) => {
      const h = await harness();
      const gate =
        timing === "during verification" ? h.hold("/auth/v1/user") : undefined;
      const capture = h.capture();
      let handle: string;
      if (gate !== undefined) {
        await gate.entered.promise;
        h.replaceSession("A2");
        gate.released.resolve();
        handle = await capture;
      } else {
        handle = await capture;
        h.replaceSession("A2");
      }
      await expect(
        h.port.updateSchoolDisplayName(request, handle),
      ).resolves.toEqual([{ code: "school_display_name_updated" }]);
      expect(h.mutations()).toHaveLength(1);
      expect(
        h.requests.every(
          ({ request }) =>
            request.headers.get("authorization") ===
            `Bearer ${h.sessions.A.access_token}`,
        ),
      ).toBe(true);
      expect(h.sessionUnchanged("A2")).toBe(true);
    },
  );

  it("rejects replacement B before capture without a verification or mutation request", async () => {
    const h = await harness();
    h.replaceAccount();
    await expect(
      h.port.captureSchoolSettingsAuthority(accounts.A, providerSessionIds.A),
    ).resolves.toEqual({ status: "rejected" });
    expect(h.requests).toEqual([]);
    expect(h.getSession).toHaveBeenCalledOnce();
    expect(h.replacementUnchanged()).toBe(true);
  });

  it.each(["during verification", "after capture"] as const)(
    "uses only captured token A when SDK storage becomes B %s",
    async (timing) => {
      const h = await harness();
      let handle: string;
      if (timing === "during verification") {
        const gate = h.hold("/auth/v1/user");
        const capture = h.capture();
        await gate.entered.promise;
        h.replaceAccount();
        gate.released.resolve();
        handle = await capture;
      } else {
        handle = await h.capture();
        h.replaceAccount();
      }
      await expect(
        h.port.updateSchoolDisplayName(request, handle),
      ).resolves.toEqual([{ code: "school_display_name_updated" }]);
      expect(h.requests.map(({ account }) => account)).toEqual(["A", "A"]);
      const mutation = h.mutations()[0]!;
      expect(mutation.body).toEqual({
        display_name: request.displayName,
        expected_settings_revision: 7,
        workspace_id: request.schoolId,
      });
      expect(Object.fromEntries(mutation.request.headers)).toEqual({
        apikey: publishableKey,
        authorization: `Bearer ${h.sessions.A.access_token}`,
        "content-type": "application/json",
        "content-profile": "desmoslock_v2",
      });
      expect(mutation.request.credentials).toBe("omit");
      expect(mutation.request.redirect).toBe("error");
      expect(mutation.request.referrerPolicy).toBe("no-referrer");
      expect(h.getSession).toHaveBeenCalledOnce();
      expect(h.replacementUnchanged()).toBe(true);
    },
  );

  it.each([
    [
      { code: "session_not_found", message: "Synthetic ended session" },
      403,
      "ended",
    ],
    [
      { code: "session_expired", message: "Synthetic expired session" },
      401,
      "ended",
    ],
    [{ id: accounts.B }, 200, "rejected"],
    [{}, 200, "unavailable"],
    [
      { code: "session_expired", message: "Synthetic dependency failure" },
      503,
      "unavailable",
    ],
  ] as const)(
    "bounds capture verification %j at HTTP %s as %s",
    async (body, status, expected) => {
      const h = await harness();
      h.setVerification(body, status);
      await expect(
        h.port.captureSchoolSettingsAuthority(accounts.A, providerSessionIds.A),
      ).resolves.toEqual({ status: expected });
      expect(h.requests).toHaveLength(1);
      expect(h.mutations()).toEqual([]);
    },
  );

  it("invalidates a pending capture on reset and cannot return its late authority", async () => {
    const h = await harness();
    const gate = h.hold("/auth/v1/user");
    const capture = h.port.captureSchoolSettingsAuthority(
      accounts.A,
      providerSessionIds.A,
    );
    await gate.entered.promise;
    h.port.clearPrivateAuthContinuations();
    gate.released.resolve();
    await expect(capture).resolves.toEqual({ status: "unavailable" });
    expect(h.mutations()).toEqual([]);
  });

  it.each([
    ["updated", [{ code: "school_display_name_updated" }]],
    ["unchanged", [{ code: "school_display_name_unchanged" }]],
    ["conflict", [{ code: "school_settings_revision_conflict" }]],
    ["lost", null],
    ["bad_json", null],
    ["http_error", null],
    ["redirected", null],
  ] as const)(
    "returns bounded raw RPC transport outcome %s without retry",
    async (outcome, expected) => {
      const h = await harness();
      const handle = await h.capture();
      h.setOutcome(outcome);
      h.replaceAccount();
      await expect(
        h.port.updateSchoolDisplayName(request, handle),
      ).resolves.toEqual(expected);
      expect(h.mutations()).toHaveLength(1);
      expect(h.mutations()[0]?.account).toBe("A");
      expect(h.getSession).toHaveBeenCalledOnce();
      expect(h.replacementUnchanged()).toBe(true);
    },
  );

  it.each(["capture", "mutation"] as const)(
    "times out a stalled %s at five seconds and ignores a late response without retry",
    async (phase) => {
      const h = await harness();
      vi.useFakeTimers();
      const handle = phase === "mutation" ? await h.capture() : null;
      const gate = h.hold(phase === "capture" ? "/auth/v1/user" : settingsPath);
      const operation =
        handle === null
          ? h.port.captureSchoolSettingsAuthority(
              accounts.A,
              providerSessionIds.A,
            )
          : h.port.updateSchoolDisplayName(request, handle);
      const signal = await gate.entered.promise;
      const settled = vi.fn();
      void operation.then(settled);
      h.replaceAccount();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const expected = phase === "capture" ? { status: "unavailable" } : null;
      await expect(operation).resolves.toEqual(expected);
      expect(signal.aborted).toBe(true);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expected);
      gate.released.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledOnce();
      expect(h.mutations()).toHaveLength(phase === "capture" ? 0 : 1);
      expect(h.getSession).toHaveBeenCalledOnce();
      expect(h.replacementUnchanged()).toBe(true);
    },
  );
});
