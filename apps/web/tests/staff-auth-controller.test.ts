import { describe, expect, it, vi } from "vitest";

import {
  createStaffAuthController,
  type StaffAuthAccessEvent,
  type StaffAuthAccessGrant,
  type StaffAuthAction,
  type StaffAuthAdapter,
  type StaffAuthBoundaryIdentity,
  type StaffAuthBoundaryManagedInvitation,
  type StaffAuthBoundaryManagedStaff,
  type StaffAuthBoundaryResult,
  type StaffAuthController,
  type StaffAuthMutation,
  type StaffAuthMutationResult,
} from "../src/auth/staff-auth-controller.js";

const invitationTokenHash = "a".repeat(56);
const alternateInvitationTokenHash = "b".repeat(56);

function identity(
  role: "admin" | "owner" | "teacher",
  email = `${role}@example.test`,
): StaffAuthBoundaryIdentity {
  return {
    accountId: `account-${role}`,
    email,
    profile: {
      displayName: `${role} Staff`,
      id: `profile-${role}`,
    },
    membership: {
      id: `membership-${role}`,
      role,
      status: "active",
    },
    school: {
      id: "school-1",
      label: "Synthetic High School",
      settingsRevision: 1,
    },
  };
}

function manageableStaff(): StaffAuthBoundaryManagedStaff[] {
  return [
    {
      profile: {
        displayName: "Ada Administrator",
        email: "ada@example.test",
        id: "profile-target-admin",
      },
      role: "admin",
      roleRevision: 7,
      schoolId: "school-1",
    },
    {
      profile: {
        displayName: "Theo Teacher",
        email: "theo@example.test",
        id: "profile-target-teacher",
      },
      role: "teacher",
      roleRevision: 11,
      schoolId: "school-1",
    },
  ];
}

function manageableInvitations(): StaffAuthBoundaryManagedInvitation[] {
  return [
    {
      email: "pending@example.test",
      expiresAt: "2026-09-04T12:00:00.000Z",
      invitationId: "invitation-pending",
      role: "teacher",
      schoolId: "school-1",
      state: "pending",
    },
  ];
}

function access(
  role: "admin" | "owner" | "teacher",
  options: {
    assuranceLevel?: "aal1" | "aal2";
    email?: string;
    identity?: StaffAuthBoundaryIdentity;
    identityGeneration?: string;
    manageableInvitations?: readonly StaffAuthBoundaryManagedInvitation[];
    manageableStaff?: readonly StaffAuthBoundaryManagedStaff[];
    factorChoices?: readonly {
      readonly challengeReceipt: string;
      readonly label: string;
    }[];
    secondFactor?:
      | "challenge_required"
      | "enrollment_required"
      | "factor_selection_required"
      | "satisfied";
    sessionGeneration?: string;
  } = {},
): StaffAuthAccessGrant {
  const assuranceLevel =
    options.assuranceLevel ?? (role === "teacher" ? "aal1" : "aal2");
  const secondFactor = options.secondFactor ?? "satisfied";
  const base = {
    assuranceLevel,
    identity: options.identity ?? identity(role, options.email),
    identityGeneration: options.identityGeneration ?? `identity-${role}`,
    kind: "access_granted" as const,
    manageableInvitations: options.manageableInvitations ?? [],
    manageableStaff:
      options.manageableStaff ??
      (role === "owner" &&
      assuranceLevel === "aal2" &&
      secondFactor === "satisfied"
        ? manageableStaff()
        : []),
    sessionGeneration: options.sessionGeneration ?? `session-${role}`,
  };
  if (secondFactor === "challenge_required") {
    return {
      ...base,
      challengeReceipt: `challenge-${role}`,
      secondFactor,
    };
  }
  if (secondFactor === "factor_selection_required") {
    return {
      ...base,
      factorChoices: options.factorChoices ?? [
        {
          challengeReceipt: "challenge-owner-phone",
          label: "Phone (Authenticator 1)",
        },
        {
          challengeReceipt: "challenge-owner-key",
          label: "Security key (Authenticator 2)",
        },
      ],
      secondFactor,
    };
  }
  return { ...base, secondFactor };
}

function invitationReady(operationId: string): StaffAuthBoundaryResult {
  return {
    acceptanceReceipt: "opaque-acceptance-receipt",
    expiresAt: "2026-09-04T12:00:00.000Z",
    inspectionOperationId: operationId,
    intendedAccountId: "account-teacher",
    intendedEmail: "invited@example.test",
    kind: "invitation_ready",
    role: "teacher",
    school: { id: "school-1", label: "Synthetic High School" },
  };
}

