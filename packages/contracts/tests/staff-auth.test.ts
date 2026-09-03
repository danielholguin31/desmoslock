import { describe, expect, it } from "vitest";

import { toPersistedStaffRole } from "@desmoslock/domain";

import type { StaffAuthWireSuccessCode } from "../src/index.js";
import {
  mapCreateStaffInvitationInternalResult,
  mapStaffAuthInternalFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseCreateStaffInvitationRequest,
  parseCreateStaffInvitationResponse,
  parsePublicStaffAuthConfiguration,
  parseRequestStaffPasswordRecoveryRequest,
  parseRequestStaffPasswordRecoveryResponse,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipRequest,
  parseRevokeStaffMembershipResponse,
  parseSelectStaffSchoolRequest,
  parseSelectStaffSchoolResponse,
  parseStaffEmailVerificationResponse,
  parseStaffLoginResponse,
  staffAuthErrorCodes,
  staffAuthProviderFailureCodes,
  staffAuthRpcFailureCodes,
  staffAuthWireSuccessCodes,
} from "../src/index.js";

const alphaSchoolId = "10000000-0000-4000-8000-000000000001";
const betaSchoolId = "10000000-0000-4000-8000-000000000002";
const invitationId = "20000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000001";
const syntheticPublishableKey = `sb_${"publishable"}_${"r".repeat(22)}_${"c".repeat(8)}`;
const expectedWireSuccesses = {
  email_verified: true,
  invitation_accepted: true,
  invitation_created: true,
  invitation_revoked: true,
  login_succeeded: true,
  membership_revoked: true,
  recovery_requested: true,
  school_selected: true,
} as const satisfies Record<StaffAuthWireSuccessCode, true>;

describe("web-only public staff auth configuration", () => {
  it("accepts only the exact modern publishable-key grammar", () => {
    expect(
      parsePublicStaffAuthConfiguration({
        publishableKey: syntheticPublishableKey,
      }),
    ).toEqual({ publishableKey: syntheticPublishableKey });
  });

  it.each([
    `sb_${"publishable"}_${"r".repeat(21)}_${"c".repeat(8)}`,
    `sb_${"publishable"}_${"r".repeat(23)}_${"c".repeat(8)}`,
    `sb_${"publishable"}_${"r".repeat(22)}_${"c".repeat(7)}`,
    `sb_${"publishable"}_${"r".repeat(22)}_${"c".repeat(9)}`,
    `sb_${"publishable"}_${"_".repeat(22)}_${"_".repeat(8)}`,
    `sb_${"secret"}_${"r".repeat(22)}_${"c".repeat(8)}`,
    `eyJ${"x".repeat(40)}`,
    `service:${syntheticPublishableKey}`,
    `operator:${syntheticPublishableKey}`,
    `postgresql://${syntheticPublishableKey}@database.invalid/example`,
    `"${syntheticPublishableKey}"`,
    `${syntheticPublishableKey}-wrapped`,
    `sb_${"publishable"}_${`secret${"r".repeat(16)}`}_${"c".repeat(8)}`,
    `sb_${"publishable"}_${`service${"r".repeat(15)}`}_${"c".repeat(8)}`,
    `sb_${"publishable"}_${`operator${"r".repeat(14)}`}_${"c".repeat(8)}`,
    `sb_${"publishable"}_${`database${"r".repeat(14)}`}_${"c".repeat(8)}`,
  ])("rejects malformed, wrapped, or disguised key material: %s", (value) => {
    expect(
      parsePublicStaffAuthConfiguration({ publishableKey: value }),
    ).toBeNull();
  });

  it.each(["databaseUrl", "operatorCredential", "secretKey", "serviceRoleKey"])(
    "rejects the privileged field %s",
    (field) => {
      expect(
        parsePublicStaffAuthConfiguration({
          [field]: "synthetic-placeholder",
          publishableKey: syntheticPublishableKey,
        }),
      ).toBeNull();
    },
  );

  it("rejects missing and unknown public configuration fields", () => {
    expect(parsePublicStaffAuthConfiguration({})).toBeNull();
    expect(
      parsePublicStaffAuthConfiguration({
        environment: "staging",
        publishableKey: syntheticPublishableKey,
      }),
    ).toBeNull();
    expect(
      parsePublicStaffAuthConfiguration({
        publishableKey: syntheticPublishableKey,
        url: "https://synthetic-staging.supabase.co",
      }),
    ).toBeNull();
  });
});

