import { parseStaffDisplayName } from "@desmoslock/contracts";

import {
  consumeStaffInvitationCallback,
  consumeStaffRecoveryCallback,
  type StaffAuthCallbackHistory,
  type StaffAuthCallbackReceipt,
  type StaffAuthCallbackRoute,
  type StaffRecoveryFlowStore,
} from "./staff-auth-callback.js";

export { parseStaffDisplayName };

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
  readonly profile: {
    readonly displayName: string;
    readonly email: string;
    readonly id: string;
  };
  readonly role: StorageManagedStaffRole;
  readonly schoolId: string;
}

export interface StaffAuthManagedStaff {
  readonly profile: {
    readonly displayName: string;
    readonly email: string;
    readonly id: string;
  };
  readonly role: ManagedStaffRole;
  readonly schoolId: string;
}

export interface StaffAuthBoundaryManagedInvitation {
  readonly email: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly role: StorageManagedStaffRole;
  readonly schoolId: string;
  readonly state: "pending";
}

export interface StaffAuthManagedInvitation {
  readonly email: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly role: ManagedStaffRole;
  readonly schoolId: string;
  readonly state: "pending";
}

export type StaffAuthAccessGrant = {
  readonly assuranceLevel: "aal1" | "aal2";
  readonly identity: StaffAuthBoundaryIdentity;
  readonly identityGeneration: string;
  readonly kind: "access_granted";
  /** Adapter-filtered to the exact active identity School before this boundary. */
  readonly manageableInvitations: readonly StaffAuthBoundaryManagedInvitation[];
  /** Adapter-filtered to the exact active identity School before this boundary. */
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
  | {
      readonly kind: "password_recovery_complete";
      readonly sessionScope: "all";
    }
  | { readonly kind: "password_recovery_rejected" }
  | { readonly kind: "step_up_required" }
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
      readonly invitationId: string;
      readonly kind: "staff_invitation_revoked";
      readonly revokedRole: StorageManagedStaffRole;
      readonly schoolId: string;
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_invitation_revocation_rejected";
    }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_membership_revoked";
      readonly profileId: string;
      readonly revokedRole: StorageManagedStaffRole;
      readonly schoolId: string;
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
    | {
        readonly codeChallenge: string;
        readonly email: string;
        readonly flowId: string;
        readonly state: string;
        readonly type: "request_password_recovery";
      }
    | {
        readonly tokenHash: string;
        readonly type: "inspect_invitation";
      }
    | {
        readonly acceptanceReceipt: string;
        readonly displayName: string;
        readonly inspectionOperationId: string;
        readonly password: string;
        readonly type: "accept_invitation";
      }
    | { readonly type: "begin_totp_enrollment" }
    | { readonly scope: "all" | "local"; readonly type: "sign_out" }
    | {
        readonly authorizationCode: string;
        readonly type: "exchange_recovery_code";
        readonly verifier: string;
      }
    | {
        /**
         * Adapter orchestration boundary: DB begin, provider password update,
         * DB finish, and global sign-out must all be authoritatively complete
         * before returning password_recovery_complete.
         */
        readonly password: string;
        readonly type: "complete_password_recovery";
      }
    | {
        readonly email: string;
        readonly schoolId: string;
        readonly targetRole: StorageManagedStaffRole;
        readonly type: "create_staff_invitation";
      }
    | {
        readonly invitationId: string;
        readonly schoolId: string;
        readonly type: "revoke_staff_invitation";
      }
    | {
        readonly profileId: string;
        readonly schoolId: string;
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
  | "recovery_callback"
  | "revoke_all_sessions"
  | "sign_in"
  | "staff_invitation"
  | "staff_invitation_revocation"
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
  | { readonly kind: "invitation_step_up_required"; readonly revision: number }
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
  | { readonly kind: "processing_recovery_callback"; readonly revision: number }
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
      readonly kind: "confirming_staff_invitation_revocation";
      readonly revision: number;
      readonly schoolLabel: string;
      readonly target: {
        readonly email: string;
        readonly role: ManagedStaffRole;
      };
    }
  | {
      readonly kind: "revoking_staff_invitation";
      readonly revision: number;
      readonly targetRole: ManagedStaffRole;
    }
  | {
      readonly kind: "staff_invitation_revoked";
      readonly revision: number;
      readonly schoolLabel: string;
      readonly targetRole: ManagedStaffRole;
    }
  | {
      readonly kind: "staff_invitation_revocation_rejected";
      readonly revision: number;
    }
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
      readonly manageableInvitations: readonly StaffAuthManagedInvitation[];
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
  | {
      readonly displayName: string;
      readonly password: string;
      readonly type: "accept_invitation";
    }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly type: "sign_out_local" }
  | { readonly type: "revoke_all_sessions" }
  | { readonly type: "retry" }
  | { readonly callbackUrl: string; readonly type: "consume_recovery_callback" }
  | { readonly password: string; readonly type: "complete_password_recovery" }
  | {
      readonly email: string;
      readonly schoolId: string;
      readonly targetRole: StorageManagedStaffRole;
      readonly type: "create_staff_invitation";
    }
  | {
      readonly profileId: string;
      readonly schoolId: string;
      readonly type: "review_staff_membership_revocation";
    }
  | {
      readonly invitationId: string;
      readonly schoolId: string;
      readonly type: "review_staff_invitation_revocation";
    }
  | { readonly type: "confirm_staff_invitation_revocation" }
  | { readonly type: "cancel_staff_invitation_revocation" }
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

