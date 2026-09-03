import {
  consumeStaffInvitationCallback,
  consumeStaffAuthPkceCallback,
  type StaffAuthCallbackHistory,
  type StaffAuthCallbackReceipt,
  type StaffAuthCallbackRoute,
  type StaffAuthCallbackStateStore,
} from "./staff-auth-callback.js";

export type StorageStaffRole = "owner" | "admin" | "teacher";

export type StaffRole = "owner" | "administrator" | "teacher";

export type ManagedStaffRole = "administrator" | "teacher";

export type StorageManagedStaffRole = "admin" | "teacher";

export interface StaffAuthBoundaryIdentity {
  readonly accountId: string;
  readonly email: string;
  readonly profile: {
    readonly displayName: string;
    readonly id: string;
  };
  readonly membership: {
    readonly id: string;
    readonly role: StorageStaffRole;
    readonly status: "active";
  };
  readonly school: {
    readonly id: string;
    readonly label: string;
  };
}

export interface StaffAuthIdentity {
  readonly accountId: string;
  readonly email: string;
  readonly profile: {
    readonly displayName: string;
    readonly id: string;
  };
  readonly membership: {
    readonly id: string;
    readonly role: StaffRole;
    readonly status: "active";
  };
  readonly school: {
    readonly id: string;
    readonly label: string;
  };
}

export interface StaffAuthBoundaryManagedStaff {
  readonly membershipId: string;
  readonly profile: {
    readonly displayName: string;
    readonly email: string;
    readonly id: string;
  };
  readonly role: StorageManagedStaffRole;
  readonly schoolId: string;
}

export interface StaffAuthManagedStaff {
  readonly membershipId: string;
  readonly profile: {
    readonly displayName: string;
    readonly email: string;
    readonly id: string;
  };
  readonly role: ManagedStaffRole;
  readonly schoolId: string;
}

export type StaffAuthAccessGrant = {
  readonly assuranceLevel: "aal1" | "aal2";
  readonly identity: StaffAuthBoundaryIdentity;
  readonly identityGeneration: string;
  readonly kind: "access_granted";
  readonly manageableStaff: readonly StaffAuthBoundaryManagedStaff[];
  readonly sessionGeneration: string;
} & (
  | {
      readonly challengeReceipt: string;
      readonly secondFactor: "challenge_required";
    }
  | { readonly secondFactor: "enrollment_required" }
  | { readonly secondFactor: "satisfied" }
);

export interface TotpEnrollmentPresentation {
  /** An object URL for an ephemeral QR image, never a provider enrollment URI. */
  readonly blobUrl: string;
  /** Invalidates the object URL and its backing bytes. Must be idempotent. */
  revoke(): void;
}

export type StaffAuthBoundaryResult =
  | StaffAuthAccessGrant
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
      readonly acceptanceReceipt: string;
      readonly expiresAt: string;
      readonly inspectionOperationId: string;
      readonly intendedAccountId: string;
      readonly intendedEmail: string;
      readonly kind: "invitation_ready";
      readonly role: StorageManagedStaffRole;
      readonly school: {
        readonly id: string;
        readonly label: string;
      };
    }
  | {
      readonly enrollmentReceipt: string;
      readonly kind: "totp_enrollment_ready";
      readonly presentation: TotpEnrollmentPresentation;
    }
  | { readonly kind: "password_recovery_ready" }
  | { readonly kind: "password_recovery_complete" }
  | { readonly kind: "password_recovery_rejected" }
  | { readonly kind: "session_expired" }
  | { readonly kind: "session_revoked" }
  | { readonly kind: "membership_inactive" }
  | { readonly kind: "totp_rejected" }
  | {
      readonly kind: "sign_out_complete";
      readonly scope: "all" | "local";
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly invitedRole: StorageManagedStaffRole;
      readonly kind: "staff_invitation_created";
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_invitation_rejected";
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_membership_revoked";
      readonly membershipId: string;
      readonly revokedRole: StorageManagedStaffRole;
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_membership_revocation_rejected";
    };

type MutationWithOperationId = { readonly operationId: string };

export type StaffAuthMutation = MutationWithOperationId &
  (
    | {
        readonly email: string;
        readonly password: string;
        readonly type: "sign_in";
      }
    | {
        readonly challengeReceipt: string;
        readonly code: string;
        readonly purpose: "step_up";
        readonly type: "verify_totp";
      }
    | {
        readonly ceremonyOperationId: string;
        readonly code: string;
        readonly enrollmentReceipt: string;
        readonly purpose: "enrollment";
        readonly type: "verify_totp";
      }
    | { readonly type: "resend_email_verification" }
    | { readonly email: string; readonly type: "request_password_recovery" }
    | {
        readonly invitationToken: string;
        readonly type: "inspect_invitation";
      }
    | {
        readonly acceptanceReceipt: string;
        readonly inspectionOperationId: string;
        readonly password: string;
        readonly type: "accept_invitation";
      }
    | { readonly type: "begin_totp_enrollment" }
    | { readonly scope: "all" | "local"; readonly type: "sign_out" }
    | {
        readonly authorizationCode: string;
        readonly flow: "email_verification" | "password_recovery" | "sign_in";
        readonly type: "exchange_pkce_code";
      }
    | {
        readonly password: string;
        readonly type: "complete_password_recovery";
      }
    | {
        readonly email: string;
        readonly targetRole: StorageManagedStaffRole;
        readonly type: "create_staff_invitation";
      }
    | {
        readonly membershipId: string;
        readonly targetRole: StorageManagedStaffRole;
        readonly type: "revoke_staff_membership";
      }
  );

export interface StaffAuthMutationResult {
  /** Must exactly echo the command ID; retries reuse the original ID. */
  readonly operationId: string;
  readonly result: StaffAuthBoundaryResult;
}

export type StaffAuthAccessEvent =
  | {
      readonly identityGeneration: string;
      readonly kind:
        | "membership_inactive"
        | "session_expired"
        | "session_revoked"
        | "signed_out";
      readonly sessionGeneration: string;
    }
  | {
      readonly access: StaffAuthAccessGrant;
      readonly kind: "access_changed";
      readonly previousIdentityGeneration: string;
      readonly previousSessionGeneration: string;
    };

export interface StaffAuthAdapter {
  /** Reads authority; the browser controller never infers backend access. */
  read(): Promise<StaffAuthBoundaryResult>;
  /** Executes an idempotent command under backend authorization. */
  perform(request: StaffAuthMutation): Promise<StaffAuthMutationResult>;
  subscribe(listener: (event: StaffAuthAccessEvent) => void): () => void;
}

export interface ProtectedSchoolData {
  clear(): void;
}