function createAdapter(
  readResult: StaffAuthBoundaryResult,
  perform: (
    request: StaffAuthMutation,
  ) => Promise<StaffAuthBoundaryResult> = async () => {
    throw new Error("unexpected mutation");
  },
): StaffAuthAdapter {
  return {
    async read() {
      return readResult;
    },
    async perform(request) {
      return {
        operationId: request.operationId,
        result: await perform(request),
      };
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function createController(
  adapter: StaffAuthAdapter,
  options: {
    clear?: () => void;
    history?: (url: string) => void;
    nextOperationId?: () => string;
    now?: () => number;
    recoveryFlowResult?:
      | { status: "invalid" | "replayed" }
      | {
          expiresAt: number;
          state: string;
          status: "accepted";
          verifier: string;
        };
  } = {},
): StaffAuthController {
  let sequence = 0;
  return createStaffAuthController({
    adapter,
    callback: {
      flows: {
        async consume() {
          return (
            options.recoveryFlowResult ?? {
              expiresAt: Date.parse("2026-09-03T12:05:00.000Z"),
              state: "s".repeat(43),
              status: "accepted",
              verifier: "v".repeat(43),
            }
          );
        },
        async create() {
          return {
            codeChallenge: "c".repeat(43),
            flowId: "f".repeat(22),
            state: "s".repeat(43),
          };
        },
      },
      history: {
        replaceState(_data, _unused, url) {
          options.history?.(url);
        },
      },
      route: {
        origin: "https://app.example.test",
        pathname: "/",
      },
    },
    clock: {
      now: () => options.now?.() ?? Date.parse("2026-09-03T12:00:00.000Z"),
    },
    operationIds: {
      next() {
        sequence += 1;
        return options.nextOperationId?.() ?? `operation-${sequence}`;
      },
    },
    protectedSchoolData: { clear: options.clear ?? (() => undefined) },
  });
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    reject(reason: unknown) {
      reject?.(reason);
    },
    resolve(value: T) {
      resolve?.(value);
    },
  };
}

describe("staff auth controller", () => {
  it("bootstraps signed out and clears protected School data", async () => {
    const clear = vi.fn();
    const controller = createController(createAdapter({ kind: "signed_out" }), {
      clear,
    });

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toEqual({
      kind: "signed_out",
      notice: null,
      revision: 2,
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("publishes authoritative account, School, Membership, and role identity", async () => {
    const controller = createController(createAdapter(access("teacher")));

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toMatchObject({
      assuranceLevel: "aal1",
      identity: {
        accountId: "account-teacher",
        email: "teacher@example.test",
        membership: {
          id: "membership-teacher",
          role: "teacher",
          status: "active",
        },
        school: { id: "school-1", label: "Synthetic High School" },
      },
      kind: "authenticated",
    });
  });

  it("requires an Administrator at AAL1 to pass the same TOTP challenge before access", async () => {
    const requests: StaffAuthMutation[] = [];
    const administrator = identity("admin");
    const adapter = createAdapter({ kind: "signed_out" }, async (request) => {
      requests.push(request);
      return request.type === "sign_in"
        ? access("admin", {
            assuranceLevel: "aal1",
            identity: administrator,
            secondFactor: "challenge_required",
          })
        : access("admin", {
            assuranceLevel: "aal2",
            identity: administrator,
          });
    });
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "admin@example.test",
      password: "correct horse battery staple",
      type: "sign_in",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_challenge",
      role: "administrator",
    });

    await controller.dispatch({ code: "123456", type: "verify_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      assuranceLevel: "aal2",
      identity: { membership: { role: "administrator" } },
      kind: "authenticated",
    });
    expect(requests[1]).toMatchObject({
      challengeReceipt: "challenge-admin",
      code: "123456",
      operationId: "operation-2",
      purpose: "step_up",
      type: "verify_totp",
    });
  });

  it("keeps factor receipts private and requires an explicit current factor choice", async () => {
    const perform = vi.fn<
      (request: StaffAuthMutation) => Promise<StaffAuthAccessGrant>
    >(async () => access("owner", { assuranceLevel: "aal2" }));
    const controller = createController(
      createAdapter(
        access("owner", {
          assuranceLevel: "aal1",
          factorChoices: [
            {
              challengeReceipt: "private-receipt-one",
              label: "Phone (Authenticator 1)",
            },
            {
              challengeReceipt: "private-receipt-two",
              label: "Security key (Authenticator 2)",
            },
          ],
          secondFactor: "factor_selection_required",
        }),
        perform,
      ),
    );

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toMatchObject({
      choices: [
        { choiceId: "factor-1", label: "Phone (Authenticator 1)" },
        { choiceId: "factor-2", label: "Security key (Authenticator 2)" },
      ],
      kind: "totp_factor_selection",
      role: "owner",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("receipt");

    await controller.dispatch({
      choiceId: "factor-stale",
      type: "select_totp_factor",
    });
    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_factor_selection",
    });

    await controller.dispatch({
      choiceId: "factor-2",
      type: "select_totp_factor",
    });
    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ kind: "totp_challenge" });

    await controller.dispatch({ code: "123456", type: "verify_totp" });
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0]?.[0]).toMatchObject({
      challengeReceipt: "private-receipt-two",
      purpose: "step_up",
      type: "verify_totp",
    });
  });

  it("keeps rejected and cancelled step-up fail-closed without clearing School data", async () => {
    const clear = vi.fn();
    const controller = createController(
      createAdapter(
        access("owner", {
          assuranceLevel: "aal1",
          secondFactor: "challenge_required",
        }),
        async () => ({ kind: "totp_rejected" }),
      ),
      { clear },
    );
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();

    await controller.dispatch({ code: "000000", type: "verify_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      feedback: "rejected",
      kind: "totp_challenge",
    });
    await controller.dispatch({ type: "cancel_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      feedback: "cancelled",
      kind: "totp_challenge",
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("shows a generic sign-in rejection without retaining credentials", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () => ({
        kind: "sign_in_rejected",
      })),
    );
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "unknown@example.test",
      password: "SENTINEL-password",
      type: "sign_in",
    });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "sign_in_rejected",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(
      /unknown@example|SENTINEL/,
    );
  });

  it("provides explicit required, sending, and sent email-verification states", async () => {
    const observed: string[] = [];
    const adapter = createAdapter({ kind: "signed_out" }, async (request) =>
      request.type === "sign_in"
        ? { kind: "email_verification_required" }
        : { kind: "email_verification_sent" },
    );
    const controller = createController(adapter);
    controller.subscribe((state) => observed.push(state.kind));
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "t@example.test",
      password: "pw",
      type: "sign_in",
    });
    await controller.dispatch({ type: "resend_email_verification" });

    expect(observed).toContain("email_verification_required");
    expect(observed).toContain("sending_email_verification");
    expect(controller.getSnapshot()).toMatchObject({
      kind: "email_verification_sent",
    });
  });

  it("shows the same recovery notice for known and unknown addresses", async () => {
    async function requestRecovery(email: string) {
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async () => ({
          kind: "recovery_request_received",
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({ email, type: "request_password_recovery" });
      return controller.getSnapshot();
    }

    const known = await requestRecovery("known@example.test");
    const unknown = await requestRecovery("unknown@example.test");
    expect({ kind: known.kind }).toEqual({ kind: unknown.kind });
    expect(JSON.stringify(unknown)).not.toContain("unknown@example.test");
  });

  it("adds only bounded public PKCE values to a recovery request", async () => {
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return { kind: "recovery_request_received" };
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "teacher@example.test",
      type: "request_password_recovery",
    });

    expect(requests[0]).toMatchObject({
      codeChallenge: "c".repeat(43),
      email: "teacher@example.test",
      flowId: "f".repeat(22),
      state: "s".repeat(43),
      type: "request_password_recovery",
    });
    expect(JSON.stringify(requests[0])).not.toContain("verifier");
  });

  it.each(["invalid", "expired", "replayed"] as const)(
    "rejects a %s invitation without retaining its token",
    async (reason) => {
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async () => ({
          kind: "invitation_rejected",
          reason,
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
        type: "inspect_invitation",
      });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "invitation_rejected",
        reason,
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        "SENTINEL",
      );
    },
  );

  it("accepts a Teacher invitation only with authoritative School and Membership identity", async () => {
    const requests: StaffAuthMutation[] = [];
    const adapter = createAdapter({ kind: "signed_out" }, async (request) => {
      requests.push(request);
      return request.type === "inspect_invitation"
        ? {
            acceptanceReceipt: "opaque-invitation-receipt",
            expiresAt: "2026-09-04T12:00:00.000Z",
            inspectionOperationId: request.operationId,
            intendedAccountId: "account-teacher",
            intendedEmail: "invited@example.test",
            kind: "invitation_ready",
            role: "teacher",
            school: { id: "school-1", label: "Synthetic High School" },
          }
        : access("teacher", { email: "invited@example.test" });
    });
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    await controller.dispatch({
      password: "new-password",
      displayName: "Invited Teacher",
      type: "accept_invitation",
    });

    expect(controller.getSnapshot()).toMatchObject({
      identity: {
        email: "invited@example.test",
        membership: { id: "membership-teacher", role: "teacher" },
        school: { id: "school-1", label: "Synthetic High School" },
      },
      kind: "authenticated",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("one-time");
  });

  it("fails closed if an adapter exposes an Owner invitation", async () => {
    const controller = createController(
      createAdapter(
        { kind: "signed_out" },
        async () =>
          ({
            acceptanceReceipt: "receipt",
            expiresAt: "2026-09-04T12:00:00.000Z",
            inspectionOperationId: "operation-1",
            intendedAccountId: "account-owner",
            intendedEmail: "owner@example.test",
            kind: "invitation_ready",
            role: "owner",
            school: { id: "school-1", label: "Synthetic High School" },
          }) as unknown as StaffAuthBoundaryResult,
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "invitation",
    });
  });

  it.each([
    ["sign_out_local", "local", "signed_out"],
    ["revoke_all_sessions", "all", "all_sessions_revoked"],
  ] as const)(
    "%s accepts only an explicit matching scoped completion",
    async (actionType, scope, notice) => {
      const clear = vi.fn();
      const requests: StaffAuthMutation[] = [];
      const controller = createController(
        createAdapter(access("teacher"), async (request) => {
          requests.push(request);
          return { kind: "sign_out_complete", scope };
        }),
        { clear },
      );
      await controller.dispatch({ type: "bootstrap" });
      clear.mockClear();
      await controller.dispatch({ type: actionType });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "signed_out",
        notice,
      });
      expect(requests[0]).toMatchObject({ scope, type: "sign_out" });
      expect(clear).toHaveBeenCalledOnce();
    },
  );

  it("returns to sign in with an explicit application reset completion", async () => {
    const clear = vi.fn();
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "membership_inactive" }, async (request) => {
        requests.push(request);
        return { kind: "reset_to_sign_in_complete" };
      }),
      { clear },
    );
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    await controller.dispatch({ type: "back_to_sign_in" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: "reset_to_sign_in" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "signed_out",
      notice: null,
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it.each(["sign_out_local", "revoke_all_sessions"] as const)(
    "projects an already-ended %s without claiming global revocation",
    async (type) => {
      const controller = createController(
        createAdapter(access("teacher"), async () => ({ kind: "signed_out" })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({ type });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "signed_out",
        notice: null,
      });
    },
  );

  it("rejects a generic or wrong-scope logout result", async () => {
    const clear = vi.fn();
    const controller = createController(
      createAdapter(access("owner"), async () => ({
        kind: "sign_out_complete",
        scope: "local",
      })),
      { clear },
    );
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    await controller.dispatch({ type: "revoke_all_sessions" });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "revoke_all_sessions",
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it.each([
    "session_expired",
    "session_revoked",
    "membership_inactive",
    "signed_out",
  ] as const)("clears School data before revalidating to %s", async (kind) => {
    const clear = vi.fn();
    const nextRead = deferred<StaffAuthBoundaryResult>();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    adapter.read = () => nextRead.promise;
    clear.mockClear();

    emit?.({ kind: "revalidation_required" });

    expect(controller.getSnapshot().kind).toBe("bootstrapping");
    expect(clear).toHaveBeenCalledOnce();
    nextRead.resolve({ kind });
    await vi.waitFor(() => expect(controller.getSnapshot().kind).toBe(kind));
    expect(clear).toHaveBeenCalledOnce();
  });

  it("clears School data and waits for a fresh authoritative identity", async () => {
    const clear = vi.fn();
    const nextRead = deferred<StaffAuthBoundaryResult>();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    adapter.read = () => nextRead.promise;
    clear.mockClear();

    emit?.({ kind: "revalidation_required" });

    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(clear).toHaveBeenCalledOnce();
    nextRead.resolve(access("owner"));
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "owner" } },
        kind: "authenticated",
      }),
    );
  });

  it.each([
    ["signed out", { kind: "signed_out" }, "signed_out"],
    [
      "email verification",
      { kind: "email_verification_required" },
      "email_verification_required",
    ],
    ["step up", { kind: "step_up_required" }, "step_up_required"],
    ["membership loss", { kind: "membership_inactive" }, "membership_inactive"],
    ["session expiry", { kind: "session_expired" }, "session_expired"],
    ["session revocation", { kind: "session_revoked" }, "session_revoked"],
    [
      "recovery resume",
      { kind: "password_recovery_ready" },
      "password_recovery_ready",
    ],
    [
      "invitation resume",
      invitationReady("bootstrap-operation"),
      "invitation_ready",
    ],
    ["fresh access", access("owner"), "authenticated"],
  ] as const)(
    "clears before a detail-free event and reboots to %s authority",
    async (_label, authority, expectedKind) => {
      const order: string[] = [];
      const nextRead = deferred<StaffAuthBoundaryResult>();
      let reads = 0;
      let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
      const adapter: StaffAuthAdapter = {
        read() {
          reads += 1;
          return reads === 1
            ? Promise.resolve(access("teacher"))
            : nextRead.promise;
        },
        async perform() {
          throw new Error("unexpected mutation");
        },
        subscribe(listener) {
          emit = listener;
          return () => undefined;
        },
      };
      const controller = createController(adapter, {
        clear: () => {
          order.push("clear");
        },
      });
      await controller.dispatch({ type: "bootstrap" });
      order.splice(0);
      controller.subscribe((state) => {
        order.push(`state:${state.kind}`);
      });

      emit?.({ kind: "revalidation_required" });

      expect(order).toEqual(["clear", "state:bootstrapping"]);
      expect(reads).toBe(1);
      nextRead.resolve(authority as StaffAuthBoundaryResult);
      await vi.waitFor(() =>
        expect(controller.getSnapshot().kind).toBe(expectedKind),
      );
    },
  );

  it("invalidates a pending TOTP challenge and ignores its stale verification", async () => {
    const verification = deferred<StaffAuthMutationResult>();
    const nextRead = deferred<StaffAuthBoundaryResult>();
    const clear = vi.fn();
    let reads = 0;
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter: StaffAuthAdapter = {
      read() {
        reads += 1;
        return reads === 1
          ? Promise.resolve(
              access("owner", {
                assuranceLevel: "aal1",
                secondFactor: "challenge_required",
              }),
            )
          : nextRead.promise;
      },
      perform: () => verification.promise,
      subscribe(listener) {
        emit = listener;
        return () => undefined;
      },
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    const pendingVerification = controller.dispatch({
      code: "123456",
      type: "verify_totp",
    });

    emit?.({ kind: "revalidation_required" });

    expect(clear).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    verification.resolve({
      operationId: "operation-1",
      result: access("owner", { assuranceLevel: "aal2" }),
    });
    nextRead.resolve({ kind: "session_revoked" });
    await pendingVerification;
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        kind: "session_revoked",
      }),
    );
  });

  it("coalesces a synchronous event burst into one fresh authority read", async () => {
    const refreshed = deferred<StaffAuthBoundaryResult>();
    const clear = vi.fn();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    const read = vi.fn(() => refreshed.promise);
    adapter.read = read;
    clear.mockClear();

    for (let index = 0; index < 5; index += 1) {
      emit?.({ kind: "revalidation_required" });
      expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    }

    expect(clear).toHaveBeenCalledTimes(5);
    expect(read).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    refreshed.resolve({ kind: "session_revoked" });
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        kind: "session_revoked",
      }),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("discards a read invalidated by another event and serializes the latest authority read", async () => {
    const stale = deferred<StaffAuthBoundaryResult>();
    const current = deferred<StaffAuthBoundaryResult>();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const read = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);
    adapter.read = read;
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.kind));

    emit?.({ kind: "revalidation_required" });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    emit?.({ kind: "revalidation_required" });
    emit?.({ kind: "revalidation_required" });
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();

    stale.resolve(access("owner"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(states).not.toContain("authenticated");
    current.resolve({ kind: "membership_inactive" });
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        kind: "membership_inactive",
      }),
    );
    expect(states).not.toContain("authenticated");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("cancels an event-triggered authority read queued before disposal", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const read = vi.fn(async () => access("owner"));
    adapter.read = read;

    emit?.({ kind: "revalidation_required" });
    controller.dispose();
    await Promise.resolve();

    expect(read).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ kind: "disposed" });
  });

  it("fails closed with a retryable bootstrap when provider authority refresh is unavailable", async () => {
    const clear = vi.fn();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    let reads = 0;
    const adapter: StaffAuthAdapter = {
      async read() {
        reads += 1;
        if (reads === 2) throw new Error("provider unavailable");
        return access("teacher");
      },
      async perform() {
        throw new Error("unexpected mutation");
      },
      subscribe(listener) {
        emit = listener;
        return () => undefined;
      },
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();

    emit?.({ kind: "revalidation_required" });
    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(clear).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().kind).toBe("dependency_failure"),
    );

    expect(controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
      retryable: true,
    });
    expect(clear).toHaveBeenCalledOnce();
    await controller.dispatch({ type: "retry" });
    expect(reads).toBe(3);
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
  });

  it("retries a failed bootstrap with no provider detail", async () => {
    let reads = 0;
    const adapter: StaffAuthAdapter = {
      async read() {
        reads += 1;
        if (reads === 1) {
          throw new Error("SENTINEL-provider-detail");
        }
        return { kind: "signed_out" };
      },
      async perform() {
        throw new Error("unexpected mutation");
      },
      subscribe() {
        return () => undefined;
      },
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      retryable: true,
    });
    await controller.dispatch({ type: "retry" });

    expect(controller.getSnapshot()).toMatchObject({ kind: "signed_out" });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");
  });

  it("requires Start again after uncertain global logout and never replays it", async () => {
    const requests: StaffAuthMutation[] = [];
    const observed: string[] = [];
    const clear = vi.fn();
    let attempt = 0;
    const controller = createController(
      createAdapter(access("owner"), async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) {
          throw new Error("SENTINEL-uncertain");
        }
        return { kind: "reset_to_sign_in_complete" };
      }),
      { clear },
    );
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    controller.subscribe((state) => observed.push(state.kind));

    await controller.dispatch({ type: "revoke_all_sessions" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      retryable: false,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "owner@example",
    );
    await controller.dispatch({ type: "retry" });

    expect(requests).toHaveLength(1);
    expect(controller.getSnapshot().kind).toBe("dependency_failure");
    await controller.dispatch({ type: "back_to_sign_in" });
    expect(requests[1]?.type).toBe("reset_to_sign_in");
    expect(observed).toEqual([
      "signing_out",
      "dependency_failure",
      "signing_out",
      "signed_out",
    ]);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("does not retain or retry a recovery address after an uncertain request", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () => {
        throw new Error("uncertain");
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "SENTINEL-private@example.test",
      type: "request_password_recovery",
    });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      operation: "password_recovery",
      retryable: false,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");
  });

  it("cancels an older sign-in completion when a newer bootstrap starts", async () => {
    const signIn = deferred<StaffAuthBoundaryResult>();
    let reads = 0;
    const adapter = createAdapter(
      { kind: "signed_out" },
      async () => signIn.promise,
    );
    adapter.read = async () => {
      reads += 1;
      return { kind: "signed_out" };
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const pendingSignIn = controller.dispatch({
      email: "teacher@example.test",
      password: "pw",
      type: "sign_in",
    });

    await controller.dispatch({ type: "bootstrap" });
    signIn.resolve(access("teacher"));
    await pendingSignIn;

    expect(reads).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ kind: "signed_out" });
  });

  it("lets only the newest overlapping bootstrap publish", async () => {
    const first = deferred<StaffAuthBoundaryResult>();
    const second = deferred<StaffAuthBoundaryResult>();
    let reads = 0;
    const adapter: StaffAuthAdapter = {
      read() {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      },
      async perform() {
        throw new Error("unexpected mutation");
      },
      subscribe() {
        return () => undefined;
      },
    };
    const controller = createController(adapter);
    const oldRead = controller.dispatch({ type: "bootstrap" });
    const newRead = controller.dispatch({ type: "bootstrap" });
    second.resolve({ kind: "session_revoked" });
    await newRead;
    first.resolve(access("teacher"));
    await oldRead;

    expect(controller.getSnapshot()).toMatchObject({ kind: "session_revoked" });
  });

  it("does not let a stale mutation overwrite a newer revocation event", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    let request: StaffAuthMutation | undefined;
    const finish = deferred<StaffAuthMutationResult>();
    const adapter: StaffAuthAdapter = {
      async read() {
        return access("teacher");
      },
      perform(input) {
        request = input;
        return finish.promise;
      },
      subscribe(listener) {
        emit = listener;
        return () => undefined;
      },
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const pending = controller.dispatch({ type: "sign_out_local" });
    adapter.read = async () => ({ kind: "session_revoked" });
    emit?.({ kind: "revalidation_required" });
    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    finish.resolve({
      operationId: request?.operationId ?? "",
      result: { kind: "sign_out_complete", scope: "local" },
    });
    await pending;

    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        kind: "session_revoked",
      }),
    );
  });

  it("ignores async completions after disposal", async () => {
    const finish = deferred<StaffAuthMutationResult>();
    let request: StaffAuthMutation | undefined;
    const adapter: StaffAuthAdapter = {
      async read() {
        return { kind: "signed_out" };
      },
      perform(input) {
        request = input;
        return finish.promise;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const clear = vi.fn();
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    const pending = controller.dispatch({
      email: "t@example.test",
      password: "pw",
      type: "sign_in",
    });
    controller.dispose();
    finish.resolve({
      operationId: request?.operationId ?? "",
      result: access("teacher"),
    });
    await pending;

    expect(controller.getSnapshot()).toMatchObject({ kind: "disposed" });
    expect(clear).not.toHaveBeenCalled();
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({ kind: "disposed" });
  });

  it("ignores queued provider events after disposal", async () => {
    const clear = vi.fn();
    let queued: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter: StaffAuthAdapter = {
      async read() {
        return access("teacher");
      },
      async perform() {
        throw new Error("unexpected mutation");
      },
      subscribe(listener) {
        queued = listener;
        return () => undefined;
      },
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    controller.dispose();
    queued?.({ kind: "revalidation_required" });

    expect(controller.getSnapshot()).toMatchObject({ kind: "disposed" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("runs an enrollment ceremony with an opaque receipt, blob QR, and the same ceremony ID", async () => {
    const revoke = vi.fn();
    const requests: StaffAuthMutation[] = [];
    const administrator = identity("admin");
    const controller = createController(
      createAdapter(
        access("admin", {
          assuranceLevel: "aal1",
          identity: administrator,
          secondFactor: "enrollment_required",
        }),
        async (request) => {
          requests.push(request);
          return request.type === "begin_totp_enrollment"
            ? {
                enrollmentReceipt: "opaque-enrollment-receipt",
                kind: "totp_enrollment_ready",
                presentation: {
                  blobUrl: "blob:https://app.example.test/qr-1",
                  revoke,
                },
              }
            : access("admin", {
                assuranceLevel: "aal2",
                identity: administrator,
              });
        },
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({ type: "begin_totp_enrollment" });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_provisioning",
      qrBlobUrl: "blob:https://app.example.test/qr-1",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(
      /otpauth|secret/i,
    );
    await controller.dispatch({ code: "123456", type: "verify_totp" });

    expect(requests[1]).toMatchObject({
      ceremonyOperationId: requests[0]?.operationId,
      enrollmentReceipt: "opaque-enrollment-receipt",
      purpose: "enrollment",
      type: "verify_totp",
    });
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes and clears a provisioning QR after a wrong code", async () => {
    const revoke = vi.fn();
    const controller = createController(
      createAdapter(
        access("admin", {
          assuranceLevel: "aal1",
          secondFactor: "enrollment_required",
        }),
        async (request) =>
          request.type === "begin_totp_enrollment"
            ? {
                enrollmentReceipt: "receipt",
                kind: "totp_enrollment_ready",
                presentation: {
                  blobUrl: "blob:https://app.example.test/qr",
                  revoke,
                },
              }
            : { kind: "totp_rejected" },
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({ type: "begin_totp_enrollment" });
    await controller.dispatch({ code: "wrong", type: "verify_totp" });

    expect(controller.getSnapshot()).toMatchObject({
      feedback: "rejected",
      kind: "totp_enrollment_required",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("blob:");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a provisioning QR when enrollment is cancelled", async () => {
    const revoke = vi.fn();
    const controller = createController(
      createAdapter(
        access("owner", {
          assuranceLevel: "aal1",
          secondFactor: "enrollment_required",
        }),
        async () => ({
          enrollmentReceipt: "receipt",
          kind: "totp_enrollment_ready",
          presentation: { blobUrl: "blob:https://app.example.test/qr", revoke },
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({ type: "begin_totp_enrollment" });
    await controller.dispatch({ type: "cancel_totp" });

    expect(controller.getSnapshot()).toMatchObject({
      feedback: "cancelled",
      kind: "totp_enrollment_required",
    });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a provisioning QR on verify dependency failure", async () => {
    const revoke = vi.fn();
    let calls = 0;
    const controller = createController(
      createAdapter(
        access("owner", {
          assuranceLevel: "aal1",
          secondFactor: "enrollment_required",
        }),
        async () => {
          calls += 1;
          if (calls === 1) {
            return {
              enrollmentReceipt: "receipt",
              kind: "totp_enrollment_ready",
              presentation: {
                blobUrl: "blob:https://app.example.test/qr",
                revoke,
              },
            };
          }
          throw new Error("provider failure");
        },
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({ type: "begin_totp_enrollment" });
    await controller.dispatch({ code: "123456", type: "verify_totp" });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      operation: "totp",
    });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a provisioning QR on disposal", async () => {
    const revoke = vi.fn();
    const controller = createController(
      createAdapter(
        access("owner", {
          assuranceLevel: "aal1",
          secondFactor: "enrollment_required",
        }),
        async () => ({
          enrollmentReceipt: "receipt",
          kind: "totp_enrollment_ready",
          presentation: { blobUrl: "blob:https://app.example.test/qr", revoke },
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({ type: "begin_totp_enrollment" });
    controller.dispose();

    expect(revoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("blob:");
  });

  it("revokes a late stale provisioning presentation", async () => {
    const revoke = vi.fn();
    let request: StaffAuthMutation | undefined;
    const finish = deferred<StaffAuthMutationResult>();
    let reads = 0;
    const adapter: StaffAuthAdapter = {
      async read() {
        reads += 1;
        return access("owner", {
          assuranceLevel: "aal1",
          secondFactor: "enrollment_required",
        });
      },
      perform(input) {
        request = input;
        return finish.promise;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const pending = controller.dispatch({ type: "begin_totp_enrollment" });
    await controller.dispatch({ type: "bootstrap" });
    finish.resolve({
      operationId: request?.operationId ?? "",
      result: {
        enrollmentReceipt: "late",
        kind: "totp_enrollment_ready",
        presentation: { blobUrl: "blob:https://app.example.test/late", revoke },
      },
    });
    await pending;

    expect(reads).toBe(2);
    expect(revoke).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_enrollment_required",
    });
  });

  it("completes a password-recovery callback after history scrubbing without retaining credentials", async () => {
    const history = vi.fn();
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return request.type === "exchange_recovery_code"
          ? { kind: "password_recovery_ready" }
          : { kind: "password_recovery_complete", sessionScope: "all" };
      }),
      { history },
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=SENTINEL-code`,
      type: "consume_recovery_callback",
    });

    expect(history).toHaveBeenCalledWith("/");
    expect(controller.getSnapshot()).toMatchObject({
      kind: "password_recovery_ready",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");
    await controller.dispatch({
      password: "SENTINEL-new-password",
      type: "complete_password_recovery",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "password_recovery_complete",
    });
    expect(requests[0]).toMatchObject({
      authorizationCode: "SENTINEL-code",
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
  });

  it("consumes a cold email-verification callback before publishing fresh authority", async () => {
    const history = vi.fn();
    const clear = vi.fn();
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return access("teacher");
      }),
      { clear, history },
    );
    const authorizationCode = "SENTINEL-email-verification-code";
    const flowId = "0123456789abcdef0123456789abcdef";

    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=email-verification&sb_flow_id=${flowId}&code=${authorizationCode}`,
      type: "consume_email_verification_callback",
    });

    expect(history).toHaveBeenCalledWith("/");
    expect(clear).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorizationCode,
      flowId,
      type: "exchange_email_verification_code",
    });
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      authorizationCode,
    );
  });

  it.each([
    `https://app.example.test/?code=bare-provider-code`,
    `https://app.example.test/?auth=email-verification&code=provider-code&sb_flow_id=short`,
    `https://app.example.test/?auth=email-verification&auth=recovery&code=provider-code&sb_flow_id=0123456789abcdef0123456789abcdef`,
  ])(
    "scrubs and rejects malformed email-verification callback %s",
    async (callbackUrl) => {
      const history = vi.fn();
      const perform = vi.fn(async () => ({
        kind: "email_verification_callback_rejected" as const,
      }));
      const controller = createController(
        createAdapter({ kind: "signed_out" }, perform),
        { history },
      );
      await controller.dispatch({
        callbackUrl,
        type: "consume_email_verification_callback",
      });

      expect(history).toHaveBeenCalledWith("/");
      expect(perform).not.toHaveBeenCalled();
      expect(controller.getSnapshot()).toMatchObject({
        kind: "callback_rejected",
      });
    },
  );

  it.each([
    { kind: "password_recovery_complete" },
    { kind: "password_recovery_complete", sessionScope: "local" },
    { kind: "signed_out" },
  ])(
    "rejects recovery completion without authoritative global-session scope %#",
    async (completion) => {
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async (request) =>
          request.type === "exchange_recovery_code"
            ? { kind: "password_recovery_ready" }
            : (completion as unknown as StaffAuthBoundaryResult),
        ),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=one`,
        type: "consume_recovery_callback",
      });
      await controller.dispatch({
        password: "new password",
        type: "complete_password_recovery",
      });

      expect(controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
        operation: "password_recovery",
      });
    },
  );

  it("turns a malformed callback success into invalid_backend_result instead of wedging", async () => {
    const adapter = createAdapter({ kind: "signed_out" });
    adapter.perform = async (request) =>
      ({
        operationId: request.operationId,
        result: undefined,
      }) as unknown as StaffAuthMutationResult;
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=one`,
      type: "consume_recovery_callback",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "recovery_callback",
    });
  });

  it("rejects access grants from a recovery-only callback", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () => access("teacher")),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=one`,
      type: "consume_recovery_callback",
    });
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "recovery_callback",
    });
  });

  it("rejects a mutation response with a mismatched operation ID", async () => {
    const adapter = createAdapter({ kind: "signed_out" });
    adapter.perform = async () => ({
      operationId: "wrong-operation",
      result: { kind: "sign_in_rejected" },
    });
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "a@example.test",
      password: "pw",
      type: "sign_in",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
  });

  it("fails closed when the operation-ID source repeats a new ID", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () => ({
        kind: "sign_in_rejected",
      })),
      { nextOperationId: () => "same-operation" },
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "a@example.test",
      password: "pw",
      type: "sign_in",
    });
    await controller.dispatch({
      email: "a@example.test",
      password: "pw",
      type: "sign_in",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "sign_in",
    });
  });

  it.each(["admin", "teacher"] as const)(
    "lets an AAL2 Owner create a %s invitation through the adapter",
    async (targetRole) => {
      const requests: StaffAuthMutation[] = [];
      const controller = createController(
        createAdapter(access("owner"), async (request) => {
          requests.push(request);
          return {
            actor: access("owner"),
            invitedRole: targetRole,
            kind: "staff_invitation_created",
          };
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        email: "SENTINEL-target@example.test",
        schoolId: "school-1",
        targetRole,
        type: "create_staff_invitation",
      });

      expect(requests[0]).toMatchObject({
        email: "SENTINEL-target@example.test",
        schoolId: "school-1",
        targetRole,
        type: "create_staff_invitation",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "staff_invitation_created",
        targetRole: targetRole === "admin" ? "administrator" : "teacher",
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        "SENTINEL",
      );
    },
  );

  it("shows an authoritative Owner invitation rejection", async () => {
    const controller = createController(
      createAdapter(access("owner"), async () => ({
        actor: access("owner"),
        kind: "staff_invitation_rejected",
      })),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "target@example.test",
      schoolId: "school-1",
      targetRole: "teacher",
      type: "create_staff_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "staff_invitation_rejected",
    });
  });

  it.each(["", "other-school"])(
    "rejects a forged invitation School selector %j before mutation",
    async (schoolId) => {
      const perform = vi.fn();
      const adapter = createAdapter(access("owner"));
      adapter.perform = perform;
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        email: "target@example.test",
        schoolId,
        targetRole: "teacher",
        type: "create_staff_invitation",
      });

      expect(perform).not.toHaveBeenCalled();
      expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
    },
  );

  it("does not allow an Administrator to invite another Administrator", async () => {
    const perform = vi.fn();
    const adapter = createAdapter(access("admin"));
    adapter.perform = perform;
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "target@example.test",
      schoolId: "school-1",
      targetRole: "admin",
      type: "create_staff_invitation",
    });

    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
  });

  it("does not expose an Owner invitation target even to malformed callers", async () => {
    const perform = vi.fn();
    const adapter = createAdapter(access("owner"));
    adapter.perform = perform;
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "target@example.test",
      schoolId: "school-1",
      targetRole: "owner",
      type: "create_staff_invitation",
    } as unknown as StaffAuthAction);

    expect(perform).not.toHaveBeenCalled();
  });

  it("lets an AAL2 Owner revoke a selected same-School pending invitation", async () => {
    const invitations = manageableInvitations();
    const owner = access("owner", { manageableInvitations: invitations });
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter(owner, async (request) => {
        requests.push(request);
        return {
          actor: owner,
          invitationId:
            request.type === "revoke_staff_invitation"
              ? request.invitationId
              : "wrong",
          kind: "staff_invitation_revoked",
          revokedRole: "teacher",
          schoolId:
            request.type === "revoke_staff_invitation"
              ? request.schoolId
              : "wrong",
        };
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      invitationId: "invitation-pending",
      schoolId: "school-1",
      type: "review_staff_invitation_revocation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "confirming_staff_invitation_revocation",
      target: { email: "pending@example.test", role: "teacher" },
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "invitation-pending",
    );
    await controller.dispatch({ type: "confirm_staff_invitation_revocation" });

    expect(requests[0]).toMatchObject({
      expectedIdentityGeneration: "identity-owner",
      expectedSessionGeneration: "session-owner",
      invitationId: "invitation-pending",
      schoolId: "school-1",
      type: "revoke_staff_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "staff_invitation_revoked",
      schoolLabel: "Synthetic High School",
      targetRole: "teacher",
    });
  });

  it.each(["invitation", "school", "role"] as const)(
    "rejects pending invitation revocation result with mismatched %s authority",
    async (field) => {
      const invitations = manageableInvitations();
      const owner = access("owner", { manageableInvitations: invitations });
      const controller = createController(
        createAdapter(owner, async () => ({
          actor: owner,
          invitationId:
            field === "invitation" ? "other-invitation" : "invitation-pending",
          kind: "staff_invitation_revoked",
          revokedRole: field === "role" ? "admin" : "teacher",
          schoolId: field === "school" ? "other-school" : "school-1",
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        invitationId: "invitation-pending",
        schoolId: "school-1",
        type: "review_staff_invitation_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_invitation_revocation",
      });
      expect(controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
        operation: "staff_invitation_revocation",
      });
    },
  );

  it("invalidates pending invitation selection when authority generation changes", async () => {
    const invitations = manageableInvitations();
    const owner = access("owner", { manageableInvitations: invitations });
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const perform = vi.fn();
    const adapter = createAdapter(owner);
    adapter.perform = perform;
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      invitationId: "invitation-pending",
      schoolId: "school-1",
      type: "review_staff_invitation_revocation",
    });
    adapter.read = async () =>
      access("owner", {
        identityGeneration: "identity-owner-2",
        manageableInvitations: invitations,
        sessionGeneration: "session-owner-2",
      });
    emit?.({ kind: "revalidation_required" });
    await controller.dispatch({ type: "confirm_staff_invitation_revocation" });
    expect(perform).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" }),
    );
    await controller.dispatch({ type: "confirm_staff_invitation_revocation" });
    expect(perform).not.toHaveBeenCalled();
  });

  it("rejects an oversized or cross-School manageable invitation list", async () => {
    const oversized = Array.from({ length: 501 }, (_, index) => ({
      ...manageableInvitations()[0]!,
      invitationId: `invitation-${index}`,
    }));
    for (const list of [
      oversized,
      [{ ...manageableInvitations()[0]!, schoolId: "other-school" }],
    ]) {
      const controller = createController(
        createAdapter(access("owner", { manageableInvitations: list })),
      );
      await controller.dispatch({ type: "bootstrap" });
      expect(controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
      });
    }
  });

  it("accepts five hundred manageable staff rows and rejects row five hundred one", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      profile: {
        displayName: `Staff ${index}`,
        email: `staff-${index}@example.test`,
        id: `profile-${index}`,
      },
      role: "teacher" as const,
      roleRevision: index + 1,
      schoolId: "school-1",
    }));
    const atLimit = createController(
      createAdapter(access("owner", { manageableStaff: rows.slice(0, 500) })),
    );
    await atLimit.dispatch({ type: "bootstrap" });
    expect(atLimit.getSnapshot()).toMatchObject({
      kind: "authenticated",
      manageableStaff: { length: 500 },
    });

    const overflow = createController(
      createAdapter(access("owner", { manageableStaff: rows })),
    );
    await overflow.dispatch({ type: "bootstrap" });
    expect(overflow.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
  });

  it("rejects distinct manageable profiles sharing one canonical email", async () => {
    const sharedEmail = "shared@example.test";
    const controller = createController(
      createAdapter(
        access("owner", {
          manageableStaff: [
            {
              ...manageableStaff()[0]!,
              profile: {
                ...manageableStaff()[0]!.profile,
                email: sharedEmail,
                id: "profile-first",
              },
            },
            {
              ...manageableStaff()[1]!,
              profile: {
                ...manageableStaff()[1]!.profile,
                email: sharedEmail,
                id: "profile-second",
              },
            },
          ],
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(sharedEmail);
  });

  // This table mirrors the canonical email predicate in packages/contracts.
  it.each([
    " SHARED@example.test",
    "SHARED@example.test",
    "shared\u0000@example.test",
    "not-an-email",
    "user@localhost",
    "usér@example.test",
  ])("rejects noncanonical manageable email %j", async (email) => {
    const controller = createController(
      createAdapter(
        access("owner", {
          manageableStaff: [
            {
              ...manageableStaff()[0]!,
              profile: { ...manageableStaff()[0]!.profile, email },
            },
          ],
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
  });

  it("rejects duplicate pending invitation email identity with different IDs", async () => {
    const original = manageableInvitations()[0]!;
    const controller = createController(
      createAdapter(
        access("owner", {
          manageableInvitations: [
            original,
            { ...original, invitationId: "invitation-pending-second" },
          ],
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
  });

  it.each([
    " pending@example.test",
    "PENDING@example.test",
    "pending\u0000@example.test",
    "not-an-email",
    "user@localhost",
    "usér@example.test",
  ])("rejects noncanonical pending invitation email %j", async (email) => {
    const controller = createController(
      createAdapter(
        access("owner", {
          manageableInvitations: [{ ...manageableInvitations()[0]!, email }],
        }),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
    });
  });

  it.each([
    { invitationId: "", schoolId: "school-1" },
    { invitationId: "forged-invitation", schoolId: "school-1" },
    { invitationId: "invitation-pending", schoolId: "forged-school" },
  ])("rejects forged pending invitation selection %#", async (selection) => {
    const perform = vi.fn();
    const adapter = createAdapter(
      access("owner", { manageableInvitations: manageableInvitations() }),
    );
    adapter.perform = perform;
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      ...selection,
      type: "review_staff_invitation_revocation",
    });
    await controller.dispatch({ type: "confirm_staff_invitation_revocation" });
    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
  });

  it.each(["admin", "teacher"] as const)(
    "lets an AAL2 Owner revoke a %s Membership through the adapter",
    async (targetRole) => {
      const requests: StaffAuthMutation[] = [];
      const controller = createController(
        createAdapter(access("owner"), async (request) => {
          requests.push(request);
          return {
            actor: access("owner"),
            kind: "staff_membership_revoked",
            profileId:
              request.type === "revoke_staff_membership"
                ? request.profileId
                : "wrong",
            revokedRole: targetRole,
            schoolId:
              request.type === "revoke_staff_membership"
                ? request.schoolId
                : "wrong",
          };
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: `profile-target-${targetRole}`,
        schoolId: "school-1",
        type: "review_staff_membership_revocation",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "confirming_staff_membership_revocation",
        target: { role: targetRole === "admin" ? "administrator" : "teacher" },
      });
      await controller.dispatch({
        type: "confirm_staff_membership_revocation",
      });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "staff_membership_revoked",
        targetRole: targetRole === "admin" ? "administrator" : "teacher",
      });
      expect(requests[0]).toMatchObject({
        expectedIdentityGeneration: "identity-owner",
        expectedRoleRevision: targetRole === "admin" ? 7 : 11,
        expectedSessionGeneration: "session-owner",
        profileId: `profile-target-${targetRole}`,
        schoolId: "school-1",
        type: "revoke_staff_membership",
      });
      expect(JSON.stringify(requests[0])).not.toContain("targetRole");
    },
  );

  it("does not retry an uncertain Membership revocation or retain its target", async () => {
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter(access("owner"), async (request) => {
        requests.push(request);
        throw new Error("uncertain");
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      profileId: "profile-target-teacher",
      schoolId: "school-1",
      type: "review_staff_membership_revocation",
    });
    await controller.dispatch({ type: "confirm_staff_membership_revocation" });
    await controller.dispatch({ type: "retry" });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      retryable: false,
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "profile-target-teacher",
    );
  });

  it("rejects an Owner command success authorized by an Administrator actor", async () => {
    const controller = createController(
      createAdapter(access("owner"), async () => ({
        actor: access("admin"),
        invitedRole: "teacher",
        kind: "staff_invitation_created",
      })),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "target@example.test",
      schoolId: "school-1",
      targetRole: "teacher",
      type: "create_staff_invitation",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "staff_invitation",
    });
  });

  it.each([
    { kind: "unknown_success" },
    { kind: "signed_out", extra: "not-allowed" },
    { ...access("teacher"), assuranceLevel: "aal3" },
    {
      ...access("teacher"),
      identity: { ...identity("teacher"), accountId: "account\u0000teacher" },
    },
  ])("rejects an adversarial non-exact boundary result %#", async (result) => {
    const adapter = createAdapter(result as unknown as StaffAuthBoundaryResult);
    const controller = createController(adapter);

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "bootstrap",
    });
  });

  it("scrubs an invitation callback before its inspection boundary and stores only a receipt", async () => {
    const order: string[] = [];
    const requests: StaffAuthMutation[] = [];
    const finish = deferred<StaffAuthBoundaryResult>();
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        order.push("inspect");
        return finish.promise;
      }),
      { history: () => order.push("scrub") },
    );
    await controller.dispatch({ type: "bootstrap" });

    const pending = controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    expect(order).toEqual(["scrub", "inspect"]);
    const inspection = requests[0];
    if (inspection?.type !== "inspect_invitation") {
      throw new Error("expected invitation inspection");
    }
    finish.resolve(invitationReady(inspection.operationId));
    await pending;

    expect(controller.getSnapshot()).toMatchObject({
      intendedEmail: "invited@example.test",
      kind: "invitation_ready",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(
      new RegExp(`${invitationTokenHash}|acceptance-receipt`),
    );
  });

  it("accepts an invitation with the exact one-time receipt and inspection operation", async () => {
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return request.type === "inspect_invitation"
          ? invitationReady(request.operationId)
          : access("teacher", { email: "invited@example.test" });
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    await controller.dispatch({
      password: "new password",
      displayName: "Invited Teacher",
      type: "accept_invitation",
    });

    expect(requests[1]).toMatchObject({
      acceptanceReceipt: "opaque-acceptance-receipt",
      displayName: "Invited Teacher",
      inspectionOperationId: requests[0]?.operationId,
      type: "accept_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
  });

  it.each([
    "",
    " Leading",
    "Trailing ",
    "Bad\u0000Name",
    "a".repeat(161),
    "😀".repeat(41),
  ])(
    "rejects invalid invitation display name %j before mutation",
    async (displayName) => {
      const requests: StaffAuthMutation[] = [];
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async (request) => {
          requests.push(request);
          return invitationReady(request.operationId);
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
        type: "inspect_invitation",
      });
      await controller.dispatch({
        displayName,
        password: "pw",
        type: "accept_invitation",
      });

      expect(requests).toHaveLength(1);
      expect(controller.getSnapshot()).toMatchObject({
        kind: "invitation_ready",
      });
    },
  );

  it("accepts an exact 160-byte multibyte display name", async () => {
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return request.type === "inspect_invitation"
          ? invitationReady(request.operationId)
          : access("teacher", { email: "invited@example.test" });
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    await controller.dispatch({
      displayName: "😀".repeat(40),
      password: "pw",
      type: "accept_invitation",
    });
    expect(requests[1]).toMatchObject({ displayName: "😀".repeat(40) });
  });

  it("rejects an accessor-backed invitation display name without invoking it", async () => {
    let reads = 0;
    const requests: StaffAuthMutation[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return invitationReady(request.operationId);
      }),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    const action = { password: "pw", type: "accept_invitation" };
    Object.defineProperty(action, "displayName", {
      enumerable: true,
      get() {
        reads += 1;
        return "Invited Teacher";
      },
    });
    await controller.dispatch(action as unknown as StaffAuthAction);
    expect(reads).toBe(0);
    expect(requests).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      kind: "invitation_ready",
    });
  });

  it("surfaces authoritative invitation step-up as a terminal refresh notice", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) =>
        request.type === "inspect_invitation"
          ? invitationReady(request.operationId)
          : { kind: "step_up_required" },
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    await controller.dispatch({
      displayName: "Invited Teacher",
      password: "pw",
      type: "accept_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "invitation_step_up_required",
    });
  });

  it.each(["account", "email", "school", "role"] as const)(
    "rejects invitation acceptance when authoritative %s continuity changes",
    async (field) => {
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async (request) => {
          if (request.type === "inspect_invitation") {
            return invitationReady(request.operationId);
          }
          const invited = identity(
            field === "role" ? "admin" : "teacher",
            "invited@example.test",
          );
          const changed: StaffAuthBoundaryIdentity = {
            ...invited,
            ...(field === "account" ? { accountId: "different-account" } : {}),
            ...(field === "email" ? { email: "different@example.test" } : {}),
            ...(field === "school"
              ? {
                  school: {
                    id: "different-school",
                    label: "Different School",
                    settingsRevision: 1,
                  },
                }
              : {}),
          };
          return access(field === "role" ? "admin" : "teacher", {
            email: "invited@example.test",
            identity: changed,
          });
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
        type: "inspect_invitation",
      });
      await controller.dispatch({
        displayName: "Invited Teacher",
        password: "pw",
        type: "accept_invitation",
      });

      expect(controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
        operation: "invitation",
      });
    },
  );

  it("rejects an expired invitation receipt before sending acceptance", async () => {
    const requests: StaffAuthMutation[] = [];
    let now = Date.parse("2026-09-03T12:00:00.000Z");
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return invitationReady(request.operationId);
      }),
      { now: () => now },
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    now = Date.parse("2026-09-05T12:00:00.000Z");
    await controller.dispatch({
      displayName: "Invited Teacher",
      password: "pw",
      type: "accept_invitation",
    });

    expect(requests).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      kind: "invitation_rejected",
      reason: "expired",
    });
  });

  it.each([
    "account",
    "email",
    "profile",
    "profile-name",
    "membership",
    "school",
    "generation",
    "session",
    "aal",
  ] as const)(
    "fails closed when an Owner command result changes initiating %s authority",
    async (field) => {
      const initiating = access("owner");
      const actorIdentity: StaffAuthBoundaryIdentity = {
        ...initiating.identity,
        ...(field === "account" ? { accountId: "other-account" } : {}),
        ...(field === "email" ? { email: "other-owner@example.test" } : {}),
        ...(field === "profile"
          ? {
              profile: {
                ...initiating.identity.profile,
                id: "other-profile",
              },
            }
          : {}),
        ...(field === "profile-name"
          ? {
              profile: {
                ...initiating.identity.profile,
                displayName: "Other Owner",
              },
            }
          : {}),
        ...(field === "membership"
          ? {
              membership: {
                ...initiating.identity.membership,
                id: "other-membership",
              },
            }
          : {}),
        ...(field === "school"
          ? {
              school: {
                id: "other-school",
                label: "Other School",
                settingsRevision: 1,
              },
            }
          : {}),
      };
      const actor = access("owner", {
        assuranceLevel: field === "aal" ? "aal1" : "aal2",
        identity: actorIdentity,
        identityGeneration:
          field === "generation" ? "other-generation" : "identity-owner",
        sessionGeneration:
          field === "session" ? "other-session" : "session-owner",
      });
      const controller = createController(
        createAdapter(initiating, async () => ({
          actor,
          invitedRole: "teacher",
          kind: "staff_invitation_created",
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        email: "target@example.test",
        schoolId: "school-1",
        targetRole: "teacher",
        type: "create_staff_invitation",
      });

      expect(controller.getSnapshot()).toMatchObject({
        code: "invalid_backend_result",
        kind: "dependency_failure",
      });
    },
  );

  it("revalidates without trusting a forged stale-session revocation", async () => {
    const clear = vi.fn();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();

    emit?.({
      identityGeneration: "old-identity",
      kind: "session_revoked",
      sessionGeneration: "old-session",
    } as unknown as StaffAuthAccessEvent);

    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(clear).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "teacher" } },
        kind: "authenticated",
      }),
    );
  });

  it("clears School data before publishing revalidation and fresh revocation", async () => {
    const order: string[] = [];
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, {
      clear: () => order.push("clear"),
    });
    await controller.dispatch({ type: "bootstrap" });
    order.splice(0);
    controller.subscribe((state) => order.push(`state:${state.kind}`));

    adapter.read = async () => ({ kind: "session_revoked" });
    emit?.({ kind: "revalidation_required" });

    expect(order).toEqual(["clear", "state:bootstrapping"]);
    await vi.waitFor(() =>
      expect(order).toEqual([
        "clear",
        "state:bootstrapping",
        "state:session_revoked",
      ]),
    );
  });

  it("stays fail-closed without reading authority when protected-data clearing throws", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    let clears = 0;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, {
      clear() {
        clears += 1;
        if (clears > 1) {
          throw new Error("storage unavailable");
        }
      },
    });
    await controller.dispatch({ type: "bootstrap" });
    const read = vi.fn(async () => access("teacher"));
    adapter.read = read;
    emit?.({ kind: "revalidation_required" });

    expect(controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
      retryable: true,
    });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not restore authenticated UI when bootstrap data clearing fails", async () => {
    const controller = createController(createAdapter(access("teacher")), {
      clear() {
        throw new Error("storage unavailable");
      },
    });

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      operation: "bootstrap",
      retryable: true,
    });
  });

  it("rejects an invitation receipt bound to a different inspection operation", async () => {
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () =>
        invitationReady("different-operation"),
      ),
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "invitation",
    });
  });

  it.each([
    { profileId: "", schoolId: "school-1" },
    { profileId: "forged-profile", schoolId: "school-1" },
    { profileId: "profile-target-teacher", schoolId: "forged-school" },
  ])(
    "does not dispatch a blank or forged Membership selection $profileId/$schoolId",
    async ({ profileId, schoolId }) => {
      const perform = vi.fn();
      const adapter = createAdapter(access("owner"));
      adapter.perform = perform;
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId,
        schoolId,
        type: "review_staff_membership_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_revocation",
      });

      expect(perform).not.toHaveBeenCalled();
      expect(controller.getSnapshot()).toMatchObject({ kind: "authenticated" });
    },
  );

  it("ignores forged event grants and only applies fresh read authority", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });

    emit?.({
      access: access("owner"),
      kind: "access_changed",
      previousIdentityGeneration: "stale-identity",
      previousSessionGeneration: "session-teacher",
    } as unknown as StaffAuthAccessEvent);

    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "teacher" } },
        kind: "authenticated",
      }),
    );
  });

  it("revalidates without trusting malformed event generation claims", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });

    emit?.({
      extra: "not-allowed",
      identityGeneration: "identity-teacher",
      kind: "session_revoked",
      sessionGeneration: "session-teacher",
    } as unknown as StaffAuthAccessEvent);

    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "teacher" } },
        kind: "authenticated",
      }),
    );
  });

  it("rejects an accessor boundary before a validated Membership role can change", async () => {
    let getterReads = 0;
    const membership: Record<string, unknown> = {
      id: "membership-teacher",
      status: "active",
    };
    Object.defineProperty(membership, "role", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? "teacher" : "owner";
      },
    });
    const mutableIdentity = {
      ...identity("teacher"),
      membership,
    };
    const result = {
      ...access("teacher"),
      identity: mutableIdentity,
    } as unknown as StaffAuthBoundaryResult;
    const controller = createController(createAdapter(result));

    await controller.dispatch({ type: "bootstrap" });

    expect(getterReads).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "bootstrap",
    });
  });

  it("rejects accessor fields on a mutation envelope without evaluating them", async () => {
    let getterReads = 0;
    const adapter = createAdapter({ kind: "signed_out" });
    adapter.perform = async (request) => {
      const response: Record<string, unknown> = {
        result: { kind: "sign_in_rejected" },
      };
      Object.defineProperty(response, "operationId", {
        enumerable: true,
        get() {
          getterReads += 1;
          return request.operationId;
        },
      });
      return response as unknown as StaffAuthMutationResult;
    };
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "teacher@example.test",
      password: "password",
      type: "sign_in",
    });

    expect(getterReads).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "sign_in",
    });
  });

  it("clears access and revalidates without inspecting an event Proxy", async () => {
    const clear = vi.fn();
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, { clear });
    await controller.dispatch({ type: "bootstrap" });
    clear.mockClear();
    const ownKeys = vi.fn(() => {
      throw new Error("boundary trap");
    });
    const event = new Proxy(
      {
        identityGeneration: "identity-teacher",
        kind: "session_revoked",
        sessionGeneration: "session-teacher",
      },
      {
        ownKeys,
      },
    ) as unknown as StaffAuthAccessEvent;

    expect(() => emit?.(event)).not.toThrow();

    expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
    expect(clear).toHaveBeenCalledOnce();
    expect(ownKeys).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        identity: { membership: { role: "teacher" } },
        kind: "authenticated",
      }),
    );
  });

  it("clears the prior School before an access change enters a different account TOTP challenge", async () => {
    const order: string[] = [];
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, {
      clear: () => order.push("clear"),
    });
    await controller.dispatch({ type: "bootstrap" });
    order.splice(0);
    controller.subscribe((state) => order.push(`state:${state.kind}`));
    const administrator: StaffAuthBoundaryIdentity = {
      ...identity("admin", "admin@other-school.test"),
      accountId: "account-admin-school-2",
      school: { id: "school-2", label: "Other School", settingsRevision: 1 },
    };

    adapter.read = async () =>
      access("admin", {
        assuranceLevel: "aal1",
        identity: administrator,
        identityGeneration: "identity-admin-school-2",
        secondFactor: "challenge_required",
        sessionGeneration: "session-admin-school-2",
      });
    emit?.({ kind: "revalidation_required" });

    expect(order).toEqual(["clear", "state:bootstrapping"]);
    await vi.waitFor(() =>
      expect(order).toEqual([
        "clear",
        "state:bootstrapping",
        "state:totp_challenge",
      ]),
    );
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_challenge",
      role: "administrator",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("school-1");
  });

  it("does not enter a new access challenge when clearing the prior School fails", async () => {
    let emit: ((event: StaffAuthAccessEvent) => void) | undefined;
    let clears = 0;
    const adapter = createAdapter(access("teacher"));
    adapter.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const controller = createController(adapter, {
      clear() {
        clears += 1;
        if (clears > 1) {
          throw new Error("storage unavailable");
        }
      },
    });
    await controller.dispatch({ type: "bootstrap" });

    const read = vi.fn(async () =>
      access("admin", {
        assuranceLevel: "aal1",
        secondFactor: "challenge_required",
      }),
    );
    adapter.read = read;
    emit?.({ kind: "revalidation_required" });

    expect(controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
    });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });

  it("scrubs and inspects an invitation while the cold bootstrap read is pending", async () => {
    const read = deferred<StaffAuthBoundaryResult>();
    const history = vi.fn();
    const requests: StaffAuthMutation[] = [];
    const adapter: StaffAuthAdapter = {
      read: () => read.promise,
      async perform(request) {
        requests.push(request);
        return {
          operationId: request.operationId,
          result: invitationReady(request.operationId),
        };
      },
      subscribe() {
        return () => undefined;
      },
    };
    const controller = createController(adapter, {
      history,
    });
    const bootstrap = controller.dispatch({ type: "bootstrap" });

    const invitation = controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });
    expect(history).toHaveBeenCalledWith("/");
    expect(requests).toHaveLength(1);
    await invitation;
    read.resolve(access("owner"));
    await bootstrap;

    expect(controller.getSnapshot()).toMatchObject({
      intendedEmail: "invited@example.test",
      kind: "invitation_ready",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      invitationTokenHash,
    );
  });

  it("clears cold protected data before a recovery exchange can publish readiness", async () => {
    const order: string[] = [];
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async () => {
        order.push("exchange");
        return { kind: "password_recovery_ready" };
      }),
      {
        clear: () => order.push("clear"),
        history: () => order.push("scrub"),
      },
    );
    controller.subscribe((state) => order.push(`state:${state.kind}`));

    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=code`,
      type: "consume_recovery_callback",
    });

    expect(order).toEqual([
      "scrub",
      "state:processing_recovery_callback",
      "clear",
      "exchange",
      "state:password_recovery_ready",
    ]);
  });

  it("blocks a cold recovery exchange when protected data cannot be cleared", async () => {
    const perform = vi.fn();
    const history = vi.fn();
    const adapter = createAdapter({ kind: "signed_out" });
    adapter.perform = perform;
    const controller = createController(adapter, {
      clear() {
        throw new Error("storage unavailable");
      },
      history,
    });

    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=recovery&flow=${"f".repeat(22)}&state=${"s".repeat(43)}&code=code`,
      type: "consume_recovery_callback",
    });

    expect(history).toHaveBeenCalledWith("/");
    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "recovery_callback",
    });
  });

  it("keeps an invalid invitation operation-ID failure terminal after scrubbing", async () => {
    const perform = vi.fn();
    const history = vi.fn();
    const adapter = createAdapter({ kind: "signed_out" });
    adapter.perform = perform;
    const controller = createController(adapter, {
      history,
      nextOperationId: () => "",
    });

    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });

    expect(history).toHaveBeenCalledWith("/");
    expect(perform).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "invitation",
    });
  });

  it("keeps a duplicate invitation operation-ID failure terminal after scrubbing", async () => {
    const requests: StaffAuthMutation[] = [];
    const history = vi.fn();
    const controller = createController(
      createAdapter({ kind: "signed_out" }, async (request) => {
        requests.push(request);
        return { kind: "invitation_rejected", reason: "invalid" };
      }),
      {
        history,
        nextOperationId: () => "same-operation",
      },
    );
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      type: "inspect_invitation",
    });

    await controller.dispatch({
      callbackUrl: `https://app.example.test/?auth=invite#token_hash=${alternateInvitationTokenHash}`,
      type: "inspect_invitation",
    });

    expect(history).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledWith("/");
    expect(requests).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "invitation",
    });
  });
});

describe("Membership administration confirmations", () => {
  it.each([
    ["admin", "teacher", 7],
    ["teacher", "admin", 11],
  ] as const)(
    "lets an Owner review a %s to %s role change with private revision binding",
    async (currentRole, targetRole, expectedRoleRevision) => {
      const target = manageableStaff().find(
        (entry) => entry.role === currentRole,
      )!;
      const updatedStaff = manageableStaff().map((entry) =>
        entry.profile.id === target.profile.id
          ? {
              ...entry,
              role: targetRole,
              roleRevision: expectedRoleRevision + 1,
            }
          : entry,
      );
      const requests: StaffAuthMutation[] = [];
      const controller = createController(
        createAdapter(access("owner"), async (request) => {
          requests.push(request);
          return {
            actor: access("owner", { manageableStaff: updatedStaff }),
            changedRole: targetRole,
            kind: "staff_membership_role_changed",
            profileId: target.profile.id,
            schoolId: "school-1",
          };
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: target.profile.id,
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "confirming_staff_membership_role_change",
        schoolLabel: "Synthetic High School",
        target: {
          displayName: target.profile.displayName,
          email: target.profile.email,
          role: currentRole === "admin" ? "administrator" : "teacher",
        },
        targetRole: targetRole === "admin" ? "administrator" : "teacher",
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toMatch(
        /profile-target|school-1|roleRevision|identity-owner|session-owner/,
      );
      expect(requests).toHaveLength(0);
      await controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        expectedIdentityGeneration: "identity-owner",
        expectedRoleRevision,
        expectedSessionGeneration: "session-owner",
        operationId: "operation-1",
        profileId: target.profile.id,
        schoolId: "school-1",
        targetRole,
        type: "change_staff_membership_role",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "staff_membership_role_changed",
        manageableStaff: expect.arrayContaining([
          expect.objectContaining({
            profile: target.profile,
            role: targetRole === "admin" ? "administrator" : "teacher",
            roleRevision: expectedRoleRevision + 1,
          }),
        ]),
        targetName: target.profile.displayName,
        targetRole: targetRole === "admin" ? "administrator" : "teacher",
      });
      controller.dispose();
    },
  );

  it.each([
    [
      "role change",
      {
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      },
      "confirm_staff_membership_role_change",
      "change_staff_membership_role",
      "staff_membership_role_change_rejected",
    ],
    [
      "Membership revocation",
      {
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_revocation",
      },
      "confirm_staff_membership_revocation",
      "revoke_staff_membership",
      "staff_membership_revocation_rejected",
    ],
    [
      "invitation revocation",
      {
        invitationId: "invitation-pending",
        schoolId: "school-1",
        type: "review_staff_invitation_revocation",
      },
      "confirm_staff_invitation_revocation",
      "revoke_staff_invitation",
      "staff_invitation_revocation_rejected",
    ],
  ] as const)(
    "waits for fresh authority and coalesces repeated confirmation of %s",
    async (_label, review, confirmType, mutationType, rejectedKind) => {
      const owner = access("owner", {
        manageableInvitations: manageableInvitations(),
      });
      const fresh = deferred<StaffAuthBoundaryResult>();
      const adapter = createAdapter(owner, async () => ({
        actor: owner,
        kind: rejectedKind,
      }));
      const perform = vi.spyOn(adapter, "perform");
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch(review);
      const read = vi.fn(() => fresh.promise);
      adapter.read = read;

      const confirmation = controller.dispatch({ type: confirmType });
      const repeatedConfirmation = controller.dispatch({ type: confirmType });
      expect(read).toHaveBeenCalledOnce();
      expect(perform).not.toHaveBeenCalled();
      fresh.resolve(owner);
      await Promise.all([confirmation, repeatedConfirmation]);

      expect(perform).toHaveBeenCalledOnce();
      expect(perform.mock.calls[0]?.[0]).toMatchObject({
        expectedIdentityGeneration: "identity-owner",
        expectedSessionGeneration: "session-owner",
        type: mutationType,
      });
      expect(controller.getSnapshot()).toMatchObject({ kind: rejectedKind });
      controller.dispose();
    },
  );

  it.each([
    [
      "review_staff_membership_role_change",
      "confirm_staff_membership_role_change",
    ],
    [
      "review_staff_membership_revocation",
      "confirm_staff_membership_revocation",
    ],
  ] as const)(
    "cancels a stale target revision before %s can mutate",
    async (reviewType, confirmType) => {
      const adapter = createAdapter(access("owner"));
      const perform = vi.spyOn(adapter, "perform");
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: reviewType,
      });
      adapter.read = async () =>
        access("owner", {
          manageableStaff: manageableStaff().map((entry) =>
            entry.role === "teacher"
              ? { ...entry, roleRevision: entry.roleRevision + 1 }
              : entry,
          ),
        });

      await controller.dispatch({ type: confirmType });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "staff_membership_revision_conflict",
      });
      expect(perform).not.toHaveBeenCalled();
      await controller.dispatch({ type: confirmType });
      expect(perform).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it("keeps an unchanged role-change target selected when unrelated staff changes", async () => {
    const adapter = createAdapter(access("owner"), async () => ({
      actor: access("owner"),
      kind: "staff_membership_role_change_rejected",
    }));
    const perform = vi.spyOn(adapter, "perform");
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      profileId: "profile-target-teacher",
      schoolId: "school-1",
      type: "review_staff_membership_role_change",
    });
    const confirmation = controller.getSnapshot();
    const publish = vi.fn();
    controller.subscribe(publish);
    publish.mockClear();
    adapter.read = async () =>
      access("owner", {
        manageableStaff: manageableStaff().map((entry) =>
          entry.role === "admin"
            ? { ...entry, roleRevision: entry.roleRevision + 1 }
            : entry,
        ),
      });

    await controller.refreshMembership();
    expect(controller.getSnapshot()).toBe(confirmation);
    expect(publish).not.toHaveBeenCalled();
    await controller.dispatch({ type: "confirm_staff_membership_role_change" });
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0]?.[0]).toMatchObject({
      expectedRoleRevision: 11,
      profileId: "profile-target-teacher",
      targetRole: "admin",
      type: "change_staff_membership_role",
    });
    controller.dispose();
  });

  it("refreshes an unknown role change without replay or inferred success", async () => {
    const adapter = createAdapter(access("owner"), async () => ({
      kind: "staff_membership_role_change_unconfirmed",
    }));
    const perform = vi.spyOn(adapter, "perform");
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      profileId: "profile-target-teacher",
      schoolId: "school-1",
      type: "review_staff_membership_role_change",
    });
    await controller.dispatch({ type: "confirm_staff_membership_role_change" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "staff_membership_role_change_unconfirmed",
    });
    await controller.dispatch({ type: "retry" });
    await controller.dispatch({ type: "confirm_staff_membership_role_change" });
    expect(perform).toHaveBeenCalledOnce();
    const read = vi.fn(async () =>
      access("owner", {
        manageableStaff: manageableStaff().map((entry) =>
          entry.role === "teacher"
            ? { ...entry, role: "admin", roleRevision: entry.roleRevision + 1 }
            : entry,
        ),
      }),
    );
    adapter.read = read;

    await controller.dispatch({ type: "refresh_staff" });
    expect(read).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      kind: "authenticated",
      manageableStaff: expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({ id: "profile-target-teacher" }),
          role: "administrator",
          roleRevision: 12,
        }),
      ]),
    });
    await controller.dispatch({ type: "confirm_staff_membership_role_change" });
    expect(perform).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it.each(["role", "revision"] as const)(
    "rejects a role-change success with contradictory refreshed target %s evidence",
    async (field) => {
      const staff = manageableStaff().map((entry) =>
        entry.role !== "teacher"
          ? entry
          : ({
              ...entry,
              role: field === "role" ? "teacher" : "admin",
              roleRevision: field === "revision" ? 11 : 12,
            } as const),
      );
      const controller = createController(
        createAdapter(access("owner"), async () => ({
          actor: access("owner", { manageableStaff: staff }),
          changedRole: "admin",
          kind: "staff_membership_role_changed",
          profileId: "profile-target-teacher",
          schoolId: "school-1",
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "dependency_failure",
        code: "invalid_backend_result",
        operation: "staff_membership_role_change",
      });
      controller.dispose();
    },
  );

  it.each(["later role change", "later revocation"] as const)(
    "keeps acknowledged role-change success separate from fresh %s state",
    async (laterChange) => {
      const staff = manageableStaff().flatMap((entry) =>
        entry.role !== "teacher"
          ? [entry]
          : laterChange === "later revocation"
            ? []
            : [{ ...entry, roleRevision: 13 }],
      );
      const controller = createController(
        createAdapter(access("owner"), async () => ({
          actor: access("owner", { manageableStaff: staff }),
          changedRole: "admin",
          kind: "staff_membership_role_changed",
          profileId: "profile-target-teacher",
          schoolId: "school-1",
        })),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });
      const snapshot = controller.getSnapshot();
      expect(snapshot).toMatchObject({
        kind: "staff_membership_role_changed",
        targetRole: "administrator",
      });
      if (snapshot.kind !== "staff_membership_role_changed")
        throw new Error("Expected acknowledged role change");
      expect(
        snapshot.manageableStaff.find(
          (entry) => entry.profile.id === "profile-target-teacher",
        ),
      ).toEqual(
        laterChange === "later revocation"
          ? undefined
          : {
              ...manageableStaff()[1]!,
              roleRevision: 13,
            },
      );
      controller.dispose();
    },
  );
});

