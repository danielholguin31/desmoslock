import { describe, expect, it } from "vitest";

import {
  acceptStaffInvitation,
  authorizeStaffInvitation,
  closeStaffInvitation,
  completeStaffPasswordRecovery,
  endStaffApplicationSession,
  evaluateProtectedStaffSchoolAccess,
  isSupportedStaffAuthClientSurface,
  persistedStaffRoles,
  productStaffRoles,
  revokeActiveStaffApplicationSessions,
  revokeStaffMembershipInSchool,
  requestStaffPasswordRecovery,
  staffAuthClientSurfaces,
  staffAuthErrorCodes,
  staffAuthSuccessCodes,
  toPersistedStaffRole,
  toProductStaffRole,
  verifyStaffMutationStepUp,
} from "../src/index.js";

const verifiedTotp = {
  assuranceLevel: "aal2",
  evidenceSource: "signed_session_claims",
  factorStatus: "verified",
  factorType: "totp",
  isCurrentSession: true,
} as const;

describe("staff role boundary", () => {
  it("keeps staff authentication on the web surface", () => {
    expect(staffAuthClientSurfaces).toEqual(["web"]);
    expect(isSupportedStaffAuthClientSurface("web")).toBe(true);
    expect(isSupportedStaffAuthClientSurface("desktop")).toBe(false);
  });

  it("maps the persisted admin role to the administrator product role", () => {
    expect(
      persistedStaffRoles.map((role) => [role, toProductStaffRole(role)]),
    ).toEqual([
      ["owner", "owner"],
      ["admin", "administrator"],
      ["teacher", "teacher"],
    ]);
    expect(
      productStaffRoles.map((role) => [role, toPersistedStaffRole(role)]),
    ).toEqual([
      ["owner", "owner"],
      ["administrator", "admin"],
      ["teacher", "teacher"],
    ]);
  });

  it("allows only an active same-School Owner with current TOTP step-up", () => {
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "owner",
        actorSchoolId: "alpha-school",
        stepUp: verifiedTotp,
        targetSchoolId: "alpha-school",
        targetRole: "administrator",
      }),
    ).toEqual({ code: "invitation_created", ok: true });
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "administrator",
        actorSchoolId: "alpha-school",
        stepUp: verifiedTotp,
        targetSchoolId: "alpha-school",
        targetRole: "teacher",
      }),
    ).toEqual({ code: "authorization_denied", ok: false });
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "owner",
        actorSchoolId: "alpha-school",
        stepUp: verifiedTotp,
        targetSchoolId: "alpha-school",
        targetRole: "owner",
      }),
    ).toEqual({ code: "invitation_owner_role_unsupported", ok: false });
  });

  it("denies cross-School scope before considering target details", () => {
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "owner",
        actorSchoolId: "alpha-school",
        stepUp: verifiedTotp,
        targetSchoolId: "beta-school",
        targetRole: "teacher",
      }),
    ).toEqual({ code: "authorization_denied", ok: false });
  });

  it("requires signed AAL2 from the current verified TOTP factor", () => {
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "owner",
        actorSchoolId: "alpha-school",
        stepUp: { ...verifiedTotp, isCurrentSession: false },
        targetSchoolId: "alpha-school",
        targetRole: "teacher",
      }),
    ).toEqual({ code: "step_up_required", ok: false });
  });

  it("denies invitation authority to Teachers and inactive memberships", () => {
    expect(
      authorizeStaffInvitation({
        actorMembershipStatus: "active",
        actorRole: "teacher",
        actorSchoolId: "alpha-school",
        stepUp: verifiedTotp,
        targetSchoolId: "alpha-school",
        targetRole: "teacher",
      }),
    ).toEqual({ code: "authorization_denied", ok: false });

    for (const actorMembershipStatus of ["suspended", "removed"] as const) {
      expect(
        authorizeStaffInvitation({
          actorMembershipStatus,
          actorRole: "owner",
          actorSchoolId: "alpha-school",
          stepUp: verifiedTotp,
          targetSchoolId: "alpha-school",
          targetRole: "teacher",
        }),
      ).toEqual({ code: "authorization_denied", ok: false });
    }
  });
});

