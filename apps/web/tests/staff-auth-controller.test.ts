import { describe, expect, it } from "vitest";

import {
  createStaffAuthController,
  type StaffAuthAdapter,
  type StaffAuthBoundaryResult,
  type StaffAuthMutation,
} from "../src/auth/staff-auth-controller.js";

function createAdapter(
  readResult: Awaited<ReturnType<StaffAuthAdapter["read"]>>,
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
    perform,
    subscribe() {
      return () => undefined;
    },
  };
}

describe("staff auth controller", () => {
  it("bootstraps signed out and clears protected School data", async () => {
    let clears = 0;
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind: "signed_out" }),
      protectedSchoolData: {
        clear() {
          clears += 1;
        },
      },
    });

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toEqual({
      kind: "signed_out",
      notice: null,
      revision: 2,
    });
    expect(clears).toBe(1);
  });

  it("requires an Administrator at AAL1 to pass a TOTP challenge before granting access", async () => {
    const requests: StaffAuthMutation[] = [];
    const adapter = createAdapter({ kind: "signed_out" }, async (request) => {
      requests.push(request);
      if (request.type === "sign_in") {
        return {
          assuranceLevel: "aal1",
          email: "admin@example.test",
          kind: "access_granted",
          role: "admin",
          secondFactor: "challenge_required",
        };
      }
      return {
        assuranceLevel: "aal2",
        email: "admin@example.test",
        kind: "access_granted",
        role: "admin",
        secondFactor: "satisfied",
      };
    });
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "admin@example.test",
      password: "correct horse battery staple",
      type: "sign_in",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_challenge",
      purpose: "step_up",
      role: "administrator",
    });

    await controller.dispatch({ code: "123456", type: "verify_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      assuranceLevel: "aal2",
      email: "admin@example.test",
      kind: "authenticated",
      role: "administrator",
    });
    expect(requests).toEqual([
      {
        email: "admin@example.test",
        password: "correct horse battery staple",
        type: "sign_in",
      },
      { code: "123456", purpose: "step_up", type: "verify_totp" },
    ]);
  });

  it("keeps a rejected or cancelled TOTP challenge fail-closed without mutating School data", async () => {
    let clears = 0;
    const requests: StaffAuthMutation[] = [];
    const adapter = createAdapter(
      {
        assuranceLevel: "aal1",
        email: "owner@example.test",
        kind: "access_granted",
        role: "owner",
        secondFactor: "challenge_required",
      },
      async (request) => {
        requests.push(request);
        return { kind: "totp_rejected" };
      },
    );
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: {
        clear() {
          clears += 1;
        },
      },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({ code: "000000", type: "verify_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      feedback: "rejected",
      kind: "totp_challenge",
      purpose: "step_up",
    });

    await controller.dispatch({ type: "cancel_totp" });
    expect(controller.getSnapshot()).toMatchObject({
      feedback: "cancelled",
      kind: "totp_challenge",
      purpose: "step_up",
    });
    expect(requests).toHaveLength(1);
    expect(clears).toBe(0);
  });

  it("shows a generic sign-in rejection without granting access", async () => {
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind: "signed_out" }, async () => ({
        kind: "sign_in_rejected",
      })),
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "unknown@example.test",
      password: "not-the-password",
      type: "sign_in",
    });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "sign_in_rejected",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "unknown@example.test",
    );
  });

  it("provides visible required and sent states for email verification", async () => {
    const adapter = createAdapter({ kind: "signed_out" }, async (request) =>
      request.type === "sign_in"
        ? { kind: "email_verification_required" }
        : { kind: "email_verification_sent" },
    );
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "teacher@example.test",
      password: "correct horse battery staple",
      type: "sign_in",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "email_verification_required",
    });

    await controller.dispatch({ type: "resend_email_verification" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "email_verification_sent",
    });
  });

  it("shows the identical recovery notice for known and unknown email addresses", async () => {
    async function requestRecovery(email: string) {
      const controller = createStaffAuthController({
        adapter: createAdapter({ kind: "signed_out" }, async () => ({
          kind: "recovery_request_received",
        })),
        protectedSchoolData: { clear() {} },
      });
      await controller.dispatch({ type: "bootstrap" });
      await controller.dispatch({ email, type: "request_password_recovery" });
      return { kind: controller.getSnapshot().kind };
    }

    const known = await requestRecovery("known@example.test");
    const unknown = await requestRecovery("unknown@example.test");

    expect(known).toEqual({ kind: "recovery_notice" });
    expect(unknown).toEqual(known);
    expect(JSON.stringify(unknown)).not.toContain("unknown@example.test");
  });

  it.each(["invalid", "expired", "replayed"] as const)(
    "rejects a %s invitation with a stable sanitized state",
    async (reason) => {
      const invitationToken = `do-not-retain-${reason}`;
      const controller = createStaffAuthController({
        adapter: createAdapter({ kind: "signed_out" }, async () => ({
          kind: "invitation_rejected",
          reason,
        })),
        protectedSchoolData: { clear() {} },
      });
      await controller.dispatch({ type: "bootstrap" });

      await controller.dispatch({
        invitationToken,
        type: "inspect_invitation",
      });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "invitation_rejected",
        reason,
      });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(
        invitationToken,
      );
    },
  );

  it("accepts an Administrator invitation only after inspection and enters TOTP enrollment", async () => {
    const requests: StaffAuthMutation[] = [];
    const adapter = createAdapter({ kind: "signed_out" }, async (request) => {
      requests.push(request);
      if (request.type === "inspect_invitation") {
        return {
          kind: "invitation_ready",
          role: "admin",
          schoolLabel: "Synthetic High School",
        };
      }
      if (request.type === "accept_invitation") {
        return {
          assuranceLevel: "aal1",
          email: "invited@example.test",
          kind: "access_granted",
          role: "admin",
          secondFactor: "enrollment_required",
        };
      }
      return { kind: "totp_challenge_ready" };
    });
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      invitationToken: "one-time-invitation",
      type: "inspect_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "invitation_ready",
      role: "administrator",
      schoolLabel: "Synthetic High School",
    });

    await controller.dispatch({
      password: "correct horse battery staple",
      type: "accept_invitation",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "totp_enrollment_required",
      role: "administrator",
    });

    await controller.dispatch({ type: "begin_totp_enrollment" });
    expect(controller.getSnapshot()).toMatchObject({
      feedback: "none",
      kind: "totp_challenge",
      purpose: "enrollment",
      role: "administrator",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "one-time-invitation",
    );
  });

  it.each([
    ["sign_out_local", "local", "signed_out"],
    ["revoke_all_sessions", "all", "all_sessions_revoked"],
  ] as const)(
    "%s clears protected data only after authoritative success",
    async (actionType, scope, notice) => {
      let clears = 0;
      const requests: StaffAuthMutation[] = [];
      const adapter = createAdapter(
        {
          assuranceLevel: "aal1",
          email: "teacher@example.test",
          kind: "access_granted",
          role: "teacher",
          secondFactor: "satisfied",
        },
        async (request) => {
          requests.push(request);
          return { kind: "signed_out" };
        },
      );
      const controller = createStaffAuthController({
        adapter,
        protectedSchoolData: {
          clear() {
            clears += 1;
          },
        },
      });
      await controller.dispatch({ type: "bootstrap" });
      expect(clears).toBe(0);

      await controller.dispatch({ type: actionType });

      expect(controller.getSnapshot()).toMatchObject({
        kind: "signed_out",
        notice,
      });
      expect(requests).toEqual([{ scope, type: "sign_out" }]);
      expect(clears).toBe(1);
    },
  );

  it.each([
    "session_expired",
    "session_revoked",
    "membership_inactive",
  ] as const)(
    "clears protected School data when the adapter reports %s",
    async (kind) => {
      let clears = 0;
      let emit: Parameters<StaffAuthAdapter["subscribe"]>[0] | undefined;
      const adapter: StaffAuthAdapter = {
        async read() {
          return {
            assuranceLevel: "aal1",
            email: "teacher@example.test",
            kind: "access_granted",
            role: "teacher",
            secondFactor: "satisfied",
          };
        },
        async perform() {
          throw new Error("unexpected mutation");
        },
        subscribe(listener) {
          emit = listener;
          return () => undefined;
        },
      };
      const controller = createStaffAuthController({
        adapter,
        protectedSchoolData: {
          clear() {
            clears += 1;
          },
        },
      });
      await controller.dispatch({ type: "bootstrap" });

      emit?.({ kind });

      expect(controller.getSnapshot()).toMatchObject({ kind });
      expect(clears).toBe(1);
    },
  );

  it("sanitizes a retryable dependency failure and retries the safe operation", async () => {
    let reads = 0;
    const adapter: StaffAuthAdapter = {
      async read() {
        reads += 1;
        if (reads === 1) {
          throw new Error("SENTINEL-provider-detail-must-not-render");
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
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });

    await controller.dispatch({ type: "bootstrap" });
    expect(controller.getSnapshot()).toMatchObject({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
      retryable: true,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");

    await controller.dispatch({ type: "retry" });
    expect(controller.getSnapshot()).toMatchObject({ kind: "signed_out" });
    expect(reads).toBe(2);
  });

  it("does not claim all-session revocation or clear data when the dependency fails", async () => {
    let attempts = 0;
    let clears = 0;
    const adapter = createAdapter(
      {
        assuranceLevel: "aal2",
        email: "owner@example.test",
        kind: "access_granted",
        role: "owner",
        secondFactor: "satisfied",
      },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("SENTINEL-revocation-provider-detail");
        }
        return { kind: "signed_out" };
      },
    );
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: {
        clear() {
          clears += 1;
        },
      },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({ type: "revoke_all_sessions" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "dependency_failure",
      operation: "revoke_all_sessions",
      retryable: true,
    });
    expect(clears).toBe(0);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");

    await controller.dispatch({ type: "retry" });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "signed_out",
      notice: "all_sessions_revoked",
    });
    expect(clears).toBe(1);
  });

  it("completes a password-recovery PKCE callback without retaining callback credentials", async () => {
    const requests: StaffAuthMutation[] = [];
    const adapter = createAdapter({ kind: "signed_out" }, async (request) => {
      requests.push(request);
      return request.type === "exchange_pkce_code"
        ? { kind: "password_recovery_ready" }
        : { kind: "password_recovery_complete" };
    });
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });
    const callbackUrl =
      "https://app.example.test/auth/callback?code=SENTINEL-code&state=SENTINEL-state";

    await controller.dispatch({
      callbackUrl,
      expectedState: "SENTINEL-state",
      type: "complete_pkce_callback",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "password_recovery_ready",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");

    await controller.dispatch({
      password: "a-new-correct-horse-battery-staple",
      type: "complete_password_recovery",
    });
    expect(controller.getSnapshot()).toMatchObject({
      kind: "password_recovery_complete",
    });
    expect(requests).toEqual([
      { authorizationCode: "SENTINEL-code", type: "exchange_pkce_code" },
      {
        password: "a-new-correct-horse-battery-staple",
        type: "complete_password_recovery",
      },
    ]);
  });

  it("shows a generic password update rejection without retaining the submitted password", async () => {
    let phase = 0;
    const adapter = createAdapter({ kind: "signed_out" }, async () => {
      phase += 1;
      return phase === 1
        ? { kind: "password_recovery_ready" }
        : { kind: "password_recovery_rejected" };
    });
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });
    await controller.dispatch({
      callbackUrl:
        "https://app.example.test/auth/callback?code=one&state=expected",
      expectedState: "expected",
      type: "complete_pkce_callback",
    });

    await controller.dispatch({
      password: "SENTINEL-rejected-password",
      type: "complete_password_recovery",
    });

    expect(controller.getSnapshot()).toMatchObject({
      kind: "password_recovery_rejected",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");
  });

  it.each([
    "email_verification_required",
    "session_expired",
    "session_revoked",
    "membership_inactive",
  ] as const)("bootstraps the explicit %s access gate", async (kind) => {
    let clears = 0;
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind }),
      protectedSchoolData: {
        clear() {
          clears += 1;
        },
      },
    });

    await controller.dispatch({ type: "bootstrap" });

    expect(controller.getSnapshot()).toMatchObject({ kind });
    expect(clears).toBe(1);
  });

  it("fails closed on an operation-incompatible adapter result", async () => {
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind: "signed_out" }, async () => ({
        kind: "recovery_request_received",
      })),
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      email: "teacher@example.test",
      password: "SENTINEL-password",
      type: "sign_in",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "sign_in",
      retryable: false,
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("SENTINEL");
  });

  it("does not let a stale request overwrite a newer authoritative revocation", async () => {
    let emit: Parameters<StaffAuthAdapter["subscribe"]>[0] | undefined;
    let finishSignIn: ((result: StaffAuthBoundaryResult) => void) | undefined;
    const adapter: StaffAuthAdapter = {
      async read() {
        return { kind: "signed_out" };
      },
      perform() {
        return new Promise((resolve) => {
          finishSignIn = resolve;
        });
      },
      subscribe(listener) {
        emit = listener;
        return () => undefined;
      },
    };
    const controller = createStaffAuthController({
      adapter,
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });
    const pending = controller.dispatch({
      email: "teacher@example.test",
      password: "correct horse battery staple",
      type: "sign_in",
    });

    emit?.({ kind: "session_revoked" });
    finishSignIn?.({
      assuranceLevel: "aal1",
      email: "teacher@example.test",
      kind: "access_granted",
      role: "teacher",
      secondFactor: "satisfied",
    });
    await pending;

    expect(controller.getSnapshot()).toMatchObject({
      kind: "session_revoked",
    });
  });

  it("publishes sanitized snapshots through a disposable view subscription", async () => {
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind: "signed_out" }),
      protectedSchoolData: { clear() {} },
    });
    const observed: string[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      observed.push(snapshot.kind);
    });

    await controller.dispatch({ type: "bootstrap" });
    unsubscribe();
    await controller.dispatch({ type: "bootstrap" });

    expect(observed).toEqual(["bootstrapping", "signed_out"]);
  });

  it("grants verified Teacher access only after an authoritative PKCE exchange result", async () => {
    const controller = createStaffAuthController({
      adapter: createAdapter({ kind: "signed_out" }, async () => ({
        assuranceLevel: "aal1",
        email: "teacher@example.test",
        kind: "access_granted",
        role: "teacher",
        secondFactor: "satisfied",
      })),
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      callbackUrl:
        "https://app.example.test/auth/callback?code=verified&state=expected",
      expectedState: "expected",
      type: "complete_pkce_callback",
    });

    expect(controller.getSnapshot()).toMatchObject({
      assuranceLevel: "aal1",
      kind: "authenticated",
      role: "teacher",
    });
  });

  it("fails closed if an adapter attempts to expose an Owner invitation", async () => {
    const controller = createStaffAuthController({
      adapter: createAdapter(
        { kind: "signed_out" },
        async () =>
          ({
            kind: "invitation_ready",
            role: "owner",
            schoolLabel: "Synthetic High School",
          }) as unknown as StaffAuthBoundaryResult,
      ),
      protectedSchoolData: { clear() {} },
    });
    await controller.dispatch({ type: "bootstrap" });

    await controller.dispatch({
      invitationToken: "one-time-invitation",
      type: "inspect_invitation",
    });

    expect(controller.getSnapshot()).toMatchObject({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "invitation",
      retryable: false,
    });
  });
});