export interface StaffAuthOperationIdSource {
  next(): string;
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
  | "staff_invitation"
  | "staff_membership"
  | "totp";

export type StaffAuthSnapshot =
  | { readonly kind: "bootstrapping"; readonly revision: number }
  | { readonly kind: "disposed"; readonly revision: number }
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
  | { readonly kind: "sending_email_verification"; readonly revision: number }
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
      readonly intendedEmail: string;
      readonly revision: number;
      readonly role: ManagedStaffRole;
      readonly schoolLabel: string;
    }
  | { readonly kind: "accepting_invitation"; readonly revision: number }
  | {
      readonly feedback: "cancelled" | "none" | "rejected";
      readonly kind: "totp_enrollment_required";
      readonly revision: number;
      readonly role: "administrator" | "owner";
    }
  | { readonly kind: "enrolling_totp"; readonly revision: number }
  | {
      readonly kind: "totp_provisioning";
      readonly qrBlobUrl: string;
      readonly revision: number;
      readonly role: "administrator" | "owner";
    }
  | {
      readonly feedback: "cancelled" | "none" | "rejected";
      readonly kind: "totp_challenge";
      readonly revision: number;
      readonly role: "administrator" | "owner";
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
      readonly kind: "creating_staff_invitation";
      readonly revision: number;
      readonly targetRole: ManagedStaffRole;
    }
  | {
      readonly kind: "staff_invitation_created";
      readonly revision: number;
      readonly schoolLabel: string;
      readonly targetRole: ManagedStaffRole;
    }
  | { readonly kind: "staff_invitation_rejected"; readonly revision: number }
  | {
      readonly target: {
        readonly displayName: string;
        readonly email: string;
        readonly role: ManagedStaffRole;
      };
      readonly kind: "confirming_staff_membership_revocation";
      readonly revision: number;
      readonly schoolLabel: string;
    }
  | {
      readonly kind: "revoking_staff_membership";
      readonly revision: number;
      readonly targetRole: ManagedStaffRole;
    }
  | {
      readonly kind: "staff_membership_revoked";
      readonly revision: number;
      readonly schoolLabel: string;
      readonly targetRole: ManagedStaffRole;
    }
  | {
      readonly kind: "staff_membership_revocation_rejected";
      readonly revision: number;
    }
  | {
      readonly code: "dependency_unavailable" | "invalid_backend_result";
      readonly kind: "dependency_failure";
      readonly operation: StaffAuthOperation;
      readonly retryable: boolean;
      readonly revision: number;
    }
  | {
      readonly assuranceLevel: "aal1" | "aal2";
      readonly identity: StaffAuthIdentity;
      readonly identityGeneration: string;
      readonly kind: "authenticated";
      readonly manageableStaff: readonly StaffAuthManagedStaff[];
      readonly revision: number;
      readonly sessionGeneration: string;
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
  | { readonly callbackUrl: string; readonly type: "inspect_invitation" }
  | { readonly password: string; readonly type: "accept_invitation" }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly type: "sign_out_local" }
  | { readonly type: "revoke_all_sessions" }
  | { readonly type: "retry" }
  | { readonly callbackUrl: string; readonly type: "complete_pkce_callback" }
  | { readonly password: string; readonly type: "complete_password_recovery" }
  | {
      readonly email: string;
      readonly targetRole: StorageManagedStaffRole;
      readonly type: "create_staff_invitation";
    }
  | {
      readonly membershipId: string;
      readonly type: "review_staff_membership_revocation";
    }
  | { readonly type: "confirm_staff_membership_revocation" }
  | { readonly type: "cancel_staff_membership_revocation" };

export interface StaffAuthController {
  dispatch(action: StaffAuthAction): Promise<StaffAuthSnapshot>;
  getSnapshot(): StaffAuthSnapshot;
  subscribe(listener: (snapshot: StaffAuthSnapshot) => void): () => void;
  dispose(): void;
}

type RetryableMutation = Extract<
  StaffAuthMutation,
  {
    type: "resend_email_verification" | "sign_out";
  }
>;

type RetryPlan =
  | { readonly kind: "bootstrap" }
  | {
      readonly kind: "email_verification";
      readonly request: Extract<
        RetryableMutation,
        { type: "resend_email_verification" }
      >;
    }
  | {
      readonly kind: "sign_out";
      readonly request: Extract<RetryableMutation, { type: "sign_out" }>;
    };

type PendingTotp =
  | {
      readonly access: StaffAuthAccessGrant;
      readonly kind: "enrollment_required";
      readonly role: "administrator" | "owner";
    }
  | {
      readonly access: StaffAuthAccessGrant;
      readonly ceremonyOperationId: string;
      readonly enrollmentReceipt: string;
      readonly kind: "provisioning";
      readonly presentation: TotpEnrollmentPresentation;
      readonly role: "administrator" | "owner";
    }
  | {
      readonly access: StaffAuthAccessGrant;
      readonly challengeReceipt: string;
      readonly kind: "step_up";
      readonly role: "administrator" | "owner";
    };

interface PendingInvitation {
  readonly acceptanceReceipt: string;
  readonly expiresAt: string;
  readonly inspectionOperationId: string;
  readonly intendedAccountId: string;
  readonly intendedEmail: string;
  readonly role: StorageManagedStaffRole;
  readonly school: {
    readonly id: string;
    readonly label: string;
  };
}

interface PendingMembershipRevocation {
  readonly actor: StaffAuthAccessGrant;
  readonly target: StaffAuthBoundaryManagedStaff;
}