interface PendingInvitationRevocation {
  readonly actor: StaffAuthAccessGrant;
  readonly target: StaffAuthBoundaryManagedInvitation;
}

export function createStaffAuthController(dependencies: {
  readonly adapter: StaffAuthAdapter;
  readonly callback: {
    readonly flows: StaffRecoveryFlowStore;
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  };
  readonly clock: { readonly now: () => number };
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
  let pendingInvitationRevocation: PendingInvitationRevocation | null = null;
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

  function clearInvitationRevocation(): void {
    pendingInvitationRevocation = null;
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
    activeGrant = null;
    clearTotpCeremony();
    clearInvitation();
    clearInvitationRevocation();
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
      readonly preserveInvitationRevocation?: boolean;
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
    if (options.preserveInvitationRevocation !== true) {
      clearInvitationRevocation();
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
      const result = decodeMutationResponse(response, request.operationId);
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
      profile: { ...entry.profile },
      role: managedRole(entry.role),
      schoolId: entry.schoolId,
    }));
  }

  function normalizeManagedInvitations(
    invitations: readonly StaffAuthBoundaryManagedInvitation[],
  ): readonly StaffAuthManagedInvitation[] {
    return invitations.map((invitation) => ({
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      invitationId: invitation.invitationId,
      role: managedRole(invitation.role),
      schoolId: invitation.schoolId,
      state: "pending",
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
    clearInvitationRevocation();
    clearMembershipRevocation();
    transition({
      assuranceLevel: grant.assuranceLevel,
      identity,
      identityGeneration: grant.identityGeneration,
      kind: "authenticated",
      manageableInvitations: normalizeManagedInvitations(
        grant.manageableInvitations,
      ),
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
    clearInvitationRevocation();
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
    const targetRole = managedRole(expectedTarget.role);
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
        result.profileId !== request.profileId ||
        result.profileId !== expectedTarget.profile.id ||
        result.schoolId !== request.schoolId ||
        result.schoolId !== expectedTarget.schoolId ||
        result.revokedRole !== expectedTarget.role
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

  async function executeRevokeInvitation(
    request: Extract<StaffAuthMutation, { type: "revoke_staff_invitation" }>,
    expectedActor: StaffAuthAccessGrant,
    expectedTarget: StaffAuthBoundaryManagedInvitation,
  ): Promise<void> {
    const targetRole = managedRole(expectedTarget.role);
    const epoch = beginOperation({
      kind: "revoking_staff_invitation",
      targetRole,
    });
    clearProtectedSchoolData();
    const result = await performMutation(
      request,
      epoch,
      "staff_invitation_revocation",
    );
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "staff_invitation_revoked") {
      const actor = validateOwnerActor(result.actor, expectedActor);
      if (
        actor === null ||
        result.invitationId !== request.invitationId ||
        result.invitationId !== expectedTarget.invitationId ||
        result.schoolId !== request.schoolId ||
        result.schoolId !== expectedTarget.schoolId ||
        result.revokedRole !== expectedTarget.role
      ) {
        rejectBoundaryResult("staff_invitation_revocation", result);
        return;
      }
      transition({
        kind: "staff_invitation_revoked",
        schoolLabel: actor.school.label,
        targetRole,
      });
    } else if (result.kind === "staff_invitation_revocation_rejected") {
      if (validateOwnerActor(result.actor, expectedActor) === null) {
        rejectBoundaryResult("staff_invitation_revocation", result);
      } else {
        transition({ kind: "staff_invitation_revocation_rejected" });
      }
    } else if (!applyAccessLoss(result)) {
      rejectBoundaryResult("staff_invitation_revocation", result);
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
    const eventSnapshot = snapshotRecord(rawEvent);
    if (eventSnapshot === null) {
      operationEpoch += 1;
      retryPlan = null;
      activeGrant = null;
      fail("bootstrap", "invalid_backend_result");
      clearProtectedSchoolData();
      return;
    }
    const event = decodeAccessEvent(eventSnapshot);
    if (event === null) {
      if (snapshotEventMatchesAuthority(eventSnapshot, current)) {
        operationEpoch += 1;
        retryPlan = null;
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
    const eventEpoch = operationEpoch;
    retryPlan = null;
    clearTotpCeremony();
    clearInvitation();
    clearInvitationRevocation();
    clearMembershipRevocation();
    if (event.kind === "access_changed") {
      activeGrant = null;
      transition({ kind: "bootstrapping" });
      if (!isCurrent(eventEpoch)) {
        return;
      }
      const cleared = clearProtectedSchoolData();
      if (!isCurrent(eventEpoch)) {
        return;
      }
      if (!cleared) {
        fail("bootstrap", "dependency_unavailable");
        return;
      }
      if (!acceptEntry(event.access)) {
        fail("bootstrap", "invalid_backend_result");
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
        let rawFlow: unknown;
        try {
          rawFlow = await dependencies.callback.flows.create();
        } catch {
          if (isCurrent(epoch)) {
            fail("password_recovery", "dependency_unavailable");
          }
          return snapshot;
        }
        if (!isCurrent(epoch)) {
          return snapshot;
        }
        const flow = snapshotExactRecord(rawFlow, [
          "codeChallenge",
          "flowId",
          "state",
        ]);
        if (
          flow === null ||
          !isBase64UrlText(flow.codeChallenge, 43) ||
          !isBase64UrlText(flow.flowId, 22) ||
          !isBase64UrlText(flow.state, 43)
        ) {
          fail("password_recovery", "invalid_backend_result");
          return snapshot;
        }
        const result = await performMutation(
          {
            codeChallenge: flow.codeChallenge,
            email: action.email,
            flowId: flow.flowId,
            operationId,
            state: flow.state,
            type: "request_password_recovery",
          },
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
          snapshot.kind !== "bootstrapping" &&
          snapshot.kind !== "signed_out" &&
          snapshot.kind !== "invitation_rejected"
        ) {
          return snapshot;
        }
        operationEpoch += 1;
        retryPlan = null;
        clearTotpCeremony();
        clearInvitation();
        clearInvitationRevocation();
        clearMembershipRevocation();
        const epoch = operationEpoch;
        let operationId: string | null = null;
        let response: unknown = null;
        let allocationFailed = false;
        const callbackWork = consumeStaffInvitationCallback(
          action.callbackUrl,
          {
            history: dependencies.callback.history,
            inspect: async (tokenHash) => {
              const allocated = allocateOperationId("invitation");
              if (allocated === null || !isCurrent(epoch)) {
                allocationFailed = allocated === null;
                throw new Error("operation unavailable");
              }
              operationId = allocated;
              activeGrant = null;
              transition({ kind: "inspecting_invitation" });
              if (!isCurrent(epoch)) {
                throw new Error("stale operation");
              }
              const cleared = clearProtectedSchoolData();
              if (!isCurrent(epoch)) {
                throw new Error("stale operation");
              }
              if (!cleared) {
                operationEpoch += 1;
                fail("invitation", "dependency_unavailable");
                throw new Error("protected data unavailable");
              }
              response = await dependencies.adapter.perform({
                operationId: allocated,
                tokenHash,
                type: "inspect_invitation",
              });
              if (!isCurrent(epoch)) {
                discardMutationResponse(response);
                throw new Error("stale operation");
              }
            },
            route: dependencies.callback.route,
          },
        );
        const receipt = await callbackWork;
        if (!isCurrent(epoch)) {
          return snapshot;
        }
        if (receipt.status === "rejected") {
          if (allocationFailed) {
            return snapshot;
          }
          if (receipt.code === "token_consumption_unavailable") {
            fail("invitation", "dependency_unavailable");
          } else {
            transition({ kind: "invitation_rejected", reason: "invalid" });
          }
          return snapshot;
        }
        const result =
          operationId === null
            ? null
            : decodeMutationResponse(response, operationId);
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
        const actionRecord = snapshotExactRecord(action, [
          "displayName",
          "password",
          "type",
        ]);
        const displayName = parseStaffDisplayName(actionRecord?.displayName);
        if (
          snapshot.kind !== "invitation_ready" ||
          pendingInvitation === null ||
          actionRecord?.type !== "accept_invitation" ||
          displayName === null ||
          typeof actionRecord.password !== "string"
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
            displayName,
            inspectionOperationId: invitation.inspectionOperationId,
            operationId,
            password: actionRecord.password,
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
        } else if (result.kind === "step_up_required") {
          clearInvitation();
          transition({ kind: "invitation_step_up_required" });
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
      case "consume_recovery_callback": {
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
        clearInvitation();
        clearInvitationRevocation();
        clearMembershipRevocation();
        const epoch = operationEpoch;
        let operationId: string | null = null;
        let operationAllocationFailed = false;
        let consumeResponse: StaffAuthMutationResult | null = null;
        const callbackWork = consumeStaffRecoveryCallback(action.callbackUrl, {
          clock: dependencies.clock,
          exchange: async ({ authorizationCode, verifier }) => {
            if (!isCurrent(epoch)) {
              throw new Error("stale operation");
            }
            const allocatedOperationId =
              allocateOperationId("recovery_callback");
            if (allocatedOperationId === null || !isCurrent(epoch)) {
              operationAllocationFailed = allocatedOperationId === null;
              throw new Error("operation unavailable");
            }
            operationId = allocatedOperationId;
            activeGrant = null;
            transition({ kind: "processing_recovery_callback" });
            if (!isCurrent(epoch)) {
              throw new Error("stale operation");
            }
            const cleared = clearProtectedSchoolData();
            if (!isCurrent(epoch)) {
              throw new Error("stale operation");
            }
            if (!cleared) {
              operationEpoch += 1;
              fail("recovery_callback", "dependency_unavailable");
              throw new Error("protected data unavailable");
            }
            const response = await dependencies.adapter.perform({
              authorizationCode,
              operationId: allocatedOperationId,
              type: "exchange_recovery_code",
              verifier,
            });
            if (!isCurrent(epoch)) {
              discardMutationResponse(response);
              throw new Error("stale operation");
            }
            consumeResponse = response;
          },
          history: dependencies.callback.history,
          route: dependencies.callback.route,
          flows: dependencies.callback.flows,
        });
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
        const response: unknown = consumeResponse;
        const result =
          operationId === null
            ? null
            : decodeMutationResponse(response, operationId);
        if (result === null) {
          discardMutationResponse(response);
          fail("recovery_callback", "invalid_backend_result");
          return snapshot;
        }
        if (result.kind === "password_recovery_ready") {
          transition({ kind: "password_recovery_ready" });
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("recovery_callback", result);
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
        const actionRecord = snapshotExactRecord(action, [
          "email",
          "schoolId",
          "targetRole",
          "type",
        ]);
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          activeGrant === null ||
          actionRecord?.type !== "create_staff_invitation" ||
          !validText(actionRecord.email, 320) ||
          !validText(actionRecord.schoolId, 256) ||
          actionRecord.schoolId !== activeGrant.identity.school.id ||
          (actionRecord.targetRole !== "admin" &&
            actionRecord.targetRole !== "teacher")
        ) {
          return snapshot;
        }
        const initiatingActor = activeGrant;
        const targetRole = managedRole(actionRecord.targetRole);
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
          {
            email: actionRecord.email,
            operationId,
            schoolId: actionRecord.schoolId,
            targetRole: actionRecord.targetRole,
            type: "create_staff_invitation",
          },
          epoch,
          "staff_invitation",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "staff_invitation_created") {
          const actor = validateOwnerActor(result.actor, initiatingActor);
          if (
            actor === null ||
            actor.school.id !== actionRecord.schoolId ||
            result.invitedRole !== actionRecord.targetRole
          ) {
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
      case "review_staff_invitation_revocation": {
        const selectionRecord = snapshotExactRecord(action, [
          "invitationId",
          "schoolId",
          "type",
        ]);
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          activeGrant === null ||
          selectionRecord?.type !== "review_staff_invitation_revocation" ||
          !validText(selectionRecord.invitationId, 256) ||
          !validText(selectionRecord.schoolId, 256) ||
          selectionRecord.schoolId !== activeGrant.identity.school.id
        ) {
          return snapshot;
        }
        const target = activeGrant.manageableInvitations.find(
          (entry) =>
            entry.invitationId === selectionRecord.invitationId &&
            entry.schoolId === selectionRecord.schoolId,
        );
        if (target === undefined) {
          return snapshot;
        }
        operationEpoch += 1;
        retryPlan = null;
        clearTotpCeremony();
        clearInvitation();
        clearMembershipRevocation();
        pendingInvitationRevocation = { actor: activeGrant, target };
        transition({
          kind: "confirming_staff_invitation_revocation",
          schoolLabel: activeGrant.identity.school.label,
          target: {
            email: target.email,
            role: managedRole(target.role),
          },
        });
        return snapshot;
      }
      case "confirm_staff_invitation_revocation": {
        if (
          snapshot.kind !== "confirming_staff_invitation_revocation" ||
          pendingInvitationRevocation === null ||
          activeGrant === null ||
          !sameAuthority(activeGrant, pendingInvitationRevocation.actor)
        ) {
          return snapshot;
        }
        const selection = pendingInvitationRevocation;
        pendingInvitationRevocation = null;
        const operationId = allocateOperationId("staff_invitation_revocation");
        if (operationId === null) {
          return snapshot;
        }
        await executeRevokeInvitation(
          {
            invitationId: selection.target.invitationId,
            operationId,
            schoolId: selection.target.schoolId,
            type: "revoke_staff_invitation",
          },
          selection.actor,
          selection.target,
        );
        return snapshot;
      }
      case "cancel_staff_invitation_revocation": {
        if (
          snapshot.kind !== "confirming_staff_invitation_revocation" ||
          pendingInvitationRevocation === null ||
          activeGrant === null ||
          !sameAuthority(activeGrant, pendingInvitationRevocation.actor)
        ) {
          return snapshot;
        }
        const actor = pendingInvitationRevocation.actor;
        clearInvitationRevocation();
        const identity = normalizeIdentity(actor.identity);
        if (identity === null) {
          fail("staff_invitation_revocation", "invalid_backend_result");
        } else {
          publishAuthenticated(actor, identity);
        }
        return snapshot;
      }
      case "review_staff_membership_revocation": {
        const selectionRecord = snapshotExactRecord(action, [
          "profileId",
          "schoolId",
          "type",
        ]);
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          activeGrant === null ||
          selectionRecord?.type !== "review_staff_membership_revocation" ||
          !validText(selectionRecord.profileId, 256) ||
          !validText(selectionRecord.schoolId, 256) ||
          selectionRecord.schoolId !== activeGrant.identity.school.id
        ) {
          return snapshot;
        }
        const target = activeGrant.manageableStaff.find(
          (entry) =>
            entry.profile.id === selectionRecord.profileId &&
            entry.schoolId === selectionRecord.schoolId,
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
          pendingMembershipRevocation === null ||
          activeGrant === null ||
          !sameAuthority(activeGrant, pendingMembershipRevocation.actor)
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
            operationId,
            profileId: selection.target.profile.id,
            schoolId: selection.target.schoolId,
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
      clearInvitationRevocation();
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

type BoundaryRecord = Readonly<Record<string, unknown>>;

/**
 * Takes one immutable-by-convention copy of an untrusted record's own data
 * descriptors. Accessors and throwing proxy traps are rejected without ever
 * evaluating a property on the boundary object itself.
 */
function snapshotRecord(value: unknown): BoundaryRecord | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const names = Reflect.ownKeys(descriptors);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of names) {
      if (typeof name !== "string") {
        return null;
      }
      const descriptor = descriptors[name];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[name] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const names = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 10_000 ||
      names.length !== length + 1
    ) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    if (
      names.some(
        (name) =>
          typeof name !== "string" ||
          (name !== "length" &&
            (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length)),
      )
    ) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactKeys(value: BoundaryRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): BoundaryRecord | null {
  const snapshot = snapshotRecord(value);
  return snapshot !== null && hasExactKeys(snapshot, keys) ? snapshot : null;
}

function validText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !hasControlText(value)
  );
}

// Keep this duplicate predicate exactly aligned with packages/contracts/src/staff-auth.ts
// until the shared package exports its canonical email scalar parser.
const canonicalManagementEmailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

function isCanonicalManagementEmail(value: unknown): value is string {
  return (
    validText(value, 254) &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    canonicalManagementEmailPattern.test(value)
  );
}

function isBase64UrlText(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/.test(value)
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
  const record = snapshotExactRecord(value, [
    "accountId",
    "email",
    "membership",
    "profile",
    "school",
  ]);
  if (record === null) {
    return null;
  }
  const profile = snapshotExactRecord(record.profile, ["displayName", "id"]);
  const membership = snapshotExactRecord(record.membership, [
    "id",
    "role",
    "status",
  ]);
  const school = snapshotExactRecord(record.school, ["id", "label"]);
  if (
    !validText(record.accountId, 256) ||
    !validText(record.email, 320) ||
    profile === null ||
    !validText(profile.displayName, 200) ||
    !validText(profile.id, 256) ||
    membership === null ||
    !validText(membership.id, 256) ||
    !isStaffRole(membership.role) ||
    membership.status !== "active" ||
    school === null ||
    !validText(school.id, 256) ||
    !validText(school.label, 200)
  ) {
    return null;
  }
  return {
    accountId: record.accountId,
    email: record.email,
    membership: {
      id: membership.id,
      role: membership.role,
      status: "active",
    },
    profile: {
      displayName: profile.displayName,
      id: profile.id,
    },
    school: { id: school.id, label: school.label },
  };
}

function decodeManagedStaff(
  value: unknown,
): StaffAuthBoundaryManagedStaff | null {
  const record = snapshotExactRecord(value, ["profile", "role", "schoolId"]);
  if (record === null) {
    return null;
  }
  const profile = snapshotExactRecord(record.profile, [
    "displayName",
    "email",
    "id",
  ]);
  if (
    !isManagedRole(record.role) ||
    !validText(record.schoolId, 256) ||
    profile === null ||
    !validText(profile.displayName, 200) ||
    !isCanonicalManagementEmail(profile.email) ||
    !validText(profile.id, 256)
  ) {
    return null;
  }
  return {
    profile: {
      displayName: profile.displayName,
      email: profile.email,
      id: profile.id,
    },
    role: record.role,
    schoolId: record.schoolId,
  };
}

function decodeManagedInvitation(
  value: unknown,
): StaffAuthBoundaryManagedInvitation | null {
  const record = snapshotExactRecord(value, [
    "email",
    "expiresAt",
    "invitationId",
    "role",
    "schoolId",
    "state",
  ]);
  if (
    record === null ||
    !isCanonicalManagementEmail(record.email) ||
    !validText(record.expiresAt, 64) ||
    !isIsoInstant(record.expiresAt) ||
    !validText(record.invitationId, 256) ||
    !isManagedRole(record.role) ||
    !validText(record.schoolId, 256) ||
    record.state !== "pending"
  ) {
    return null;
  }
  return {
    email: record.email,
    expiresAt: record.expiresAt,
    invitationId: record.invitationId,
    role: record.role,
    schoolId: record.schoolId,
    state: "pending",
  };
}

function decodeAccessGrant(value: unknown): StaffAuthAccessGrant | null {
  const record = snapshotRecord(value);
  if (
    record === null ||
    record.kind !== "access_granted" ||
    (record.assuranceLevel !== "aal1" && record.assuranceLevel !== "aal2") ||
    !validText(record.identityGeneration, 256) ||
    !validText(record.sessionGeneration, 256)
  ) {
    return null;
  }
  const identity = decodeIdentity(record.identity);
  const rawManageableInvitations = snapshotArray(record.manageableInvitations);
  const rawManageableStaff = snapshotArray(record.manageableStaff);
  if (
    rawManageableInvitations === null ||
    rawManageableInvitations.length > 500 ||
    rawManageableStaff === null ||
    rawManageableStaff.length > 500
  ) {
    return null;
  }
  const manageableInvitations = rawManageableInvitations.map(
    decodeManagedInvitation,
  );
  const manageableStaff = rawManageableStaff.map(decodeManagedStaff);
  const exactKeys =
    record.secondFactor === "challenge_required"
      ? [
          "assuranceLevel",
          "challengeReceipt",
          "identity",
          "identityGeneration",
          "kind",
          "manageableInvitations",
          "manageableStaff",
          "secondFactor",
          "sessionGeneration",
        ]
      : [
          "assuranceLevel",
          "identity",
          "identityGeneration",
          "kind",
          "manageableInvitations",
          "manageableStaff",
          "secondFactor",
          "sessionGeneration",
        ];
  if (
    !hasExactKeys(record, exactKeys) ||
    identity === null ||
    manageableInvitations.some((entry) => entry === null) ||
    manageableStaff.some((entry) => entry === null) ||
    (record.secondFactor !== "challenge_required" &&
      record.secondFactor !== "enrollment_required" &&
      record.secondFactor !== "satisfied") ||
    ((record.secondFactor === "challenge_required" ||
      record.secondFactor === "enrollment_required") &&
      record.assuranceLevel !== "aal1") ||
    (record.secondFactor === "challenge_required" &&
      !validText(record.challengeReceipt, 512))
  ) {
    return null;
  }
  const staff = manageableStaff as StaffAuthBoundaryManagedStaff[];
  const invitations =
    manageableInvitations as StaffAuthBoundaryManagedInvitation[];
  const assuranceLevel = record.assuranceLevel as "aal1" | "aal2";
  const profileIds = new Set<string>();
  const profileByEmail = new Map<string, string>();
  if (
    identity.membership.role !== "owner" &&
    (staff.length !== 0 || invitations.length !== 0)
  ) {
    return null;
  }
  for (const entry of staff) {
    if (
      entry.schoolId !== identity.school.id ||
      entry.profile.id === identity.profile.id ||
      profileIds.has(entry.profile.id) ||
      (profileByEmail.has(entry.profile.email) &&
        profileByEmail.get(entry.profile.email) !== entry.profile.id)
    ) {
      return null;
    }
    profileIds.add(entry.profile.id);
    profileByEmail.set(entry.profile.email, entry.profile.id);
  }
  const invitationIds = new Set<string>();
  const invitationEmails: Array<{
    readonly email: string;
    readonly schoolId: string;
  }> = [];
  for (const invitation of invitations) {
    if (
      invitation.schoolId !== identity.school.id ||
      invitationIds.has(invitation.invitationId) ||
      invitationEmails.some(
        (known) =>
          known.schoolId === invitation.schoolId &&
          known.email === invitation.email,
      )
    ) {
      return null;
    }
    invitationIds.add(invitation.invitationId);
    invitationEmails.push({
      email: invitation.email,
      schoolId: invitation.schoolId,
    });
  }
  const base = {
    assuranceLevel,
    identity,
    identityGeneration: record.identityGeneration,
    kind: "access_granted" as const,
    manageableInvitations: invitations,
    manageableStaff: staff,
    sessionGeneration: record.sessionGeneration,
  };
  if (record.secondFactor === "challenge_required") {
    return {
      ...base,
      challengeReceipt: record.challengeReceipt as string,
      secondFactor: "challenge_required",
    };
  }
  return { ...base, secondFactor: record.secondFactor };
}

function decodePresentation(value: unknown): TotpEnrollmentPresentation | null {
  const presentation = snapshotExactRecord(value, ["blobUrl", "revoke"]);
  if (
    presentation === null ||
    !validText(presentation.blobUrl, 2048) ||
    typeof presentation.revoke !== "function"
  ) {
    return null;
  }
  try {
    if (new URL(presentation.blobUrl).protocol !== "blob:") {
      return null;
    }
  } catch {
    return null;
  }
  const blobUrl = presentation.blobUrl;
  const revoke = presentation.revoke;
  return {
    blobUrl,
    revoke: () => Reflect.apply(revoke, presentation, []),
  };
}

function decodeBoundaryResult(value: unknown): StaffAuthBoundaryResult | null {
  const record = snapshotRecord(value);
  if (record === null || typeof record.kind !== "string") {
    return null;
  }
  if (record.kind === "access_granted") {
    return decodeAccessGrant(record);
  }
  if (hasExactKeys(record, ["kind"])) {
    switch (record.kind) {
      case "email_verification_required":
      case "email_verification_sent":
      case "membership_inactive":
      case "password_recovery_ready":
      case "password_recovery_rejected":
      case "recovery_request_received":
      case "session_expired":
      case "session_revoked":
      case "sign_in_rejected":
      case "signed_out":
      case "step_up_required":
      case "totp_rejected":
        return { kind: record.kind };
    }
  }
  if (record.kind === "invitation_rejected") {
    return hasExactKeys(record, ["kind", "reason"]) &&
      (record.reason === "expired" ||
        record.reason === "invalid" ||
        record.reason === "replayed")
      ? { kind: "invitation_rejected", reason: record.reason }
      : null;
  }
  if (record.kind === "invitation_ready") {
    const school = snapshotExactRecord(record.school, ["id", "label"]);
    if (
      !hasExactKeys(record, [
        "acceptanceReceipt",
        "expiresAt",
        "inspectionOperationId",
        "intendedAccountId",
        "intendedEmail",
        "kind",
        "role",
        "school",
      ]) ||
      !validText(record.acceptanceReceipt, 1024) ||
      !validText(record.expiresAt, 64) ||
      !isIsoInstant(record.expiresAt) ||
      !validText(record.inspectionOperationId, 200) ||
      !validText(record.intendedAccountId, 256) ||
      !validText(record.intendedEmail, 320) ||
      !isManagedRole(record.role) ||
      school === null ||
      !validText(school.id, 256) ||
      !validText(school.label, 200)
    ) {
      return null;
    }
    return {
      acceptanceReceipt: record.acceptanceReceipt,
      expiresAt: record.expiresAt,
      inspectionOperationId: record.inspectionOperationId,
      intendedAccountId: record.intendedAccountId,
      intendedEmail: record.intendedEmail,
      kind: "invitation_ready",
      role: record.role,
      school: { id: school.id, label: school.label },
    };
  }
  if (record.kind === "totp_enrollment_ready") {
    const presentation = decodePresentation(record.presentation);
    return hasExactKeys(record, [
      "enrollmentReceipt",
      "kind",
      "presentation",
    ]) &&
      validText(record.enrollmentReceipt, 512) &&
      presentation !== null
      ? {
          enrollmentReceipt: record.enrollmentReceipt,
          kind: "totp_enrollment_ready",
          presentation,
        }
      : null;
  }
  if (record.kind === "sign_out_complete") {
    return hasExactKeys(record, ["kind", "scope"]) &&
      (record.scope === "all" || record.scope === "local")
      ? { kind: "sign_out_complete", scope: record.scope }
      : null;
  }
  if (record.kind === "password_recovery_complete") {
    return hasExactKeys(record, ["kind", "sessionScope"]) &&
      record.sessionScope === "all"
      ? { kind: "password_recovery_complete", sessionScope: "all" }
      : null;
  }
  if (
    record.kind === "staff_invitation_created" ||
    record.kind === "staff_invitation_rejected" ||
    record.kind === "staff_invitation_revoked" ||
    record.kind === "staff_invitation_revocation_rejected" ||
    record.kind === "staff_membership_revoked" ||
    record.kind === "staff_membership_revocation_rejected"
  ) {
    const actor = decodeAccessGrant(record.actor);
    if (actor === null) {
      return null;
    }
    if (record.kind === "staff_invitation_created") {
      return hasExactKeys(record, ["actor", "invitedRole", "kind"]) &&
        isManagedRole(record.invitedRole)
        ? {
            actor,
            invitedRole: record.invitedRole,
            kind: "staff_invitation_created",
          }
        : null;
    }
    if (record.kind === "staff_invitation_rejected") {
      return hasExactKeys(record, ["actor", "kind"])
        ? { actor, kind: "staff_invitation_rejected" }
        : null;
    }
    if (record.kind === "staff_invitation_revoked") {
      return hasExactKeys(record, [
        "actor",
        "invitationId",
        "kind",
        "revokedRole",
        "schoolId",
      ]) &&
        validText(record.invitationId, 256) &&
        isManagedRole(record.revokedRole) &&
        validText(record.schoolId, 256)
        ? {
            actor,
            invitationId: record.invitationId,
            kind: "staff_invitation_revoked",
            revokedRole: record.revokedRole,
            schoolId: record.schoolId,
          }
        : null;
    }
    if (record.kind === "staff_invitation_revocation_rejected") {
      return hasExactKeys(record, ["actor", "kind"])
        ? { actor, kind: "staff_invitation_revocation_rejected" }
        : null;
    }
    if (record.kind === "staff_membership_revoked") {
      return hasExactKeys(record, [
        "actor",
        "kind",
        "profileId",
        "revokedRole",
        "schoolId",
      ]) &&
        validText(record.profileId, 256) &&
        validText(record.schoolId, 256) &&
        isManagedRole(record.revokedRole)
        ? {
            actor,
            kind: "staff_membership_revoked",
            profileId: record.profileId,
            revokedRole: record.revokedRole,
            schoolId: record.schoolId,
          }
        : null;
    }
    return hasExactKeys(record, ["actor", "kind"])
      ? { actor, kind: "staff_membership_revocation_rejected" }
      : null;
  }
  return null;
}

function snapshotEventMatchesAuthority(
  value: BoundaryRecord,
  current: StaffAuthAccessGrant,
): boolean {
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
  const record = snapshotRecord(value);
  if (record === null || typeof record.kind !== "string") {
    return null;
  }
  if (record.kind === "access_changed") {
    const access = decodeAccessGrant(record.access);
    return hasExactKeys(record, [
      "access",
      "kind",
      "previousIdentityGeneration",
      "previousSessionGeneration",
    ]) &&
      validText(record.previousIdentityGeneration, 256) &&
      validText(record.previousSessionGeneration, 256) &&
      access !== null
      ? {
          access,
          kind: "access_changed",
          previousIdentityGeneration: record.previousIdentityGeneration,
          previousSessionGeneration: record.previousSessionGeneration,
        }
      : null;
  }
  if (
    record.kind !== "membership_inactive" &&
    record.kind !== "session_expired" &&
    record.kind !== "session_revoked" &&
    record.kind !== "signed_out"
  ) {
    return null;
  }
  return hasExactKeys(record, [
    "identityGeneration",
    "kind",
    "sessionGeneration",
  ]) &&
    validText(record.identityGeneration, 256) &&
    validText(record.sessionGeneration, 256)
    ? {
        identityGeneration: record.identityGeneration,
        kind: record.kind,
        sessionGeneration: record.sessionGeneration,
      }
    : null;
}

function decodeMutationResponse(
  value: unknown,
  expectedOperationId: string,
): StaffAuthBoundaryResult | null {
  const response = snapshotExactRecord(value, ["operationId", "result"]);
  return response !== null && response.operationId === expectedOperationId
    ? decodeBoundaryResult(response.result)
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
  const result = snapshotRecord(value);
  const presentation =
    result?.kind === "totp_enrollment_ready"
      ? snapshotExactRecord(result.presentation, ["blobUrl", "revoke"])
      : null;
  if (presentation !== null && typeof presentation.revoke === "function") {
    try {
      Reflect.apply(presentation.revoke, presentation, []);
    } catch {
      // Best-effort cleanup of an untrusted or stale presentation.
    }
  }
}

function discardMutationResponse(value: unknown): void {
  const response = snapshotRecord(value);
  if (response !== null) {
    discardBoundaryResult(response.result);
  }
}
