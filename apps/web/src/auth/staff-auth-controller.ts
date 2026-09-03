import {
  consumeStaffAuthPkceCallback,
  type StaffAuthCallbackReceipt,
} from "./staff-auth-callback.js";

export type StorageStaffRole = "owner" | "admin" | "teacher";

export type StaffRole = "owner" | "administrator" | "teacher";

export type StaffAuthBoundaryResult =
  | { readonly kind: "signed_out" }
  | { readonly kind: "sign_in_rejected" }
  | { readonly kind: "email_verification_required" }
  | { readonly kind: "email_verification_sent" }
  | { readonly kind: "recovery_request_received" }
  | {
      readonly kind: "invitation_rejected";
      readonly reason: "expired" | "invalid" | "replayed";
    }
  | {
      readonly kind: "invitation_ready";
      readonly role: "admin" | "teacher";
      readonly schoolLabel: string;
    }
  | { readonly kind: "totp_challenge_ready" }
  | { readonly kind: "password_recovery_ready" }
  | { readonly kind: "password_recovery_complete" }
  | { readonly kind: "password_recovery_rejected" }
  | { readonly kind: "session_expired" }
  | { readonly kind: "session_revoked" }
  | { readonly kind: "membership_inactive" }
  | { readonly kind: "totp_rejected" }
  | {
      readonly assuranceLevel: "aal1" | "aal2";
      readonly email: string;
      readonly kind: "access_granted";
      readonly role: StorageStaffRole;
      readonly secondFactor:
        "challenge_required" | "enrollment_required" | "satisfied";
    };

export type StaffAuthMutation =
  | {
      readonly email: string;
      readonly password: string;
      readonly type: "sign_in";
    }
  | {
      readonly code: string;
      readonly purpose: "enrollment" | "step_up";
      readonly type: "verify_totp";
    }
  | { readonly type: "resend_email_verification" }
  | { readonly email: string; readonly type: "request_password_recovery" }
  | { readonly invitationToken: string; readonly type: "inspect_invitation" }
  | { readonly password: string; readonly type: "accept_invitation" }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly scope: "all" | "local"; readonly type: "sign_out" }
  | {
      readonly authorizationCode: string;
      readonly type: "exchange_pkce_code";
    }
  | { readonly password: string; readonly type: "complete_password_recovery" };

export type StaffAuthAccessEvent = {
  readonly kind:
    | "membership_inactive"
    | "session_expired"
    | "session_revoked"
    | "signed_out";
};

export interface StaffAuthAdapter {
  read(): Promise<StaffAuthBoundaryResult>;
  perform(request: StaffAuthMutation): Promise<StaffAuthBoundaryResult>;
  subscribe(listener: (event: StaffAuthAccessEvent) => void): () => void;
}

export interface ProtectedSchoolData {
  clear(): void;
}

export type StaffAuthOperation =
  | "bootstrap"
  | "email_verification"
  | "invitation"
  | "local_logout"
  | "password_recovery"
  | "pkce_callback"
  | "revoke_all_sessions"
  | "sign_in"
  | "totp";

