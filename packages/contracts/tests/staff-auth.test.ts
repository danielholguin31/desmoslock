import { describe, expect, it } from "vitest";

import {
  parseAcceptStaffInvitationRequest,
  parseCreateStaffInvitationRequest,
  parseRequestStaffPasswordRecoveryRequest,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffMembershipRequest,
  parseSelectStaffSchoolRequest,
  parseStaffAuthResponse,
  staffAuthErrorCodes,
  staffAuthSuccessCodes,
} from "../src/index.js";

const alphaSchoolId = "10000000-0000-4000-8000-000000000001";
const betaSchoolId = "10000000-0000-4000-8000-000000000002";
const invitationId = "20000000-0000-4000-8000-000000000001";
const membershipId = "30000000-0000-4000-8000-000000000001";

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
});