describe("staff invitation lifecycle", () => {
  const pendingInvitation = {
    accountLinkage: "invited_identity",
    identityMatches: true,
    invitationState: "pending",
    membershipState: "absent",
  } as const;

  it("accepts the intended invited identity exactly once", () => {
    const accepted = acceptStaffInvitation(pendingInvitation);
    expect(accepted).toEqual({
      code: "invitation_accepted",
      invitationState: "accepted",
      membershipState: "active",
      ok: true,
    });

    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        invitationState: accepted.invitationState,
        membershipState: accepted.membershipState,
      }),
    ).toEqual({
      code: "invitation_already_accepted",
      invitationState: "accepted",
      membershipState: "active",
      ok: false,
    });
  });

  it("rejects the wrong identity before changing invitation state", () => {
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        identityMatches: false,
      }),
    ).toEqual({
      code: "identity_mismatch",
      invitationState: "pending",
      membershipState: "absent",
      ok: false,
    });
  });

  it("fails closed for every terminal invitation state", () => {
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        invitationState: "accepted",
      }),
    ).toMatchObject({ code: "invitation_already_accepted", ok: false });
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        invitationState: "expired",
      }),
    ).toMatchObject({ code: "invitation_expired", ok: false });
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        invitationState: "revoked",
      }),
    ).toMatchObject({ code: "invitation_link_revoked", ok: false });
  });

  it("expires or revokes a pending invitation without replaying a terminal transition", () => {
    expect(closeStaffInvitation("pending", "expiry")).toEqual({
      changed: true,
      state: "expired",
    });
    expect(closeStaffInvitation("pending", "revocation")).toEqual({
      changed: true,
      state: "revoked",
    });
    expect(closeStaffInvitation("accepted", "revocation")).toEqual({
      changed: false,
      state: "accepted",
    });
    expect(closeStaffInvitation("expired", "revocation")).toEqual({
      changed: false,
      state: "expired",
    });
  });

  it("does not link an existing confirmed identity or reactivate a removed member", () => {
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        accountLinkage: "existing_confirmed_user",
      }),
    ).toMatchObject({
      code: "existing_confirmed_user_unsupported",
      ok: false,
    });
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        membershipState: "suspended",
      }),
    ).toMatchObject({
      code: "membership_suspended",
      ok: false,
    });
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        membershipState: "removed",
      }),
    ).toMatchObject({
      code: "removed_member_reactivation_unsupported",
      ok: false,
    });
    expect(
      acceptStaffInvitation({
        ...pendingInvitation,
        membershipState: "active",
      }),
    ).toMatchObject({ code: "membership_already_active", ok: false });
  });
});

describe("staff sessions and recovery", () => {
  it.each([
    ["logout", "logged_out"],
    ["expiry", "expired"],
    ["revocation", "revoked"],
  ] as const)("ends an active session for %s", (reason, state) => {
    expect(endStaffApplicationSession("active", reason)).toEqual({
      code: "session_ended",
      ok: true,
      state,
    });
  });

  it.each([
    ["logged_out", "session_logged_out"],
    ["expired", "session_expired"],
    ["revoked", "session_revoked"],
  ] as const)("does not replay the terminal %s transition", (state, code) => {
    expect(endStaffApplicationSession(state, "revocation")).toEqual({
      code,
      ok: false,
      state,
    });
  });

  it("revokes active application sessions while preserving terminal history", () => {
    expect(
      revokeActiveStaffApplicationSessions([
        { id: "current", state: "active" },
        { id: "older", state: "expired" },
        { id: "other-client", state: "logged_out" },
        { id: "previously-revoked", state: "revoked" },
      ]),
    ).toEqual([
      { id: "current", state: "revoked" },
      { id: "older", state: "expired" },
      { id: "other-client", state: "logged_out" },
      { id: "previously-revoked", state: "revoked" },
    ]);
  });

  it("never reveals whether a recovery identity exists", () => {
    expect(requestStaffPasswordRecovery({ accountExists: true })).toEqual({
      code: "recovery_requested",
      ok: true,
    });
    expect(requestStaffPasswordRecovery({ accountExists: false })).toEqual({
      code: "recovery_requested",
      ok: true,
    });
  });

  it("completes recovery once and revokes every active application session", () => {
    const sessions = [
      { id: "current", state: "active" },
      { id: "other-client", state: "active" },
      { id: "historical", state: "expired" },
    ] as const;
    const completed = completeStaffPasswordRecovery({
      sessions,
      state: "pending",
    });
    expect(completed).toEqual({
      code: "recovery_completed",
      ok: true,
      sessions: [
        { id: "current", state: "revoked" },
        { id: "other-client", state: "revoked" },
        { id: "historical", state: "expired" },
      ],
      state: "completed",
    });

    expect(
      completeStaffPasswordRecovery({
        sessions: completed.sessions,
        state: completed.state,
      }),
    ).toEqual({
      code: "recovery_link_invalid_or_expired",
      ok: false,
      sessions: completed.sessions,
      state: "completed",
    });
  });

  it.each(["expired", "revoked"] as const)(
    "collapses the terminal %s recovery state to one public failure",
    (state) => {
      expect(completeStaffPasswordRecovery({ sessions: [], state })).toEqual({
        code: "recovery_link_invalid_or_expired",
        ok: false,
        sessions: [],
        state,
      });
    },
  );
});