export type StaffAuthSnapshot =
  | { readonly kind: "bootstrapping"; readonly revision: number }
  | {
      readonly kind: "signed_out";
      readonly notice: "all_sessions_revoked" | "signed_out" | null;
      readonly revision: number;
    }
  | {
      readonly kind: "signing_out";
      readonly revision: number;
      readonly scope: "all" | "local";
    }
  | { readonly kind: "signing_in"; readonly revision: number }
  | { readonly kind: "sign_in_rejected"; readonly revision: number }
  | {
      readonly kind: "email_verification_required";
      readonly revision: number;
    }
  | { readonly kind: "email_verification_sent"; readonly revision: number }
  | { readonly kind: "requesting_recovery"; readonly revision: number }
  | { readonly kind: "recovery_notice"; readonly revision: number }
  | { readonly kind: "inspecting_invitation"; readonly revision: number }
  | {
      readonly kind: "invitation_rejected";
      readonly reason: "expired" | "invalid" | "replayed";
      readonly revision: number;
    }
  | {
      readonly kind: "invitation_ready";
      readonly revision: number;
      readonly role: Exclude<StaffRole, "owner">;
      readonly schoolLabel: string;
    }
  | { readonly kind: "accepting_invitation"; readonly revision: number }
  | {
      readonly kind: "totp_enrollment_required";
      readonly revision: number;
      readonly role: "administrator" | "owner";
    }
  | { readonly kind: "enrolling_totp"; readonly revision: number }
  | {
      readonly kind: "totp_challenge";
      readonly purpose: "enrollment" | "step_up";
      readonly feedback: "cancelled" | "none" | "rejected";
      readonly revision: number;
      readonly role: StaffRole;
    }
  | { readonly kind: "verifying_totp"; readonly revision: number }
  | { readonly kind: "session_expired"; readonly revision: number }
  | { readonly kind: "session_revoked"; readonly revision: number }
  | { readonly kind: "membership_inactive"; readonly revision: number }
  | { readonly kind: "processing_pkce_callback"; readonly revision: number }
  | {
      readonly code: Exclude<StaffAuthCallbackReceipt["code"], "accepted">;
      readonly kind: "callback_rejected";
      readonly revision: number;
    }
  | { readonly kind: "password_recovery_ready"; readonly revision: number }
  | { readonly kind: "updating_password"; readonly revision: number }
  | { readonly kind: "password_recovery_complete"; readonly revision: number }
  | { readonly kind: "password_recovery_rejected"; readonly revision: number }
  | {
      readonly code: "dependency_unavailable" | "invalid_backend_result";
      readonly kind: "dependency_failure";
      readonly operation: StaffAuthOperation;
      readonly retryable: boolean;
      readonly revision: number;
    }
  | {
      readonly assuranceLevel: "aal1" | "aal2";
      readonly email: string;
      readonly kind: "authenticated";
      readonly revision: number;
      readonly role: StaffRole;
    };

export type StaffAuthAction =
  | { readonly type: "bootstrap" }
  | {
      readonly email: string;
      readonly password: string;
      readonly type: "sign_in";
    }
  | { readonly code: string; readonly type: "verify_totp" }
  | { readonly type: "cancel_totp" }
  | { readonly type: "resend_email_verification" }
  | { readonly email: string; readonly type: "request_password_recovery" }
  | { readonly invitationToken: string; readonly type: "inspect_invitation" }
  | { readonly password: string; readonly type: "accept_invitation" }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly type: "sign_out_local" }
  | { readonly type: "revoke_all_sessions" }
  | { readonly type: "retry" }
  | {
      readonly callbackUrl: string;
      readonly expectedState: string;
      readonly type: "complete_pkce_callback";
    }
  | { readonly password: string; readonly type: "complete_password_recovery" };

export interface StaffAuthController {
  dispatch(action: StaffAuthAction): Promise<StaffAuthSnapshot>;
  getSnapshot(): StaffAuthSnapshot;
  subscribe(listener: (snapshot: StaffAuthSnapshot) => void): () => void;
  dispose(): void;
}