describe("ended sessions during Membership management", () => {
  it.each([
    {
      commandType: "create_staff_invitation",
      review: null,
      action: {
        email: "teacher@example.test",
        schoolId: "school-1",
        targetRole: "teacher",
        type: "create_staff_invitation",
      },
    },
    {
      commandType: "revoke_staff_invitation",
      review: {
        invitationId: "invitation-pending",
        schoolId: "school-1",
        type: "review_staff_invitation_revocation",
      },
      action: { type: "confirm_staff_invitation_revocation" },
    },
    {
      commandType: "revoke_staff_membership",
      review: {
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_revocation",
      },
      action: { type: "confirm_staff_membership_revocation" },
    },
    {
      commandType: "change_staff_membership_role",
      review: {
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      },
      action: { type: "confirm_staff_membership_role_change" },
    },
  ] as const)(
    "returns to neutral signed out after $commandType without extra account actions",
    async ({ action, commandType, review }) => {
      const owner = access("owner", {
        manageableInvitations: manageableInvitations(),
      });
      const adapter = createAdapter(owner, async () => ({
        kind: "signed_out",
      }));
      const read = vi.spyOn(adapter, "read");
      const perform = vi.spyOn(adapter, "perform");
      const order: string[] = [];
      const controller = createController(adapter, {
        clear: () => {
          order.push("clear");
        },
      });
      controller.subscribe((snapshot) => {
        order.push(`state:${snapshot.kind}`);
      });
      await controller.dispatch({ type: "bootstrap" });
      if (review !== null) await controller.dispatch(review);
      order.splice(0);

      await controller.dispatch(action);

      expect(read).toHaveBeenCalledTimes(2);
      expect(perform).toHaveBeenCalledOnce();
      expect(perform.mock.calls[0]?.[0]).toMatchObject({
        expectedIdentityGeneration: "identity-owner",
        expectedSessionGeneration: "session-owner",
        type: commandType,
      });
      expect(controller.getSnapshot()).toEqual({
        kind: "signed_out",
        notice: null,
        revision: expect.any(Number),
      });
      expect(order.slice(-2)).toEqual(["clear", "state:signed_out"]);
      const ended = controller.getSnapshot();
      await controller.dispatch({ type: "retry" });
      await controller.dispatch({
        type: "confirm_staff_invitation_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });
      await controller.refreshMembership();
      expect(controller.getSnapshot()).toBe(ended);
      expect(read).toHaveBeenCalledTimes(2);
      expect(perform).toHaveBeenCalledOnce();
      controller.dispose();
    },
  );
});

describe("Membership result freshness", () => {
  it.each(["unchanged", "revoked"] as const)(
    "revalidates a completed role-change receipt when authority is %s",
    async (authorityState) => {
      const freshActor = access("owner", {
        manageableStaff: manageableStaff().map((entry) =>
          entry.role === "teacher"
            ? { ...entry, role: "admin", roleRevision: 12 }
            : entry,
        ),
      });
      const adapter = createAdapter(access("owner"), async () => ({
        actor: freshActor,
        changedRole: "admin",
        kind: "staff_membership_role_changed",
        profileId: "profile-target-teacher",
        schoolId: "school-1",
      }));
      const perform = vi.spyOn(adapter, "perform");
      const order: string[] = [];
      const controller = createController(adapter, {
        clear: () => {
          order.push("clear");
        },
      });
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        profileId: "profile-target-teacher",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_role_change",
      });
      const receipt = controller.getSnapshot();
      expect(receipt).toMatchObject({ kind: "staff_membership_role_changed" });
      const publish = vi.fn();
      controller.subscribe((snapshot) => {
        publish(snapshot);
        order.push(`state:${snapshot.kind}`);
      });
      publish.mockClear();
      order.splice(0);
      const read = vi.fn<StaffAuthAdapter["read"]>(async () =>
        authorityState === "revoked"
          ? { kind: "membership_inactive" }
          : freshActor,
      );
      adapter.read = read;

      await controller.refreshMembership();

      expect(read).toHaveBeenCalledOnce();
      expect(perform).toHaveBeenCalledOnce();
      if (authorityState === "unchanged") {
        expect(controller.getSnapshot()).toBe(receipt);
        expect(publish).not.toHaveBeenCalled();
        expect(order).toEqual([]);
      } else {
        expect(controller.getSnapshot()).toMatchObject({
          kind: "membership_inactive",
        });
        expect(order).toEqual(["clear", "state:membership_inactive"]);
        expect(JSON.stringify(controller.getSnapshot())).not.toMatch(
          /Ada|Theo|profile-target|manageableStaff/,
        );
      }
      controller.dispose();
    },
  );
});