export function createStaffAuthController(dependencies: {
  readonly adapter: StaffAuthAdapter;
  readonly callback: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
    readonly states: StaffAuthCallbackStateStore;
  };
  readonly clock: { readonly now: () => number };
  readonly invitationCallback: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  };
  readonly operationIds: StaffAuthOperationIdSource;
  readonly protectedSchoolData: ProtectedSchoolData;
}): StaffAuthController {
  type SnapshotWithoutRevision<T> = T extends unknown
    ? Omit<T, "revision">
    : never;

  let revision = 0;
  let operationEpoch = 0;
  let disposed = false;
  let snapshot: StaffAuthSnapshot = { kind: "bootstrapping", revision };
  let activeGrant: StaffAuthAccessGrant | null = null;
  let pendingInvitation: PendingInvitation | null = null;
  let pendingMembershipRevocation: PendingMembershipRevocation | null = null;
  let pendingTotp: PendingTotp | null = null;
  let retryPlan: RetryPlan | null = null;
  const issuedOperationIds = new Set<string>();
  const listeners = new Set<(snapshot: StaffAuthSnapshot) => void>();

  function transition(next: SnapshotWithoutRevision<StaffAuthSnapshot>): void {
    if (disposed) {
      return;
    }
    revision += 1;
    snapshot = { ...next, revision } as StaffAuthSnapshot;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A view listener is not part of the authorization boundary.
      }
    }
  }

  function clearProtectedSchoolData(): boolean {
    try {
      dependencies.protectedSchoolData.clear();
      return true;
    } catch {
      // Access state is already fail-closed before this best-effort cleanup.
      return false;
    }
  }

  function revokePresentation(
    presentation: TotpEnrollmentPresentation | null,
  ): void {
    if (presentation === null) {
      return;
    }
    try {
      presentation.revoke();
    } catch {
      // Revocation is best-effort and must never expose provider detail.
    }
  }

  function clearTotpCeremony(): void {
    if (pendingTotp?.kind === "provisioning") {
      revokePresentation(pendingTotp.presentation);
    }
    pendingTotp = null;
  }

  function clearInvitation(): void {
    pendingInvitation = null;
  }

  function clearMembershipRevocation(): void {
    pendingMembershipRevocation = null;
  }

  function resetEnrollment(feedback: "cancelled" | "rejected"): void {
    if (pendingTotp?.kind !== "provisioning") {
      return;
    }
    const { access, presentation, role } = pendingTotp;
    revokePresentation(presentation);
    pendingTotp = { access, kind: "enrollment_required", role };
    transition({ feedback, kind: "totp_enrollment_required", role });
  }

  function fail(
    operation: StaffAuthOperation,
    code: "dependency_unavailable" | "invalid_backend_result",
    retry: RetryPlan | null = null,
  ): void {
    clearTotpCeremony();
    clearInvitation();
    clearMembershipRevocation();
    retryPlan = retry;
    transition({
      code,
      kind: "dependency_failure",
      operation,
      retryable: retry !== null,
    });
  }

  function beginOperation(
    next: SnapshotWithoutRevision<StaffAuthSnapshot>,
    options: {
      readonly preserveInvitation?: boolean;
      readonly preserveMembershipRevocation?: boolean;
      readonly preserveTotp?: boolean;
    } = {},
  ): number {
    operationEpoch += 1;
    retryPlan = null;
    if (options.preserveTotp !== true) {
      clearTotpCeremony();
    }
    if (options.preserveInvitation !== true) {
      clearInvitation();
    }
    if (options.preserveMembershipRevocation !== true) {
      clearMembershipRevocation();
    }
    transition(next);
    return operationEpoch;
  }

  function isCurrent(epoch: number): boolean {
    return !disposed && epoch === operationEpoch;
  }

  function currentTime(): number | null {
    try {
      const value = dependencies.clock.now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function allocateOperationId(operation: StaffAuthOperation): string | null {
    let operationId: string;
    try {
      operationId = dependencies.operationIds.next();
    } catch {
      fail(operation, "invalid_backend_result");
      return null;
    }
    if (!validText(operationId, 200) || issuedOperationIds.has(operationId)) {
      fail(operation, "invalid_backend_result");
      return null;
    }
    issuedOperationIds.add(operationId);
    return operationId;
  }

  async function readBoundary(
    epoch: number,
    retry: RetryPlan,
  ): Promise<StaffAuthBoundaryResult | null> {
    try {
      const rawResult: unknown = await dependencies.adapter.read();
      if (!isCurrent(epoch)) {
        discardBoundaryResult(rawResult);
        return null;
      }
      const result = decodeBoundaryResult(rawResult);
      if (result === null) {
        discardBoundaryResult(rawResult);
        fail("bootstrap", "invalid_backend_result");
        return null;
      }
      return result;
    } catch {
      if (isCurrent(epoch)) {
        fail("bootstrap", "dependency_unavailable", retry);
      }
      return null;
    }
  }

  async function performMutation(
    request: StaffAuthMutation,
    epoch: number,
    operation: StaffAuthOperation,
    retry: RetryPlan | null = null,
  ): Promise<StaffAuthBoundaryResult | null> {
    try {
      const response: unknown = await dependencies.adapter.perform(request);
      if (!isCurrent(epoch)) {
        discardMutationResponse(response);
        return null;
      }
      const result =
        isRecord(response) &&
        hasExactKeys(response, ["operationId", "result"]) &&
        response.operationId === request.operationId
          ? decodeBoundaryResult(response.result)
          : null;
      if (result === null) {
        discardMutationResponse(response);
        fail(operation, "invalid_backend_result");
        return null;
      }
      return result;
    } catch {
      if (isCurrent(epoch)) {
        fail(operation, "dependency_unavailable", retry);
      }
      return null;
    }
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

  function managedRole(role: StorageManagedStaffRole): ManagedStaffRole {
    return role === "admin" ? "administrator" : "teacher";
  }

  function normalizeIdentity(
    identity: StaffAuthBoundaryIdentity,
  ): StaffAuthIdentity | null {
    if (
      !validText(identity.accountId, 256) ||
      !validText(identity.email, 320) ||
      !validText(identity.profile.displayName, 200) ||
      !validText(identity.profile.id, 256) ||
      !validText(identity.school.id, 256) ||
      !validText(identity.school.label, 200) ||
      !validText(identity.membership.id, 256) ||
      identity.membership.status !== "active"
    ) {
      return null;
    }
    const role = displayRole(identity.membership.role);
    if (role === null) {
      return null;
    }
    return {
      accountId: identity.accountId,
      email: identity.email,
      profile: {
        displayName: identity.profile.displayName,
        id: identity.profile.id,
      },
      membership: {
        id: identity.membership.id,
        role,
        status: "active",
      },
      school: {
        id: identity.school.id,
        label: identity.school.label,
      },
    };
  }

  function sameIdentity(
    left: StaffAuthBoundaryIdentity,
    right: StaffAuthBoundaryIdentity,
  ): boolean {
    return (
      left.accountId === right.accountId &&
      left.email === right.email &&
      left.profile.id === right.profile.id &&
      left.profile.displayName === right.profile.displayName &&
      left.membership.id === right.membership.id &&
      left.membership.role === right.membership.role &&
      left.membership.status === right.membership.status &&
      left.school.id === right.school.id &&
      left.school.label === right.school.label
    );
  }

  function sameAuthority(
    left: StaffAuthAccessGrant,
    right: StaffAuthAccessGrant,
  ): boolean {
    return (
      left.sessionGeneration === right.sessionGeneration &&
      left.identityGeneration === right.identityGeneration &&
      sameIdentity(left.identity, right.identity)
    );
  }

  function normalizeManagedStaff(
    staff: readonly StaffAuthBoundaryManagedStaff[],
  ): readonly StaffAuthManagedStaff[] {
    return staff.map((entry) => ({
      membershipId: entry.membershipId,
      profile: { ...entry.profile },
      role: managedRole(entry.role),
      schoolId: entry.schoolId,
    }));
  }

  function publishAuthenticated(
    grant: StaffAuthAccessGrant,
    identity: StaffAuthIdentity,
  ): boolean {
    if (activeGrant !== null && !sameAuthority(activeGrant, grant)) {
      transition({ kind: "bootstrapping" });
      if (!clearProtectedSchoolData()) {
        activeGrant = null;
        fail("bootstrap", "dependency_unavailable");
        return false;
      }
    }
    activeGrant = grant;
    clearTotpCeremony();
    clearInvitation();
    clearMembershipRevocation();
    transition({
      assuranceLevel: grant.assuranceLevel,
      identity,
      identityGeneration: grant.identityGeneration,
      kind: "authenticated",
      manageableStaff: normalizeManagedStaff(grant.manageableStaff),
      sessionGeneration: grant.sessionGeneration,
    });
    return true;
  }

  function acceptEntry(
    grant: StaffAuthAccessGrant,
    expectedRole: ManagedStaffRole | null = null,
  ): boolean {
    const identity = normalizeIdentity(grant.identity);
    if (
      identity === null ||
      (expectedRole !== null && identity.membership.role !== expectedRole)
    ) {
      return false;
    }
    const role = identity.membership.role;
    if (role === "owner" || role === "administrator") {
      if (grant.assuranceLevel === "aal1") {
        if (grant.secondFactor === "enrollment_required") {
          pendingTotp = {
            access: grant,
            kind: "enrollment_required",
            role,
          };
          transition({
            feedback: "none",
            kind: "totp_enrollment_required",
            role,
          });
          return true;
        }
        if (
          grant.secondFactor === "challenge_required" &&
          validText(grant.challengeReceipt, 512)
        ) {
          pendingTotp = {
            access: grant,
            challengeReceipt: grant.challengeReceipt,
            kind: "step_up",
            role,
          };
          transition({
            feedback: "none",
            kind: "totp_challenge",
            role,
          });
          return true;
        }
        return false;
      }
      if (
        grant.assuranceLevel !== "aal2" ||
        grant.secondFactor !== "satisfied"
      ) {
        return false;
      }
      return publishAuthenticated(grant, identity);
    }
    if (grant.secondFactor !== "satisfied") {
      return false;
    }
    return publishAuthenticated(grant, identity);
  }

  function acceptVerifiedAccess(
    grant: StaffAuthAccessGrant,
    expected: PendingTotp,
  ): boolean {
    const identity = normalizeIdentity(grant.identity);
    if (
      identity === null ||
      grant.assuranceLevel !== "aal2" ||
      grant.secondFactor !== "satisfied" ||
      identity.membership.role !== expected.role ||
      !sameAuthority(grant, expected.access)
    ) {
      return false;
    }
    return publishAuthenticated(grant, identity);
  }

  function validateOwnerActor(
    grant: StaffAuthAccessGrant,
    expected: StaffAuthAccessGrant,
  ): StaffAuthIdentity | null {
    const identity = normalizeIdentity(grant.identity);
    if (
      identity === null ||
      identity.membership.role !== "owner" ||
      grant.assuranceLevel !== "aal2" ||
      grant.secondFactor !== "satisfied" ||
      expected.assuranceLevel !== "aal2" ||
      expected.secondFactor !== "satisfied" ||
      !sameAuthority(grant, expected)
    ) {
      return null;
    }
    return identity;
  }

  function matchesInvitationAccess(
    grant: StaffAuthAccessGrant,
    invitation: PendingInvitation,
  ): boolean {
    return (
      grant.identity.accountId === invitation.intendedAccountId &&
      grant.identity.email === invitation.intendedEmail &&
      grant.identity.membership.role === invitation.role &&
      grant.identity.school.id === invitation.school.id &&
      grant.identity.school.label === invitation.school.label
    );
  }

  function applyAccessLoss(
    result: StaffAuthBoundaryResult,
    clearProtectedData = true,
  ): boolean {
    if (
      result.kind !== "email_verification_required" &&
      result.kind !== "membership_inactive" &&
      result.kind !== "session_expired" &&
      result.kind !== "session_revoked"
    ) {
      return false;
    }
    activeGrant = null;
    retryPlan = null;
    clearTotpCeremony();
    clearInvitation();
    clearMembershipRevocation();
    transition({ kind: result.kind });
    if (clearProtectedData) {
      clearProtectedSchoolData();
    }
    return true;
  }

  function applyEntryResult(
    result: StaffAuthBoundaryResult,
    expectedRole: ManagedStaffRole | null = null,
    clearProtectedData = true,
  ): boolean {
    if (result.kind === "access_granted") {
      return acceptEntry(result, expectedRole);
    }
    return applyAccessLoss(result, clearProtectedData);
  }

  function rejectBoundaryResult(
    operation: StaffAuthOperation,
    result: StaffAuthBoundaryResult,
  ): void {
    discardBoundaryResult(result);
    fail(operation, "invalid_backend_result");
  }

  async function executeBootstrap(): Promise<void> {
    const epoch = beginOperation({ kind: "bootstrapping" });
    activeGrant = null;
    if (!clearProtectedSchoolData()) {
      fail("bootstrap", "dependency_unavailable", { kind: "bootstrap" });
      return;
    }
    const result = await readBoundary(epoch, { kind: "bootstrap" });
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "signed_out") {
      transition({ kind: "signed_out", notice: null });
    } else if (!applyEntryResult(result, null, false)) {
      rejectBoundaryResult("bootstrap", result);
    }
  }

  async function executeResendVerification(
    existingRequest?: Extract<
      RetryableMutation,
      { type: "resend_email_verification" }
    >,
  ): Promise<void> {
    const epoch = beginOperation({ kind: "sending_email_verification" });
    const operationId =
      existingRequest?.operationId ?? allocateOperationId("email_verification");
    if (operationId === null || !isCurrent(epoch)) {
      return;
    }
    const request = existingRequest ?? {
      operationId,
      type: "resend_email_verification" as const,
    };
    const result = await performMutation(request, epoch, "email_verification", {
      kind: "email_verification",
      request,
    });
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "email_verification_sent") {
      transition({ kind: "email_verification_sent" });
    } else if (result.kind === "email_verification_required") {
      transition({ kind: "email_verification_required" });
    } else if (!applyAccessLoss(result)) {
      rejectBoundaryResult("email_verification", result);
    }
  }

  async function executeSignOut(
    scope: "all" | "local",
    existingRequest?: Extract<RetryableMutation, { type: "sign_out" }>,
  ): Promise<void> {
    const operation = scope === "all" ? "revoke_all_sessions" : "local_logout";
    const epoch = beginOperation({ kind: "signing_out", scope });
    if (existingRequest === undefined) {
      clearProtectedSchoolData();
    }
    const operationId =
      existingRequest?.operationId ?? allocateOperationId(operation);
    if (operationId === null || !isCurrent(epoch)) {
      return;
    }
    const request = existingRequest ?? {
      operationId,
      scope,
      type: "sign_out" as const,
    };
    const result = await performMutation(request, epoch, operation, {
      kind: "sign_out",
      request,
    });
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "sign_out_complete" && result.scope === scope) {
      activeGrant = null;
      transition({
        kind: "signed_out",
        notice: scope === "all" ? "all_sessions_revoked" : "signed_out",
      });
    } else if (!applyAccessLoss(result)) {
      rejectBoundaryResult(operation, result);
    }
  }

  async function executeRevokeMembership(
    request: Extract<StaffAuthMutation, { type: "revoke_staff_membership" }>,
    expectedActor: StaffAuthAccessGrant,
    expectedTarget: StaffAuthBoundaryManagedStaff,
  ): Promise<void> {
    const targetRole = managedRole(request.targetRole);
    const epoch = beginOperation({
      kind: "revoking_staff_membership",
      targetRole,
    });
    clearProtectedSchoolData();
    const result = await performMutation(request, epoch, "staff_membership");
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "staff_membership_revoked") {
      const actor = validateOwnerActor(result.actor, expectedActor);
      if (
        actor === null ||
        result.membershipId !== request.membershipId ||
        result.membershipId !== expectedTarget.membershipId ||
        result.revokedRole !== request.targetRole
      ) {
        rejectBoundaryResult("staff_membership", result);
        return;
      }
      transition({
        kind: "staff_membership_revoked",
        schoolLabel: actor.school.label,
        targetRole,
      });
    } else if (result.kind === "staff_membership_revocation_rejected") {
      if (validateOwnerActor(result.actor, expectedActor) === null) {
        rejectBoundaryResult("staff_membership", result);
      } else {
        transition({ kind: "staff_membership_revocation_rejected" });
      }
    } else if (!applyAccessLoss(result)) {
      rejectBoundaryResult("staff_membership", result);
    }
  }

  async function executeRetry(plan: RetryPlan): Promise<void> {
    switch (plan.kind) {
      case "bootstrap":
        await executeBootstrap();
        return;
      case "email_verification":
        await executeResendVerification(plan.request);
        return;
      case "sign_out":
        await executeSignOut(plan.request.scope, plan.request);
        return;
    }
  }

  const eventListener = (rawEvent: StaffAuthAccessEvent) => {
    if (disposed) {
      return;
    }
    const current = activeGrant;
    if (current === null) {
      return;
    }
    const event = decodeAccessEvent(rawEvent);
    if (event === null) {
      if (rawEventMatchesAuthority(rawEvent, current)) {
        operationEpoch += 1;
        activeGrant = null;
        fail("bootstrap", "invalid_backend_result");
        clearProtectedSchoolData();
      }
      return;
    }
    const matchesCurrent =
      event.kind === "access_changed"
        ? event.previousSessionGeneration === current.sessionGeneration &&
          event.previousIdentityGeneration === current.identityGeneration
        : event.sessionGeneration === current.sessionGeneration &&
          event.identityGeneration === current.identityGeneration;
    if (!matchesCurrent) {
      return;
    }

    operationEpoch += 1;
    retryPlan = null;
    clearTotpCeremony();
    clearInvitation();
    clearMembershipRevocation();
    if (event.kind === "access_changed") {
      if (!acceptEntry(event.access)) {
        activeGrant = null;
        fail("bootstrap", "invalid_backend_result");
        clearProtectedSchoolData();
      }
      return;
    }

    activeGrant = null;
    if (event.kind === "signed_out") {
      transition({ kind: "signed_out", notice: null });
    } else {
      transition({ kind: event.kind });
    }
    clearProtectedSchoolData();
  };

  const unsubscribe = dependencies.adapter.subscribe(eventListener);

  async function dispatch(action: StaffAuthAction): Promise<StaffAuthSnapshot> {
    if (disposed) {
      return snapshot;
    }
    if (action.type === "retry") {
      const pendingRetry = retryPlan;
      retryPlan = null;
      if (snapshot.kind !== "dependency_failure" || pendingRetry === null) {
        return snapshot;
      }
      await executeRetry(pendingRetry);
      return snapshot;
    }

    switch (action.type) {
      case "bootstrap": {
        await executeBootstrap();
        return snapshot;
      }
      case "sign_in": {
        if (
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "sign_in_rejected"
        ) {
          return snapshot;
        }
        const epoch = beginOperation({ kind: "signing_in" });
        const operationId = allocateOperationId("sign_in");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "sign_in",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "sign_in_rejected") {
          transition({ kind: "sign_in_rejected" });
        } else if (!applyEntryResult(result)) {
          rejectBoundaryResult("sign_in", result);
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
        await executeResendVerification();
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
        const epoch = beginOperation({ kind: "requesting_recovery" });
        const operationId = allocateOperationId("password_recovery");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "password_recovery",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "recovery_request_received") {
          transition({ kind: "recovery_notice" });
        } else {
          rejectBoundaryResult("password_recovery", result);
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
        operationEpoch += 1;
        retryPlan = null;
        clearTotpCeremony();
        clearInvitation();
        clearMembershipRevocation();
        const epoch = operationEpoch;
        let operationId: string | null = null;
        let response: unknown = null;
        let allocationFailed = false;
        const callbackWork = consumeStaffInvitationCallback(
          action.callbackUrl,
          {
            history: dependencies.invitationCallback.history,
            inspect: async (invitationToken) => {
              const allocated = allocateOperationId("invitation");
              if (allocated === null || !isCurrent(epoch)) {
                allocationFailed = allocated === null;
                throw new Error("operation unavailable");
              }
              operationId = allocated;
              response = await dependencies.adapter.perform({
                invitationToken,
                operationId: allocated,
                type: "inspect_invitation",
              });
              if (!isCurrent(epoch)) {
                discardMutationResponse(response);
                throw new Error("stale operation");
              }
            },
            route: dependencies.invitationCallback.route,
          },
        );
        if (isCurrent(epoch)) {
          transition({ kind: "inspecting_invitation" });
        }
        const receipt = await callbackWork;
        if (!isCurrent(epoch)) {
          return snapshot;
        }
        if (receipt.status === "rejected") {
          if (allocationFailed) {
            return snapshot;
          }
          if (receipt.code === "inspection_unavailable") {
            fail("invitation", "dependency_unavailable");
          } else {
            transition({ kind: "invitation_rejected", reason: "invalid" });
          }
          return snapshot;
        }
        const result =
          operationId !== null &&
          isRecord(response) &&
          hasExactKeys(response, ["operationId", "result"]) &&
          response.operationId === operationId
            ? decodeBoundaryResult(response.result)
            : null;
        if (result === null) {
          discardMutationResponse(response);
          fail("invitation", "invalid_backend_result");
          return snapshot;
        }
        if (
          result.kind === "invitation_rejected" &&
          (result.reason === "expired" ||
            result.reason === "invalid" ||
            result.reason === "replayed")
        ) {
          transition({ kind: "invitation_rejected", reason: result.reason });
        } else if (result.kind === "invitation_ready") {
          const inspectedAt = currentTime();
          if (
            result.inspectionOperationId !== operationId ||
            inspectedAt === null ||
            !isFutureExpiry(result.expiresAt, inspectedAt)
          ) {
            rejectBoundaryResult("invitation", result);
            return snapshot;
          }
          pendingInvitation = {
            acceptanceReceipt: result.acceptanceReceipt,
            expiresAt: result.expiresAt,
            inspectionOperationId: result.inspectionOperationId,
            intendedAccountId: result.intendedAccountId,
            intendedEmail: result.intendedEmail,
            role: result.role,
            school: result.school,
          };
          transition({
            intendedEmail: result.intendedEmail,
            kind: "invitation_ready",
            role: managedRole(result.role),
            schoolLabel: result.school.label,
          });
        } else {
          rejectBoundaryResult("invitation", result);
        }
        return snapshot;
      }
      case "accept_invitation": {
        if (
          snapshot.kind !== "invitation_ready" ||
          pendingInvitation === null
        ) {
          return snapshot;
        }
        const invitation = pendingInvitation;
        const acceptanceStartedAt = currentTime();
        if (acceptanceStartedAt === null) {
          fail("invitation", "dependency_unavailable");
          return snapshot;
        }
        if (!isFutureExpiry(invitation.expiresAt, acceptanceStartedAt)) {
          clearInvitation();
          transition({ kind: "invitation_rejected", reason: "expired" });
          return snapshot;
        }
        const invitedRole = managedRole(invitation.role);
        const epoch = beginOperation({ kind: "accepting_invitation" });
        const operationId = allocateOperationId("invitation");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          {
            acceptanceReceipt: invitation.acceptanceReceipt,
            inspectionOperationId: invitation.inspectionOperationId,
            operationId,
            password: action.password,
            type: "accept_invitation",
          },
          epoch,
          "invitation",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "access_granted") {
          const acceptedAt = currentTime();
          if (
            acceptedAt === null ||
            !isFutureExpiry(invitation.expiresAt, acceptedAt) ||
            !matchesInvitationAccess(result, invitation) ||
            !acceptEntry(result, invitedRole)
          ) {
            rejectBoundaryResult("invitation", result);
          }
        } else if (
          result.kind === "invitation_rejected" &&
          (result.reason === "expired" ||
            result.reason === "invalid" ||
            result.reason === "replayed")
        ) {
          transition({ kind: "invitation_rejected", reason: result.reason });
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("invitation", result);
        }
        return snapshot;
      }
      case "begin_totp_enrollment": {
        if (
          snapshot.kind !== "totp_enrollment_required" ||
          pendingTotp?.kind !== "enrollment_required"
        ) {
          return snapshot;
        }
        const enrollment = pendingTotp;
        const epoch = beginOperation(
          { kind: "enrolling_totp" },
          { preserveTotp: true },
        );
        const operationId = allocateOperationId("totp");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const request: StaffAuthMutation = {
          operationId,
          type: "begin_totp_enrollment",
        };
        const result = await performMutation(request, epoch, "totp");
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "totp_enrollment_ready") {
          pendingTotp = {
            access: enrollment.access,
            ceremonyOperationId: operationId,
            enrollmentReceipt: result.enrollmentReceipt,
            kind: "provisioning",
            presentation: result.presentation,
            role: enrollment.role,
          };
          transition({
            kind: "totp_provisioning",
            qrBlobUrl: result.presentation.blobUrl,
            role: enrollment.role,
          });
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("totp", result);
        }
        return snapshot;
      }
      case "verify_totp": {
        if (
          (snapshot.kind !== "totp_challenge" &&
            snapshot.kind !== "totp_provisioning") ||
          pendingTotp === null ||
          pendingTotp.kind === "enrollment_required"
        ) {
          return snapshot;
        }
        const challenge = pendingTotp;
        const epoch = beginOperation(
          { kind: "verifying_totp" },
          { preserveTotp: true },
        );
        const operationId = allocateOperationId("totp");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (challenge.kind === "provisioning") {
          revokePresentation(challenge.presentation);
          pendingTotp = {
            access: challenge.access,
            kind: "enrollment_required",
            role: challenge.role,
          };
        }
        const request: StaffAuthMutation =
          challenge.kind === "provisioning"
            ? {
                ceremonyOperationId: challenge.ceremonyOperationId,
                code: action.code,
                enrollmentReceipt: challenge.enrollmentReceipt,
                operationId,
                purpose: "enrollment",
                type: "verify_totp",
              }
            : {
                challengeReceipt: challenge.challengeReceipt,
                code: action.code,
                operationId,
                purpose: "step_up",
                type: "verify_totp",
              };
        const result = await performMutation(request, epoch, "totp");
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "access_granted") {
          if (!acceptVerifiedAccess(result, challenge)) {
            rejectBoundaryResult("totp", result);
          }
        } else if (result.kind === "totp_rejected") {
          if (challenge.kind === "provisioning") {
            transition({
              feedback: "rejected",
              kind: "totp_enrollment_required",
              role: challenge.role,
            });
          } else {
            transition({
              feedback: "rejected",
              kind: "totp_challenge",
              role: challenge.role,
            });
          }
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("totp", result);
        }
        return snapshot;
      }
      case "cancel_totp": {
        if (
          snapshot.kind === "totp_provisioning" &&
          pendingTotp?.kind === "provisioning"
        ) {
          resetEnrollment("cancelled");
        } else if (
          snapshot.kind === "totp_challenge" &&
          pendingTotp?.kind === "step_up"
        ) {
          transition({
            feedback: "cancelled",
            kind: "totp_challenge",
            role: pendingTotp.role,
          });
        }
        return snapshot;
      }
      case "sign_out_local":
      case "revoke_all_sessions": {
        if (snapshot.kind !== "authenticated") {
          return snapshot;
        }
        await executeSignOut(
          action.type === "sign_out_local" ? "local" : "all",
        );
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
        operationEpoch += 1;
        retryPlan = null;
        clearTotpCeremony();
        const epoch = operationEpoch;
        let operationId: string | null = null;
        let operationAllocationFailed = false;
        let exchangeResponse: StaffAuthMutationResult | null = null;
        const callbackWork = consumeStaffAuthPkceCallback(action.callbackUrl, {
          exchange: async ({ authorizationCode, flow }) => {
            if (!isCurrent(epoch)) {
              throw new Error("stale operation");
            }
            const allocatedOperationId = allocateOperationId("pkce_callback");
            if (allocatedOperationId === null || !isCurrent(epoch)) {
              operationAllocationFailed = allocatedOperationId === null;
              throw new Error("operation unavailable");
            }
            operationId = allocatedOperationId;
            const response = await dependencies.adapter.perform({
              authorizationCode,
              flow,
              operationId: allocatedOperationId,
              type: "exchange_pkce_code",
            });
            if (!isCurrent(epoch)) {
              discardMutationResponse(response);
              throw new Error("stale operation");
            }
            exchangeResponse = response;
          },
          history: dependencies.callback.history,
          route: dependencies.callback.route,
          states: dependencies.callback.states,
        });
        if (isCurrent(epoch)) {
          transition({ kind: "processing_pkce_callback" });
        }
        const receipt = await callbackWork;
        if (!isCurrent(epoch)) {
          return snapshot;
        }
        if (receipt.status === "rejected") {
          if (operationAllocationFailed) {
            return snapshot;
          }
          transition({ code: receipt.code, kind: "callback_rejected" });
          return snapshot;
        }
        const response: unknown = exchangeResponse;
        const result =
          operationId !== null &&
          isRecord(response) &&
          hasExactKeys(response, ["operationId", "result"]) &&
          response.operationId === operationId
            ? decodeBoundaryResult(response.result)
            : null;
        if (result === null) {
          discardMutationResponse(response);
          fail("pkce_callback", "invalid_backend_result");
          return snapshot;
        }
        if (receipt.flow === "password_recovery") {
          if (result.kind === "password_recovery_ready") {
            transition({ kind: "password_recovery_ready" });
          } else if (!applyAccessLoss(result)) {
            rejectBoundaryResult("pkce_callback", result);
          }
        } else if (result.kind === "access_granted") {
          if (!acceptEntry(result)) {
            rejectBoundaryResult("pkce_callback", result);
          }
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("pkce_callback", result);
        }
        return snapshot;
      }
      case "complete_password_recovery": {
        if (snapshot.kind !== "password_recovery_ready") {
          return snapshot;
        }
        const epoch = beginOperation({ kind: "updating_password" });
        const operationId = allocateOperationId("password_recovery");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "password_recovery",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "password_recovery_complete") {
          transition({ kind: "password_recovery_complete" });
        } else if (result.kind === "password_recovery_rejected") {
          transition({ kind: "password_recovery_rejected" });
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("password_recovery", result);
        }
        return snapshot;
      }
      case "create_staff_invitation": {
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          activeGrant === null ||
          !validText(action.email, 320) ||
          (action.targetRole !== "admin" && action.targetRole !== "teacher")
        ) {
          return snapshot;
        }
        const initiatingActor = activeGrant;
        const targetRole = managedRole(action.targetRole);
        const epoch = beginOperation({
          kind: "creating_staff_invitation",
          targetRole,
        });
        clearProtectedSchoolData();
        const operationId = allocateOperationId("staff_invitation");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "staff_invitation",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "staff_invitation_created") {
          const actor = validateOwnerActor(result.actor, initiatingActor);
          if (actor === null || result.invitedRole !== action.targetRole) {
            rejectBoundaryResult("staff_invitation", result);
          } else {
            transition({
              kind: "staff_invitation_created",
              schoolLabel: actor.school.label,
              targetRole,
            });
          }
        } else if (result.kind === "staff_invitation_rejected") {
          if (validateOwnerActor(result.actor, initiatingActor) === null) {
            rejectBoundaryResult("staff_invitation", result);
          } else {
            transition({ kind: "staff_invitation_rejected" });
          }
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("staff_invitation", result);
        }
        return snapshot;
      }
      case "review_staff_membership_revocation": {
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          activeGrant === null ||
          !validText(action.membershipId, 256)
        ) {
          return snapshot;
        }
        const target = activeGrant.manageableStaff.find(
          (entry) => entry.membershipId === action.membershipId,
        );
        if (target === undefined) {
          return snapshot;
        }
        operationEpoch += 1;
        retryPlan = null;
        clearTotpCeremony();
        clearInvitation();
        pendingMembershipRevocation = { actor: activeGrant, target };
        transition({
          kind: "confirming_staff_membership_revocation",
          schoolLabel: activeGrant.identity.school.label,
          target: {
            displayName: target.profile.displayName,
            email: target.profile.email,
            role: managedRole(target.role),
          },
        });
        return snapshot;
      }
      case "confirm_staff_membership_revocation": {
        if (
          snapshot.kind !== "confirming_staff_membership_revocation" ||
          pendingMembershipRevocation === null
        ) {
          return snapshot;
        }
        const selection = pendingMembershipRevocation;
        pendingMembershipRevocation = null;
        const operationId = allocateOperationId("staff_membership");
        if (operationId === null) {
          return snapshot;
        }
        await executeRevokeMembership(
          {
            membershipId: selection.target.membershipId,
            operationId,
            targetRole: selection.target.role,
            type: "revoke_staff_membership",
          },
          selection.actor,
          selection.target,
        );
        return snapshot;
      }
      case "cancel_staff_membership_revocation": {
        if (
          snapshot.kind !== "confirming_staff_membership_revocation" ||
          pendingMembershipRevocation === null ||
          activeGrant === null ||
          !sameAuthority(activeGrant, pendingMembershipRevocation.actor)
        ) {
          return snapshot;
        }
        const actor = pendingMembershipRevocation.actor;
        clearMembershipRevocation();
        const identity = normalizeIdentity(actor.identity);
        if (identity === null) {
          fail("staff_membership", "invalid_backend_result");
        } else {
          publishAuthenticated(actor, identity);
        }
        return snapshot;
      }
    }
    return snapshot;
  }

  return {
    dispatch,
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      operationEpoch += 1;
      retryPlan = null;
      activeGrant = null;
      clearTotpCeremony();
      clearInvitation();
      clearMembershipRevocation();
      listeners.clear();
      revision += 1;
      snapshot = { kind: "disposed", revision };
      try {
        unsubscribe();
      } catch {
        // A provider teardown failure must not resurrect or mutate auth state.
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function validText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !hasControlText(value)
  );
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isManagedRole(value: unknown): value is StorageManagedStaffRole {
  return value === "admin" || value === "teacher";
}

function isStaffRole(value: unknown): value is StorageStaffRole {
  return value === "admin" || value === "owner" || value === "teacher";
}

function decodeIdentity(value: unknown): StaffAuthBoundaryIdentity | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "email",
      "membership",
      "profile",
      "school",
    ]) ||
    !validText(value.accountId, 256) ||
    !validText(value.email, 320) ||
    !isRecord(value.profile) ||
    !hasExactKeys(value.profile, ["displayName", "id"]) ||
    !validText(value.profile.displayName, 200) ||
    !validText(value.profile.id, 256) ||
    !isRecord(value.membership) ||
    !hasExactKeys(value.membership, ["id", "role", "status"]) ||
    !validText(value.membership.id, 256) ||
    !isStaffRole(value.membership.role) ||
    value.membership.status !== "active" ||
    !isRecord(value.school) ||
    !hasExactKeys(value.school, ["id", "label"]) ||
    !validText(value.school.id, 256) ||
    !validText(value.school.label, 200)
  ) {
    return null;
  }
  return {
    accountId: value.accountId,
    email: value.email,
    membership: {
      id: value.membership.id,
      role: value.membership.role,
      status: "active",
    },
    profile: {
      displayName: value.profile.displayName,
      id: value.profile.id,
    },
    school: { id: value.school.id, label: value.school.label },
  };
}

