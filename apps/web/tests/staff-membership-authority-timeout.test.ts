import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseStaffAuthAdapter } from "../src/auth/supabase-staff-auth-adapter.js";
import {
  createStaffAuthController,
  type StaffAuthSnapshot,
} from "../src/auth/staff-auth-controller.js";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backend = "https://membership-timeout.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const accountId = "a1000000-0000-4000-8000-000000000001";
const schoolId = "11000000-0000-4000-8000-000000000001";
const profileId = "21000000-0000-4000-8000-000000000001";
const contextPath = "/rest/v1/rpc/current_staff_context";

function syntheticSession() {
  const now = Math.floor(Date.now() / 1_000);
  const user = {
    id: accountId,
    app_metadata: {},
    aud: "authenticated",
    role: "authenticated",
    user_metadata: {},
    created_at: "2026-09-01T00:00:00.000Z",
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    email: "owner@example.test",
    factors: [
      {
        id: "51000000-0000-4000-8000-000000000001",
        factor_type: "totp",
        status: "verified",
      },
    ],
  };
  const accessToken = [
    { alg: "HS256", typ: "JWT" },
    {
      aal: "aal2",
      amr: [
        { method: "password", timestamp: now },
        { method: "totp", timestamp: now },
      ],
      aud: "authenticated",
      exp: now + 3_600,
      iat: now,
      role: "authenticated",
      session_id: "b1000000-0000-4000-8000-000000000001",
      sub: accountId,
    },
    "synthetic-signature",
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    access_token: accessToken,
    expires_at: now + 3_600,
    expires_in: 3_600,
    refresh_token: "synthetic-timeout-refresh",
    token_type: "bearer",
    user,
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

// This composes the installed SDK, real port, adapter and controller. All HTTP
// terminates here; synthetic responses prove browser authority lifecycle only.
async function harness() {
  const session = syntheticSession();
  const storageKey = "synthetic-membership-timeout-session";
  const storage = new Map([[storageKey, JSON.stringify(session)]]);
  const requests: Array<{ path: string; signal: AbortSignal }> = [];
  const unexpectedRequests: string[] = [];
  const gates: Array<{
    entered: ReturnType<typeof Promise.withResolvers<AbortSignal>>;
    released: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  let hold: (typeof gates)[number] | undefined;
  let role: "owner" | "teacher" = "owner";
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== backend ||
      request.headers.get("authorization") !== `Bearer ${session.access_token}`
    ) {
      unexpectedRequests.push(url.href);
      throw new Error("Unexpected synthetic authority request");
    }
    requests.push({ path: url.pathname, signal: request.signal });
    const respond = (body: unknown) => {
      const response = Response.json(body, {
        headers: { "x-supabase-api-version": "2024-01-01" },
      });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    };
    if (url.pathname === "/auth/v1/user" && request.method === "GET")
      return respond(session.user);
    if (url.pathname === contextPath && request.method === "POST") {
      // Capture the old role before the hold. Deliberately ignore abort so a
      // late response tests the consumer's deadline, not a cooperative fetch.
      const rows = [
        {
          code: "ok",
          display_name: "Synthetic Staff",
          membership_role: role,
          profile_id: profileId,
          role_revision: role === "owner" ? 8 : 9,
          school_id: schoolId,
          school_name: "Synthetic School",
          school_slug: "synthetic-school",
        },
      ];
      if (hold !== undefined) {
        const gate = hold;
        hold = undefined;
        gate.entered.resolve(request.signal);
        await gate.released.promise;
      }
      return respond(rows);
    }
    if (
      url.pathname === "/rest/v1/rpc/current_manageable_staff" &&
      request.method === "POST"
    )
      return respond([
        {
          code: "ok",
          display_name: "Synthetic Target",
          email: "target@example.test",
          membership_role: "teacher",
          profile_id: "21000000-0000-4000-8000-000000000003",
          role_revision: 3,
          school_id: schoolId,
        },
      ]);
    if (
      url.pathname === "/rest/v1/rpc/current_manageable_staff_invitations" &&
      request.method === "POST"
    )
      return respond([]);
    unexpectedRequests.push(url.href);
    throw new Error("Unexpected synthetic authority endpoint");
  };
  const client = createClient(backend, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
    },
    global: { fetch: intercepted },
  });
  await client.auth.getSession();
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: intercepted,
    origin: "https://app.example.test",
    publishableKey,
    url: backend,
  });
  let sequence = 0;
  const operationIds = {
    next: () =>
      `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
  const adapter = createSupabaseStaffAuthAdapter({
    clock: { now: Date.now },
    createBlobUrl: () => {
      throw new Error("Unexpected authentication presentation");
    },
    operationIds,
    port,
    revokeBlobUrl: () => undefined,
  });
  const published: StaffAuthSnapshot[] = [];
  const clear = vi.fn();
  const controller = createStaffAuthController({
    adapter,
    callback: {
      flows: {
        async consume() {
          return { status: "invalid" };
        },
        async create() {
          throw new Error("Unexpected recovery flow");
        },
      },
      history: { replaceState() {} },
      route: { origin: "https://app.example.test", pathname: "/" },
    },
    clock: { now: Date.now },
    operationIds,
    protectedSchoolData: { clear },
  });
  controller.subscribe((snapshot) => published.push(snapshot));
  cleanups.push(() => {
    controller.dispose();
    adapter.dispose();
    port.clearPrivateAuthContinuations();
    client.auth.stopAutoRefresh();
    for (const gate of gates) gate.released.resolve();
    expect(unexpectedRequests).toEqual([]);
  });
  await controller.dispatch({ type: "bootstrap" });
  await vi.waitFor(() => {
    expect(controller.getSnapshot()).toMatchObject({
      assuranceLevel: "aal2",
      identity: { membership: { role: "owner" } },
      kind: "authenticated",
      manageableStaff: [expect.objectContaining({ role: "teacher" })],
    });
  });
  await controller.refreshMembership();
  published.length = 0;
  requests.length = 0;
  clear.mockClear();
  return {
    clear,
    controller,
    published,
    contextRequests: () => requests.filter(({ path }) => path === contextPath),
    downgrade() {
      role = "teacher";
    },
    holdContext() {
      const gate = {
        entered: Promise.withResolvers<AbortSignal>(),
        released: Promise.withResolvers<void>(),
      };
      gates.push(gate);
      hold = gate;
      return gate;
    },
    emitProviderSignIn() {
      return client.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    },
  };
}

describe("composed Membership authority read deadlines", () => {
  it("clears protected state after a stalled quiet read and recovers without accepting its late Owner response", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const owner = h.controller.getSnapshot();
    const gate = h.holdContext();
    const refresh = h.controller.refreshMembership();
    const signal = await gate.entered.promise;
    h.downgrade();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.controller.getSnapshot()).toBe(owner);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
      retryable: true,
    });
    expect(signal.aborted).toBe(true);
    expect(h.clear).toHaveBeenCalledOnce();
    await expect(refresh).resolves.toBe(h.controller.getSnapshot());

    const recovered = await h.controller.dispatch({ type: "bootstrap" });
    expect(recovered).toMatchObject({
      identity: { membership: { role: "teacher" } },
      kind: "authenticated",
      manageableInvitations: [],
      manageableStaff: [],
    });
    expect(h.contextRequests()).toHaveLength(2);
    const publications = [...h.published];
    gate.released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toBe(recovered);
    expect(h.published).toEqual(publications);

    await expect(h.controller.refreshMembership()).resolves.toBe(recovered);
    expect(h.contextRequests()).toHaveLength(3);
    expect(h.published).toEqual(publications);
  });

  it("invalidates access immediately on an SDK auth event and unblocks its fresh read when the old quiet read times out", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const gate = h.holdContext();
    const refresh = h.controller.refreshMembership();
    const signal = await gate.entered.promise;
    h.downgrade();

    expect((await h.emitProviderSignIn()).error).toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.published.map(({ kind }) => kind)).toEqual(["bootstrapping"]);
    expect(h.contextRequests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(h.contextRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await refresh;
    const recovered = h.controller.getSnapshot();
    expect(recovered).toMatchObject({
      identity: { membership: { role: "teacher" } },
      kind: "authenticated",
      manageableInvitations: [],
      manageableStaff: [],
    });
    expect(h.contextRequests()).toHaveLength(2);
    expect(h.published.map(({ kind }) => kind)).toEqual([
      "bootstrapping",
      "authenticated",
    ]);

    const publications = [...h.published];
    gate.released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toBe(recovered);
    expect(h.published).toEqual(publications);
    await expect(h.controller.refreshMembership()).resolves.toBe(recovered);
    expect(h.contextRequests()).toHaveLength(3);
  });
});
