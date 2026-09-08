import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStaffAuthController,
  type StaffAuthAccessEvent,
  type StaffAuthAccessGrant,
  type StaffAuthAction,
  type StaffAuthAdapter,
  type StaffAuthBoundaryResult,
  type StaffAuthController,
  type StaffAuthMutationResult,
  type StaffAuthSnapshot,
  type StorageStaffRole,
} from "../src/auth/staff-auth-controller.js";

function access(
  role: StorageStaffRole = "owner",
  targetRevision = 1,
): StaffAuthAccessGrant {
  return {
    assuranceLevel: role === "teacher" ? "aal1" : "aal2",
    identity: {
      accountId: "account-current",
      email: "current@example.test",
      membership: {
        id: "membership-current",
        role,
        status: "active",
      },
      profile: { displayName: "Current Staff", id: "profile-current" },
      school: { id: "school-alpha", label: "Alpha School" },
    },
    identityGeneration: `identity-${role}`,
    kind: "access_granted",
    manageableInvitations:
      role === "teacher"
        ? []
        : [
            {
              email: "invited@example.test",
              expiresAt: "2026-09-30T12:00:00.000Z",
              invitationId: "invitation-teacher",
              role: "teacher",
              schoolId: "school-alpha",
              state: "pending",
            },
          ],
    manageableStaff:
      role === "teacher"
        ? []
        : [
            {
              profile: {
                displayName: "Target Teacher",
                email: "target@example.test",
                id: "profile-target",
              },
              role: "teacher",
              roleRevision: targetRevision,
              schoolId: "school-alpha",
            },
          ],
    secondFactor: "satisfied",
    sessionGeneration: "session-current",
  };
}

const controllers: StaffAuthController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function harness(initial: StaffAuthBoundaryResult = access()) {
  const read = vi.fn<StaffAuthAdapter["read"]>(async () =>
    structuredClone(initial),
  );
  const perform = vi.fn<StaffAuthAdapter["perform"]>(async () => {
    throw new Error("Unexpected Membership mutation");
  });
  const clear = vi.fn();
  const unsubscribe = vi.fn();
  const published: StaffAuthSnapshot[] = [];
  const order: string[] = [];
  let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
  let sequence = 0;
  const controller = createStaffAuthController({
    adapter: {
      perform,
      read,
      subscribe(listener) {
        emit = listener;
        return unsubscribe;
      },
    },
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
    clock: { now: () => Date.parse("2026-09-07T12:00:00.000Z") },
    operationIds: { next: () => `membership-operation-${++sequence}` },
    protectedSchoolData: {
      clear() {
        order.push("clear");
        clear();
      },
    },
  });
  controllers.push(controller);
  controller.subscribe((snapshot) => {
    published.push(snapshot);
    order.push(`state:${snapshot.kind}`);
  });
  return {
    clear,
    controller,
    emitRevalidation() {
      if (emit === undefined) throw new Error("Missing authority subscription");
      emit({ kind: "revalidation_required" });
    },
    order,
    perform,
    published,
    read,
    resetObservations() {
      clear.mockClear();
      published.splice(0);
      order.splice(0);
    },
    unsubscribe,
  };
}

const confirmations = [
  {
    cancel: { type: "cancel_staff_membership_role_change" },
    kind: "confirming_staff_membership_role_change",
    name: "role change",
    review: {
      profileId: "profile-target",
      schoolId: "school-alpha",
      type: "review_staff_membership_role_change",
    },
  },
  {
    cancel: { type: "cancel_staff_membership_revocation" },
    kind: "confirming_staff_membership_revocation",
    name: "Membership revocation",
    review: {
      profileId: "profile-target",
      schoolId: "school-alpha",
      type: "review_staff_membership_revocation",
    },
  },
  {
    cancel: { type: "cancel_staff_invitation_revocation" },
    kind: "confirming_staff_invitation_revocation",
    name: "invitation revocation",
    review: {
      invitationId: "invitation-teacher",
      schoolId: "school-alpha",
      type: "review_staff_invitation_revocation",
    },
  },
] as const satisfies readonly {
  readonly cancel: StaffAuthAction;
  readonly kind: StaffAuthSnapshot["kind"];
  readonly name: string;
  readonly review: StaffAuthAction;
}[];

