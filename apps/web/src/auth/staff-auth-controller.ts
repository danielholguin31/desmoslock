import {
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

export type StaffAuthAccessGrant = {
  readonly assuranceLevel: "aal1" | "aal2";
  readonly identity: StaffAuthBoundaryIdentity;
  readonly kind: "access_granted";
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
      readonly kind: "invitation_ready";
      readonly role: StorageManagedStaffRole;
      readonly schoolLabel: string;
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
  | { readonly kind: "staff_invitation_rejected" }
  | {
      readonly actor: StaffAuthAccessGrant;
      readonly kind: "staff_membership_revoked";
      readonly membershipId: string;
      readonly revokedRole: StorageManagedStaffRole;
    }
  | { readonly kind: "staff_membership_revocation_rejected" };

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
    | { readonly password: string; readonly type: "accept_invitation" }
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
      readonly kind:
        | "membership_inactive"
        | "session_expired"
        | "session_revoked"
        | "signed_out";
    }
  | {
      readonly access: StaffAuthAccessGrant;
      readonly kind: "access_changed";
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
      readonly kind: "authenticated";
      readonly revision: number;
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
  | { readonly callbackUrl: string; readonly type: "complete_pkce_callback" }
  | { readonly password: string; readonly type: "complete_password_recovery" }
  | {
      readonly email: string;
      readonly targetRole: StorageManagedStaffRole;
      readonly type: "create_staff_invitation";
    }
  | {
      readonly membershipId: string;
      readonly targetRole: StorageManagedStaffRole;
      readonly type: "revoke_staff_membership";
    };

export interface StaffAuthController {
  dispatch(action: StaffAuthAction): Promise<StaffAuthSnapshot>;
  getSnapshot(): StaffAuthSnapshot;
  subscribe(listener: (snapshot: StaffAuthSnapshot) => void): () => void;
  dispose(): void;
}

type RetryableMutation = Extract<
  StaffAuthMutation,
  {
    type: "resend_email_verification" | "revoke_staff_membership" | "sign_out";
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
    }
  | {
      readonly kind: "staff_membership";
      readonly request: Extract<
        RetryableMutation,
        { type: "revoke_staff_membership" }
      >;
    };

type PendingTotp =
  | {
      readonly identity: StaffAuthBoundaryIdentity;
      readonly kind: "enrollment_required";
      readonly role: "administrator" | "owner";
    }
  | {
      readonly ceremonyOperationId: string;
      readonly enrollmentReceipt: string;
      readonly identity: StaffAuthBoundaryIdentity;
      readonly kind: "provisioning";
      readonly presentation: TotpEnrollmentPresentation;
      readonly role: "administrator" | "owner";
    }
  | {
      readonly challengeReceipt: string;
      readonly identity: StaffAuthBoundaryIdentity;
      readonly kind: "step_up";
      readonly role: "administrator" | "owner";
    };

export function createStaffAuthController(dependencies: {
  readonly adapter: StaffAuthAdapter;
  readonly callback: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
    readonly states: StaffAuthCallbackStateStore;
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
  let pendingTotp: PendingTotp | null = null;
  let retryPlan: RetryPlan | null = null;
  let activeIdentityKey: string | null = null;
  const issuedOperationIds = new Set<string>();
  const listeners = new Set<(snapshot: StaffAuthSnapshot) => void>();

  function transition(next: SnapshotWithoutRevision<StaffAuthSnapshot>): void {
    if (disposed) {
      return;
    }
    revision += 1;
    snapshot = { ...next, revision } as StaffAuthSnapshot;
    for (const listener of listeners) {
      listener(snapshot);
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

  function resetEnrollment(feedback: "cancelled" | "rejected"): void {
    if (pendingTotp?.kind !== "provisioning") {
      return;
    }
    const { identity, presentation, role } = pendingTotp;
    revokePresentation(presentation);
    pendingTotp = { identity, kind: "enrollment_required", role };
    transition({ feedback, kind: "totp_enrollment_required", role });
  }

  function fail(
    operation: StaffAuthOperation,
    code: "dependency_unavailable" | "invalid_backend_result",
    retry: RetryPlan | null = null,
  ): void {
    clearTotpCeremony();
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
    options: { readonly preserveTotp?: boolean } = {},
  ): number {
    operationEpoch += 1;
    retryPlan = null;
    if (options.preserveTotp !== true) {
      clearTotpCeremony();
    }
    transition(next);
    return operationEpoch;
  }

  function isCurrent(epoch: number): boolean {
    return !disposed && epoch === operationEpoch;
  }

  function allocateOperationId(operation: StaffAuthOperation): string | null {
    let operationId: string;
    try {
      operationId = dependencies.operationIds.next();
    } catch {
      fail(operation, "invalid_backend_result");
      return null;
    }
    if (
      typeof operationId !== "string" ||
      operationId.length === 0 ||
      operationId.length > 200 ||
      issuedOperationIds.has(operationId)
    ) {
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
      const result = await dependencies.adapter.read();
      if (!isCurrent(epoch)) {
        discardBoundaryResult(result);
        return null;
      }
      if (!isBoundaryResult(result)) {
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
      const response = await dependencies.adapter.perform(request);
      if (!isCurrent(epoch)) {
        discardMutationResponse(response);
        return null;
      }
      if (
        !isRecord(response) ||
        response.operationId !== request.operationId ||
        !isBoundaryResult(response.result)
      ) {
        discardMutationResponse(response);
        fail(operation, "invalid_backend_result");
        return null;
      }
      return response.result;
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
      !isRecord(identity) ||
      !validText(identity.accountId, 256) ||
      !validText(identity.email, 320) ||
      !isRecord(identity.school) ||
      !validText(identity.school.id, 256) ||
      !validText(identity.school.label, 200) ||
      !isRecord(identity.membership) ||
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

  function identityKey(identity: StaffAuthBoundaryIdentity): string {
    return [
      identity.accountId,
      identity.school.id,
      identity.membership.id,
      identity.membership.role,
    ].join("\u0000");
  }

  function sameIdentity(
    left: StaffAuthBoundaryIdentity,
    right: StaffAuthBoundaryIdentity,
  ): boolean {
    return identityKey(left) === identityKey(right);
  }

  function publishAuthenticated(
    grant: StaffAuthAccessGrant,
    identity: StaffAuthIdentity,
  ): void {
    const nextIdentityKey = identityKey(grant.identity);
    if (activeIdentityKey !== null && activeIdentityKey !== nextIdentityKey) {
      dependencies.protectedSchoolData.clear();
    }
    activeIdentityKey = nextIdentityKey;
    clearTotpCeremony();
    transition({
      assuranceLevel: grant.assuranceLevel,
      identity,
      kind: "authenticated",
    });
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
            identity: grant.identity,
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
            challengeReceipt: grant.challengeReceipt,
            identity: grant.identity,
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
      publishAuthenticated(grant, identity);
      return true;
    }
    if (grant.secondFactor !== "satisfied") {
      return false;
    }
    publishAuthenticated(grant, identity);
    return true;
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
      !sameIdentity(grant.identity, expected.identity)
    ) {
      return false;
    }
    publishAuthenticated(grant, identity);
    return true;
  }

  function validateOwnerActor(
    grant: StaffAuthAccessGrant,
  ): StaffAuthIdentity | null {
    const identity = normalizeIdentity(grant.identity);
    if (
      identity === null ||
      identity.membership.role !== "owner" ||
      grant.assuranceLevel !== "aal2" ||
      grant.secondFactor !== "satisfied"
    ) {
      return null;
    }
    const nextIdentityKey = identityKey(grant.identity);
    if (activeIdentityKey !== null && activeIdentityKey !== nextIdentityKey) {
      dependencies.protectedSchoolData.clear();
    }
    activeIdentityKey = nextIdentityKey;
    return identity;
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
    activeIdentityKey = null;
    retryPlan = null;
    clearTotpCeremony();
    if (clearProtectedData) {
      dependencies.protectedSchoolData.clear();
    }
    transition({ kind: result.kind });
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
    activeIdentityKey = null;
    dependencies.protectedSchoolData.clear();
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
      activeIdentityKey = null;
      dependencies.protectedSchoolData.clear();
      transition({
        kind: "signed_out",
        notice: scope === "all" ? "all_sessions_revoked" : "signed_out",
      });
    } else if (!applyAccessLoss(result)) {
      rejectBoundaryResult(operation, result);
    }
  }

  async function executeRevokeMembership(
    request: Extract<RetryableMutation, { type: "revoke_staff_membership" }>,
  ): Promise<void> {
    const targetRole = managedRole(request.targetRole);
    const epoch = beginOperation({
      kind: "revoking_staff_membership",
      targetRole,
    });
    const result = await performMutation(request, epoch, "staff_membership", {
      kind: "staff_membership",
      request,
    });
    if (result === null || !isCurrent(epoch)) {
      return;
    }
    if (result.kind === "staff_membership_revoked") {
      const actor = validateOwnerActor(result.actor);
      if (
        actor === null ||
        result.membershipId !== request.membershipId ||
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
      transition({ kind: "staff_membership_revocation_rejected" });
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
      case "staff_membership":
        await executeRevokeMembership(plan.request);
    }
  }

  const eventListener = (event: StaffAuthAccessEvent) => {
    if (disposed || !isRecord(event) || typeof event.kind !== "string") {
      return;
    }
    if (
      event.kind !== "access_changed" &&
      event.kind !== "membership_inactive" &&
      event.kind !== "session_expired" &&
      event.kind !== "session_revoked" &&
      event.kind !== "signed_out"
    ) {
      return;
    }
    operationEpoch += 1;
    retryPlan = null;
    activeIdentityKey = null;
    clearTotpCeremony();
    dependencies.protectedSchoolData.clear();
    if (event.kind === "access_changed") {
      if (
        !isRecord(event.access) ||
        !acceptEntry(event.access as StaffAuthAccessGrant)
      ) {
        fail("bootstrap", "invalid_backend_result");
      }
      return;
    }
    if (event.kind === "signed_out") {
      transition({ kind: "signed_out", notice: null });
      return;
    }
    transition({ kind: event.kind });
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
        const epoch = beginOperation({ kind: "inspecting_invitation" });
        const operationId = allocateOperationId("invitation");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "invitation",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (
          result.kind === "invitation_rejected" &&
          (result.reason === "expired" ||
            result.reason === "invalid" ||
            result.reason === "replayed")
        ) {
          transition({ kind: "invitation_rejected", reason: result.reason });
        } else if (
          result.kind === "invitation_ready" &&
          (result.role === "admin" || result.role === "teacher") &&
          validText(result.schoolLabel, 200)
        ) {
          transition({
            kind: "invitation_ready",
            role: managedRole(result.role),
            schoolLabel: result.schoolLabel,
          });
        } else {
          rejectBoundaryResult("invitation", result);
        }
        return snapshot;
      }
      case "accept_invitation": {
        if (snapshot.kind !== "invitation_ready") {
          return snapshot;
        }
        const invitedRole = snapshot.role;
        const epoch = beginOperation({ kind: "accepting_invitation" });
        const operationId = allocateOperationId("invitation");
        if (operationId === null || !isCurrent(epoch)) {
          return snapshot;
        }
        const result = await performMutation(
          { ...action, operationId },
          epoch,
          "invitation",
        );
        if (result === null || !isCurrent(epoch)) {
          return snapshot;
        }
        if (result.kind === "access_granted") {
          if (!acceptEntry(result, invitedRole)) {
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
          if (
            !validText(result.enrollmentReceipt, 512) ||
            !isPresentation(result.presentation)
          ) {
            discardBoundaryResult(result);
            fail("totp", "invalid_backend_result");
            return snapshot;
          }
          pendingTotp = {
            ceremonyOperationId: operationId,
            enrollmentReceipt: result.enrollmentReceipt,
            identity: enrollment.identity,
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
            identity: challenge.identity,
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
        if (
          operationId === null ||
          !isRecord(response) ||
          response.operationId !== operationId ||
          !isBoundaryResult(response.result)
        ) {
          discardMutationResponse(response);
          fail("pkce_callback", "invalid_backend_result");
          return snapshot;
        }
        const result = response.result;
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
        } else if (result.kind === "email_verification_required") {
          activeIdentityKey = null;
          dependencies.protectedSchoolData.clear();
          transition({ kind: "email_verification_required" });
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
          (action.targetRole !== "admin" && action.targetRole !== "teacher")
        ) {
          return snapshot;
        }
        const targetRole = managedRole(action.targetRole);
        const epoch = beginOperation({
          kind: "creating_staff_invitation",
          targetRole,
        });
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
          const actor = validateOwnerActor(result.actor);
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
          transition({ kind: "staff_invitation_rejected" });
        } else if (!applyAccessLoss(result)) {
          rejectBoundaryResult("staff_invitation", result);
        }
        return snapshot;
      }
      case "revoke_staff_membership": {
        if (
          snapshot.kind !== "authenticated" ||
          snapshot.assuranceLevel !== "aal2" ||
          snapshot.identity.membership.role !== "owner" ||
          (action.targetRole !== "admin" && action.targetRole !== "teacher")
        ) {
          return snapshot;
        }
        const operationId = allocateOperationId("staff_membership");
        if (operationId === null) {
          return snapshot;
        }
        await executeRevokeMembership({ ...action, operationId });
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
      clearTotpCeremony();
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
  return typeof value === "object" && value !== null;
}

function isBoundaryResult(value: unknown): value is StaffAuthBoundaryResult {
  return isRecord(value) && typeof value.kind === "string";
}

function validText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function isPresentation(value: unknown): value is TotpEnrollmentPresentation {
  if (
    !isRecord(value) ||
    typeof value.blobUrl !== "string" ||
    value.blobUrl.length > 2048 ||
    typeof value.revoke !== "function"
  ) {
    return false;
  }
  try {
    return new URL(value.blobUrl).protocol === "blob:";
  } catch {
    return false;
  }
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