describe("staff auth request contracts", () => {
  it("accepts an exact Administrator or Teacher invitation request", () => {
    const administratorRequest = parseCreateStaffInvitationRequest({
      email: "administrator@example.invalid",
      role: "administrator",
      schoolId: alphaSchoolId,
    });
    expect(administratorRequest).toEqual({
      email: "administrator@example.invalid",
      role: "administrator",
      schoolId: alphaSchoolId,
    });
    expect(
      administratorRequest === null
        ? null
        : toPersistedStaffRole(administratorRequest.role),
    ).toBe("admin");
    expect(
      parseCreateStaffInvitationRequest({
        email: "teacher@example.invalid",
        role: "teacher",
        schoolId: betaSchoolId,
      }),
    ).toEqual({
      email: "teacher@example.invalid",
      role: "teacher",
      schoolId: betaSchoolId,
    });
  });

  it("rejects persisted roles, Owner invitations, unknown keys, and missing keys", () => {
    expect(
      parseCreateStaffInvitationRequest({
        email: "administrator@example.invalid",
        role: "admin",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
    expect(
      parseCreateStaffInvitationRequest({
        email: "owner@example.invalid",
        role: "owner",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
    expect(
      parseCreateStaffInvitationRequest({
        email: "teacher@example.invalid",
        operator: "synthetic-placeholder",
        role: "teacher",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
    expect(
      parseCreateStaffInvitationRequest({
        email: "teacher@example.invalid",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
  });

  it.each([
    " Teacher@example.invalid",
    "Teacher@example.invalid",
    "teacher@example.invalid ",
    "teacher..name@example.invalid",
    "teacher@example",
    "teacher@-example.invalid",
  ])("rejects a noncanonical email identity: %s", (email) => {
    expect(parseRequestStaffPasswordRecoveryRequest({ email })).toBeNull();
  });

  it.each([
    "10000000-0000-0000-8000-000000000001",
    "10000000-0000-4000-0000-000000000001",
    "10000000-0000-4000-8000-00000000000Z",
    "10000000000040008000000000000001",
    "10000000-0000-4000-8000-000000000001 ",
  ])("rejects a malformed or noncanonical identifier: %s", (schoolId) => {
    expect(parseSelectStaffSchoolRequest({ schoolId })).toBeNull();
  });

  it("requires an exact, bounded display name when accepting an invitation", () => {
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "Taylor Rivera",
        invitationId,
      }),
    ).toEqual({ displayName: "Taylor Rivera", invitationId });
    expect(parseAcceptStaffInvitationRequest({ invitationId })).toBeNull();
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "Taylor Rivera",
        invitationId,
        invitationToken: "forbidden-sensitive-sentinel",
      }),
    ).toBeNull();
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: " ",
        invitationId,
      }),
    ).toBeNull();
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "x".repeat(161),
        invitationId,
      }),
    ).toBeNull();
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "x".repeat(160),
        invitationId,
      }),
    ).toEqual({ displayName: "x".repeat(160), invitationId });
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "é".repeat(81),
        invitationId,
      }),
    ).toBeNull();
    expect(
      parseAcceptStaffInvitationRequest({
        displayName: "Taylor\nRivera",
        invitationId,
      }),
    ).toBeNull();
  });

  it("parses invitation revocation as an identifier-only request", () => {
    expect(parseRevokeStaffInvitationRequest({ invitationId })).toEqual({
      invitationId,
    });
    expect(
      parseRevokeStaffInvitationRequest({
        invitationId,
        reason: "provider-specific-detail",
      }),
    ).toBeNull();
  });

  it("revokes a Profile in one School without exposing a Membership identifier", () => {
    expect(
      parseRevokeStaffMembershipRequest({
        profileId,
        schoolId: alphaSchoolId,
      }),
    ).toEqual({ profileId, schoolId: alphaSchoolId });
    expect(
      parseRevokeStaffMembershipRequest({
        membershipId: "40000000-0000-4000-8000-000000000001",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
    expect(
      parseRevokeStaffMembershipRequest({ schoolId: alphaSchoolId }),
    ).toBeNull();
    expect(
      parseRevokeStaffMembershipRequest({
        profileId,
        reason: "provider-specific-detail",
        schoolId: alphaSchoolId,
      }),
    ).toBeNull();
  });

  it("keeps School selection explicitly scoped", () => {
    expect(parseSelectStaffSchoolRequest({ schoolId: betaSchoolId })).toEqual({
      schoolId: betaSchoolId,
    });
  });

  it("parses a non-enumerating recovery request without credential fields", () => {
    expect(
      parseRequestStaffPasswordRecoveryRequest({
        email: "unknown@example.invalid",
      }),
    ).toEqual({ email: "unknown@example.invalid" });
    expect(
      parseRequestStaffPasswordRecoveryRequest({
        email: "unknown@example.invalid",
        password: "forbidden-sensitive-sentinel",
      }),
    ).toBeNull();
  });

  it("rejects arrays, inherited fields, accessors, and symbol fields", () => {
    const inherited = Object.assign(
      Object.create({ operator: "synthetic-placeholder" }) as Record<
        string,
        unknown
      >,
      { schoolId: alphaSchoolId },
    );
    const accessor = {
      get schoolId() {
        return alphaSchoolId;
      },
    };
    const symbolField = {
      schoolId: alphaSchoolId,
      [Symbol("operator")]: "synthetic-placeholder",
    };

    expect(parseSelectStaffSchoolRequest([alphaSchoolId])).toBeNull();
    expect(parseSelectStaffSchoolRequest(inherited)).toBeNull();
    expect(parseSelectStaffSchoolRequest(accessor)).toBeNull();
    expect(parseSelectStaffSchoolRequest(symbolField)).toBeNull();
  });
});

describe("operation-specific staff auth response contracts", () => {
  it("keeps domain-composite success codes outside the public wire vocabulary", () => {
    expect(staffAuthWireSuccessCodes).toEqual(
      Object.keys(expectedWireSuccesses),
    );
    expect(staffAuthWireSuccessCodes).not.toContain("recovery_completed");
    expect(staffAuthWireSuccessCodes).not.toContain("session_ended");
    expect(staffAuthWireSuccessCodes).not.toContain("step_up_verified");
  });

  it("accepts each operation's exact success", () => {
    expect(
      parseCreateStaffInvitationResponse({
        code: "invitation_created",
        ok: true,
      }),
    ).toEqual({ code: "invitation_created", ok: true });
    expect(
      parseAcceptStaffInvitationResponse({
        code: "invitation_accepted",
        ok: true,
      }),
    ).toEqual({ code: "invitation_accepted", ok: true });
    expect(
      parseRevokeStaffInvitationResponse({
        code: "invitation_revoked",
        ok: true,
      }),
    ).toEqual({ code: "invitation_revoked", ok: true });
    expect(
      parseRevokeStaffMembershipResponse({
        code: "membership_revoked",
        ok: true,
      }),
    ).toEqual({ code: "membership_revoked", ok: true });
    expect(
      parseRequestStaffPasswordRecoveryResponse({
        code: "recovery_requested",
        ok: true,
      }),
    ).toEqual({ code: "recovery_requested", ok: true });
    expect(
      parseSelectStaffSchoolResponse({ code: "school_selected", ok: true }),
    ).toEqual({ code: "school_selected", ok: true });
    expect(
      parseStaffLoginResponse({ code: "login_succeeded", ok: true }),
    ).toEqual({ code: "login_succeeded", ok: true });
    expect(
      parseStaffEmailVerificationResponse({ code: "email_verified", ok: true }),
    ).toEqual({ code: "email_verified", ok: true });
  });

  it.each(staffAuthErrorCodes)(
    "accepts create-invitation product error %s",
    (code) => {
      expect(parseCreateStaffInvitationResponse({ code, ok: false })).toEqual({
        code,
        ok: false,
      });
    },
  );

  it("accepts only the documented failures for each remaining operation", () => {
    const cases = [
      [
        parseAcceptStaffInvitationResponse,
        [
          "authentication_required",
          "authorization_denied",
          "existing_confirmed_user_unsupported",
          "invalid_request",
          "invitation_expired",
          "invitation_not_found",
          "rate_limited",
          "service_unavailable",
          "session_expired",
          "session_revoked",
          "step_up_required",
        ],
      ],
      [
        parseRevokeStaffInvitationResponse,
        [
          "authentication_required",
          "authorization_denied",
          "invalid_request",
          "invitation_expired",
          "invitation_not_found",
          "rate_limited",
          "service_unavailable",
          "session_expired",
          "session_revoked",
          "step_up_required",
        ],
      ],
      [
        parseRevokeStaffMembershipResponse,
        [
          "authentication_required",
          "authorization_denied",
          "invalid_request",
          "rate_limited",
          "service_unavailable",
          "session_expired",
          "session_revoked",
          "step_up_required",
        ],
      ],
      [
        parseSelectStaffSchoolResponse,
        [
          "authentication_required",
          "authorization_denied",
          "invalid_request",
          "service_unavailable",
          "session_expired",
          "session_revoked",
        ],
      ],
      [
        parseStaffLoginResponse,
        [
          "authorization_denied",
          "invalid_request",
          "rate_limited",
          "service_unavailable",
        ],
      ],
      [
        parseStaffEmailVerificationResponse,
        [
          "authorization_denied",
          "invalid_request",
          "rate_limited",
          "service_unavailable",
        ],
      ],
    ] as const;

    for (const [parse, errorCodes] of cases) {
      for (const code of errorCodes) {
        expect(parse({ code, ok: false })).toEqual({ code, ok: false });
      }
    }

    expect(
      parseAcceptStaffInvitationResponse({
        code: "step_up_required",
        ok: false,
      }),
    ).toEqual({ code: "step_up_required", ok: false });
    expect(
      parseRevokeStaffMembershipResponse({
        code: "invitation_expired",
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseSelectStaffSchoolResponse({ code: "rate_limited", ok: false }),
    ).toBeNull();
    expect(
      parseStaffLoginResponse({ code: "session_expired", ok: false }),
    ).toBeNull();
    expect(
      parseStaffEmailVerificationResponse({
        code: "authentication_required",
        ok: false,
      }),
    ).toBeNull();
  });

  it("keeps recovery non-enumerating while preserving retry failures", () => {
    expect(
      parseRequestStaffPasswordRecoveryResponse({
        code: "recovery_requested",
        ok: true,
      }),
    ).toEqual({ code: "recovery_requested", ok: true });
    expect(
      parseRequestStaffPasswordRecoveryResponse({
        code: "rate_limited",
        ok: false,
      }),
    ).toEqual({ code: "rate_limited", ok: false });
    expect(
      parseRequestStaffPasswordRecoveryResponse({
        code: "service_unavailable",
        ok: false,
      }),
    ).toEqual({ code: "service_unavailable", ok: false });
    expect(
      parseRequestStaffPasswordRecoveryResponse({
        code: "authorization_denied",
        ok: false,
      }),
    ).toBeNull();
  });

  it("rejects missing or extra keys, ok/code mismatches, and wrong-operation codes", () => {
    expect(
      parseCreateStaffInvitationResponse({ code: "invitation_created" }),
    ).toBeNull();
    expect(parseCreateStaffInvitationResponse({ ok: true })).toBeNull();
    expect(
      parseCreateStaffInvitationResponse({
        code: "invitation_created",
        ok: true,
        providerDetail: "forbidden-sensitive-sentinel",
      }),
    ).toBeNull();
    expect(
      parseCreateStaffInvitationResponse({
        code: "invitation_created",
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseCreateStaffInvitationResponse({ code: "invalid_request", ok: true }),
    ).toBeNull();
    expect(
      parseAcceptStaffInvitationResponse({
        code: "invitation_created",
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseStaffLoginResponse({ code: "email_verified", ok: true }),
    ).toBeNull();
    expect(
      parseRevokeStaffInvitationResponse({
        code: "membership_revoked",
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseRevokeStaffInvitationResponse({
        code: "invitation_consumed",
        ok: false,
      }),
    ).toBeNull();
  });

  it("snapshots descriptor values instead of rereading a time-varying Proxy", () => {
    let propertyReads = 0;
    const source = { code: "invitation_created", ok: true };
    const timeVarying = new Proxy(source, {
      get(target, property, receiver) {
        propertyReads += 1;
        if (property === "code") return "provider_specific_failure";
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const parsed = parseCreateStaffInvitationResponse(timeVarying);
    source.code = "login_succeeded";

    expect(parsed).toEqual({ code: "invitation_created", ok: true });
    expect(propertyReads).toBe(0);
  });
});

describe("internal staff auth result mapping", () => {
  const rpcMappings = [
    ["conflict", "service_unavailable"],
    ["dependency_unavailable", "service_unavailable"],
    ["email_unverified", "authorization_denied"],
    ["forbidden", "authorization_denied"],
    ["invalid_request", "invalid_request"],
    ["invitation_consumed", "invitation_not_found"],
    ["invitation_expired", "invitation_expired"],
    ["invitation_not_found", "invitation_not_found"],
    ["membership_inactive", "authorization_denied"],
    ["rate_limited", "rate_limited"],
    ["session_expired", "session_expired"],
    ["session_revoked", "session_revoked"],
    ["step_up_required", "step_up_required"],
    ["unauthenticated", "authentication_required"],
    ["unknown", "service_unavailable"],
  ] as const;
  const providerMappings = [
    ["dependency_unavailable", "service_unavailable"],
    ["existing_user_conflict", "existing_confirmed_user_unsupported"],
    ["rate_limited", "rate_limited"],
    ["unknown", "service_unavailable"],
  ] as const;

  it("exhaustively translates detailed RPC outcomes to product failures", () => {
    expect(staffAuthRpcFailureCodes).toEqual(
      rpcMappings.map(([internalCode]) => internalCode),
    );
    for (const [internalCode, productCode] of rpcMappings) {
      expect(
        mapStaffAuthInternalFailure({
          code: internalCode,
          source: "rpc",
        }),
      ).toEqual({ code: productCode, ok: false });
    }
  });

  it("exhaustively translates provider outcomes without leaking provider terms", () => {
    expect(staffAuthProviderFailureCodes).toEqual(
      providerMappings.map(([internalCode]) => internalCode),
    );
    for (const [internalCode, productCode] of providerMappings) {
      expect(
        mapStaffAuthInternalFailure({
          code: internalCode,
          source: "provider",
        }),
      ).toEqual({ code: productCode, ok: false });
    }
  });

  it("publishes create success only after the invitation becomes usable", () => {
    expect(
      mapCreateStaffInvitationInternalResult({
        code: "invitation_usable",
        ok: true,
      }),
    ).toEqual({ code: "invitation_created", ok: true });
    expect(
      mapCreateStaffInvitationInternalResult({
        code: "existing_user_conflict",
        ok: false,
        source: "provider",
      }),
    ).toEqual({ code: "existing_confirmed_user_unsupported", ok: false });
  });
});