describe("quiet Membership authority refresh", () => {
  it.each(["owner", "admin", "teacher"] as const)(
    "preserves an unchanged %s snapshot without publishing or clearing protected data",
    async (role) => {
      const h = harness(access(role));
      await h.controller.dispatch({ type: "bootstrap" });
      const before = h.controller.getSnapshot();
      expect(before.kind).toBe("authenticated");
      h.resetObservations();

      expect(await h.controller.refreshMembership()).toBe(before);

      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.controller.getSnapshot()).toBe(before);
      expect(h.published).toEqual([]);
      expect(h.clear).not.toHaveBeenCalled();
      expect(h.perform).not.toHaveBeenCalled();
    },
  );

  it.each(confirmations)(
    "preserves an unchanged $name confirmation without publication",
    async ({ kind, review }) => {
      const h = harness();
      await h.controller.dispatch({ type: "bootstrap" });
      const before = await h.controller.dispatch(review);
      expect(before.kind).toBe(kind);
      h.resetObservations();

      expect(await h.controller.refreshMembership()).toBe(before);
      expect(h.controller.getSnapshot()).toBe(before);
      expect(h.published).toEqual([]);
      expect(h.clear).not.toHaveBeenCalled();
      expect(h.perform).not.toHaveBeenCalled();
    },
  );

  it("coalesces concurrent quiet refreshes and permits a new read after completion", async () => {
    const h = harness();
    await h.controller.dispatch({ type: "bootstrap" });
    const before = h.controller.getSnapshot();
    const pending = Promise.withResolvers<StaffAuthBoundaryResult>();
    h.read.mockImplementationOnce(() => pending.promise);
    h.resetObservations();

    const first = h.controller.refreshMembership();
    const second = h.controller.refreshMembership();
    const third = h.controller.refreshMembership();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.published).toEqual([]);

    pending.resolve(access());
    expect(await Promise.all([first, second, third])).toEqual([
      before,
      before,
      before,
    ]);
    await h.controller.refreshMembership();
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.published).toEqual([]);
  });

  it.each(confirmations)(
    "does not publish a late quiet read after cancelling $name",
    async ({ cancel, review }) => {
      const h = harness();
      await h.controller.dispatch({ type: "bootstrap" });
      await h.controller.dispatch(review);
      const pending = Promise.withResolvers<StaffAuthBoundaryResult>();
      h.read.mockImplementationOnce(() => pending.promise);
      const refresh = h.controller.refreshMembership();

      const cancelled = await h.controller.dispatch(cancel);
      expect(cancelled.kind).toBe("authenticated");
      h.resetObservations();
      pending.resolve(access("owner", 2));
      await refresh;

      expect(h.controller.getSnapshot()).toBe(cancelled);
      expect(h.published).toEqual([]);
      expect(h.perform).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sign_out_local", "local"],
    ["revoke_all_sessions", "all"],
  ] as const)(
    "does not restore access when a quiet read completes during %s",
    async (type, scope) => {
      const h = harness();
      await h.controller.dispatch({ type: "bootstrap" });
      const pending = Promise.withResolvers<StaffAuthBoundaryResult>();
      const mutation = Promise.withResolvers<StaffAuthMutationResult>();
      h.read.mockImplementationOnce(() => pending.promise);
      h.perform.mockImplementationOnce(() => mutation.promise);
      const refresh = h.controller.refreshMembership();

      const logout = h.controller.dispatch({ type });
      const signingOut = h.controller.getSnapshot();
      expect(signingOut).toMatchObject({ kind: "signing_out", scope });
      h.resetObservations();
      pending.resolve(access("owner", 2));
      await refresh;
      expect(h.controller.getSnapshot()).toBe(signingOut);
      expect(h.published).toEqual([]);

      const request = h.perform.mock.calls[0]?.[0];
      if (request === undefined) throw new Error("Missing logout mutation");
      mutation.resolve({
        operationId: request.operationId,
        result: { kind: "sign_out_complete", scope },
      });
      await logout;
      expect(h.controller.getSnapshot().kind).toBe("signed_out");
      expect(h.published.map((snapshot) => snapshot.kind)).toEqual([
        "signed_out",
      ]);
      await h.controller.refreshMembership();
      expect(h.read).toHaveBeenCalledTimes(2);
    },
  );

  it("ignores a late quiet read and queued authority event after disposal", async () => {
    const h = harness();
    await h.controller.dispatch({ type: "bootstrap" });
    const pending = Promise.withResolvers<StaffAuthBoundaryResult>();
    h.read.mockImplementationOnce(() => pending.promise);
    const refresh = h.controller.refreshMembership();
    h.controller.dispose();
    const disposed = h.controller.getSnapshot();
    h.resetObservations();

    h.emitRevalidation();
    pending.resolve(access("owner", 2));
    await refresh;
    await h.controller.refreshMembership();

    expect(disposed.kind).toBe("disposed");
    expect(h.controller.getSnapshot()).toBe(disposed);
    expect(h.published).toEqual([]);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cannot overwrite event-driven revocation with an older quiet read", async () => {
    const h = harness();
    await h.controller.dispatch({ type: "bootstrap" });
    const quiet = Promise.withResolvers<StaffAuthBoundaryResult>();
    const authoritative = Promise.withResolvers<StaffAuthBoundaryResult>();
    h.read.mockImplementationOnce(() => quiet.promise);
    h.read.mockImplementationOnce(() => authoritative.promise);
    const refresh = h.controller.refreshMembership();
    h.resetObservations();

    h.emitRevalidation();
    expect(h.order).toEqual(["clear", "state:bootstrapping"]);
    const revalidating = h.controller.getSnapshot();
    h.resetObservations();
    quiet.resolve(access("owner", 2));
    await refresh;
    expect(h.controller.getSnapshot()).toBe(revalidating);
    expect(h.published).toEqual([]);

    authoritative.resolve({ kind: "membership_inactive" });
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().kind).toBe("membership_inactive"),
    );
    const revoked = h.controller.getSnapshot();
    expect(h.controller.getSnapshot()).toBe(revoked);
    expect(h.published.map((snapshot) => snapshot.kind)).toEqual([
      "membership_inactive",
    ]);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)(
    "does not publish privileged %s access for an AAL1 grant claiming satisfied step-up",
    async (role) => {
      const h = harness(access(role));
      await h.controller.dispatch({ type: "bootstrap" });
      h.read.mockResolvedValue({
        ...access(role),
        assuranceLevel: "aal1",
        manageableInvitations: [],
        manageableStaff: [],
        secondFactor: "satisfied",
      });
      h.resetObservations();

      await h.controller.refreshMembership();

      expect(h.controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
        operation: "bootstrap",
      });
      expect(
        h.published.some((snapshot) => snapshot.kind === "authenticated"),
      ).toBe(false);
      expect(h.perform).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "admin"] as const)(
    "clears protected data and the pending intent before publishing a live %s downgrade",
    async (role) => {
      const h = harness(access(role));
      await h.controller.dispatch({ type: "bootstrap" });
      await h.controller.dispatch({
        profileId: "profile-target",
        schoolId: "school-alpha",
        type: "review_staff_membership_revocation",
      });
      h.read.mockResolvedValue(access("teacher"));
      h.resetObservations();

      await h.controller.refreshMembership();

      expect(h.order).toEqual(["clear", "state:authenticated"]);
      expect(h.controller.getSnapshot()).toMatchObject({
        identity: {
          accountId: "account-current",
          membership: { role: "teacher" },
        },
        kind: "authenticated",
        manageableInvitations: [],
        manageableStaff: [],
        notice: "staff_access_changed",
      });
      expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
        "profile-target",
      );
      await h.controller.dispatch({
        type: "confirm_staff_membership_revocation",
      });
      expect(h.perform).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "teacher" } },
        kind: "authenticated",
      });
    },
  );

  it.each(["membership_inactive", "session_revoked"] as const)(
    "removes management authority before publishing live %s",
    async (kind) => {
      const h = harness();
      await h.controller.dispatch({ type: "bootstrap" });
      await h.controller.dispatch(confirmations[0].review);
      h.read.mockResolvedValue({ kind });
      h.resetObservations();

      await h.controller.refreshMembership();

      expect(h.order[0]).toBe("clear");
      expect(h.published.map((snapshot) => snapshot.kind)).toEqual([kind]);
      expect(h.controller.getSnapshot()).toMatchObject({ kind });
      expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
        "school-alpha",
      );
      await h.controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });
      await h.controller.refreshMembership();
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.perform).not.toHaveBeenCalled();
    },
  );

  it("does not publish replacement access when clearing the previous School fails", async () => {
    const h = harness();
    await h.controller.dispatch({ type: "bootstrap" });
    h.read.mockResolvedValue(access("teacher"));
    h.clear.mockImplementation(() => {
      throw new Error("Protected data cleanup failed");
    });
    h.resetObservations();

    await h.controller.refreshMembership();

    expect(h.controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
    });
    expect(
      h.published.some((snapshot) => snapshot.kind === "authenticated"),
    ).toBe(false);
    expect(h.perform).not.toHaveBeenCalled();
  });
});