describe("School-scoped Membership revocation", () => {
  const memberships = [
    { id: "alpha-membership", schoolId: "alpha-school", status: "active" },
    { id: "beta-membership", schoolId: "beta-school", status: "active" },
  ] as const;
  const authorizedOwner = {
    actorMembershipStatus: "active",
    actorRole: "owner",
    actorSchoolId: "alpha-school",
    stepUp: verifiedTotp,
  } as const;

  it("removes only the selected School Membership", () => {
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        membershipId: "alpha-membership",
        schoolId: "alpha-school",
      }),
    ).toEqual({
      code: "membership_revoked",
      memberships: [
        {
          id: "alpha-membership",
          schoolId: "alpha-school",
          status: "removed",
        },
        {
          id: "beta-membership",
          schoolId: "beta-school",
          status: "active",
        },
      ],
      ok: true,
    });
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        actorRole: "administrator",
        membershipId: "alpha-membership",
        schoolId: "alpha-school",
      }),
    ).toMatchObject({ code: "membership_revoked", ok: true });
  });

  it("uses one denial for cross-School, absent, and unauthorized targets", () => {
    const denial = {
      code: "authorization_denied",
      memberships,
      ok: false,
    } as const;

    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        membershipId: "beta-membership",
        schoolId: "alpha-school",
      }),
    ).toEqual(denial);
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        membershipId: "absent-membership",
        schoolId: "alpha-school",
      }),
    ).toEqual(denial);
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        actorSchoolId: "beta-school",
        membershipId: "alpha-membership",
        schoolId: "alpha-school",
      }),
    ).toEqual(denial);
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        actorRole: "teacher",
        membershipId: "alpha-membership",
        schoolId: "alpha-school",
      }),
    ).toEqual(denial);
  });

  it("requires current verified TOTP step-up before target lookup", () => {
    expect(
      revokeStaffMembershipInSchool(memberships, {
        ...authorizedOwner,
        membershipId: "absent-membership",
        schoolId: "alpha-school",
        stepUp: { ...verifiedTotp, assuranceLevel: "aal1" },
      }),
    ).toEqual({ code: "step_up_required", memberships, ok: false });
  });

  it("denies the next protected request without globally ending the session", () => {
    const revoked = revokeStaffMembershipInSchool(memberships, {
      ...authorizedOwner,
      membershipId: "alpha-membership",
      schoolId: "alpha-school",
    });
    expect(revoked.ok).toBe(true);
    const alphaMembership = revoked.memberships.find(
      (membership) => membership.id === "alpha-membership",
    );

    expect(
      evaluateProtectedStaffSchoolAccess({
        membershipEvidence: "live_backend",
        membershipSchoolId: alphaMembership?.schoolId ?? null,
        membershipStatus: alphaMembership?.status ?? null,
        requestedSchoolId: "alpha-school",
        sessionState: "active",
      }),
    ).toEqual({ allowed: false, code: "authorization_denied" });
    expect(
      evaluateProtectedStaffSchoolAccess({
        membershipEvidence: "live_backend",
        membershipSchoolId: "beta-school",
        membershipStatus: "active",
        requestedSchoolId: "beta-school",
        sessionState: "active",
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateProtectedStaffSchoolAccess({
        membershipEvidence: "cached_client",
        membershipSchoolId: "beta-school",
        membershipStatus: "active",
        requestedSchoolId: "beta-school",
        sessionState: "active",
      }),
    ).toEqual({ allowed: false, code: "authorization_denied" });
  });
});

describe("privileged Membership mutation step-up", () => {
  it("requires AAL2 from a current verified TOTP factor", () => {
    expect(verifyStaffMutationStepUp(verifiedTotp)).toEqual({
      code: "step_up_verified",
      ok: true,
    });
  });

  it.each([
    { ...verifiedTotp, assuranceLevel: "aal1" as const },
    { ...verifiedTotp, evidenceSource: "untrusted_client" as const },
    { ...verifiedTotp, factorStatus: "unverified" as const },
    { ...verifiedTotp, factorType: null },
    { ...verifiedTotp, isCurrentSession: false },
  ])("fails closed when one assurance condition is absent", (stepUp) => {
    expect(verifyStaffMutationStepUp(stepUp)).toEqual({
      code: "step_up_required",
      ok: false,
    });
  });
});

describe("staff auth public code stability", () => {
  it("keeps success and error codes unique and disjoint", () => {
    expect(new Set(staffAuthSuccessCodes).size).toBe(
      staffAuthSuccessCodes.length,
    );
    expect(new Set(staffAuthErrorCodes).size).toBe(staffAuthErrorCodes.length);
    expect(
      staffAuthSuccessCodes.filter((code) =>
        (staffAuthErrorCodes as readonly string[]).includes(code),
      ),
    ).toEqual([]);
  });
});