describe("Administrator management authority", () => {
  it("lets an active AAL2 Administrator invite a Teacher using initiating generations", async () => {
    const actor = access("admin");
    const adapter = createAdapter(actor, async () => ({
      actor,
      invitedRole: "teacher",
      kind: "staff_invitation_created",
    }));
    const perform = vi.spyOn(adapter, "perform");
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      email: "new-teacher@example.test",
      schoolId: "school-1",
      targetRole: "teacher",
      type: "create_staff_invitation",
    });
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0]?.[0]).toEqual({
      email: "new-teacher@example.test",
      expectedIdentityGeneration: "identity-admin",
      expectedSessionGeneration: "session-admin",
      operationId: "operation-1",
      schoolId: "school-1",
      targetRole: "teacher",
      type: "create_staff_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "staff_invitation_created",
      targetRole: "teacher",
    });
    controller.dispose();
  });

  it.each(["Membership", "invitation"] as const)(
    "lets an active AAL2 Administrator revoke a selected Teacher %s",
    async (selectionKind) => {
      const actor = access("admin", {
        manageableStaff: manageableStaff().filter(
          (entry) => entry.role === "teacher",
        ),
        manageableInvitations: manageableInvitations(),
      });
      const adapter = createAdapter(actor, async () =>
        selectionKind === "Membership"
          ? {
              actor,
              kind: "staff_membership_revoked",
              profileId: "profile-target-teacher",
              revokedRole: "teacher",
              schoolId: "school-1",
            }
          : {
              actor,
              kind: "staff_invitation_revoked",
              invitationId: "invitation-pending",
              revokedRole: "teacher",
              schoolId: "school-1",
            },
      );
      const perform = vi.spyOn(adapter, "perform");
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch(
        selectionKind === "Membership"
          ? {
              profileId: "profile-target-teacher",
              schoolId: "school-1",
              type: "review_staff_membership_revocation",
            }
          : {
              invitationId: "invitation-pending",
              schoolId: "school-1",
              type: "review_staff_invitation_revocation",
            },
      );
      expect(perform).not.toHaveBeenCalled();
      await controller.dispatch({
        type:
          selectionKind === "Membership"
            ? "confirm_staff_membership_revocation"
            : "confirm_staff_invitation_revocation",
      });
      expect(perform).toHaveBeenCalledOnce();
      expect(perform.mock.calls[0]?.[0]).toEqual({
        expectedIdentityGeneration: "identity-admin",
        expectedSessionGeneration: "session-admin",
        operationId: "operation-1",
        schoolId: "school-1",
        ...(selectionKind === "Membership"
          ? {
              expectedRoleRevision: 11,
              profileId: "profile-target-teacher",
              type: "revoke_staff_membership",
            }
          : {
              invitationId: "invitation-pending",
              type: "revoke_staff_invitation",
            }),
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind:
          selectionKind === "Membership"
            ? "staff_membership_revoked"
            : "staff_invitation_revoked",
        targetRole: "teacher",
      });
      controller.dispose();
    },
  );

  it("keeps role changes Owner-only even for a manageable Teacher", async () => {
    const adapter = createAdapter(
      access("admin", {
        manageableStaff: manageableStaff().filter(
          (entry) => entry.role === "teacher",
        ),
      }),
    );
    const perform = vi.spyOn(adapter, "perform");
    const controller = createController(adapter);
    await controller.dispatch({ type: "bootstrap" });
    const initial = controller.getSnapshot();
    await controller.dispatch({
      profileId: "profile-target-teacher",
      schoolId: "school-1",
      type: "review_staff_membership_role_change",
    });
    await controller.dispatch({ type: "confirm_staff_membership_role_change" });
    expect(controller.getSnapshot()).toBe(initial);
    expect(perform).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["staff", "invitations"] as const)(
    "rejects an Administrator grant exposing Administrator %s",
    async (listKind) => {
      const actor = access("admin", {
        manageableStaff: listKind === "staff" ? manageableStaff() : [],
        manageableInvitations:
          listKind === "invitations"
            ? [{ ...manageableInvitations()[0]!, role: "admin" }]
            : [],
      });
      const adapter = createAdapter(actor);
      const perform = vi.spyOn(adapter, "perform");
      const controller = createController(adapter);
      await controller.dispatch({ type: "bootstrap" });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "dependency_failure",
        code: "invalid_backend_result",
        operation: "bootstrap",
      });
      await controller.dispatch({
        invitationId: "invitation-pending",
        schoolId: "school-1",
        type: "review_staff_invitation_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_invitation_revocation",
      });
      await controller.dispatch({
        profileId: "profile-target-admin",
        schoolId: "school-1",
        type: "review_staff_membership_revocation",
      });
      await controller.dispatch({
        type: "confirm_staff_membership_revocation",
      });
      expect(perform).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "11",
    11n,
    undefined,
    null,
    true,
  ])(
    "rejects an invalid management revision %s before publishing a target",
    async (roleRevision) => {
      const actor = access("owner", {
        manageableStaff: [
          { ...manageableStaff()[1]!, roleRevision },
        ] as unknown as StaffAuthBoundaryManagedStaff[],
      });
      const controller = createController(createAdapter(actor));
      await controller.dispatch({ type: "bootstrap" });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "dependency_failure",
        code: "invalid_backend_result",
        operation: "bootstrap",
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        "profile-target-teacher",
      );
      controller.dispose();
    },
  );

  it("rejects a management target with its revision omitted", async () => {
    const { profile, role, schoolId } = manageableStaff()[1]!;
    const actor = access("owner", {
      manageableStaff: [
        { profile, role, schoolId },
      ] as unknown as StaffAuthBoundaryManagedStaff[],
    });
    const controller = createController(createAdapter(actor));
    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      code: "invalid_backend_result",
      operation: "bootstrap",
    });
    controller.dispose();
  });
});

