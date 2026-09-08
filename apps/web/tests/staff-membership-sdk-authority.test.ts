import { createStaffAuthSessionStorageFixture } from "./helpers/staff-auth-session-storage-fixture.js";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createSupabaseStaffAuthAdapter } from "../src/auth/supabase-staff-auth-adapter.js";
import type { StaffAuthMutation } from "../src/auth/staff-auth-controller.js";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backend = "https://membership-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-membership-sdk-session";
const schoolId = "11000000-0000-4000-8000-000000000001";
const targetId = "21000000-0000-4000-8000-000000000003";
const invitationId = "41000000-0000-4000-8000-000000000001";
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
const commandTypes = [
  "create_staff_invitation",
  "revoke_staff_invitation",
  "revoke_staff_membership",
  "change_staff_membership_role",
] as const;
type ManagementCommand = (typeof commandTypes)[number];
const mutationPaths = [
  "/functions/v1/staff-invitations",
  "/rest/v1/rpc/revoke_staff_invitation",
  "/rest/v1/rpc/revoke_membership",
  "/rest/v1/rpc/change_membership_role",
];

function unavailableMutation(type: ManagementCommand) {
  return type === "create_staff_invitation"
    ? { code: "service_unavailable", ok: false }
    : null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function session(
  account: Account,
  providerSessionId = providerSessionIds[account],
  tokenVersion = 0,
) {
  const now = Math.floor(Date.now() / 1_000);
  const user = {
    id: accounts[account],
    app_metadata: {},
    aud: "authenticated",
    role: "authenticated",
    user_metadata: {},
    created_at: "2026-09-01T00:00:00.000Z",
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    email: `owner-${account.toLowerCase()}@example.test`,
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
      session_id: providerSessionId,
      jti: String(tokenVersion),
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

// The installed SDK, real adapter and real port run together. Every HTTP request
// terminates in these synthetic responders; this suite is not database proof.
async function harness() {
  const sessions = {
    A: session("A"),
    B: session("B"),
    A2: session("A", replacementSessionId),
    AR: session("A", providerSessionIds.A, 1),
  };
  const storage = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const removals: string[] = [];
  const requests: Array<{
    account: Account | "unknown";
    path: string;
    method: string;
    body: string;
  }> = [];
  const sessionRequests: Array<{
    variant: SessionVariant | undefined;
    method: string;
    path: string;
  }> = [];
  const ended = new Set<Account>();
  let roleOutcome: "acknowledged" | "lost" | "malformed" = "acknowledged";
  let targetRole = "teacher";
  let hold:
    | {
        path: string;
        entered: ReturnType<typeof deferred>;
        released: ReturnType<typeof deferred>;
      }
    | undefined;
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const variant = (Object.keys(sessions) as SessionVariant[]).find(
      (key) => authorization === `Bearer ${sessions[key].access_token}`,
    );
    const account =
      variant === undefined ? "unknown" : variant === "B" ? "B" : "A";
    sessionRequests.push({
      variant,
      method: request.method,
      path: url.pathname,
    });
    if (url.origin !== backend || account === "unknown")
      throw new Error("Unexpected synthetic SDK request");
    requests.push({
      account,
      path: url.pathname,
      method: request.method,
      body: request.method === "GET" ? "" : await request.text(),
    });
    if (hold?.path === url.pathname) {
      const gate = hold;
      hold = undefined;
      gate.entered.resolve();
      await gate.released.promise;
    }
    const respond = (body: unknown, status = 200) => {
      const response = Response.json(body, {
        headers: { "x-supabase-api-version": "2024-01-01" },
        status,
      });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    };
    if (url.pathname === "/auth/v1/user" && request.method === "GET")
      return ended.has(account)
        ? respond(
            { code: "session_not_found", message: "Synthetic ended session" },
            403,
          )
        : respond(sessions[account].user);
    if (url.pathname === "/rest/v1/rpc/current_staff_context")
      return respond([
        {
          code: "ok",
          display_name: "Synthetic Owner",
          membership_role: "owner",
          profile_id: `21000000-0000-4000-8000-00000000000${account === "A" ? "1" : "2"}`,
          role_revision: 8,
          school_id: schoolId,
          school_name: "Synthetic School",
          school_settings_revision: 1,
          school_slug: "synthetic-school",
        },
      ]);
    if (url.pathname === "/rest/v1/rpc/current_manageable_staff")
      return respond([
        {
          code: "ok",
          display_name: "Synthetic Target",
          email: "target@example.test",
          membership_role: targetRole,
          profile_id: targetId,
          role_revision: targetRole === "teacher" ? 3 : 4,
          school_id: schoolId,
        },
      ]);
    if (url.pathname === "/rest/v1/rpc/current_manageable_staff_invitations")
      return respond([
        {
          code: "ok",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          invitation_id: invitationId,
          invitation_status: "pending_acceptance",
          invited_email: "invited@example.test",
          invited_role: "teacher",
          school_id: schoolId,
        },
      ]);
    if (url.pathname === mutationPaths[0])
      return respond({ ok: true, code: "invitation_created" });
    if (url.pathname === mutationPaths[1])
      return respond([{ code: "invitation_revoked" }]);
    if (url.pathname === mutationPaths[2])
      return respond([{ code: "membership_revoked" }]);
    if (url.pathname === mutationPaths[3]) {
      targetRole = "admin";
      if (roleOutcome === "lost")
        throw new Error("private-synthetic-role-diagnostic");
      return respond(
        roleOutcome === "malformed"
          ? [{ role: targetRole }]
          : [{ code: "membership_role_changed" }],
      );
    }
    throw new Error("Unexpected synthetic SDK endpoint");
  };
  const sessionStorage = createStaffAuthSessionStorageFixture(
    storageKey,
    storage,
  );
  const removeItem = sessionStorage.removeItem.bind(sessionStorage);
  sessionStorage.removeItem = async (key) => {
    removals.push(key);
    await removeItem(key);
  };
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
  const port = createSupabaseStaffAuthPort({
    sessionStorage,
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: intercepted,
    origin: "https://app.example.test",
    publishableKey,
    url: backend,
  });
  let sequence = 1;
  const adapter = createSupabaseStaffAuthAdapter({
    clock: { now: Date.now },
    createBlobUrl: () => {
      throw new Error("Unexpected presentation");
    },
    operationIds: {
      next: () =>
        `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    },
    port,
    revokeBlobUrl: () => undefined,
  });
  const actor = await adapter.read();
  if (
    actor.kind !== "access_granted" ||
    actor.identity.accountId !== accounts.A
  )
    throw new Error("Expected visible A");
  const expectedIdentityGeneration = actor.identityGeneration;
  const expectedSessionGeneration = actor.sessionGeneration;
  requests.length = 0;
  sessionRequests.length = 0;
  removals.length = 0;
  function command(type: ManagementCommand): StaffAuthMutation {
    const common = {
      expectedIdentityGeneration,
      expectedSessionGeneration,
      operationId: "90000000-0000-4000-8000-000000000001",
      schoolId,
    };
    switch (type) {
      case "create_staff_invitation":
        return {
          ...common,
          type,
          email: "invited@example.test",
          targetRole: "teacher",
        };
      case "revoke_staff_invitation":
        return { ...common, type, invitationId };
      case "revoke_staff_membership":
        return {
          ...common,
          type,
          profileId: targetId,
          expectedRoleRevision: 3,
        };
      case "change_staff_membership_role":
        return {
          ...common,
          type,
          profileId: targetId,
          expectedRoleRevision: 3,
          targetRole: "admin",
        };
    }
  }
  function write(type: ManagementCommand, authorityHandle: string) {
    switch (type) {
      case "create_staff_invitation":
        return port.invokeInvitation(
          { email: "invited@example.test", role: "teacher", schoolId },
          authorityHandle,
        );
      case "revoke_staff_invitation":
        return port.revokeInvitation({ invitationId }, authorityHandle);
      case "revoke_staff_membership":
        return port.revokeMembership(
          { expectedRoleRevision: 3, profileId: targetId, schoolId },
          authorityHandle,
        );
      case "change_staff_membership_role":
        return port.changeMembershipRole(
          {
            expectedRoleRevision: 3,
            profileId: targetId,
            role: "administrator",
            schoolId,
          },
          authorityHandle,
        );
    }
  }
  return {
    sessions,
    sessionStorage,
    port,
    write,
    async capture() {
      const captured = await port.captureStaffManagementAuthority(
        accounts.A,
        providerSessionIds.A,
      );
      expect(captured).toEqual({
        status: "ready",
        authorityHandle: expect.any(String),
      });
      if (
        typeof captured !== "object" ||
        captured === null ||
        !("authorityHandle" in captured) ||
        typeof captured.authorityHandle !== "string"
      )
        throw new Error("Missing management handle");
      return captured.authorityHandle;
    },
    sessionRequests,
    async replaceSession(variant: SessionVariant) {
      await sessionStorage.setItem(
        storageKey,
        JSON.stringify(sessions[variant]),
      );
    },
    sessionUnchanged: (variant: SessionVariant) =>
      storage.get(storageKey) === JSON.stringify(sessions[variant]),
    initialAuthority: actor,
    adapter,
    command,
    ended,
    requests,
    removals,
    mutations: () =>
      requests.filter(({ path }) => mutationPaths.includes(path)),
    async replaceWithB() {
      await sessionStorage.setItem(storageKey, JSON.stringify(sessions.B));
    },
    bIsUnchanged: () => storage.get(storageKey) === JSON.stringify(sessions.B),
    hold(path: string) {
      const gate = { path, entered: deferred(), released: deferred() };
      hold = gate;
      return gate;
    },
    setRoleOutcome(value: typeof roleOutcome) {
      roleOutcome = value;
    },
    dispose() {
      hold?.released.resolve();
      adapter.dispose();
      port.clearPrivateAuthContinuations();
      client.auth.stopAutoRefresh();
    },
  };
}

describe("installed SDK staff management authority", () => {
  describe.each(["A2", "B"] as const)("committed replacement %s", (variant) => {
    it.each(commandTypes)(
      "blocks %s before egress after a completed authority read and preserves replacement bytes/version",
      async (type) => {
        const test = await harness();
        try {
          const handle = await test.capture();
          expect(await test.adapter.read()).toMatchObject({
            kind: "access_granted",
          });
          await test.replaceSession(variant);
          const replacement = await test.sessionStorage.readSessionSnapshot();
          const priorRequests = test.requests.length;
          const outcome = await test.write(type, handle);
          expect.soft(outcome).toEqual(unavailableMutation(type));
          expect(test.requests).toHaveLength(priorRequests);
          expect.soft(test.mutations()).toEqual([]);
          expect(
            test.sessionRequests.every(({ variant }) => variant === "A"),
          ).toBe(true);
          expect(await test.sessionStorage.readSessionSnapshot()).toEqual(
            replacement,
          );
          expect(test.sessionUnchanged(variant)).toBe(true);
          expect(test.removals).toEqual([]);
        } finally {
          test.dispose();
        }
      },
    );
  });

  it.each(["A2", "B"] as const)(
    "refuses a pending management capture when %s commits during user verification",
    async (variant) => {
      const test = await harness();
      const gate = test.hold("/auth/v1/user");
      try {
        const pending = test.port.captureStaffManagementAuthority(
          accounts.A,
          providerSessionIds.A,
        );
        await gate.entered.promise;
        await test.replaceSession(variant);
        const replacement = await test.sessionStorage.readSessionSnapshot();
        gate.released.resolve();
        await expect(pending).resolves.toEqual({ status: "unavailable" });
        expect(test.mutations()).toEqual([]);
        expect(test.sessionRequests).toEqual([
          { variant: "A", method: "GET", path: "/auth/v1/user" },
        ]);
        expect(await test.sessionStorage.readSessionSnapshot()).toEqual(
          replacement,
        );
        expect(test.sessionUnchanged(variant)).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        gate.released.resolve();
        test.dispose();
      }
    },
  );

  describe.each(["A2", "B"] as const)(
    "replacement %s during a started mutation",
    (variant) => {
      it.each(commandTypes)(
        "retains A for %s, discards the late result, and never retries",
        async (type) => {
          const test = await harness();
          const gate = test.hold(mutationPaths[commandTypes.indexOf(type)]!);
          try {
            const handle = await test.capture();
            const pending = test.write(type, handle);
            await gate.entered.promise;
            await test.replaceSession(variant);
            const replacement = await test.sessionStorage.readSessionSnapshot();
            gate.released.resolve();
            await expect(pending).resolves.toEqual(unavailableMutation(type));
            expect(test.mutations()).toHaveLength(1);
            expect(
              test.sessionRequests.every(({ variant }) => variant === "A"),
            ).toBe(true);
            const priorRequests = test.requests.length;
            await expect(test.write(type, handle)).resolves.toEqual(
              unavailableMutation(type),
            );
            expect(test.requests).toHaveLength(priorRequests);
            expect(test.mutations()).toHaveLength(1);
            expect(await test.sessionStorage.readSessionSnapshot()).toEqual(
              replacement,
            );
            expect(test.sessionUnchanged(variant)).toBe(true);
            expect(test.removals).toEqual([]);
          } finally {
            gate.released.resolve();
            test.dispose();
          }
        },
      );
    },
  );

  it.each(commandTypes)(
    "%s refuses same-account S2 replacing S1 before capture without waiting for an auth event",
    async (type) => {
      const test = await harness();
      let events = 0;
      const unsubscribe = test.adapter.subscribe(() => {
        events += 1;
      });
      try {
        await test.replaceSession("A2");
        await expect(test.adapter.perform(test.command(type))).rejects.toThrow(
          "authority",
        );
        expect(events).toBe(0);
        expect(test.mutations()).toEqual([]);
        expect(test.sessionRequests).toEqual([
          { variant: "A2", method: "GET", path: "/auth/v1/user" },
        ]);
        expect(test.sessionUnchanged("A2")).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        unsubscribe();
        test.dispose();
      }
    },
  );

  it.each(["A2", "AR"] as const)(
    "a later verified %s read updates only the generation required by provider session continuity",
    async (variant) => {
      const test = await harness();
      let events = 0;
      const unsubscribe = test.adapter.subscribe(() => {
        events += 1;
      });
      try {
        const initial = test.initialAuthority;
        expect(initial.providerSessionId).toBe(providerSessionIds.A);
        await test.replaceSession(variant);
        const fresh = await test.adapter.read();
        expect(fresh.kind).toBe("access_granted");
        if (fresh.kind !== "access_granted")
          throw new Error("Expected fresh grant");
        expect(fresh.identityGeneration).toBe(initial.identityGeneration);
        expect(fresh.providerSessionId).toBe(
          variant === "A2" ? replacementSessionId : providerSessionIds.A,
        );
        if (variant === "A2")
          expect(fresh.sessionGeneration).not.toBe(initial.sessionGeneration);
        else expect(fresh.sessionGeneration).toBe(initial.sessionGeneration);
        const repeated = await test.adapter.read();
        expect(repeated).toMatchObject({
          kind: "access_granted",
          identityGeneration: fresh.identityGeneration,
          sessionGeneration: fresh.sessionGeneration,
          providerSessionId: fresh.providerSessionId,
        });
        expect(events).toBe(0);
        expect(test.mutations()).toEqual([]);
        expect(test.sessionUnchanged(variant)).toBe(true);
      } finally {
        unsubscribe();
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s accepts a renewed token in S1 using the existing visible grant",
    async (type) => {
      const test = await harness();
      try {
        await test.replaceSession("AR");
        await test.adapter.perform(test.command(type));
        expect(test.mutations()).toHaveLength(1);
        expect(
          test.sessionRequests.every(({ variant }) => variant === "AR"),
        ).toBe(true);
        const fresh = await test.adapter.read();
        expect(fresh).toMatchObject({
          kind: "access_granted",
          providerSessionId: providerSessionIds.A,
          identityGeneration: test.initialAuthority.identityGeneration,
          sessionGeneration: test.initialAuthority.sessionGeneration,
        });
        expect(test.sessionUnchanged("AR")).toBe(true);
      } finally {
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s stops before mutation when S2 invalidates the captured authority reread",
    async (type) => {
      const test = await harness();
      const gate = test.hold("/rest/v1/rpc/current_manageable_staff");
      try {
        const pending = test.adapter.perform(test.command(type));
        await gate.entered.promise;
        await test.replaceSession("A2");
        gate.released.resolve();
        await expect(pending).rejects.toThrow(
          "Staff management dependency is unavailable",
        );
        const mutations = test.sessionRequests.filter(({ path }) =>
          mutationPaths.includes(path),
        );
        expect(mutations).toHaveLength(0);
        expect(test.sessionUnchanged("A2")).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        gate.released.resolve();
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s refuses replacement B before capture and cannot recapture it by replay",
    async (type) => {
      const test = await harness();
      try {
        const command = test.command(type);
        await test.replaceWithB();
        await expect(test.adapter.perform(command)).rejects.toThrow(
          "authority",
        );
        await expect(test.adapter.perform(command)).rejects.toThrow("re-entry");
        expect(test.mutations()).toEqual([]);
        expect(test.bIsUnchanged()).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s reports an ended session without replacing or removing its cache",
    async (type) => {
      const test = await harness();
      try {
        test.ended.add("A");
        const before = await test.sessionStorage.readSessionSnapshot();
        expect(await test.adapter.perform(test.command(type))).toMatchObject({
          result: { kind: "signed_out" },
        });
        expect(test.mutations()).toEqual([]);
        expect(await test.sessionStorage.readSessionSnapshot()).toEqual(before);
        expect(test.sessionUnchanged("A")).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s reports stale capture as unavailable and preserves B even if A ended",
    async (type) => {
      const test = await harness();
      try {
        const gate = test.hold("/auth/v1/user");
        const pending = test.adapter.perform(test.command(type));
        await gate.entered.promise;
        await test.replaceWithB();
        test.ended.add("A");
        gate.released.resolve();
        await expect(pending).rejects.toThrow(
          "Staff management authority is unavailable",
        );
        expect(test.mutations()).toEqual([]);
        expect(test.bIsUnchanged()).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        test.dispose();
      }
    },
  );

  it.each(commandTypes)(
    "%s stops before mutation when B invalidates the captured authority reread",
    async (type) => {
      const test = await harness();
      try {
        const gate = test.hold("/rest/v1/rpc/current_manageable_staff");
        const pending = test.adapter.perform(test.command(type));
        await gate.entered.promise;
        await test.replaceWithB();
        gate.released.resolve();
        await expect(pending).rejects.toThrow(
          "Staff management dependency is unavailable",
        );
        expect(test.mutations()).toHaveLength(0);
        expect(test.bIsUnchanged()).toBe(true);
        expect(test.removals).toEqual([]);
        const priorRequests = test.requests.length;
        await expect(test.adapter.perform(test.command(type))).rejects.toThrow(
          "re-entry",
        );
        expect(test.requests).toHaveLength(priorRequests);
      } finally {
        test.dispose();
      }
    },
  );

  it.each(["lost", "malformed"] as const)(
    "does not infer role success or repeat a %s mutation even when the target changed",
    async (outcome) => {
      const test = await harness();
      try {
        test.setRoleOutcome(outcome);
        const command = test.command("change_staff_membership_role");
        const result = await test.adapter.perform(command);
        expect(result).toEqual({
          operationId: command.operationId,
          result: { kind: "staff_membership_role_change_unconfirmed" },
        });
        expect(test.mutations()).toHaveLength(1);
        const priorRequests = test.requests.length;
        await test.replaceWithB();
        await expect(test.adapter.perform(command)).rejects.toThrow("re-entry");
        expect(test.requests).toHaveLength(priorRequests);
        expect(test.bIsUnchanged()).toBe(true);
        expect(test.removals).toEqual([]);
      } finally {
        test.dispose();
      }
    },
  );

  it("discards a role response delivered after the adapter was disposed", async () => {
    const test = await harness();
    try {
      const gate = test.hold("/rest/v1/rpc/change_membership_role");
      const pending = test.adapter.perform(
        test.command("change_staff_membership_role"),
      );
      await gate.entered.promise;
      test.adapter.dispose();
      await test.replaceWithB();
      gate.released.resolve();
      await expect(pending).rejects.toThrow("disposed");
      expect(test.mutations()).toHaveLength(1);
      expect(test.mutations()[0]?.account).toBe("A");
      expect(test.bIsUnchanged()).toBe(true);
      expect(test.removals).toEqual([]);
    } finally {
      test.dispose();
    }
  });
});
