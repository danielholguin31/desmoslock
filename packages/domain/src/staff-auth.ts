export const persistedStaffRoles = ["owner", "admin", "teacher"] as const;

export type PersistedStaffRole = (typeof persistedStaffRoles)[number];

export const productStaffRoles = ["owner", "administrator", "teacher"] as const;

export type ProductStaffRole = (typeof productStaffRoles)[number];

export type InvitableStaffRole = Exclude<ProductStaffRole, "owner">;

export const staffAuthClientSurfaces = ["web"] as const;

export type StaffAuthClientSurface = (typeof staffAuthClientSurfaces)[number];

export function isSupportedStaffAuthClientSurface(
  value: unknown,
): value is StaffAuthClientSurface {
  return value === "web";
}

export const staffAuthSuccessCodes = [
  "invitation_accepted",
  "invitation_created",
  "membership_revoked",
  "recovery_completed",
  "recovery_requested",
  "session_ended",
  "step_up_verified",
] as const;

export type StaffAuthSuccessCode = (typeof staffAuthSuccessCodes)[number];

export const staffAuthErrorCodes = [
  "authentication_required",
  "authorization_denied",
  "existing_confirmed_user_unsupported",
  "identity_mismatch",
  "invalid_request",
  "invitation_already_accepted",
  "invitation_expired",
  "invitation_not_found",
  "invitation_owner_role_unsupported",
  "invitation_revoked",
  "membership_already_active",
  "membership_not_found",
  "membership_removed",
  "membership_school_scope_mismatch",
  "recovery_link_invalid_or_expired",
  "removed_member_reactivation_unsupported",
  "service_unavailable",
  "session_expired",
  "session_logged_out",
  "session_revoked",
  "step_up_required",
] as const;

export type StaffAuthErrorCode = (typeof staffAuthErrorCodes)[number];

export interface StaffAuthSuccess<
  Code extends StaffAuthSuccessCode = StaffAuthSuccessCode,
> {
  readonly code: Code;
  readonly ok: true;
}

export interface StaffAuthFailure<
  Code extends StaffAuthErrorCode = StaffAuthErrorCode,
> {
  readonly code: Code;
  readonly ok: false;
}

const persistedToProductRole = {
  admin: "administrator",
  owner: "owner",
  teacher: "teacher",
} as const satisfies Record<PersistedStaffRole, ProductStaffRole>;

const productToPersistedRole = {
  administrator: "admin",
  owner: "owner",
  teacher: "teacher",
} as const satisfies Record<ProductStaffRole, PersistedStaffRole>;

export function toProductStaffRole(role: PersistedStaffRole): ProductStaffRole {
  return persistedToProductRole[role];
}

export function toPersistedStaffRole(
  role: ProductStaffRole,
): PersistedStaffRole {
  return productToPersistedRole[role];
}

export function authorizeStaffInvitation(input: {
  readonly actorMembershipStatus: "active" | "suspended" | "removed";
  readonly actorRole: ProductStaffRole;
  readonly targetRole: ProductStaffRole;
}):
  | StaffAuthSuccess<"invitation_created">
  | StaffAuthFailure<
      "authorization_denied" | "invitation_owner_role_unsupported"
    > {
  if (
    input.actorMembershipStatus !== "active" ||
    input.actorRole === "teacher"
  ) {
    return { code: "authorization_denied", ok: false };
  }

  if (input.targetRole === "owner") {
    return { code: "invitation_owner_role_unsupported", ok: false };
  }

  return { code: "invitation_created", ok: true };
}

export type StaffInvitationState =
  "pending" | "accepted" | "revoked" | "expired";

export function closeStaffInvitation(
  state: StaffInvitationState,
  reason: "expiry" | "revocation",
): { readonly changed: boolean; readonly state: StaffInvitationState } {
  if (state !== "pending") return { changed: false, state };

  return {
    changed: true,
    state: reason === "expiry" ? "expired" : "revoked",
  };
}

export type StaffInvitationAccountLinkage =
  "invited_identity" | "existing_confirmed_user";

export type StaffInvitationMembershipState = "absent" | "active" | "removed";

export type StaffInvitationAcceptanceResult =
  | (StaffAuthSuccess<"invitation_accepted"> & {
      readonly invitationState: "accepted";
      readonly membershipState: "active";
    })
  | (StaffAuthFailure<
      | "existing_confirmed_user_unsupported"
      | "identity_mismatch"
      | "invitation_already_accepted"
      | "invitation_expired"
      | "invitation_revoked"
      | "membership_already_active"
      | "removed_member_reactivation_unsupported"
    > & {
      readonly invitationState: StaffInvitationState;
      readonly membershipState: StaffInvitationMembershipState;
    });

export function acceptStaffInvitation(input: {
  readonly accountLinkage: StaffInvitationAccountLinkage;
  readonly identityMatches: boolean;
  readonly invitationState: StaffInvitationState;
  readonly membershipState: StaffInvitationMembershipState;
}): StaffInvitationAcceptanceResult {
  const unchanged = {
    invitationState: input.invitationState,
    membershipState: input.membershipState,
  } as const;

  if (!input.identityMatches) {
    return { ...unchanged, code: "identity_mismatch", ok: false };
  }

  if (input.invitationState === "accepted") {
    return {
      ...unchanged,
      code: "invitation_already_accepted",
      ok: false,
    };
  }
  if (input.invitationState === "expired") {
    return { ...unchanged, code: "invitation_expired", ok: false };
  }
  if (input.invitationState === "revoked") {
    return { ...unchanged, code: "invitation_revoked", ok: false };
  }

  if (input.accountLinkage === "existing_confirmed_user") {
    return {
      ...unchanged,
      code: "existing_confirmed_user_unsupported",
      ok: false,
    };
  }
  if (input.membershipState === "active") {
    return { ...unchanged, code: "membership_already_active", ok: false };
  }
  if (input.membershipState === "removed") {
    return {
      ...unchanged,
      code: "removed_member_reactivation_unsupported",
      ok: false,
    };
  }

  return {
    code: "invitation_accepted",
    invitationState: "accepted",
    membershipState: "active",
    ok: true,
  };
}