function decodeManagedStaff(
  value: unknown,
): StaffAuthBoundaryManagedStaff | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["membershipId", "profile", "role", "schoolId"]) ||
    !validText(value.membershipId, 256) ||
    !isManagedRole(value.role) ||
    !validText(value.schoolId, 256) ||
    !isRecord(value.profile) ||
    !hasExactKeys(value.profile, ["displayName", "email", "id"]) ||
    !validText(value.profile.displayName, 200) ||
    !validText(value.profile.email, 320) ||
    !validText(value.profile.id, 256)
  ) {
    return null;
  }
  return {
    membershipId: value.membershipId,
    profile: {
      displayName: value.profile.displayName,
      email: value.profile.email,
      id: value.profile.id,
    },
    role: value.role,
    schoolId: value.schoolId,
  };
}

function decodeAccessGrant(value: unknown): StaffAuthAccessGrant | null {
  if (
    !isRecord(value) ||
    value.kind !== "access_granted" ||
    (value.assuranceLevel !== "aal1" && value.assuranceLevel !== "aal2") ||
    !validText(value.identityGeneration, 256) ||
    !validText(value.sessionGeneration, 256) ||
    !Array.isArray(value.manageableStaff)
  ) {
    return null;
  }
  const identity = decodeIdentity(value.identity);
  const manageableStaff = value.manageableStaff.map(decodeManagedStaff);
  const exactKeys =
    value.secondFactor === "challenge_required"
      ? [
          "assuranceLevel",
          "challengeReceipt",
          "identity",
          "identityGeneration",
          "kind",
          "manageableStaff",
          "secondFactor",
          "sessionGeneration",
        ]
      : [
          "assuranceLevel",
          "identity",
          "identityGeneration",
          "kind",
          "manageableStaff",
          "secondFactor",
          "sessionGeneration",
        ];
  if (
    !hasExactKeys(value, exactKeys) ||
    identity === null ||
    manageableStaff.some((entry) => entry === null) ||
    (value.secondFactor !== "challenge_required" &&
      value.secondFactor !== "enrollment_required" &&
      value.secondFactor !== "satisfied") ||
    ((value.secondFactor === "challenge_required" ||
      value.secondFactor === "enrollment_required") &&
      value.assuranceLevel !== "aal1") ||
    (value.secondFactor === "challenge_required" &&
      !validText(value.challengeReceipt, 512))
  ) {
    return null;
  }
  const staff = manageableStaff as StaffAuthBoundaryManagedStaff[];
  const assuranceLevel = value.assuranceLevel as "aal1" | "aal2";
  const membershipIds = new Set<string>();
  const profileIds = new Set<string>();
  if (identity.membership.role !== "owner" && staff.length !== 0) {
    return null;
  }
  for (const entry of staff) {
    if (
      entry.schoolId !== identity.school.id ||
      entry.membershipId === identity.membership.id ||
      membershipIds.has(entry.membershipId) ||
      profileIds.has(entry.profile.id)
    ) {
      return null;
    }
    membershipIds.add(entry.membershipId);
    profileIds.add(entry.profile.id);
  }
  const base = {
    assuranceLevel,
    identity,
    identityGeneration: value.identityGeneration,
    kind: "access_granted" as const,
    manageableStaff: staff,
    sessionGeneration: value.sessionGeneration,
  };
  if (value.secondFactor === "challenge_required") {
    return {
      ...base,
      challengeReceipt: value.challengeReceipt as string,
      secondFactor: "challenge_required",
    };
  }
  return { ...base, secondFactor: value.secondFactor };
}