export function createStaffAuthController(dependencies: {
  readonly adapter: StaffAuthAdapter;
  readonly protectedSchoolData: ProtectedSchoolData;
}): StaffAuthController {
  type SnapshotWithoutRevision<T> = T extends unknown
    ? Omit<T, "revision">
    : never;
  type DispatchableAction = Exclude<StaffAuthAction, { type: "retry" }>;
  type RetryPlan = {
    readonly action: DispatchableAction;
    readonly resume: StaffAuthSnapshot | null;
  };

  let revision = 0;
  let snapshot: StaffAuthSnapshot = { kind: "bootstrapping", revision };
  let pendingTotpPurpose: "enrollment" | "step_up" | null = null;
  let pendingTotpRole: StaffRole | null = null;
  let authorityGeneration = 0;
  let retryPlan: RetryPlan | null = null;
  const listeners = new Set<(snapshot: StaffAuthSnapshot) => void>();

  function transition(next: SnapshotWithoutRevision<StaffAuthSnapshot>): void {
    revision += 1;
    snapshot = { ...next, revision } as StaffAuthSnapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function restore(prior: StaffAuthSnapshot): void {
    revision += 1;
    snapshot = { ...prior, revision };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function fail(
    operation: StaffAuthOperation,
    code: "dependency_unavailable" | "invalid_backend_result",
    retry: RetryPlan | null = null,
  ): void {
    retryPlan = retry;
    transition({
      code,
      kind: "dependency_failure",
      operation,
      retryable: retry !== null,
    });
  }

  function displayRole(role: StorageStaffRole): StaffRole | null {
    if (role === "admin") {
      return "administrator";
    }
    if (role === "owner" || role === "teacher") {
      return role;
    }
    return null;
  }

  function isInvitationFailureReason(
    reason: string,
  ): reason is "expired" | "invalid" | "replayed" {
    return (
      reason === "expired" || reason === "invalid" || reason === "replayed"
    );
  }

  function acceptAccess(
    result: Extract<StaffAuthBoundaryResult, { kind: "access_granted" }>,
    expectedRole: StaffRole | null = null,
  ): boolean {
    const role = displayRole(result.role);
    if (
      role === null ||
      (expectedRole !== null && role !== expectedRole) ||
      (result.assuranceLevel !== "aal1" && result.assuranceLevel !== "aal2") ||
      (result.secondFactor !== "challenge_required" &&
        result.secondFactor !== "enrollment_required" &&
        result.secondFactor !== "satisfied") ||
      typeof result.email !== "string" ||
      result.email.length === 0 ||
      result.email.length > 320
    ) {
      return false;
    }
    if (
      (role === "owner" || role === "administrator") &&
      result.assuranceLevel === "aal1"
    ) {
      pendingTotpRole = role;
      if (result.secondFactor === "enrollment_required") {
        pendingTotpPurpose = "enrollment";
        transition({ kind: "totp_enrollment_required", role });
        return true;
      }
      pendingTotpPurpose = "step_up";
      transition({
        feedback: "none",
        kind: "totp_challenge",
        purpose: pendingTotpPurpose,
        role,
      });
      return true;
    }
    if (
      (role === "owner" || role === "administrator") &&
      result.secondFactor !== "satisfied"
    ) {
      return false;
    }
    pendingTotpPurpose = null;
    pendingTotpRole = null;
    transition({
      assuranceLevel: result.assuranceLevel,
      email: result.email,
      kind: "authenticated",
      role,
    });
    return true;
  }

  function applyAccessLoss(result: StaffAuthBoundaryResult): boolean {
    if (
      result.kind !== "email_verification_required" &&
      result.kind !== "membership_inactive" &&
      result.kind !== "session_expired" &&
      result.kind !== "session_revoked"
    ) {
      return false;
    }
    pendingTotpPurpose = null;
    pendingTotpRole = null;
    dependencies.protectedSchoolData.clear();
    transition({ kind: result.kind });
    return true;
  }

  function applyEntryResult(
    result: StaffAuthBoundaryResult,
    expectedRole: StaffRole | null = null,
  ): boolean {
    if (result.kind === "access_granted") {
      return acceptAccess(result, expectedRole);
    }
    return applyAccessLoss(result);
  }

  async function readBoundary(
    retry: RetryPlan,
  ): Promise<StaffAuthBoundaryResult | null> {
    const startedAtGeneration = authorityGeneration;
    try {
      const result = await dependencies.adapter.read();
      if (startedAtGeneration !== authorityGeneration) {
        return null;
      }
      retryPlan = null;
      return result;
    } catch {
      if (startedAtGeneration === authorityGeneration) {
        fail("bootstrap", "dependency_unavailable", retry);
      }
      return null;
    }
  }

  async function performMutation(
    request: StaffAuthMutation,
    operation: StaffAuthOperation,
    retry: RetryPlan | null = null,
  ): Promise<StaffAuthBoundaryResult | null> {
    const startedAtGeneration = authorityGeneration;
    try {
      const result = await dependencies.adapter.perform(request);
      if (startedAtGeneration !== authorityGeneration) {
        return null;
      }
      retryPlan = null;
      return result;
    } catch {
      if (startedAtGeneration === authorityGeneration) {
        fail(operation, "dependency_unavailable", retry);
      }
      return null;
    }
  }

  const unsubscribe = dependencies.adapter.subscribe((event) => {
    authorityGeneration += 1;
    retryPlan = null;
    pendingTotpPurpose = null;
    pendingTotpRole = null;
    dependencies.protectedSchoolData.clear();
    if (event.kind === "signed_out") {
      transition({ kind: "signed_out", notice: null });
      return;
    }
    transition({ kind: event.kind });
  });

  async function dispatch(action: StaffAuthAction): Promise<StaffAuthSnapshot> {
    if (action.type === "retry") {
      const pendingRetry = retryPlan;
      retryPlan = null;
      if (pendingRetry === null) {
        return snapshot;
      }
      if (pendingRetry.resume !== null) {
        restore(pendingRetry.resume);
      }
      return dispatch(pendingRetry.action);
    }

    switch (action.type) {
      case "bootstrap": {
        transition({ kind: "bootstrapping" });
        const result = await readBoundary({
          action: { type: "bootstrap" },
          resume: null,
        });
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "signed_out") {
          dependencies.protectedSchoolData.clear();
          transition({ kind: "signed_out", notice: null });
        } else if (!applyEntryResult(result)) {
          dependencies.protectedSchoolData.clear();
          fail("bootstrap", "invalid_backend_result");
        }
        return snapshot;
      }
      case "sign_in": {
        if (
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "sign_in_rejected"
        ) {
          return snapshot;
        }
        transition({ kind: "signing_in" });
        const result = await performMutation(action, "sign_in");
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "sign_in_rejected") {
          transition({ kind: "sign_in_rejected" });
        } else if (!applyEntryResult(result)) {
          fail("sign_in", "invalid_backend_result");
        }
        return snapshot;
      }
      case "resend_email_verification": {
        if (
          snapshot.kind !== "email_verification_required" &&
          snapshot.kind !== "email_verification_sent"
        ) {
          return snapshot;
        }
        const resume = snapshot;
        const result = await performMutation(action, "email_verification", {
          action,
          resume,
        });
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "email_verification_sent") {
          transition({ kind: "email_verification_sent" });
        } else if (result.kind === "email_verification_required") {
          transition({ kind: "email_verification_required" });
        } else {
          fail("email_verification", "invalid_backend_result");
        }
        return snapshot;
      }
      case "request_password_recovery": {
        if (
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "sign_in_rejected" &&
          snapshot.kind !== "recovery_notice"
        ) {
          return snapshot;
        }
        const resume = snapshot;
        transition({ kind: "requesting_recovery" });
        const result = await performMutation(action, "password_recovery", {
          action,
          resume,
        });
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "recovery_request_received") {
          transition({ kind: "recovery_notice" });
        } else {
          fail("password_recovery", "invalid_backend_result");
        }
        return snapshot;
      }
      case "inspect_invitation": {
        if (
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "invitation_rejected"
        ) {
          return snapshot;
        }
        transition({ kind: "inspecting_invitation" });
        const result = await performMutation(action, "invitation");
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "invitation_rejected") {
          if (isInvitationFailureReason(result.reason)) {
            transition({
              kind: "invitation_rejected",
              reason: result.reason,
            });
          } else {
            fail("invitation", "invalid_backend_result");
          }
        } else if (result.kind === "invitation_ready") {
          if (
            (result.role === "admin" || result.role === "teacher") &&
            typeof result.schoolLabel === "string" &&
            result.schoolLabel.trim().length > 0 &&
            result.schoolLabel.length <= 200
          ) {
            transition({
              kind: "invitation_ready",
              role: result.role === "admin" ? "administrator" : "teacher",
              schoolLabel: result.schoolLabel,
            });
          } else {
            transition({
              code: "invalid_backend_result",
              kind: "dependency_failure",
              operation: "invitation",
              retryable: false,
            });
          }
        } else {
          fail("invitation", "invalid_backend_result");
        }
        return snapshot;
      }
      case "accept_invitation": {
        if (snapshot.kind !== "invitation_ready") {
          return snapshot;
        }
        const invitedRole = snapshot.role;
        transition({ kind: "accepting_invitation" });
        const result = await performMutation(action, "invitation");
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "access_granted") {
          if (!acceptAccess(result, invitedRole)) {
            fail("invitation", "invalid_backend_result");
          }
        } else if (result.kind === "invitation_rejected") {
          if (isInvitationFailureReason(result.reason)) {
            transition({
              kind: "invitation_rejected",
              reason: result.reason,
            });
          } else {
            fail("invitation", "invalid_backend_result");
          }
        } else if (!applyAccessLoss(result)) {
          fail("invitation", "invalid_backend_result");
        }
        return snapshot;
      }
      case "begin_totp_enrollment": {
        if (
          snapshot.kind !== "totp_enrollment_required" ||
          pendingTotpRole === null
        ) {
          return snapshot;
        }
        const resume = snapshot;
        const role = pendingTotpRole;
        transition({ kind: "enrolling_totp" });
        const result = await performMutation(action, "totp", {
          action,
          resume,
        });
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "totp_challenge_ready") {
          pendingTotpPurpose = "enrollment";
          transition({
            feedback: "none",
            kind: "totp_challenge",
            purpose: "enrollment",
            role,
          });
        } else if (!applyAccessLoss(result)) {
          fail("totp", "invalid_backend_result");
        }
        return snapshot;
      }
      case "sign_out_local":
      case "revoke_all_sessions": {
        if (snapshot.kind !== "authenticated") {
          return snapshot;
        }
        const resume = snapshot;
        const scope = action.type === "sign_out_local" ? "local" : "all";
        transition({ kind: "signing_out", scope });
        const result = await performMutation(
          {
            scope,
            type: "sign_out",
          },
          scope === "all" ? "revoke_all_sessions" : "local_logout",
          { action, resume },
        );
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "signed_out") {
          dependencies.protectedSchoolData.clear();
          transition({
            kind: "signed_out",
            notice: scope === "all" ? "all_sessions_revoked" : "signed_out",
          });
        } else if (!applyAccessLoss(result)) {
          fail(
            scope === "all" ? "revoke_all_sessions" : "local_logout",
            "invalid_backend_result",
          );
        }
        return snapshot;
      }
      case "complete_pkce_callback": {
        if (
          snapshot.kind !== "bootstrapping" &&
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "email_verification_required" &&
          snapshot.kind !== "email_verification_sent" &&
          snapshot.kind !== "recovery_notice" &&
          snapshot.kind !== "callback_rejected"
        ) {
          return snapshot;
        }
        const startedAtGeneration = authorityGeneration;
        transition({ kind: "processing_pkce_callback" });
        let exchangeResult: StaffAuthBoundaryResult | null = null;
        const receipt = await consumeStaffAuthPkceCallback(action.callbackUrl, {
          exchange: async (authorizationCode) => {
            exchangeResult = await dependencies.adapter.perform({
              authorizationCode,
              type: "exchange_pkce_code",
            });
          },
          expectedState: action.expectedState,
        });
        if (startedAtGeneration !== authorityGeneration) {
          return snapshot;
        }
        if (receipt.status === "rejected") {
          transition({ kind: "callback_rejected", code: receipt.code });
        } else {
          const result = exchangeResult as StaffAuthBoundaryResult | null;
          if (result?.kind === "password_recovery_ready") {
            transition({ kind: "password_recovery_ready" });
          } else if (result?.kind === "access_granted") {
            acceptAccess(result);
          } else if (result?.kind === "email_verification_required") {
            dependencies.protectedSchoolData.clear();
            transition({ kind: "email_verification_required" });
          } else if (
            result?.kind === "membership_inactive" ||
            result?.kind === "session_expired" ||
            result?.kind === "session_revoked"
          ) {
            dependencies.protectedSchoolData.clear();
            transition({ kind: result.kind });
          } else {
            transition({
              code: "invalid_backend_result",
              kind: "dependency_failure",
              operation: "pkce_callback",
              retryable: false,
            });
          }
        }
        return snapshot;
      }
      case "complete_password_recovery": {
        if (snapshot.kind !== "password_recovery_ready") {
          return snapshot;
        }
        transition({ kind: "updating_password" });
        const result = await performMutation(action, "password_recovery");
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "password_recovery_complete") {
          transition({ kind: "password_recovery_complete" });
        } else if (result.kind === "password_recovery_rejected") {
          transition({ kind: "password_recovery_rejected" });
        } else if (!applyAccessLoss(result)) {
          fail("password_recovery", "invalid_backend_result");
        }
        return snapshot;
      }
      case "cancel_totp": {
        if (snapshot.kind !== "totp_challenge") {
          return snapshot;
        }
        transition({
          feedback: "cancelled",
          kind: "totp_challenge",
          purpose: snapshot.purpose,
          role: snapshot.role,
        });
        return snapshot;
      }
      case "verify_totp": {
        if (
          snapshot.kind !== "totp_challenge" ||
          pendingTotpPurpose === null ||
          pendingTotpRole === null
        ) {
          return snapshot;
        }
        const purpose = pendingTotpPurpose;
        const role = pendingTotpRole;
        transition({ kind: "verifying_totp" });
        const result = await performMutation(
          {
            code: action.code,
            purpose,
            type: "verify_totp",
          },
          "totp",
        );
        if (result === null) {
          return snapshot;
        }
        if (result.kind === "access_granted") {
          if (!acceptAccess(result, role)) {
            fail("totp", "invalid_backend_result");
          }
        } else if (result.kind === "totp_rejected") {
          transition({
            feedback: "rejected",
            kind: "totp_challenge",
            purpose,
            role,
          });
        } else if (!applyAccessLoss(result)) {
          fail("totp", "invalid_backend_result");
        }
        return snapshot;
      }
    }
  }

  return {
    dispatch,
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}
