import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthAdapter,
  type SupabaseStaffAuthPort,
} from "../src/auth/supabase-staff-auth-adapter.js";

const firstOperationId = "10000000-0000-4000-8000-000000000001";
const secondOperationId = "10000000-0000-4000-8000-000000000002";
const accountId = "a1000000-0000-4000-8000-000000000001";
const profileId = "21000000-0000-4000-8000-000000000001";
const schoolId = "11000000-0000-4000-8000-000000000001";
const targetProfileId = "21000000-0000-4000-8000-000000000002";
const invitationId = "41000000-0000-4000-8000-000000000001";
const factorId = "51000000-0000-4000-8000-000000000001";
const challengeId = "61000000-0000-4000-8000-000000000001";

function port(
  overrides: Partial<SupabaseStaffAuthPort> = {},
): SupabaseStaffAuthPort {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected external call");
  };
  return {
    acceptInvitation: unavailable,
    beginPasswordRecovery: unavailable,
    challengeTotp: unavailable,
    enrollTotp: unavailable,
    exchangeRecoveryCode: unavailable,
    finishPasswordRecovery: unavailable,
    invokeInvitation: unavailable,
    invokeRecovery: unavailable,
    onAuthStateChange: () => () => undefined,
    readAccount: unavailable,
    readAssurance: unavailable,
    readCurrentContext: unavailable,
    readCurrentInvitations: unavailable,
    readManageableInvitations: unavailable,
    readManageableStaff: unavailable,
    readSession: async () => ({ status: "signed_out" }),
    readTotpFactors: unavailable,
    removeTotpFactor: unavailable,
    resendEmailVerification: unavailable,
    revokeAllStaffSessions: unavailable,
    revokeCurrentStaffSession: unavailable,
    revokeInvitation: unavailable,
    revokeMembership: unavailable,
    signIn: unavailable,
    signOut: unavailable,
    updatePassword: unavailable,
    verifyInvitationToken: unavailable,
    verifyTotp: unavailable,
    ...overrides,
  };
}

function ownerPort(
  overrides: Partial<SupabaseStaffAuthPort> = {},
): SupabaseStaffAuthPort {
  return port({
    readAccount: async () => ({
      accountId,
      email: "owner@example.test",
      emailVerified: true,
    }),
    readAssurance: async () => ({
      currentLevel: "aal2",
      nextLevel: "aal2",
    }),
    readCurrentContext: async () => [
      {
        code: "ok",
        display_name: "Olivia Owner",
        membership_role: "owner",
        profile_id: profileId,
        role_revision: 8,
        school_id: schoolId,
        school_name: "Example School",
        school_slug: "example-school",
      },
    ],
    readManageableInvitations: async () => [],
    readManageableStaff: async () => [],
    readSession: async () => ({ status: "authenticated" }),
    ...overrides,
  });
}

function operationIdSource(start = 1): { next(): string } {
  let sequence = start;
  return {
    next() {
      const suffix = String(sequence).padStart(12, "0");
      sequence += 1;
      return `10000000-0000-4000-8000-${suffix}`;
    },
  };
}

function encodedQr(svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>') {
  return `data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`;
}

