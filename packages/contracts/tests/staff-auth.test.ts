import { describe, expect, it } from "vitest";

import { toPersistedStaffRole } from "@desmoslock/domain";

import type { StaffAuthWireSuccessCode } from "../src/index.js";
import {
  STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS,
  mapCreateStaffInvitationInternalResult,
  mapCurrentManageableStaffInvitationsRpcRows,
  mapCurrentManageableStaffRpcRows,
  mapRequestStaffPasswordRecoveryInternalResult,
  mapStaffPasswordRecoveryRpcFailure,
  mapStaffAuthInternalFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseCreateStaffInvitationRequest,
  parseCreateStaffInvitationResponse,
  parseBeginStaffPasswordRecoveryOperationRequest,
  parseBeginStaffPasswordRecoveryRpcResult,
  parseFinishStaffPasswordRecoveryOperationRequest,
  parseFinishStaffPasswordRecoveryRpcResult,
  parseManageableStaffInvitationListResponse,
  parseManageableStaffListResponse,
  parsePublicStaffAuthConfiguration,
  parseRequestStaffPasswordRecoveryRequest,
  parseRequestStaffPasswordRecoveryResponse,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipRequest,
  parseRevokeStaffMembershipResponse,
  parseSelectStaffSchoolRequest,
  parseSelectStaffSchoolResponse,
  parseStaffDisplayName,
  parseStaffEmailVerificationResponse,
  parseStaffLoginResponse,
  parseStaffPasswordRecoveryCompletionResponse,
  staffAuthErrorCodes,
  staffAuthProviderFailureCodes,
  staffAuthRpcFailureCodes,
  staffAuthWireSuccessCodes,
  staffPasswordRecoveryDownstreamOutcomes,
  staffPasswordRecoveryRpcFailureCodes,
} from "../src/index.js";

const alphaSchoolId = "10000000-0000-4000-8000-000000000001";
const betaSchoolId = "10000000-0000-4000-8000-000000000002";
const invitationId = "20000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000001";
const secondProfileId = "30000000-0000-4000-8000-000000000002";
const secondInvitationId = "20000000-0000-4000-8000-000000000002";
const recoveryCodeChallenge = "c".repeat(43);
const recoveryFlowId = "f".repeat(22);
const recoveryOperationId = "50000000-0000-4000-8000-000000000001";
const recoveryState = "s".repeat(43);
const syntheticPublishableKey = `sb_${"publishable"}_${"r".repeat(22)}_${"c".repeat(8)}`;
const expectedWireSuccesses = {
  email_verified: true,
  invitation_accepted: true,
  invitation_created: true,
  invitation_revoked: true,
  login_succeeded: true,
  manageable_invitations_listed: true,
  manageable_staff_listed: true,
  membership_revoked: true,
  recovery_completed: true,
  recovery_requested: true,
  school_selected: true,
} as const satisfies Record<StaffAuthWireSuccessCode, true>;

function manageableStaffRpcRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    code: "ok",
    display_name: "Taylor Rivera",
    email: "taylor@example.invalid",
    membership_role: "admin",
    profile_id: profileId,
    school_id: alphaSchoolId,
    ...overrides,
  };
}

function manageableInvitationRpcRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    code: "ok",
    expires_at: "2026-09-04T16:30:00.123456+00:00",
    invitation_id: invitationId,
    invitation_status: "pending_acceptance",
    invited_email: "teacher@example.invalid",
    invited_role: "teacher",
    school_id: alphaSchoolId,
    ...overrides,
  };
}