function decodePresentation(value: unknown): TotpEnrollmentPresentation | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["blobUrl", "revoke"]) ||
    !validText(value.blobUrl, 2048) ||
    typeof value.revoke !== "function"
  ) {
    return null;
  }
  try {
    if (new URL(value.blobUrl).protocol !== "blob:") {
      return null;
    }
  } catch {
    return null;
  }
  const revoke = value.revoke as () => void;
  return { blobUrl: value.blobUrl, revoke: () => revoke.call(value) };
}

function decodeBoundaryResult(value: unknown): StaffAuthBoundaryResult | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "access_granted") {
    return decodeAccessGrant(value);
  }
  if (hasExactKeys(value, ["kind"])) {
    switch (value.kind) {
      case "email_verification_required":
      case "email_verification_sent":
      case "membership_inactive":
      case "password_recovery_complete":
      case "password_recovery_ready":
      case "password_recovery_rejected":
      case "recovery_request_received":
      case "session_expired":
      case "session_revoked":
      case "sign_in_rejected":
      case "signed_out":
      case "totp_rejected":
        return { kind: value.kind };
    }
  }
  if (value.kind === "invitation_rejected") {
    return hasExactKeys(value, ["kind", "reason"]) &&
      (value.reason === "expired" ||
        value.reason === "invalid" ||
        value.reason === "replayed")
      ? { kind: "invitation_rejected", reason: value.reason }
      : null;
  }
  if (value.kind === "invitation_ready") {
    if (
      !hasExactKeys(value, [
        "acceptanceReceipt",
        "expiresAt",
        "inspectionOperationId",
        "intendedAccountId",
        "intendedEmail",
        "kind",
        "role",
        "school",
      ]) ||
      !validText(value.acceptanceReceipt, 1024) ||
      !validText(value.expiresAt, 64) ||
      !isIsoInstant(value.expiresAt) ||
      !validText(value.inspectionOperationId, 200) ||
      !validText(value.intendedAccountId, 256) ||
      !validText(value.intendedEmail, 320) ||
      !isManagedRole(value.role) ||
      !isRecord(value.school) ||
      !hasExactKeys(value.school, ["id", "label"]) ||
      !validText(value.school.id, 256) ||
      !validText(value.school.label, 200)
    ) {
      return null;
    }
    return {
      acceptanceReceipt: value.acceptanceReceipt,
      expiresAt: value.expiresAt,
      inspectionOperationId: value.inspectionOperationId,
      intendedAccountId: value.intendedAccountId,
      intendedEmail: value.intendedEmail,
      kind: "invitation_ready",
      role: value.role,
      school: { id: value.school.id, label: value.school.label },
    };
  }
  if (value.kind === "totp_enrollment_ready") {
    const presentation = decodePresentation(value.presentation);
    return hasExactKeys(value, ["enrollmentReceipt", "kind", "presentation"]) &&
      validText(value.enrollmentReceipt, 512) &&
      presentation !== null
      ? {
          enrollmentReceipt: value.enrollmentReceipt,
          kind: "totp_enrollment_ready",
          presentation,
        }
      : null;
  }
  if (value.kind === "sign_out_complete") {
    return hasExactKeys(value, ["kind", "scope"]) &&
      (value.scope === "all" || value.scope === "local")
      ? { kind: "sign_out_complete", scope: value.scope }
      : null;
  }
  if (
    value.kind === "staff_invitation_created" ||
    value.kind === "staff_invitation_rejected" ||
    value.kind === "staff_membership_revoked" ||
    value.kind === "staff_membership_revocation_rejected"
  ) {
    const actor = decodeAccessGrant(value.actor);
    if (actor === null) {
      return null;
    }
    if (value.kind === "staff_invitation_created") {
      return hasExactKeys(value, ["actor", "invitedRole", "kind"]) &&
        isManagedRole(value.invitedRole)
        ? {
            actor,
            invitedRole: value.invitedRole,
            kind: "staff_invitation_created",
          }
        : null;
    }
    if (value.kind === "staff_invitation_rejected") {
      return hasExactKeys(value, ["actor", "kind"])
        ? { actor, kind: "staff_invitation_rejected" }
        : null;
    }
    if (value.kind === "staff_membership_revoked") {
      return hasExactKeys(value, [
        "actor",
        "kind",
        "membershipId",
        "revokedRole",
      ]) &&
        validText(value.membershipId, 256) &&
        isManagedRole(value.revokedRole)
        ? {
            actor,
            kind: "staff_membership_revoked",
            membershipId: value.membershipId,
            revokedRole: value.revokedRole,
          }
        : null;
    }
    return hasExactKeys(value, ["actor", "kind"])
      ? { actor, kind: "staff_membership_revocation_rejected" }
      : null;
  }
  return null;
}