describe("composed authentication outcome separation", () => {
  it.each(["updated", "rejected", "unknown"] as const)(
    "keeps accepted Membership distinct from password %s and permits a fresh sign in",
    async (passwordOutcome) => {
      const controller = createController(
        createAdapter({ kind: "signed_out" }, async (request) => {
          if (request.type === "inspect_invitation")
            return invitationReady(request.operationId);
          if (request.type === "reset_to_sign_in")
            return { kind: "reset_to_sign_in_complete" };
          return { kind: "invitation_accepted", passwordOutcome };
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        type: "inspect_invitation",
        callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
      });
      await controller.dispatch({
        type: "accept_invitation",
        displayName: "Invited Teacher",
        password: "private-new-password",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "invitation_accepted",
        passwordOutcome,
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        "private-new-password",
      );
      await controller.dispatch({ type: "back_to_sign_in" });
      expect(controller.getSnapshot()).toMatchObject({ kind: "signed_out" });
      controller.dispose();
    },
  );

  it.each([true, false])(
    "retains unknown password outcome when cleanupComplete=%s",
    async (cleanupComplete) => {
      const controller = createController(
        createAdapter({ kind: "password_recovery_ready" }, async (request) => {
          if (request.type === "reset_to_sign_in")
            return { kind: "reset_to_sign_in_complete" };
          return {
            kind: "password_recovery_uncertain",
            passwordOutcome: "unknown",
            cleanupComplete,
          };
        }),
      );
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({
        type: "complete_password_recovery",
        password: "private-new-password",
      });
      expect(controller.getSnapshot()).toMatchObject({
        kind: "password_recovery_uncertain",
        passwordOutcome: "unknown",
        cleanupComplete,
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        "private-new-password",
      );
      await controller.dispatch({ type: "back_to_sign_in" });
      expect(controller.getSnapshot()).toMatchObject({ kind: "signed_out" });
      controller.dispose();
    },
  );
});

it("accepts a durable invitation after its same School was renamed", async () => {
  const invited = identity("teacher", "invited@example.test");
  const controller = createController(
    createAdapter({ kind: "signed_out" }, async (request) =>
      request.type === "inspect_invitation"
        ? invitationReady(request.operationId)
        : access("teacher", {
            email: "invited@example.test",
            identity: {
              ...invited,
              school: {
                ...invited.school,
                label: "Renamed High School",
                settingsRevision: 2,
              },
            },
          }),
    ),
  );
  await controller.dispatch({ type: "bootstrap" });
  await controller.dispatch({
    type: "inspect_invitation",
    callbackUrl: `https://app.example.test/?auth=invite#token_hash=${invitationTokenHash}`,
  });
  await controller.dispatch({
    type: "accept_invitation",
    displayName: "Invited Teacher",
    password: "synthetic-password",
  });
  expect(controller.getSnapshot()).toMatchObject({
    kind: "authenticated",
    identity: {
      accountId: "account-teacher",
      school: {
        id: "school-1",
        label: "Renamed High School",
        settingsRevision: 2,
      },
    },
  });
  controller.dispose();
});