function managementFailureRow(
  code: string,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries([
    ["code", code],
    ...fields.map((field) => [field, null] as const),
  ]);
}

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
    expect(
      parseRequestStaffPasswordRecoveryRequest({
        codeChallenge: recoveryCodeChallenge,
        email,
        flowId: recoveryFlowId,
        state: recoveryState,
      }),
    ).toBeNull();
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
    expect(parseStaffDisplayName("Taylor Rivera")).toBe("Taylor Rivera");
    expect(parseStaffDisplayName(" Taylor Rivera ")).toBeNull();
    expect(parseStaffDisplayName("Taylor\nRivera")).toBeNull();
    expect(parseStaffDisplayName("é".repeat(81))).toBeNull();
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
        codeChallenge: recoveryCodeChallenge,
        email: "unknown@example.invalid",
        flowId: recoveryFlowId,
        state: recoveryState,
      }),
    ).toEqual({
      codeChallenge: recoveryCodeChallenge,
      email: "unknown@example.invalid",
      flowId: recoveryFlowId,
      state: recoveryState,
    });
    expect(
      parseRequestStaffPasswordRecoveryRequest({
        codeChallenge: recoveryCodeChallenge,
        email: "unknown@example.invalid",
        flowId: recoveryFlowId,
        password: "forbidden-sensitive-sentinel",
        state: recoveryState,
      }),
    ).toBeNull();
  });

  it("requires exact transient PKCE request bindings without a verifier", () => {
    const valid = {
      codeChallenge: recoveryCodeChallenge,
      email: "unknown@example.invalid",
      flowId: recoveryFlowId,
      state: recoveryState,
    };

    for (const request of [
      { ...valid, flowId: "f".repeat(21) },
      { ...valid, flowId: "f".repeat(23) },
      { ...valid, flowId: `${"f".repeat(21)}=` },
      { ...valid, state: "s".repeat(42) },
      { ...valid, state: "s".repeat(44) },
      { ...valid, state: `${"s".repeat(42)}/` },
      { ...valid, codeChallenge: "c".repeat(42) },
      { ...valid, codeChallenge: "c".repeat(44) },
      { ...valid, codeChallenge: `${"c".repeat(42)}+` },
      { ...valid, verifier: "v".repeat(43) },
      {
        codeChallenge: recoveryCodeChallenge,
        email: "unknown@example.invalid",
        flowId: recoveryFlowId,
      },
    ]) {
      expect(parseRequestStaffPasswordRecoveryRequest(request)).toBeNull();
    }
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

describe("password-recovery operation contracts", () => {
  const recoveryFailures = [
    ["conflict", "service_unavailable"],
    ["email_unverified", "authorization_denied"],
    ["forbidden", "authorization_denied"],
    ["invalid_request", "invalid_request"],
    ["membership_inactive", "authorization_denied"],
    ["recovery_expired", "session_expired"],
    ["session_expired", "session_expired"],
    ["unauthenticated", "authentication_required"],
  ] as const;

  it("parses exact begin and finish operation identities without secrets", () => {
    expect(
      parseBeginStaffPasswordRecoveryOperationRequest({
        operationId: recoveryOperationId,
      }),
    ).toEqual({ operationId: recoveryOperationId });
    expect(
      parseFinishStaffPasswordRecoveryOperationRequest({
        operationId: recoveryOperationId,
      }),
    ).toEqual({ operationId: recoveryOperationId });
    expect(
      parseBeginStaffPasswordRecoveryOperationRequest({
        operationId: recoveryOperationId,
        verifier: "forbidden-sensitive-sentinel",
      }),
    ).toBeNull();
    expect(
      parseFinishStaffPasswordRecoveryOperationRequest({
        operationId: "not-an-operation-id",
      }),
    ).toBeNull();
  });

  it.each(["recovery_sessions_revoked", "recovery_completed"] as const)(
    "parses canonical begin success %s with its bounded operation",
    (code) => {
      expect(
        parseBeginStaffPasswordRecoveryRpcResult({
          code,
          expires_at: "2026-09-03T18:15:00.987654-04:00",
          operation_id: recoveryOperationId,
        }),
      ).toEqual({
        code,
        expiresAt: "2026-09-03T22:15:00.987Z",
        ok: true,
        operationId: recoveryOperationId,
      });
    },
  );

  it.each(recoveryFailures)(
    "parses begin failure %s and maps it to %s",
    (rpcCode, productCode) => {
      expect(
        parseBeginStaffPasswordRecoveryRpcResult({
          code: rpcCode,
          expires_at: null,
          operation_id: null,
        }),
      ).toEqual({ code: rpcCode, ok: false });
      expect(mapStaffPasswordRecoveryRpcFailure(rpcCode)).toEqual({
        code: productCode,
        ok: false,
      });
    },
  );

  it("keeps finish operation results exact and operation-specific", () => {
    expect(
      parseFinishStaffPasswordRecoveryRpcResult({
        code: "recovery_completed",
      }),
    ).toEqual({ code: "recovery_completed", ok: true });
    for (const code of [
      "conflict",
      "email_unverified",
      "forbidden",
      "invalid_request",
      "recovery_expired",
      "session_expired",
      "unauthenticated",
    ] as const) {
      expect(parseFinishStaffPasswordRecoveryRpcResult({ code })).toEqual({
        code,
        ok: false,
      });
    }
    expect(
      parseFinishStaffPasswordRecoveryRpcResult({
        code: "membership_inactive",
      }),
    ).toBeNull();
    expect(
      parseFinishStaffPasswordRecoveryRpcResult({
        code: "recovery_sessions_revoked",
      }),
    ).toBeNull();
  });

  it("rejects malformed or mixed-null DB recovery results", () => {
    expect(
      parseBeginStaffPasswordRecoveryRpcResult({
        code: "forbidden",
        expires_at: null,
        operation_id: recoveryOperationId,
      }),
    ).toBeNull();
    expect(
      parseBeginStaffPasswordRecoveryRpcResult({
        code: "recovery_sessions_revoked",
        expires_at: null,
        operation_id: recoveryOperationId,
      }),
    ).toBeNull();
    expect(
      parseBeginStaffPasswordRecoveryRpcResult({
        code: "recovery_sessions_revoked",
        expires_at: "not-a-time",
        operation_id: recoveryOperationId,
      }),
    ).toBeNull();
    expect(
      parseFinishStaffPasswordRecoveryRpcResult({
        code: "recovery_completed",
        operation_id: recoveryOperationId,
      }),
    ).toBeNull();
  });

  it("exhaustively maps internal recovery failure vocabulary", () => {
    expect(staffPasswordRecoveryRpcFailureCodes).toEqual(
      recoveryFailures.map(([code]) => code),
    );
  });

  it("parses only a secret-free composite result after adapter cleanup", () => {
    expect(
      parseStaffPasswordRecoveryCompletionResponse({
        code: "recovery_completed",
        ok: true,
      }),
    ).toEqual({ code: "recovery_completed", ok: true });
    for (const code of [
      "authentication_required",
      "authorization_denied",
      "invalid_request",
      "service_unavailable",
      "session_expired",
    ] as const) {
      expect(
        parseStaffPasswordRecoveryCompletionResponse({ code, ok: false }),
      ).toEqual({ code, ok: false });
    }
    expect(
      parseStaffPasswordRecoveryCompletionResponse({
        code: "recovery_expired",
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseStaffPasswordRecoveryCompletionResponse({
        code: "recovery_completed",
        ok: true,
        operationId: recoveryOperationId,
      }),
    ).toBeNull();
  });
});

describe("Owner management-list contracts", () => {
  const staffFailureFields = [
    "display_name",
    "email",
    "membership_role",
    "profile_id",
    "school_id",
  ] as const;
  const invitationFailureFields = [
    "expires_at",
    "invitation_id",
    "invitation_status",
    "invited_email",
    "invited_role",
    "school_id",
  ] as const;
  const failureMappings = [
    ["unauthenticated", "authentication_required"],
    ["email_unverified", "authorization_denied"],
    ["session_expired", "session_expired"],
    ["session_revoked", "session_revoked"],
    ["step_up_required", "step_up_required"],
    ["membership_inactive", "authorization_denied"],
    ["forbidden", "authorization_denied"],
  ] as const;

  it("maps authoritative staff rows to product identities and roles", () => {
    const mapped = mapCurrentManageableStaffRpcRows([
      manageableStaffRpcRow(),
      manageableStaffRpcRow({
        membership_role: "teacher",
        school_id: betaSchoolId,
      }),
      manageableStaffRpcRow({
        display_name: "Morgan Lee",
        email: "morgan@example.invalid",
        membership_role: "teacher",
        profile_id: secondProfileId,
      }),
    ]);

    expect(mapped).toEqual({
      code: "manageable_staff_listed",
      items: [
        {
          displayName: "Taylor Rivera",
          email: "taylor@example.invalid",
          profileId,
          role: "administrator",
          schoolId: alphaSchoolId,
        },
        {
          displayName: "Taylor Rivera",
          email: "taylor@example.invalid",
          profileId,
          role: "teacher",
          schoolId: betaSchoolId,
        },
        {
          displayName: "Morgan Lee",
          email: "morgan@example.invalid",
          profileId: secondProfileId,
          role: "teacher",
          schoolId: alphaSchoolId,
        },
      ],
      ok: true,
    });
    expect(parseManageableStaffListResponse(mapped)).toEqual(mapped);
  });

  it("normalizes every revocable DB invitation state to product pending", () => {
    const mapped = mapCurrentManageableStaffInvitationsRpcRows([
      manageableInvitationRpcRow({
        invitation_status: "pending_delivery",
      }),
      manageableInvitationRpcRow({
        expires_at: "2026-09-04T12:30:00-04:00",
        invitation_id: secondInvitationId,
        invitation_status: "delivery_ready",
        invited_email: "administrator@example.invalid",
        invited_role: "admin",
      }),
      manageableInvitationRpcRow({
        expires_at: "2026-09-04T18:30:00+02:00",
        invitation_id: "20000000-0000-4000-8000-000000000003",
        invitation_status: "pending_acceptance",
        invited_email: "other@example.invalid",
        school_id: betaSchoolId,
      }),
    ]);

    expect(mapped).toEqual({
      code: "manageable_invitations_listed",
      items: [
        {
          email: "teacher@example.invalid",
          expiresAt: "2026-09-04T16:30:00.123Z",
          invitationId,
          role: "teacher",
          schoolId: alphaSchoolId,
          state: "pending",
        },
        {
          email: "administrator@example.invalid",
          expiresAt: "2026-09-04T16:30:00.000Z",
          invitationId: secondInvitationId,
          role: "administrator",
          schoolId: alphaSchoolId,
          state: "pending",
        },
        {
          email: "other@example.invalid",
          expiresAt: "2026-09-04T16:30:00.000Z",
          invitationId: "20000000-0000-4000-8000-000000000003",
          role: "teacher",
          schoolId: betaSchoolId,
          state: "pending",
        },
      ],
      ok: true,
    });
    expect(parseManageableStaffInvitationListResponse(mapped)).toEqual(mapped);
  });

  it.each(failureMappings)(
    "maps management RPC failure %s to product failure %s",
    (rpcCode, productCode) => {
      expect(
        mapCurrentManageableStaffRpcRows([
          managementFailureRow(rpcCode, staffFailureFields),
        ]),
      ).toEqual({ code: productCode, ok: false });
      expect(
        mapCurrentManageableStaffInvitationsRpcRows([
          managementFailureRow(rpcCode, invitationFailureFields),
        ]),
      ).toEqual({ code: productCode, ok: false });
    },
  );

  it("treats an authorized empty selector as an exact empty success", () => {
    expect(mapCurrentManageableStaffRpcRows([])).toEqual({
      code: "manageable_staff_listed",
      items: [],
      ok: true,
    });
    expect(mapCurrentManageableStaffInvitationsRpcRows([])).toEqual({
      code: "manageable_invitations_listed",
      items: [],
      ok: true,
    });
  });

  it("fails closed on mixed, malformed, privileged, or inconsistent staff rows", () => {
    const failure = managementFailureRow("forbidden", staffFailureFields);
    const invalidCases = [
      [manageableStaffRpcRow(), failure],
      [manageableStaffRpcRow({ membership_role: "owner" })],
      [manageableStaffRpcRow({ membership_role: "administrator" })],
      [manageableStaffRpcRow({ display_name: "Taylor\nRivera" })],
      [manageableStaffRpcRow({ email: "Taylor@example.invalid" })],
      [manageableStaffRpcRow({ profile_id: "not-a-profile" })],
      [manageableStaffRpcRow({ auth_user_id: "forbidden-identity" })],
      [failure, managementFailureRow("forbidden", staffFailureFields)],
      [
        {
          ...managementFailureRow("forbidden", staffFailureFields),
          email: "should-be-null@example.invalid",
        },
      ],
      [manageableStaffRpcRow(), manageableStaffRpcRow()],
      [
        manageableStaffRpcRow(),
        manageableStaffRpcRow({
          email: "different@example.invalid",
          school_id: betaSchoolId,
        }),
      ],
    ];

    for (const rows of invalidCases) {
      expect(mapCurrentManageableStaffRpcRows(rows)).toEqual({
        code: "service_unavailable",
        ok: false,
      });
    }
  });

  it("fails closed on invalid invitation identities, states, timestamps, and leakage", () => {
    const failure = managementFailureRow(
      "session_revoked",
      invitationFailureFields,
    );
    const invalidCases = [
      [manageableInvitationRpcRow(), failure],
      [manageableInvitationRpcRow({ invited_role: "owner" })],
      [manageableInvitationRpcRow({ invited_role: "administrator" })],
      [manageableInvitationRpcRow({ invitation_status: "accepted" })],
      [manageableInvitationRpcRow({ invitation_status: "revoked" })],
      [manageableInvitationRpcRow({ expires_at: "2026-02-30T12:00:00Z" })],
      [manageableInvitationRpcRow({ expires_at: "2026-09-04" })],
      [
        manageableInvitationRpcRow({
          request_key: "forbidden-sensitive-sentinel",
        }),
      ],
      [
        {
          ...managementFailureRow("forbidden", invitationFailureFields),
          invitation_id: invitationId,
        },
      ],
      [manageableInvitationRpcRow(), manageableInvitationRpcRow()],
      [
        manageableInvitationRpcRow(),
        manageableInvitationRpcRow({ invitation_id: secondInvitationId }),
      ],
    ];

    for (const rows of invalidCases) {
      expect(mapCurrentManageableStaffInvitationsRpcRows(rows)).toEqual({
        code: "service_unavailable",
        ok: false,
      });
    }
  });

  it("rejects row 501 instead of silently truncating either management list", () => {
    expect(STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS).toBe(500);
    const staffRows = Array.from(
      { length: STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS + 1 },
      (_, index) =>
        manageableStaffRpcRow({
          profile_id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
    );
    const invitationRows = Array.from(
      { length: STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS + 1 },
      (_, index) =>
        manageableInvitationRpcRow({
          invitation_id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          invited_email: `teacher-${index}@example.invalid`,
        }),
    );

    expect(mapCurrentManageableStaffRpcRows(staffRows)).toEqual({
      code: "service_unavailable",
      ok: false,
    });
    expect(mapCurrentManageableStaffInvitationsRpcRows(invitationRows)).toEqual(
      { code: "service_unavailable", ok: false },
    );
    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        items: staffRows.map((row) => ({
          displayName: row.display_name,
          email: row.email,
          profileId: row.profile_id,
          role: "administrator",
          schoolId: row.school_id,
        })),
        ok: true,
      }),
    ).toBeNull();
  });

  it("strictly parses canonical list responses without raw storage vocabulary", () => {
    const staffItem = {
      displayName: "Taylor Rivera",
      email: "taylor@example.invalid",
      profileId,
      role: "administrator",
      schoolId: alphaSchoolId,
    };
    const invitationItem = {
      email: "teacher@example.invalid",
      expiresAt: "2026-09-04T16:30:00.123Z",
      invitationId,
      role: "teacher",
      schoolId: alphaSchoolId,
      state: "pending",
    };

    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        items: [staffItem],
        ok: true,
      }),
    ).toEqual({
      code: "manageable_staff_listed",
      items: [staffItem],
      ok: true,
    });
    expect(
      parseManageableStaffInvitationListResponse({
        code: "manageable_invitations_listed",
        items: [invitationItem],
        ok: true,
      }),
    ).toEqual({
      code: "manageable_invitations_listed",
      items: [invitationItem],
      ok: true,
    });
    expect(
      parseManageableStaffListResponse({
        code: "authorization_denied",
        ok: false,
      }),
    ).toEqual({ code: "authorization_denied", ok: false });
    expect(
      parseManageableStaffInvitationListResponse({
        code: "step_up_required",
        ok: false,
      }),
    ).toEqual({ code: "step_up_required", ok: false });
    for (const code of [
      "authentication_required",
      "authorization_denied",
      "service_unavailable",
      "session_expired",
      "session_revoked",
      "step_up_required",
    ] as const) {
      expect(parseManageableStaffListResponse({ code, ok: false })).toEqual({
        code,
        ok: false,
      });
      expect(
        parseManageableStaffInvitationListResponse({ code, ok: false }),
      ).toEqual({ code, ok: false });
    }

    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        items: [{ ...staffItem, membershipId: "forbidden-storage-identity" }],
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        items: [{ ...staffItem, role: "admin" }],
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffInvitationListResponse({
        code: "manageable_invitations_listed",
        items: [
          { ...invitationItem, providerToken: "forbidden-sensitive-sentinel" },
        ],
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffListResponse({
        code: "rate_limited",
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffInvitationListResponse({
        code: "invalid_request",
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffInvitationListResponse({
        code: "manageable_invitations_listed",
        items: [{ ...invitationItem, expiresAt: "2026-09-04T12:30:00-04:00" }],
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        ok: true,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffListResponse({
        code: "manageable_staff_listed",
        items: [],
        ok: false,
      }),
    ).toBeNull();
    expect(
      parseManageableStaffInvitationListResponse({
        code: "authorization_denied",
        items: [],
        ok: false,
      }),
    ).toBeNull();
  });

  it("snapshots list and row descriptors without invoking Proxy getters", () => {
    let propertyReads = 0;
    const row = new Proxy(manageableStaffRpcRow(), {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const rows = new Proxy([row], {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(mapCurrentManageableStaffRpcRows(rows)).toEqual({
      code: "manageable_staff_listed",
      items: [
        {
          displayName: "Taylor Rivera",
          email: "taylor@example.invalid",
          profileId,
          role: "administrator",
          schoolId: alphaSchoolId,
        },
      ],
      ok: true,
    });
    expect(propertyReads).toBe(0);
  });
});

describe("operation-specific staff auth response contracts", () => {
  it("keeps non-wire domain success codes outside public vocabulary", () => {
    expect(staffAuthWireSuccessCodes).toEqual(
      Object.keys(expectedWireSuccesses),
    );
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

  it("allows only perimeter failures to select a recovery public error", () => {
    for (const code of [
      "invalid_request",
      "rate_limited",
      "service_unavailable",
    ] as const) {
      expect(
        mapRequestStaffPasswordRecoveryInternalResult({
          code,
          ok: false,
          source: "perimeter",
        }),
      ).toEqual({ code, ok: false });
    }
  });

  it.each([
    "accepted",
    "account_absent",
    "dependency_unavailable",
    "delivery_failed",
    "rate_limited",
    "rejected",
    "timed_out",
    "unknown",
  ] as const)(
    "keeps downstream recovery outcome %s enumeration-neutral",
    (outcome) => {
      expect(staffPasswordRecoveryDownstreamOutcomes).toContain(outcome);
      expect(
        mapRequestStaffPasswordRecoveryInternalResult({
          outcome,
          source: "downstream",
        }),
      ).toEqual({ code: "recovery_requested", ok: true });
    },
  );

  it("keeps the downstream recovery mapping vocabulary exhaustive", () => {
    expect(staffPasswordRecoveryDownstreamOutcomes).toEqual([
      "accepted",
      "account_absent",
      "dependency_unavailable",
      "delivery_failed",
      "rate_limited",
      "rejected",
      "timed_out",
      "unknown",
    ]);
  });
});