function rawEventMatchesAuthority(
  value: unknown,
  current: StaffAuthAccessGrant,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "access_changed") {
    return (
      value.previousIdentityGeneration === current.identityGeneration &&
      value.previousSessionGeneration === current.sessionGeneration
    );
  }
  if (
    value.kind !== "membership_inactive" &&
    value.kind !== "session_expired" &&
    value.kind !== "session_revoked" &&
    value.kind !== "signed_out"
  ) {
    return false;
  }
  return (
    value.identityGeneration === current.identityGeneration &&
    value.sessionGeneration === current.sessionGeneration
  );
}

function decodeAccessEvent(value: unknown): StaffAuthAccessEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "access_changed") {
    const access = decodeAccessGrant(value.access);
    return hasExactKeys(value, [
      "access",
      "kind",
      "previousIdentityGeneration",
      "previousSessionGeneration",
    ]) &&
      validText(value.previousIdentityGeneration, 256) &&
      validText(value.previousSessionGeneration, 256) &&
      access !== null
      ? {
          access,
          kind: "access_changed",
          previousIdentityGeneration: value.previousIdentityGeneration,
          previousSessionGeneration: value.previousSessionGeneration,
        }
      : null;
  }
  if (
    value.kind !== "membership_inactive" &&
    value.kind !== "session_expired" &&
    value.kind !== "session_revoked" &&
    value.kind !== "signed_out"
  ) {
    return null;
  }
  return hasExactKeys(value, [
    "identityGeneration",
    "kind",
    "sessionGeneration",
  ]) &&
    validText(value.identityGeneration, 256) &&
    validText(value.sessionGeneration, 256)
    ? {
        identityGeneration: value.identityGeneration,
        kind: value.kind,
        sessionGeneration: value.sessionGeneration,
      }
    : null;
}

function isIsoInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isFutureExpiry(value: string, now: number): boolean {
  return Number.isFinite(now) && isIsoInstant(value) && Date.parse(value) > now;
}

function discardBoundaryResult(value: unknown): void {
  if (
    isRecord(value) &&
    value.kind === "totp_enrollment_ready" &&
    isRecord(value.presentation) &&
    typeof value.presentation.revoke === "function"
  ) {
    try {
      value.presentation.revoke();
    } catch {
      // Best-effort cleanup of an untrusted or stale presentation.
    }
  }
}

function discardMutationResponse(value: unknown): void {
  if (isRecord(value)) {
    discardBoundaryResult(value.result);
  }
}