describe("Supabase staff auth adapter", () => {
  it("reports signed-out only after the provider session boundary confirms it", async () => {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: { next: () => firstOperationId },
      port: port(),
      revokeBlobUrl: () => undefined,
    });

    await expect(adapter.read()).resolves.toEqual({ kind: "signed_out" });
    adapter.dispose();
  });

  it("builds Teacher access only from a verified account and exact live DB context", async () => {
    const identifiers = [firstOperationId, secondOperationId];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () => [
          {
            code: "ok",
            display_name: "Taylor Teacher",
            membership_role: "teacher",
            profile_id: profileId,
            role_revision: 3,
            school_id: schoolId,
            school_name: "Example School",
            school_slug: "example-school",
          },
        ],
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(adapter.read()).resolves.toEqual({
      assuranceLevel: "aal1",
      identity: {
        accountId,
        email: "teacher@example.test",
        membership: {
          id: `${schoolId}:${profileId}`,
          role: "teacher",
          status: "active",
        },
        profile: { displayName: "Taylor Teacher", id: profileId },
        school: { id: schoolId, label: "Example School" },
      },
      identityGeneration: secondOperationId,
      kind: "access_granted",
      manageableInvitations: [],
      manageableStaff: [],
      secondFactor: "satisfied",
      sessionGeneration: firstOperationId,
    });
    adapter.dispose();
  });

  it("parses all-School management RPC rows then exposes only the exact active School", async () => {
    const otherSchoolId = "11000000-0000-4000-8000-000000000002";
    const identifiers = [firstOperationId, secondOperationId];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId,
          email: "owner@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal2",
          nextLevel: "aal2",
        }),
        readCurrentContext: async () => [
          {
            code: "ok",
            display_name: "Olivia Owner",
            membership_role: "owner",
            profile_id: profileId,
            role_revision: 8,
            school_id: schoolId,
            school_name: "Example School",
            school_slug: "example-school",
          },
        ],
        readManageableInvitations: async () => [
          {
            code: "ok",
            expires_at: "2026-09-04T12:00:00+00:00",
            invitation_id: "41000000-0000-4000-8000-000000000001",
            invitation_status: "pending_acceptance",
            invited_email: "pending@example.test",
            invited_role: "admin",
            school_id: schoolId,
          },
          {
            code: "ok",
            expires_at: "2026-09-04T13:00:00+00:00",
            invitation_id: "41000000-0000-4000-8000-000000000002",
            invitation_status: "pending_delivery",
            invited_email: "other@example.test",
            invited_role: "teacher",
            school_id: otherSchoolId,
          },
        ],
        readManageableStaff: async () => [
          {
            code: "ok",
            display_name: "Ada Admin",
            email: "ada@example.test",
            membership_role: "admin",
            profile_id: "21000000-0000-4000-8000-000000000002",
            school_id: schoolId,
          },
          {
            code: "ok",
            display_name: "Theo Teacher",
            email: "theo@example.test",
            membership_role: "teacher",
            profile_id: "21000000-0000-4000-8000-000000000003",
            school_id: otherSchoolId,
          },
        ],
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });

    const result = await adapter.read();
    expect(result).toMatchObject({
      assuranceLevel: "aal2",
      kind: "access_granted",
      manageableInvitations: [
        {
          email: "pending@example.test",
          invitationId: "41000000-0000-4000-8000-000000000001",
          role: "admin",
          schoolId,
          state: "pending",
        },
      ],
      manageableStaff: [
        {
          profile: {
            displayName: "Ada Admin",
            email: "ada@example.test",
            id: "21000000-0000-4000-8000-000000000002",
          },
          role: "admin",
          schoolId,
        },
      ],
      secondFactor: "satisfied",
    });
    expect(JSON.stringify(result)).not.toContain(otherSchoolId);
    adapter.dispose();
  });

  it.each([
    {
      factors: { factors: [] },
      expected: { secondFactor: "enrollment_required" },
      label: "requires enrollment without a verified factor",
    },
    {
      factors: {
        factors: [
          {
            factorId: "51000000-0000-4000-8000-000000000001",
            status: "verified",
          },
        ],
      },
      expected: {
        challengeReceipt: "10000000-0000-4000-8000-000000000003",
        secondFactor: "challenge_required",
      },
      label: "requires a challenge for the one verified factor",
    },
  ])("$label for privileged AAL1 access", async ({ expected, factors }) => {
    const identifiers = [
      firstOperationId,
      secondOperationId,
      "10000000-0000-4000-8000-000000000003",
    ];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId,
          email: "owner@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal2",
        }),
        readCurrentContext: async () => [
          {
            code: "ok",
            display_name: "Olivia Owner",
            membership_role: "owner",
            profile_id: profileId,
            role_revision: 8,
            school_id: schoolId,
            school_name: "Example School",
            school_slug: "example-school",
          },
        ],
        readSession: async () => ({ status: "authenticated" }),
        readTotpFactors: async () => factors,
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(adapter.read()).resolves.toMatchObject({
      assuranceLevel: "aal1",
      kind: "access_granted",
      ...expected,
    });
    adapter.dispose();
  });

  it.each([
    ["rejected", { kind: "sign_in_rejected" }],
    ["email_verification_required", { kind: "email_verification_required" }],
  ] as const)(
    "maps a provider %s sign-in without exposing provider details",
    async (status, expected) => {
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: { next: () => firstOperationId },
        port: port({ signIn: async () => ({ status }) }),
        revokeBlobUrl: () => undefined,
      });

      await expect(
        adapter.perform({
          email: "staff@example.test",
          operationId: firstOperationId,
          password: "sentinel-password-not-output",
          type: "sign_in",
        }),
      ).resolves.toEqual({ operationId: firstOperationId, result: expected });
      expect(JSON.stringify(adapter)).not.toContain("sentinel-password");
      adapter.dispose();
    },
  );

  it("resends verification only for the transient email from the preceding sign-in", async () => {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: { next: () => firstOperationId },
      port: port({
        resendEmailVerification: async (email) =>
          email === "staff@example.test"
            ? { status: "sent" }
            : { status: "rejected" },
        signIn: async () => ({ status: "email_verification_required" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.perform({
      email: "staff@example.test",
      operationId: firstOperationId,
      password: "not-retained",
      type: "sign_in",
    });

    await expect(
      adapter.perform({
        operationId: secondOperationId,
        type: "resend_email_verification",
      }),
    ).resolves.toEqual({
      operationId: secondOperationId,
      result: { kind: "email_verification_sent" },
    });
    adapter.dispose();
  });

  it.each(["known@example.test", "unknown@example.test"])(
    "returns the identical recovery notice for %s",
    async (email) => {
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: { next: () => firstOperationId },
        port: port({
          invokeRecovery: async (request) =>
            request.email === email
              ? { code: "recovery_requested", ok: true }
              : { code: "service_unavailable", ok: false },
        }),
        revokeBlobUrl: () => undefined,
      });

      const result = await adapter.perform({
        codeChallenge: "c".repeat(43),
        email,
        flowId: "f".repeat(22),
        operationId: firstOperationId,
        state: "s".repeat(43),
        type: "request_password_recovery",
      });
      expect(result).toEqual({
        operationId: firstOperationId,
        result: { kind: "recovery_request_received" },
      });
      expect(JSON.stringify(result)).not.toContain(email);
      adapter.dispose();
    },
  );

  it("exchanges a consumed PKCE callback without retaining the code or verifier", async () => {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: { next: () => firstOperationId },
      port: port({
        exchangeRecoveryCode: async ({ authorizationCode, verifier }) =>
          authorizationCode === "opaque-authorization-code" &&
          verifier === "v".repeat(43)
            ? { status: "ready" }
            : { status: "rejected" },
      }),
      revokeBlobUrl: () => undefined,
    });

    const result = await adapter.perform({
      authorizationCode: "opaque-authorization-code",
      operationId: firstOperationId,
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
    expect(result).toEqual({
      operationId: firstOperationId,
      result: { kind: "password_recovery_ready" },
    });
    expect(JSON.stringify(adapter)).not.toContain("opaque-authorization-code");
    expect(JSON.stringify(adapter)).not.toContain("v".repeat(43));
    adapter.dispose();
  });

  it("completes DB begin, user-scoped password update, DB finish, then global sign-out", async () => {
    const calls: string[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: { next: () => firstOperationId },
      port: port({
        beginPasswordRecovery: async (operationId) => {
          calls.push(`begin:${operationId}`);
          return [
            {
              code: "recovery_sessions_revoked",
              expires_at: "2026-09-03T23:00:00+00:00",
              operation_id: operationId,
            },
          ];
        },
        finishPasswordRecovery: async (operationId) => {
          calls.push(`finish:${operationId}`);
          return [{ code: "recovery_completed" }];
        },
        signOut: async (scope) => {
          calls.push(`signout:${scope}`);
          return { status: "signed_out" };
        },
        updatePassword: async (password) => {
          calls.push(password === "fresh-password" ? "password" : "wrong");
          return { status: "updated" };
        },
      }),
      revokeBlobUrl: () => undefined,
    });

    const result = await adapter.perform({
      operationId: firstOperationId,
      password: "fresh-password",
      type: "complete_password_recovery",
    });
    expect(result).toEqual({
      operationId: firstOperationId,
      result: { kind: "password_recovery_complete", sessionScope: "all" },
    });
    expect(calls).toEqual([
      `begin:${firstOperationId}`,
      "password",
      `finish:${firstOperationId}`,
      "signout:all",
    ]);
    expect(JSON.stringify(adapter)).not.toContain("fresh-password");
    adapter.dispose();
  });

  it("binds invitation acceptance to a private receipt and the same verified account", async () => {
    const invitationId = "41000000-0000-4000-8000-000000000001";
    const acceptanceReceipt = "10000000-0000-4000-8000-000000000003";
    const identifiers = [
      acceptanceReceipt,
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
    ];
    let accepted = false;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        acceptInvitation: async (request) => {
          if (
            request.invitationId !== invitationId ||
            request.displayName !== "Taylor Teacher"
          ) {
            return [{ code: "invalid_request" }];
          }
          accepted = true;
          return [{ code: "invitation_accepted" }];
        },
        readAccount: async () => ({
          accountId,
          email: "invitee@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () =>
          accepted
            ? [
                {
                  code: "ok",
                  display_name: "Taylor Teacher",
                  membership_role: "teacher",
                  profile_id: profileId,
                  role_revision: 1,
                  school_id: schoolId,
                  school_name: "Example School",
                  school_slug: "example-school",
                },
              ]
            : [
                {
                  code: "membership_inactive",
                  display_name: null,
                  membership_role: null,
                  profile_id: null,
                  role_revision: null,
                  school_id: null,
                  school_name: null,
                  school_slug: null,
                },
              ],
        readCurrentInvitations: async () => [
          {
            code: "ok",
            expires_at: "2026-09-04T12:00:00+00:00",
            invitation_id: invitationId,
            invited_role: "teacher",
            school_id: schoolId,
            school_name: "Example School",
          },
        ],
        readSession: async () => ({ status: "authenticated" }),
        updatePassword: async () => ({ status: "updated" }),
        verifyInvitationToken: async (tokenHash) =>
          tokenHash === "a".repeat(56)
            ? {
                accountId,
                email: "invitee@example.test",
                status: "verified",
              }
            : { status: "invalid" },
      }),
      revokeBlobUrl: () => undefined,
    });

    const inspection = await adapter.perform({
      operationId: firstOperationId,
      tokenHash: "a".repeat(56),
      type: "inspect_invitation",
    });
    expect(inspection).toEqual({
      operationId: firstOperationId,
      result: {
        acceptanceReceipt,
        expiresAt: "2026-09-04T12:00:00.000Z",
        inspectionOperationId: firstOperationId,
        intendedAccountId: accountId,
        intendedEmail: "invitee@example.test",
        kind: "invitation_ready",
        role: "teacher",
        school: { id: schoolId, label: "Example School" },
      },
    });
    expect(JSON.stringify(inspection)).not.toContain(invitationId);
    expect(JSON.stringify(inspection)).not.toContain("a".repeat(56));

    const acceptance = await adapter.perform({
      acceptanceReceipt,
      displayName: "Taylor Teacher",
      inspectionOperationId: firstOperationId,
      operationId: secondOperationId,
      password: "new-invited-password",
      type: "accept_invitation",
    });
    expect(acceptance).toMatchObject({
      operationId: secondOperationId,
      result: {
        identity: {
          accountId,
          profile: { displayName: "Taylor Teacher" },
          school: { id: schoolId },
        },
        kind: "access_granted",
      },
    });
    expect(JSON.stringify(adapter)).not.toContain("new-invited-password");
    adapter.dispose();
  });

  it.each(["expired", "invalid", "replayed"] as const)(
    "maps a provider %s invitation without inspecting DB rows",
    async (status) => {
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: { next: () => firstOperationId },
        port: port({ verifyInvitationToken: async () => ({ status }) }),
        revokeBlobUrl: () => undefined,
      });
      await expect(
        adapter.perform({
          operationId: firstOperationId,
          tokenHash: "b".repeat(56),
          type: "inspect_invitation",
        }),
      ).resolves.toEqual({
        operationId: firstOperationId,
        result: { kind: "invitation_rejected", reason: status },
      });
      adapter.dispose();
    },
  );

  it("binds a created invitation to the fresh same-School Owner authority", async () => {
    const calls: unknown[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: ownerPort({
        invokeInvitation: async (request) => {
          calls.push(request);
          return { code: "invitation_created", ok: true };
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        email: "new-admin@example.test",
        operationId: "90000000-0000-4000-8000-000000000001",
        schoolId,
        targetRole: "admin",
        type: "create_staff_invitation",
      }),
    ).resolves.toMatchObject({
      result: {
        actor: {
          assuranceLevel: "aal2",
          identity: { accountId, school: { id: schoolId } },
          secondFactor: "satisfied",
        },
        invitedRole: "admin",
        kind: "staff_invitation_created",
      },
    });
    expect(calls).toEqual([
      {
        email: "new-admin@example.test",
        role: "administrator",
        schoolId,
      },
    ]);
    adapter.dispose();
  });

  it("never invokes invitation delivery for a forged cross-School command", async () => {
    let called = false;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        invokeInvitation: async () => {
          called = true;
          return { code: "invitation_created", ok: true };
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        email: "staff@example.test",
        operationId: "90000000-0000-4000-8000-000000000002",
        schoolId: "11000000-0000-4000-8000-000000000002",
        targetRole: "teacher",
        type: "create_staff_invitation",
      }),
    ).resolves.toMatchObject({ result: { kind: "membership_inactive" } });
    expect(called).toBe(false);
    adapter.dispose();
  });

  it("fails closed when management authority changes after the provider mutation", async () => {
    let contextReads = 0;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        invokeInvitation: async () => ({
          code: "invitation_created",
          ok: true,
        }),
        readCurrentContext: async () => {
          contextReads += 1;
          return [
            {
              code: "ok",
              display_name: "Olivia Owner",
              membership_role: "owner",
              profile_id: profileId,
              role_revision: contextReads >= 3 ? 9 : 8,
              school_id: schoolId,
              school_name: "Example School",
              school_slug: "example-school",
            },
          ];
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        email: "staff@example.test",
        operationId: "90000000-0000-4000-8000-000000000003",
        schoolId,
        targetRole: "teacher",
        type: "create_staff_invitation",
      }),
    ).rejects.toThrow("continuity");
    adapter.dispose();
  });

  it("revokes only authoritative same-School invitation and membership selectors", async () => {
    let staffPresent = true;
    let invitationPresent = true;
    const calls: unknown[] = [];
    const managedRows = () =>
      staffPresent
        ? [
            {
              code: "ok",
              display_name: "Ada Admin",
              email: "ada@example.test",
              membership_role: "admin",
              profile_id: targetProfileId,
              school_id: schoolId,
            },
          ]
        : [];
    const invitationRows = () =>
      invitationPresent
        ? [
            {
              code: "ok",
              expires_at: "2026-09-04T12:00:00+00:00",
              invitation_id: invitationId,
              invitation_status: "pending_acceptance",
              invited_email: "pending@example.test",
              invited_role: "teacher",
              school_id: schoolId,
            },
          ]
        : [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        readManageableInvitations: async () => invitationRows(),
        readManageableStaff: async () => managedRows(),
        revokeInvitation: async (request) => {
          calls.push(request);
          invitationPresent = false;
          return [{ code: "invitation_revoked" }];
        },
        revokeMembership: async (request) => {
          calls.push(request);
          staffPresent = false;
          return [{ code: "membership_revoked" }];
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        invitationId,
        operationId: "90000000-0000-4000-8000-000000000004",
        schoolId,
        type: "revoke_staff_invitation",
      }),
    ).resolves.toMatchObject({
      result: {
        invitationId,
        kind: "staff_invitation_revoked",
        revokedRole: "teacher",
        schoolId,
      },
    });
    await expect(
      adapter.perform({
        operationId: "90000000-0000-4000-8000-000000000005",
        profileId: targetProfileId,
        schoolId,
        type: "revoke_staff_membership",
      }),
    ).resolves.toMatchObject({
      result: {
        kind: "staff_membership_revoked",
        profileId: targetProfileId,
        revokedRole: "admin",
        schoolId,
      },
    });
    expect(calls).toEqual([
      { invitationId },
      { profileId: targetProfileId, schoolId },
    ]);
    adapter.dispose();
  });

  it.each(["local", "all"] as const)(
    "completes %s sign-out only after application and provider revocation",
    async (scope) => {
      const calls: string[] = [];
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => "blob:not-used",
        operationIds: operationIdSource(),
        port: port({
          revokeAllStaffSessions: async () => {
            calls.push("application:all");
            return [{ code: "ok" }];
          },
          revokeCurrentStaffSession: async () => {
            calls.push("application:local");
            return [{ code: "ok" }];
          },
          signOut: async (providerScope) => {
            calls.push(`provider:${providerScope}`);
            return { status: "signed_out" };
          },
        }),
        revokeBlobUrl: () => undefined,
      });

      await expect(
        adapter.perform({
          operationId: `90000000-0000-4000-8000-00000000000${scope === "local" ? "6" : "7"}`,
          scope,
          type: "sign_out",
        }),
      ).resolves.toEqual({
        operationId: `90000000-0000-4000-8000-00000000000${scope === "local" ? "6" : "7"}`,
        result: { kind: "sign_out_complete", scope },
      });
      expect(calls).toEqual([`application:${scope}`, `provider:${scope}`]);
      adapter.dispose();
    },
  );

  it("keeps an uncertain global sign-out pending and safely retries a DB-confirmed revocation", async () => {
    let attempts = 0;
    let providerCalls = 0;
    const request = {
      operationId: "90000000-0000-4000-8000-000000000008",
      scope: "all" as const,
      type: "sign_out" as const,
    };
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        revokeAllStaffSessions: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("uncertain transport");
          return [{ code: "session_revoked" }];
        },
        signOut: async () => {
          providerCalls += 1;
          return { status: "signed_out" };
        },
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(adapter.perform(request)).rejects.toThrow();
    expect(providerCalls).toBe(0);
    await expect(adapter.perform(request)).resolves.toMatchObject({
      result: { kind: "sign_out_complete", scope: "all" },
    });
    expect(attempts).toBe(2);
    expect(providerCalls).toBe(1);
    adapter.dispose();
  });

  it("runs a real TOTP provisioning ceremony without exposing the enrollment URI", async () => {
    let assurance: "aal1" | "aal2" = "aal1";
    const revokedUrls: string[] = [];
    const removedFactors: string[] = [];
    let createdBlob: Blob | null = null;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: (blob) => {
        createdBlob = blob;
        return "blob:totp-qr";
      },
      operationIds: operationIdSource(),
      port: ownerPort({
        challengeTotp: async (receivedFactorId) =>
          receivedFactorId === factorId
            ? { challengeId, status: "challenged" }
            : { status: "unavailable" },
        enrollTotp: async () => ({
          factorId,
          qrCode: encodedQr(),
          status: "enrolled",
        }),
        readAssurance: async () => ({
          currentLevel: assurance,
          nextLevel: "aal2",
        }),
        readTotpFactors: async () => ({ factors: [] }),
        removeTotpFactor: async (receivedFactorId) => {
          removedFactors.push(receivedFactorId);
          return { status: "removed" };
        },
        verifyTotp: async (input) => {
          expect(input).toEqual({ challengeId, code: "123456", factorId });
          assurance = "aal2";
          return { status: "verified" };
        },
      }),
      revokeBlobUrl: (url) => revokedUrls.push(url),
    });
    await expect(adapter.read()).resolves.toMatchObject({
      secondFactor: "enrollment_required",
    });
    const enrollment = await adapter.perform({
      operationId: "90000000-0000-4000-8000-000000000009",
      type: "begin_totp_enrollment",
    });
    expect(enrollment).toMatchObject({
      result: {
        enrollmentReceipt: "10000000-0000-4000-8000-000000000003",
        kind: "totp_enrollment_ready",
        presentation: { blobUrl: "blob:totp-qr" },
      },
    });
    expect(createdBlob).toMatchObject({ type: "image/svg+xml;charset=utf-8" });
    if (enrollment.result.kind !== "totp_enrollment_ready") {
      throw new Error("expected enrollment result");
    }
    enrollment.result.presentation.revoke();
    await expect(
      adapter.perform({
        ceremonyOperationId: "90000000-0000-4000-8000-000000000009",
        code: "123456",
        enrollmentReceipt: enrollment.result.enrollmentReceipt,
        operationId: "90000000-0000-4000-8000-000000000010",
        purpose: "enrollment",
        type: "verify_totp",
      }),
    ).resolves.toMatchObject({
      result: {
        assuranceLevel: "aal2",
        kind: "access_granted",
        secondFactor: "satisfied",
      },
    });
    expect(revokedUrls).toEqual(["blob:totp-qr"]);
    expect(removedFactors).toEqual([]);
    expect(JSON.stringify(enrollment)).not.toContain("otpauth:");
    adapter.dispose();
  });

  it("rejects and cleans a failed or active-content TOTP enrollment", async () => {
    const removedFactors: string[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:should-not-exist",
      operationIds: operationIdSource(),
      port: ownerPort({
        enrollTotp: async () => ({
          factorId,
          qrCode: encodedQr("<svg><script>sentinel()</script></svg>"),
          status: "enrolled",
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal2",
        }),
        readTotpFactors: async () => ({ factors: [] }),
        removeTotpFactor: async (receivedFactorId) => {
          removedFactors.push(receivedFactorId);
          return { status: "removed" };
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        operationId: "90000000-0000-4000-8000-000000000011",
        type: "begin_totp_enrollment",
      }),
    ).rejects.toThrow("presentation");
    await vi.waitFor(() => expect(removedFactors).toEqual([factorId]));
    adapter.dispose();
  });

  it("lets a wrong step-up code retry the same bounded factor receipt", async () => {
    let assurance: "aal1" | "aal2" = "aal1";
    let verificationAttempts = 0;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        challengeTotp: async () => ({ challengeId, status: "challenged" }),
        readAssurance: async () => ({
          currentLevel: assurance,
          nextLevel: "aal2",
        }),
        readTotpFactors: async () => ({
          factors: [{ factorId, status: "verified" }],
        }),
        verifyTotp: async () => {
          verificationAttempts += 1;
          if (verificationAttempts === 1) return { status: "rejected" };
          assurance = "aal2";
          return { status: "verified" };
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    const challenge = await adapter.read();
    if (
      challenge.kind !== "access_granted" ||
      challenge.secondFactor !== "challenge_required"
    ) {
      throw new Error("expected challenge");
    }

    await expect(
      adapter.perform({
        challengeReceipt: challenge.challengeReceipt,
        code: "000000",
        operationId: "90000000-0000-4000-8000-000000000012",
        purpose: "step_up",
        type: "verify_totp",
      }),
    ).resolves.toMatchObject({ result: { kind: "totp_rejected" } });
    await expect(
      adapter.perform({
        challengeReceipt: challenge.challengeReceipt,
        code: "123456",
        operationId: "90000000-0000-4000-8000-000000000013",
        purpose: "step_up",
        type: "verify_totp",
      }),
    ).resolves.toMatchObject({
      result: { assuranceLevel: "aal2", secondFactor: "satisfied" },
    });
    expect(verificationAttempts).toBe(2);
    adapter.dispose();
  });

  it("coalesces auth notifications into fresh authoritative generation events", async () => {
    let notify: () => void = () => undefined;
    let school = schoolId;
    let contextReads = 0;
    const events: unknown[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () => {
          contextReads += 1;
          return [
            {
              code: "ok",
              display_name: "Taylor Teacher",
              membership_role: "teacher",
              profile_id: profileId,
              role_revision: 1,
              school_id: school,
              school_name:
                school === schoolId ? "Example School" : "Second School",
              school_slug:
                school === schoolId ? "example-school" : "second-school",
            },
          ];
        },
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();
    adapter.subscribe((event) => events.push(event));
    school = "11000000-0000-4000-8000-000000000002";
    notify();
    notify();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      access: {
        identity: { school: { id: school } },
        identityGeneration: "10000000-0000-4000-8000-000000000004",
        sessionGeneration: "10000000-0000-4000-8000-000000000003",
      },
      kind: "access_changed",
      previousIdentityGeneration: "10000000-0000-4000-8000-000000000002",
      previousSessionGeneration: "10000000-0000-4000-8000-000000000001",
    });
    expect(contextReads).toBe(2);
    adapter.dispose();
  });

  it("unsubscribes and ignores a queued authority read after disposal", async () => {
    let notify: () => void = () => undefined;
    const contextDeferred: { resolve?: (value: unknown) => void } = {};
    let contextReads = 0;
    let unsubscribed = false;
    const events: unknown[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => {
            unsubscribed = true;
          };
        },
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () => {
          contextReads += 1;
          if (contextReads > 1) {
            return new Promise((resolve) => {
              contextDeferred.resolve = resolve;
            });
          }
          return [
            {
              code: "ok",
              display_name: "Taylor Teacher",
              membership_role: "teacher",
              profile_id: profileId,
              role_revision: 1,
              school_id: schoolId,
              school_name: "Example School",
              school_slug: "example-school",
            },
          ];
        },
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();
    adapter.subscribe((event) => events.push(event));
    notify();
    await vi.waitFor(() =>
      expect(contextDeferred.resolve).toBeTypeOf("function"),
    );
    adapter.dispose();
    contextDeferred.resolve?.([
      {
        code: "session_revoked",
        display_name: null,
        membership_role: null,
        profile_id: null,
        role_revision: null,
        school_id: null,
        school_name: null,
        school_slug: null,
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(unsubscribed).toBe(true);
    expect(events).toEqual([]);
    await expect(adapter.read()).rejects.toThrow("disposed");
  });

  it("coalesces duplicate operation IDs and rejects cross-command reuse", async () => {
    const signInDeferred: { resolve?: (value: unknown) => void } = {};
    let calls = 0;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        signIn: async () => {
          calls += 1;
          return new Promise((resolve) => {
            signInDeferred.resolve = resolve;
          });
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    const request = {
      email: "staff@example.test",
      operationId: "90000000-0000-4000-8000-000000000014",
      password: "sentinel-not-retained",
      type: "sign_in" as const,
    };
    const first = adapter.perform(request);
    const duplicate = adapter.perform(request);
    expect(calls).toBe(1);
    signInDeferred.resolve?.({ status: "rejected" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      {
        operationId: request.operationId,
        result: { kind: "sign_in_rejected" },
      },
      {
        operationId: request.operationId,
        result: { kind: "sign_in_rejected" },
      },
    ]);
    await expect(
      adapter.perform({
        operationId: request.operationId,
        type: "resend_email_verification",
      }),
    ).rejects.toThrow("reused");
    expect(JSON.stringify(adapter)).not.toContain("sentinel-not-retained");
    adapter.dispose();
  });
});