export type StaffApplicationSessionState =
  "active" | "logged_out" | "expired" | "revoked";

export type StaffSessionEndReason = "logout" | "expiry" | "revocation";

export type StaffSessionTransitionResult =
  | (StaffAuthSuccess<"session_ended"> & {
      readonly state: Exclude<StaffApplicationSessionState, "active">;
    })
  | (StaffAuthFailure<
      "session_expired" | "session_logged_out" | "session_revoked"
    > & {
      readonly state: Exclude<StaffApplicationSessionState, "active">;
    });

const terminalSessionCode = {
  expired: "session_expired",
  logged_out: "session_logged_out",
  revoked: "session_revoked",
} as const;

const endReasonState = {
  expiry: "expired",
  logout: "logged_out",
  revocation: "revoked",
} as const satisfies Record<
  StaffSessionEndReason,
  Exclude<StaffApplicationSessionState, "active">
>;

export function endStaffApplicationSession(
  state: StaffApplicationSessionState,
  reason: StaffSessionEndReason,
): StaffSessionTransitionResult {
  if (state !== "active") {
    return { code: terminalSessionCode[state], ok: false, state };
  }

  return { code: "session_ended", ok: true, state: endReasonState[reason] };
}

export interface StaffApplicationSession {
  readonly id: string;
  readonly state: StaffApplicationSessionState;
}

export function revokeAllStaffApplicationSessions(
  sessions: readonly StaffApplicationSession[],
): readonly StaffApplicationSession[] {
  return sessions.map((session) => ({ ...session, state: "revoked" }));
}

export type StaffPasswordRecoveryState =
  "pending" | "completed" | "expired" | "revoked";

export function requestStaffPasswordRecovery(input: {
  readonly accountExists: boolean;
}): StaffAuthSuccess<"recovery_requested"> {
  void input.accountExists;
  return { code: "recovery_requested", ok: true };
}

export type StaffPasswordRecoveryResult =
  | (StaffAuthSuccess<"recovery_completed"> & {
      readonly sessions: readonly StaffApplicationSession[];
      readonly state: "completed";
    })
  | (StaffAuthFailure<"recovery_link_invalid_or_expired"> & {
      readonly sessions: readonly StaffApplicationSession[];
      readonly state: StaffPasswordRecoveryState;
    });

export function completeStaffPasswordRecovery(input: {
  readonly sessions: readonly StaffApplicationSession[];
  readonly state: StaffPasswordRecoveryState;
}): StaffPasswordRecoveryResult {
  if (input.state !== "pending") {
    return {
      code: "recovery_link_invalid_or_expired",
      ok: false,
      sessions: input.sessions,
      state: input.state,
    };
  }

  return {
    code: "recovery_completed",
    ok: true,
    sessions: revokeAllStaffApplicationSessions(input.sessions),
    state: "completed",
  };
}

export interface StaffMembershipReference {
  readonly id: string;
  readonly schoolId: string;
  readonly status: "active" | "suspended" | "removed";
}

export type StaffMembershipRevocationResult =
  | (StaffAuthSuccess<"membership_revoked"> & {
      readonly memberships: readonly StaffMembershipReference[];
    })
  | (StaffAuthFailure<
      | "membership_not_found"
      | "membership_removed"
      | "membership_school_scope_mismatch"
    > & {
      readonly memberships: readonly StaffMembershipReference[];
    });

export function revokeStaffMembershipInSchool(
  memberships: readonly StaffMembershipReference[],
  input: {
    readonly membershipId: string;
    readonly schoolId: string;
  },
): StaffMembershipRevocationResult {
  const membership = memberships.find(
    (candidate) => candidate.id === input.membershipId,
  );
  if (membership === undefined) {
    return { code: "membership_not_found", memberships, ok: false };
  }
  if (membership.schoolId !== input.schoolId) {
    return {
      code: "membership_school_scope_mismatch",
      memberships,
      ok: false,
    };
  }
  if (membership.status === "removed") {
    return { code: "membership_removed", memberships, ok: false };
  }

  return {
    code: "membership_revoked",
    memberships: memberships.map((candidate) =>
      candidate.id === input.membershipId
        ? { ...candidate, status: "removed" }
        : candidate,
    ),
    ok: true,
  };
}

export interface StaffMutationStepUp {
  readonly assuranceLevel: "aal1" | "aal2";
  readonly factorStatus: "unverified" | "verified" | null;
  readonly factorType: "totp" | null;
  readonly isCurrentSession: boolean;
}

export function verifyStaffMutationStepUp(
  stepUp: StaffMutationStepUp,
): StaffAuthSuccess<"step_up_verified"> | StaffAuthFailure<"step_up_required"> {
  if (
    stepUp.assuranceLevel !== "aal2" ||
    stepUp.factorType !== "totp" ||
    stepUp.factorStatus !== "verified" ||
    !stepUp.isCurrentSession
  ) {
    return { code: "step_up_required", ok: false };
  }

  return { code: "step_up_verified", ok: true };
}
