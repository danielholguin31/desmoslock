import { describe, expect, it } from "vitest";

import {
  parseAcceptStaffInvitationRequest,
  parseCreateStaffInvitationRequest,
  parsePublicStaffAuthConfiguration,
  parseRequestStaffPasswordRecoveryRequest,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipRequest,
  parseSelectStaffSchoolRequest,
  parseSelectStaffSchoolResponse,
  parseStaffAuthResponse,
  parseStaffEmailVerificationResponse,
  parseStaffLoginResponse,
  staffAuthErrorCodes,
  staffAuthSuccessCodes,
} from "../src/index.js";

const alphaSchoolId = "10000000-0000-4000-8000-000000000001";
const betaSchoolId = "10000000-0000-4000-8000-000000000002";
const invitationId = "20000000-0000-4000-8000-000000000001";
const membershipId = "30000000-0000-4000-8000-000000000001";
const syntheticPublishableKey = `sb_${"publishable"}_${"r".repeat(22)}_${"c".repeat(8)}`;

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
    expect(
      parseCreateStaffInvitationRequest({
        email: "administrator@example.invalid",
        role: "administrator",
        schoolId: alphaSchoolId,
      }),
    ).toEqual({
      email: "administrator@example.invalid",
      role: "administrator",
      schoolId: alphaSchoolId,
    });
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

  it("rejects Owner invitations, unknown keys, and missing keys", () => {
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

  it("parses invitation acceptance without accepting a bearer value", () => {
    expect(parseAcceptStaffInvitationRequest({ invitationId })).toEqual({
      invitationId,
    });
    expect(
      parseAcceptStaffInvitationRequest({
        invitationId,
        invitationToken: "forbidden-sensitive-sentinel",
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

  it("keeps Membership revocation and School selection explicitly scoped", () => {
    expect(
      parseRevokeStaffMembershipRequest({
        membershipId,
        schoolId: alphaSchoolId,
      }),
    ).toEqual({ membershipId, schoolId: alphaSchoolId });
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

describe("staff auth response contract", () => {
  it.each(staffAuthSuccessCodes)(
    "accepts the stable success code %s",
    (code) => {
      expect(parseStaffAuthResponse({ code, ok: true })).toEqual({
        code,
        ok: true,
      });
    },
  );

  it.each(staffAuthErrorCodes)("accepts the stable error code %s", (code) => {
    expect(parseStaffAuthResponse({ code, ok: false })).toEqual({
      code,
      ok: false,
    });
  });

  it("rejects success/error mismatches and unknown provider codes", () => {
    expect(
      parseStaffAuthResponse({ code: "invitation_created", ok: false }),
    ).toBeNull();
    expect(
      parseStaffAuthResponse({ code: "authorization_denied", ok: true }),
    ).toBeNull();
    expect(
      parseStaffAuthResponse({ code: "provider_specific_failure", ok: false }),
    ).toBeNull();
  });

  it("does not admit account-existence or provider-detail leakage", () => {
    expect(
      parseStaffAuthResponse({
        accountExists: false,
        code: "recovery_requested",
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseStaffAuthResponse({
        code: "service_unavailable",
        ok: false,
        providerDetail: "forbidden-sensitive-sentinel",
      }),
    ).toBeNull();

    const publicFailure = parseStaffAuthResponse({
      code: "service_unavailable",
      ok: false,
    });
    expect(JSON.stringify(publicFailure)).not.toContain(
      "forbidden-sensitive-sentinel",
    );
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

    const parsed = parseStaffAuthResponse(timeVarying);
    source.code = "login_succeeded";

    expect(parsed).toEqual({ code: "invitation_created", ok: true });
    expect(propertyReads).toBe(0);
  });

  it("uses operation-specific visible-flow success and error codes", () => {
    expect(
      parseRevokeStaffInvitationResponse({
        code: "invitation_revoked",
        ok: true,
      }),
    ).toEqual({ code: "invitation_revoked", ok: true });
    expect(
      parseRevokeStaffInvitationResponse({
        code: "invitation_revocation_failed",
        ok: false,
      }),
    ).toEqual({ code: "invitation_revocation_failed", ok: false });
    expect(
      parseSelectStaffSchoolResponse({ code: "school_selected", ok: true }),
    ).toEqual({ code: "school_selected", ok: true });
    expect(
      parseSelectStaffSchoolResponse({
        code: "school_selection_denied",
        ok: false,
      }),
    ).toEqual({ code: "school_selection_denied", ok: false });
    expect(
      parseStaffLoginResponse({ code: "login_succeeded", ok: true }),
    ).toEqual({ code: "login_succeeded", ok: true });
    expect(
      parseStaffLoginResponse({ code: "login_failed", ok: false }),
    ).toEqual({ code: "login_failed", ok: false });
    expect(
      parseStaffEmailVerificationResponse({ code: "email_verified", ok: true }),
    ).toEqual({ code: "email_verified", ok: true });
    expect(
      parseStaffEmailVerificationResponse({
        code: "email_verification_failed",
        ok: false,
      }),
    ).toEqual({ code: "email_verification_failed", ok: false });
  });

  it("rejects a valid code from the wrong visible flow", () => {
    expect(
      parseStaffLoginResponse({ code: "email_verified", ok: true }),
    ).toBeNull();
    expect(
      parseRevokeStaffInvitationResponse({
        code: "invitation_link_revoked",
        ok: false,
      }),
    ).toBeNull();
  });
});
