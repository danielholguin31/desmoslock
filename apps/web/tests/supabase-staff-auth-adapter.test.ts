import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthAdapter,
  type SupabaseStaffAuthPort,
} from "../src/auth/supabase-staff-auth-adapter.js";
import type { StaffAuthAccessEvent } from "../src/auth/staff-auth-controller.js";

const firstOperationId = "10000000-0000-4000-8000-000000000001";
const secondOperationId = "10000000-0000-4000-8000-000000000002";
const accountId = "a1000000-0000-4000-8000-000000000001";
const profileId = "21000000-0000-4000-8000-000000000001";
const schoolId = "11000000-0000-4000-8000-000000000001";
const targetProfileId = "21000000-0000-4000-8000-000000000002";
const invitationId = "41000000-0000-4000-8000-000000000001";
const factorId = "51000000-0000-4000-8000-000000000001";
const challengeId = "61000000-0000-4000-8000-000000000001";
const passwordAuthority = "synthetic-password-authority-handle";

function port(
  overrides: Partial<SupabaseStaffAuthPort> = {},
): SupabaseStaffAuthPort {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected external call");
  };
  return {
    acceptInvitation: unavailable,
    beginPasswordRecovery: unavailable,
    capturePasswordAuthority: async () => passwordAuthority,
    challengeTotp: unavailable,
    enrollTotp: unavailable,
    exchangeEmailVerificationCode: unavailable,
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
    releasePasswordAuthority: () => undefined,
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
      currentAuthenticationMethods: ["password"],
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

function inactiveContext() {
  return [
    {
      code: "membership_inactive",
      display_name: null,
      membership_role: null,
      profile_id: profileId,
      role_revision: null,
      school_id: null,
      school_name: null,
      school_slug: null,
    },
  ];
}

function acceptedInvitationContext() {
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
}

function invitationHarness(overrides: Partial<SupabaseStaffAuthPort> = {}) {
  const state = { accepted: false };
  const capturePasswordAuthority = vi.fn(async () => passwordAuthority);
  const releasePasswordAuthority = vi.fn();
  const updatePassword = vi.fn(async () => ({ status: "updated" }));
  const signOut = vi.fn(async () => ({ status: "signed_out" }));
  const verifyInvitationToken = vi.fn(async () => ({
    accountId,
    email: "invitee@example.test",
    status: "verified",
  }));
  const adapter = createSupabaseStaffAuthAdapter({
    clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
    createBlobUrl: () => {
      throw new Error("not used");
    },
    operationIds: operationIdSource(10),
    port: port({
      acceptInvitation: async () => {
        state.accepted = true;
        return [{ code: "invitation_accepted" }];
      },
      capturePasswordAuthority,
      releasePasswordAuthority,
      readAccount: async () => ({
        accountId,
        email: "invitee@example.test",
        emailVerified: true,
      }),
      readAssurance: async () => ({
        currentAuthenticationMethods: ["password"],
        currentLevel: "aal1",
        nextLevel: "aal1",
      }),
      readCurrentContext: async () =>
        state.accepted ? acceptedInvitationContext() : inactiveContext(),
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
      signOut,
      updatePassword,
      verifyInvitationToken,
      ...overrides,
    }),
    revokeBlobUrl: () => undefined,
  });
  return {
    adapter,
    capturePasswordAuthority,
    releasePasswordAuthority,
    signOut,
    state,
    updatePassword,
    verifyInvitationToken,
    async accept() {
      const inspection = await adapter.perform({
        operationId: firstOperationId,
        tokenHash: "a".repeat(56),
        type: "inspect_invitation",
      });
      if (inspection.result.kind !== "invitation_ready")
        throw new Error("expected invitation");
      return adapter.perform({
        acceptanceReceipt: inspection.result.acceptanceReceipt,
        displayName: "Taylor Teacher",
        inspectionOperationId: inspection.result.inspectionOperationId,
        operationId: secondOperationId,
        password: "new-invited-password",
        type: "accept_invitation",
      });
    },
  };
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

  it("accepts the exact inactive-membership context with its bound profile ID", async () => {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readCurrentContext: async () => [
          {
            code: "membership_inactive",
            display_name: null,
            membership_role: null,
            profile_id: profileId,
            role_revision: null,
            school_id: null,
            school_name: null,
            school_slug: null,
          },
        ],
        readCurrentInvitations: async () => [
          {
            code: "invitation_not_found",
            expires_at: null,
            invitation_id: null,
            invited_role: null,
            school_id: null,
            school_name: null,
          },
        ],
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(adapter.read()).resolves.toEqual({
      kind: "membership_inactive",
    });
    adapter.dispose();
  });

  it.each([
    ["membership_inactive", "not-a-profile-id"],
    ["session_revoked", profileId],
  ] as const)(
    "rejects malformed %s context failure identity data",
    async (code, returnedProfileId) => {
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: operationIdSource(),
        port: port({
          readAccount: async () => ({
            accountId,
            email: "teacher@example.test",
            emailVerified: true,
          }),
          readCurrentContext: async () => [
            {
              code,
              display_name: null,
              membership_role: null,
              profile_id: returnedProfileId,
              role_revision: null,
              school_id: null,
              school_name: null,
              school_slug: null,
            },
          ],
          readSession: async () => ({ status: "authenticated" }),
        }),
        revokeBlobUrl: () => undefined,
      });

      await expect(adapter.read()).rejects.toThrow("malformed");
      adapter.dispose();
    },
  );

  it("returns sanitized opaque choices for multiple verified factors without challenging either", async () => {
    const challengeTotp = vi.fn();
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: ownerPort({
        challengeTotp,
        readAssurance: async () => ({
          currentAuthenticationMethods: ["password"],
          currentLevel: "aal1",
          nextLevel: "aal2",
        }),
        readTotpFactors: async () => ({
          factors: [
            {
              factorId,
              friendlyName: "  Phone\u202e\n ",
              status: "verified",
            },
            {
              factorId: "51000000-0000-4000-8000-000000000002",
              friendlyName: "Security key",
              status: "verified",
            },
          ],
        }),
      }),
      revokeBlobUrl: () => undefined,
    });

    const result = await adapter.read();

    expect(result).toMatchObject({
      factorChoices: [
        {
          challengeReceipt: "10000000-0000-4000-8000-000000000003",
          label: "Phone (Authenticator 1)",
        },
        {
          challengeReceipt: "10000000-0000-4000-8000-000000000004",
          label: "Security key (Authenticator 2)",
        },
      ],
      secondFactor: "factor_selection_required",
    });
    expect(JSON.stringify(result)).not.toContain(factorId);
    expect(challengeTotp).not.toHaveBeenCalled();
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
          currentAuthenticationMethods: ["password"],
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
          currentAuthenticationMethods: ["password", "totp"],
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
          {
            code: "ok",
            expires_at: "2026-09-04T13:00:00+00:00",
            invitation_id: "41000000-0000-4000-8000-000000000003",
            invitation_status: "delivery_ready",
            invited_email: "uncertain@example.test",
            invited_role: "teacher",
            school_id: schoolId,
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
        {
          email: "uncertain@example.test",
          invitationId: "41000000-0000-4000-8000-000000000003",
          role: "teacher",
          schoolId,
          state: "delivery_unconfirmed",
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
      nextLevel: "aal1" as const,
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
      nextLevel: "aal2" as const,
    },
  ])(
    "$label for privileged AAL1 access",
    async ({ expected, factors, nextLevel }) => {
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
            currentAuthenticationMethods: ["password"],
            currentLevel: "aal1",
            nextLevel,
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
    },
  );

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

  it("re-reads authoritative access after an SDK-owned email verification exchange", async () => {
    const exchangeEmailVerificationCode = vi.fn(async () => ({
      status: "ready",
    }));
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        exchangeEmailVerificationCode,
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentAuthenticationMethods: ["password"],
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () => [
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
        ],
        readSession: async () => ({ status: "authenticated" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    const authorizationCode = "synthetic-email-verification-code";
    const flowId = "0123456789abcdef0123456789abcdef";

    await expect(
      adapter.perform({
        authorizationCode,
        flowId,
        operationId: firstOperationId,
        type: "exchange_email_verification_code",
      }),
    ).resolves.toMatchObject({
      operationId: firstOperationId,
      result: {
        identity: { accountId, school: { id: schoolId } },
        kind: "access_granted",
      },
    });
    expect(exchangeEmailVerificationCode).toHaveBeenCalledWith({
      authorizationCode,
      flowId,
    });
    expect(JSON.stringify(adapter)).not.toContain(authorizationCode);
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

  it("revalidates the original recovery binding after provider notifications without reading school context", async () => {
    let notify: () => void = () => undefined;
    const capture = vi.fn(async () => passwordAuthority);
    const release = vi.fn();
    const readCurrentContext = vi.fn(async () => [{ code: "forbidden" }]);
    const readSession = vi.fn(async () => ({ status: "authenticated" }));
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "unused",
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority: capture,
        releasePasswordAuthority: release,
        exchangeRecoveryCode: async () => {
          notify();
          return { status: "ready" };
        },
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
        readSession,
        readCurrentContext,
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.perform({
      authorizationCode: "synthetic-recovery-code",
      operationId: firstOperationId,
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
    notify();
    expect(await adapter.read()).toEqual({ kind: "password_recovery_ready" });
    expect(capture).toHaveBeenCalledWith();
    expect(release).toHaveBeenCalledWith(passwordAuthority);
    expect(readSession).not.toHaveBeenCalled();
    expect(readCurrentContext).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("keeps a safe recovery restart after a lost binding and repeated provider notifications", async () => {
    let notify: () => void = () => undefined;
    const capture = vi.fn(async (): Promise<string | null> => null);
    const readCurrentContext = vi.fn(async () => [{ code: "forbidden" }]);
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "unused",
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority: capture,
        exchangeRecoveryCode: async () => ({ status: "ready" }),
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
        readCurrentContext,
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.perform({
      authorizationCode: "synthetic-recovery-code",
      operationId: firstOperationId,
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
    notify();
    expect(await adapter.read()).toEqual({
      kind: "password_recovery_rejected",
    });
    notify();
    expect(await adapter.read()).toEqual({
      kind: "password_recovery_rejected",
    });
    expect(readCurrentContext).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("releases a stale recovery probe after reset without restoring the password form", async () => {
    let finishProbe: (value: string) => void = () => undefined;
    const capture = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const release = vi.fn();
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "unused",
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority: capture,
        exchangeRecoveryCode: async () => ({ status: "ready" }),
        releasePasswordAuthority: release,
        signOut: async () => ({ status: "signed_out" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.perform({
      authorizationCode: "synthetic-recovery-code",
      operationId: firstOperationId,
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
    const pendingRead = adapter.read();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    await adapter.perform({
      operationId: secondOperationId,
      type: "reset_to_sign_in",
    });
    finishProbe(passwordAuthority);
    expect(await pendingRead).toEqual({ kind: "password_recovery_rejected" });
    expect(release).toHaveBeenCalledWith(passwordAuthority);
    expect(await adapter.read()).toEqual({ kind: "signed_out" });
    adapter.dispose();
  });

  it("does not restore recovery route intent when a late exchange finishes after reset", async () => {
    let finishExchange: (value: { status: string }) => void = () => undefined;
    const exchange = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          finishExchange = resolve;
        }),
    );
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "unused",
      operationIds: operationIdSource(),
      port: port({
        exchangeRecoveryCode: exchange,
        signOut: async () => ({ status: "signed_out" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    const pendingExchange = adapter.perform({
      authorizationCode: "synthetic-recovery-code",
      operationId: firstOperationId,
      type: "exchange_recovery_code",
      verifier: "v".repeat(43),
    });
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    await adapter.perform({
      operationId: secondOperationId,
      type: "reset_to_sign_in",
    });
    finishExchange({ status: "ready" });
    expect((await pendingExchange).result).toEqual({
      kind: "password_recovery_rejected",
    });
    expect(await adapter.read()).toEqual({ kind: "signed_out" });
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

  it("holds one private recovery authority through canonical cleanup and releases it before returning", async () => {
    const calls: unknown[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority: async (expectedAccountId) => {
          calls.push(["capture", expectedAccountId]);
          return passwordAuthority;
        },
        beginPasswordRecovery: async (operationId, authority) => {
          calls.push(["begin", operationId, authority]);
          return [
            {
              code: "recovery_sessions_revoked",
              expires_at: "2026-09-03T23:00:00+00:00",
              operation_id: secondOperationId,
            },
          ];
        },
        updatePassword: async (password, authority) => {
          calls.push(["password", password, authority]);
          return { status: "updated" };
        },
        finishPasswordRecovery: async (operationId, authority) => {
          calls.push(["finish", operationId, authority]);
          return [{ code: "recovery_completed" }];
        },
        signOut: async (scope, authority) => {
          calls.push(["signout", scope, authority]);
          return { status: "signed_out" };
        },
        releasePasswordAuthority: (authority) => {
          calls.push(["release", authority]);
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
      ["capture", undefined],
      ["begin", firstOperationId, passwordAuthority],
      ["password", "fresh-password", passwordAuthority],
      ["finish", secondOperationId, passwordAuthority],
      ["signout", "all", passwordAuthority],
      ["release", passwordAuthority],
    ]);
    expect(JSON.stringify(result)).not.toContain(passwordAuthority);
    expect(JSON.stringify(adapter)).not.toContain(passwordAuthority);
    adapter.dispose();
  });

  it("never starts recovery mutations when no password authority can be captured", async () => {
    const capturePasswordAuthority = vi.fn(async () => null);
    const releasePasswordAuthority = vi.fn();
    const beginPasswordRecovery = vi.fn();
    const updatePassword = vi.fn();
    const finishPasswordRecovery = vi.fn();
    const signOut = vi.fn();
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority,
        releasePasswordAuthority,
        beginPasswordRecovery,
        updatePassword,
        finishPasswordRecovery,
        signOut,
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.perform({
      operationId: firstOperationId,
      password: "fresh-password",
      type: "complete_password_recovery",
    });
    expect(capturePasswordAuthority).toHaveBeenCalledOnce();
    expect(beginPasswordRecovery).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
    expect(finishPasswordRecovery).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(releasePasswordAuthority).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("releases a late recovery authority without starting mutations after auth invalidation during capture", async () => {
    let notify: () => void = () => undefined;
    let finishCapture: ((authority: string) => void) | undefined;
    const capturePasswordAuthority = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const releasePasswordAuthority = vi.fn();
    const beginPasswordRecovery = vi.fn();
    const updatePassword = vi.fn();
    const finishPasswordRecovery = vi.fn();
    const signOut = vi.fn();
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        capturePasswordAuthority,
        releasePasswordAuthority,
        beginPasswordRecovery,
        updatePassword,
        finishPasswordRecovery,
        signOut,
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
      }),
      revokeBlobUrl: () => undefined,
    });
    const result = adapter.perform({
      operationId: firstOperationId,
      password: "fresh-password",
      type: "complete_password_recovery",
    });
    await vi.waitFor(() =>
      expect(capturePasswordAuthority).toHaveBeenCalledOnce(),
    );
    notify();
    finishCapture?.(passwordAuthority);
    await result;
    expect(beginPasswordRecovery).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
    expect(finishPasswordRecovery).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(releasePasswordAuthority).toHaveBeenCalledExactlyOnceWith(
      passwordAuthority,
    );
    adapter.dispose();
  });

  it.each(["throws", "malformed"] as const)(
    "releases captured recovery authority when begin %s before any password mutation",
    async (failure) => {
      const releasePasswordAuthority = vi.fn();
      const updatePassword = vi.fn();
      const finishPasswordRecovery = vi.fn();
      const signOut = vi.fn();
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: operationIdSource(),
        port: port({
          beginPasswordRecovery: async () => {
            if (failure === "throws")
              throw new Error("lost recovery begin response");
            return [{ unexpected: true }];
          },
          releasePasswordAuthority,
          updatePassword,
          finishPasswordRecovery,
          signOut,
        }),
        revokeBlobUrl: () => undefined,
      });
      await expect(
        adapter.perform({
          operationId: firstOperationId,
          password: "fresh-password",
          type: "complete_password_recovery",
        }),
      ).rejects.toThrow();
      expect(releasePasswordAuthority).toHaveBeenCalledExactlyOnceWith(
        passwordAuthority,
      );
      expect(updatePassword).not.toHaveBeenCalled();
      expect(finishPasswordRecovery).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
      adapter.dispose();
    },
  );

  it.each(["updated", "rejected", "throws", "malformed"] as const)(
    "finishes the canonical recovery operation and signs out globally after provider %s",
    async (providerResult) => {
      const calls: string[] = [];
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: operationIdSource(),
        port: port({
          beginPasswordRecovery: async (operationId) => {
            calls.push(`begin:${operationId}`);
            return [
              {
                code: "recovery_sessions_revoked",
                expires_at: "2026-09-03T23:00:00+00:00",
                operation_id: secondOperationId,
              },
            ];
          },
          updatePassword: async () => {
            calls.push("password");
            if (providerResult === "throws")
              throw new Error("lost provider response");
            return providerResult === "malformed"
              ? { unexpected: true }
              : { status: providerResult };
          },
          finishPasswordRecovery: async (operationId) => {
            calls.push(`finish:${operationId}`);
            return [{ code: "recovery_completed" }];
          },
          signOut: async (scope) => {
            calls.push(`signout:${scope}`);
            return { status: "signed_out" };
          },
        }),
        revokeBlobUrl: () => undefined,
      });
      const outcome =
        providerResult === "updated"
          ? { kind: "password_recovery_complete", sessionScope: "all" }
          : providerResult === "rejected"
            ? { kind: "password_recovery_rejected" }
            : {
                kind: "password_recovery_uncertain",
                passwordOutcome: "unknown",
                cleanupComplete: true,
              };

      await expect(
        adapter.perform({
          operationId: firstOperationId,
          password: "fresh-password",
          type: "complete_password_recovery",
        }),
      ).resolves.toEqual({ operationId: firstOperationId, result: outcome });
      expect(calls).toEqual([
        `begin:${firstOperationId}`,
        "password",
        `finish:${secondOperationId}`,
        "signout:all",
      ]);
      adapter.dispose();
    },
  );

  it.each([
    ["updated", "finish throws"],
    ["rejected", "finish rejects"],
    ["unknown", "finish malformed"],
    ["updated", "signout throws"],
    ["rejected", "signout malformed"],
    ["unknown", "signout throws"],
  ] as const)(
    "preserves the %s password outcome when %s and still attempts global sign-out",
    async (passwordOutcome, failure) => {
      const releasePasswordAuthority = vi.fn();
      const updatePassword = vi.fn(async () => {
        if (passwordOutcome === "unknown")
          throw new Error("lost password response");
        return { status: passwordOutcome };
      });
      const finishPasswordRecovery = vi.fn(async () => {
        if (failure === "finish throws")
          throw new Error("lost finish response");
        if (failure === "finish rejects") return [{ code: "session_expired" }];
        return failure === "finish malformed"
          ? [{ unexpected: true }]
          : [{ code: "recovery_completed" }];
      });
      const signOut = vi.fn(async () => {
        if (failure === "signout throws")
          throw new Error("lost signout response");
        return failure === "signout malformed"
          ? { unexpected: true }
          : { status: "signed_out" };
      });
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: operationIdSource(),
        port: port({
          beginPasswordRecovery: async () => [
            {
              code: "recovery_sessions_revoked",
              expires_at: "2026-09-03T23:00:00+00:00",
              operation_id: secondOperationId,
            },
          ],
          updatePassword,
          finishPasswordRecovery,
          releasePasswordAuthority,
          signOut,
        }),
        revokeBlobUrl: () => undefined,
      });

      await expect(
        adapter.perform({
          operationId: firstOperationId,
          password: "fresh-password",
          type: "complete_password_recovery",
        }),
      ).resolves.toEqual({
        operationId: firstOperationId,
        result: {
          kind: "password_recovery_uncertain",
          passwordOutcome,
          cleanupComplete: false,
        },
      });
      expect(updatePassword).toHaveBeenCalledExactlyOnceWith(
        "fresh-password",
        passwordAuthority,
      );
      expect(finishPasswordRecovery).toHaveBeenCalledExactlyOnceWith(
        secondOperationId,
        passwordAuthority,
      );
      expect(signOut).toHaveBeenCalledExactlyOnceWith("all", passwordAuthority);
      expect(releasePasswordAuthority).toHaveBeenCalledExactlyOnceWith(
        passwordAuthority,
      );
      adapter.dispose();
    },
  );

  it("does not report password success from a previously completed recovery ledger entry", async () => {
    const updatePassword = vi.fn();
    const finishPasswordRecovery = vi.fn(async () => [
      { code: "recovery_completed" },
    ]);
    const signOut = vi.fn(async () => ({ status: "signed_out" }));
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: operationIdSource(),
      port: port({
        beginPasswordRecovery: async () => [
          {
            code: "recovery_completed",
            expires_at: "2026-09-03T23:00:00+00:00",
            operation_id: secondOperationId,
          },
        ],
        updatePassword,
        finishPasswordRecovery,
        signOut,
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(
      adapter.perform({
        operationId: firstOperationId,
        password: "fresh-password",
        type: "complete_password_recovery",
      }),
    ).resolves.toEqual({
      operationId: firstOperationId,
      result: {
        kind: "password_recovery_uncertain",
        passwordOutcome: "unknown",
        cleanupComplete: true,
      },
    });
    expect(updatePassword).not.toHaveBeenCalled();
    expect(finishPasswordRecovery).toHaveBeenCalledExactlyOnceWith(
      secondOperationId,
      passwordAuthority,
    );
    expect(signOut).toHaveBeenCalledExactlyOnceWith("all", passwordAuthority);
    adapter.dispose();
  });

  it("binds invitation acceptance to a private receipt and the same verified account", async () => {
    const invitationId = "41000000-0000-4000-8000-000000000001";
    const acceptanceReceipt = "10000000-0000-4000-8000-000000000006";
    const identifiers = [
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
      acceptanceReceipt,
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
          currentAuthenticationMethods: ["password"],
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

  it("never mutates invitation or password state when recipient authority capture fails", async () => {
    const capturePasswordAuthority = vi.fn(async () => null);
    const acceptInvitation = vi.fn();
    const fixture = invitationHarness({
      capturePasswordAuthority,
      acceptInvitation,
    });
    const result = await fixture.accept();
    expect(capturePasswordAuthority).toHaveBeenCalledExactlyOnceWith(accountId);
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(fixture.updatePassword).not.toHaveBeenCalled();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(fixture.releasePasswordAuthority).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(passwordAuthority);
    fixture.adapter.dispose();
  });

  it("holds the same recipient authority across an invitation retry, password failure, and local cleanup", async () => {
    const calls: unknown[] = [];
    let attempts = 0;
    const fixture = invitationHarness({
      acceptInvitation: async (request, authority) => {
        calls.push(["accept", request, authority]);
        attempts += 1;
        if (attempts === 1) throw new Error("lost acceptance response");
        fixture.state.accepted = true;
        return [{ code: "invitation_accepted" }];
      },
      updatePassword: async (password, authority) => {
        calls.push(["password", password, authority]);
        return { status: "rejected" };
      },
      signOut: async (scope, authority) => {
        calls.push(["signout", scope, authority]);
        throw new Error("lost local cleanup response");
      },
      releasePasswordAuthority: (authority) => {
        calls.push(["release", authority]);
      },
    });
    const result = await fixture.accept();
    expect(result).toEqual({
      operationId: secondOperationId,
      result: { kind: "invitation_accepted", passwordOutcome: "rejected" },
    });
    expect(fixture.capturePasswordAuthority).toHaveBeenCalledExactlyOnceWith(
      accountId,
    );
    expect(calls).toEqual([
      [
        "accept",
        { displayName: "Taylor Teacher", invitationId },
        passwordAuthority,
      ],
      [
        "accept",
        { displayName: "Taylor Teacher", invitationId },
        passwordAuthority,
      ],
      ["password", "new-invited-password", passwordAuthority],
      ["signout", "local", passwordAuthority],
      ["release", passwordAuthority],
    ]);
    expect(JSON.stringify(result)).not.toContain(passwordAuthority);
    expect(JSON.stringify(fixture.adapter)).not.toContain(passwordAuthority);
    fixture.adapter.dispose();
  });

  it("releases a late invitation authority without mutation after auth invalidation during capture", async () => {
    let notify: () => void = () => undefined;
    let finishCapture: ((authority: string) => void) | undefined;
    const capturePasswordAuthority = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const acceptInvitation = vi.fn();
    const fixture = invitationHarness({
      acceptInvitation,
      capturePasswordAuthority,
      onAuthStateChange: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    const result = fixture.accept();
    await vi.waitFor(() =>
      expect(capturePasswordAuthority).toHaveBeenCalledOnce(),
    );
    notify();
    finishCapture?.(passwordAuthority);
    await result;
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(fixture.updatePassword).not.toHaveBeenCalled();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(fixture.releasePasswordAuthority).toHaveBeenCalledExactlyOnceWith(
      passwordAuthority,
    );
    fixture.adapter.dispose();
  });

  it("accepts the database invitation before sending the password to the provider", async () => {
    const calls: string[] = [];
    const fixture = invitationHarness({
      acceptInvitation: async () => {
        calls.push("accept");
        fixture.state.accepted = true;
        return [{ code: "invitation_accepted" }];
      },
      updatePassword: async () => {
        calls.push("password");
        expect(fixture.state.accepted).toBe(true);
        return { status: "updated" };
      },
    });
    await expect(fixture.accept()).resolves.toMatchObject({
      result: { kind: "access_granted" },
    });
    expect(calls).toEqual(["accept", "password"]);
    fixture.adapter.dispose();
  });

  it.each(["rejected", "throws", "malformed"] as const)(
    "preserves committed invitation acceptance and attempts local sign-out after password %s",
    async (providerResult) => {
      const revokeMembership = vi.fn();
      const updatePassword = vi.fn(async () => {
        if (providerResult === "throws")
          throw new Error("SENTINEL-password-provider-response");
        return providerResult === "malformed"
          ? { unexpected: true }
          : { status: "rejected" };
      });
      const fixture = invitationHarness({
        revokeMembership,
        updatePassword,
      });
      const result = await fixture.accept();
      expect(result).toEqual({
        operationId: secondOperationId,
        result: {
          kind: "invitation_accepted",
          passwordOutcome:
            providerResult === "rejected" ? "rejected" : "unknown",
        },
      });
      expect(fixture.state.accepted).toBe(true);
      expect(updatePassword).toHaveBeenCalledExactlyOnceWith(
        "new-invited-password",
        passwordAuthority,
      );
      expect(fixture.signOut).toHaveBeenCalledExactlyOnceWith(
        "local",
        passwordAuthority,
      );
      expect(revokeMembership).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
      fixture.adapter.dispose();
    },
  );

  it("keeps invitation acceptance committed when best-effort local sign-out also fails", async () => {
    const signOut = vi.fn(async () => {
      throw new Error("lost sign-out response");
    });
    const fixture = invitationHarness({
      signOut,
      updatePassword: async () => ({ status: "rejected" }),
    });
    await expect(fixture.accept()).resolves.toMatchObject({
      result: { kind: "invitation_accepted", passwordOutcome: "rejected" },
    });
    expect(signOut).toHaveBeenCalledExactlyOnceWith("local", passwordAuthority);
    expect(fixture.state.accepted).toBe(true);
    fixture.adapter.dispose();
  });

  it.each(["throws", "malformed"] as const)(
    "reconciles a committed invitation after its acceptance response %s without repeating the RPC",
    async (response) => {
      const acceptInvitation = vi.fn(async () => {
        fixture.state.accepted = true;
        if (response === "throws") throw new Error("lost commit response");
        return [{ unexpected: true }];
      });
      const fixture = invitationHarness({ acceptInvitation });
      await expect(fixture.accept()).resolves.toMatchObject({
        result: { kind: "access_granted" },
      });
      expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(
        {
          displayName: "Taylor Teacher",
          invitationId,
        },
        passwordAuthority,
      );
      expect(fixture.updatePassword).toHaveBeenCalledExactlyOnceWith(
        "new-invited-password",
        passwordAuthority,
      );
      fixture.adapter.dispose();
    },
  );

  it("retries the same invitation UUID and display name once when no committed authority is visible", async () => {
    const acceptInvitation = vi.fn(async () => {
      if (acceptInvitation.mock.calls.length === 1)
        throw new Error("first acceptance response lost");
      fixture.state.accepted = true;
      return [{ code: "invitation_accepted" }];
    });
    const fixture = invitationHarness({ acceptInvitation });
    await expect(fixture.accept()).resolves.toMatchObject({
      result: { kind: "access_granted" },
    });
    expect(acceptInvitation.mock.calls).toEqual([
      [{ displayName: "Taylor Teacher", invitationId }, passwordAuthority],
      [{ displayName: "Taylor Teacher", invitationId }, passwordAuthority],
    ]);
    expect(fixture.updatePassword).toHaveBeenCalledExactlyOnceWith(
      "new-invited-password",
      passwordAuthority,
    );
    fixture.adapter.dispose();
  });

  it.each(["throws", "malformed"] as const)(
    "reports uncertainty without password egress after two unresolved invitation responses that %s",
    async (response) => {
      const acceptInvitation = vi.fn(async () => {
        if (response === "throws")
          throw new Error("SENTINEL-lost-acceptance-response");
        return [{ unexpected: true }];
      });
      const fixture = invitationHarness({ acceptInvitation });
      const result = await fixture.accept();
      expect(result).toEqual({
        operationId: secondOperationId,
        result: { kind: "invitation_acceptance_uncertain" },
      });
      expect(acceptInvitation).toHaveBeenCalledTimes(2);
      expect(acceptInvitation.mock.calls[0]).toEqual(
        acceptInvitation.mock.calls[1],
      );
      expect(fixture.updatePassword).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
      fixture.adapter.dispose();
    },
  );

  it("does not retry invitation acceptance or send a password after reconciliation finds another account", async () => {
    let currentAccountId = accountId;
    const acceptInvitation = vi.fn(async () => {
      currentAccountId = "a1000000-0000-4000-8000-000000000002";
      throw new Error("lost acceptance response during account switch");
    });
    const fixture = invitationHarness({
      acceptInvitation,
      readAccount: async () => ({
        accountId: currentAccountId,
        email: "invitee@example.test",
        emailVerified: true,
      }),
    });
    await expect(fixture.accept()).resolves.toMatchObject({
      result: { kind: "invitation_acceptance_uncertain" },
    });
    expect(acceptInvitation).toHaveBeenCalledOnce();
    expect(fixture.updatePassword).not.toHaveBeenCalled();
    fixture.adapter.dispose();
  });

  it("never updates a password or retries a definitively rejected database invitation", async () => {
    const acceptInvitation = vi.fn(async () => [
      { code: "invitation_expired" },
    ]);
    const fixture = invitationHarness({ acceptInvitation });
    await expect(fixture.accept()).resolves.toEqual({
      operationId: secondOperationId,
      result: { kind: "invitation_rejected", reason: "expired" },
    });
    expect(acceptInvitation).toHaveBeenCalledOnce();
    expect(fixture.updatePassword).not.toHaveBeenCalled();
    fixture.adapter.dispose();
  });

  it.each(["account", "session"] as const)(
    "does not send a password or sign out a changed %s after database acceptance commits",
    async (change) => {
      let currentAccountId = accountId;
      let notify: () => void = () => undefined;
      const fixture = invitationHarness({
        acceptInvitation: async () => {
          fixture.state.accepted = true;
          if (change === "account")
            currentAccountId = "a1000000-0000-4000-8000-000000000002";
          else notify();
          return [{ code: "invitation_accepted" }];
        },
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
        readAccount: async () => ({
          accountId: currentAccountId,
          email: "invitee@example.test",
          emailVerified: true,
        }),
      });
      await expect(fixture.accept()).resolves.toMatchObject({
        result: { kind: "invitation_accepted", passwordOutcome: "unknown" },
      });
      expect(fixture.state.accepted).toBe(true);
      expect(fixture.updatePassword).not.toHaveBeenCalled();
      expect(fixture.signOut).not.toHaveBeenCalled();
      fixture.adapter.dispose();
    },
  );

  it("does not sign out another account when it changes during an uncertain invitation password update", async () => {
    let currentAccountId = accountId;
    const updatePassword = vi.fn(async () => {
      currentAccountId = "a1000000-0000-4000-8000-000000000002";
      throw new Error("password response lost while switching account");
    });
    const fixture = invitationHarness({
      readAccount: async () => ({
        accountId: currentAccountId,
        email: "invitee@example.test",
        emailVerified: true,
      }),
      updatePassword,
    });
    await expect(fixture.accept()).resolves.toMatchObject({
      result: { kind: "invitation_accepted", passwordOutcome: "unknown" },
    });
    expect(updatePassword).toHaveBeenCalledExactlyOnceWith(
      "new-invited-password",
      passwordAuthority,
    );
    expect(fixture.signOut).not.toHaveBeenCalled();
    fixture.adapter.dispose();
  });

  it("reconstructs a pending invitation after reload without reusing its consumed verification token", async () => {
    const fixture = invitationHarness();
    const restored = await fixture.adapter.read();
    expect(restored).toMatchObject({
      kind: "invitation_ready",
      intendedAccountId: accountId,
      intendedEmail: "invitee@example.test",
      role: "teacher",
      school: { id: schoolId, label: "Example School" },
    });
    expect(fixture.verifyInvitationToken).not.toHaveBeenCalled();
    if (restored.kind !== "invitation_ready")
      throw new Error("expected restored invitation");
    await expect(
      fixture.adapter.perform({
        acceptanceReceipt: restored.acceptanceReceipt,
        displayName: "Taylor Teacher",
        inspectionOperationId: restored.inspectionOperationId,
        operationId: secondOperationId,
        password: "new-invited-password",
        type: "accept_invitation",
      }),
    ).resolves.toMatchObject({ result: { kind: "access_granted" } });
    expect(fixture.verifyInvitationToken).not.toHaveBeenCalled();
    fixture.adapter.dispose();
  });

  it("resumes a transient invitation lookup without verifying the one-shot token twice", async () => {
    const continuationReceipt = "10000000-0000-4000-8000-000000000003";
    const acceptanceReceipt = "10000000-0000-4000-8000-000000000006";
    const identifiers = [
      continuationReceipt,
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
      acceptanceReceipt,
    ];
    const verifyInvitationToken = vi.fn(async () => ({
      accountId,
      email: "invitee@example.test",
      status: "verified",
    }));
    let invitationReads = 0;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId,
          email: "invitee@example.test",
          emailVerified: true,
        }),
        readCurrentInvitations: async () => {
          invitationReads += 1;
          if (invitationReads === 1) {
            throw new Error("temporary lookup failure");
          }
          return [
            {
              code: "ok",
              expires_at: "2026-09-04T12:00:00+00:00",
              invitation_id: invitationId,
              invited_role: "teacher",
              school_id: schoolId,
              school_name: "Example School",
            },
          ];
        },
        readSession: async () => ({ status: "authenticated" }),
        verifyInvitationToken,
      }),
      revokeBlobUrl: () => undefined,
    });

    const interrupted = await adapter.perform({
      operationId: firstOperationId,
      tokenHash: "a".repeat(56),
      type: "inspect_invitation",
    });
    expect(interrupted).toEqual({
      operationId: firstOperationId,
      result: {
        continuationReceipt,
        inspectionOperationId: firstOperationId,
        kind: "invitation_inspection_interrupted",
      },
    });
    expect(JSON.stringify(interrupted)).not.toContain("invitee@example.test");
    expect(JSON.stringify(interrupted)).not.toContain("a".repeat(56));

    await expect(
      adapter.perform({
        continuationReceipt,
        inspectionOperationId: firstOperationId,
        operationId: secondOperationId,
        type: "resume_invitation_inspection",
      }),
    ).resolves.toMatchObject({
      operationId: secondOperationId,
      result: { acceptanceReceipt, kind: "invitation_ready" },
    });
    expect(verifyInvitationToken).toHaveBeenCalledOnce();

    await expect(
      adapter.perform({
        continuationReceipt,
        inspectionOperationId: firstOperationId,
        operationId: "10000000-0000-4000-8000-000000000007",
        type: "resume_invitation_inspection",
      }),
    ).resolves.toEqual({
      operationId: "10000000-0000-4000-8000-000000000007",
      result: { kind: "invitation_rejected", reason: "invalid" },
    });
    adapter.dispose();
  });

  it("keeps the opaque invitation continuation after one malformed DB response", async () => {
    const continuationReceipt = "10000000-0000-4000-8000-000000000003";
    const identifiers = [
      continuationReceipt,
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006",
    ];
    let invitationReads = 0;
    const verifyInvitationToken = vi.fn(async () => ({
      accountId,
      email: "invitee@example.test",
      status: "verified",
    }));
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId,
          email: "invitee@example.test",
          emailVerified: true,
        }),
        readCurrentInvitations: async () => {
          invitationReads += 1;
          return invitationReads === 1
            ? [{ malformed: true }]
            : [
                {
                  code: "ok",
                  expires_at: "2026-09-04T12:00:00+00:00",
                  invitation_id: invitationId,
                  invited_role: "teacher",
                  school_id: schoolId,
                  school_name: "Example School",
                },
              ];
        },
        readSession: async () => ({ status: "authenticated" }),
        verifyInvitationToken,
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(
      adapter.perform({
        operationId: firstOperationId,
        tokenHash: "a".repeat(56),
        type: "inspect_invitation",
      }),
    ).resolves.toMatchObject({
      result: {
        continuationReceipt,
        kind: "invitation_inspection_interrupted",
      },
    });
    await expect(
      adapter.perform({
        continuationReceipt,
        inspectionOperationId: firstOperationId,
        operationId: secondOperationId,
        type: "resume_invitation_inspection",
      }),
    ).resolves.toMatchObject({ result: { kind: "invitation_ready" } });
    expect(verifyInvitationToken).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("invalidates an interrupted invitation inspection when the account changes", async () => {
    const continuationReceipt = "10000000-0000-4000-8000-000000000003";
    const identifiers = [
      continuationReceipt,
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
    ];
    let currentAccountId = accountId;
    let invitationReads = 0;
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
      createBlobUrl: () => {
        throw new Error("not used");
      },
      operationIds: {
        next: () => identifiers.shift() ?? "identifier-exhausted",
      },
      port: port({
        readAccount: async () => ({
          accountId: currentAccountId,
          email: "invitee@example.test",
          emailVerified: true,
        }),
        readCurrentInvitations: async () => {
          invitationReads += 1;
          throw new Error("temporary lookup failure");
        },
        readSession: async () => ({ status: "authenticated" }),
        verifyInvitationToken: async () => ({
          accountId,
          email: "invitee@example.test",
          status: "verified",
        }),
      }),
      revokeBlobUrl: () => undefined,
    });

    await adapter.perform({
      operationId: firstOperationId,
      tokenHash: "a".repeat(56),
      type: "inspect_invitation",
    });
    currentAccountId = "a1000000-0000-4000-8000-000000000002";
    await expect(
      adapter.perform({
        continuationReceipt,
        inspectionOperationId: firstOperationId,
        operationId: secondOperationId,
        type: "resume_invitation_inspection",
      }),
    ).resolves.toEqual({
      operationId: secondOperationId,
      result: { kind: "invitation_rejected", reason: "invalid" },
    });
    expect(invitationReads).toBe(1);
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
    const actor = await adapter.read();
    if (actor.kind !== "access_granted")
      throw new Error("expected owner authority");

    await expect(
      adapter.perform({
        email: "new-admin@example.test",
        expectedIdentityGeneration: actor.identityGeneration,
        expectedSessionGeneration: actor.sessionGeneration,
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
    const actor = await adapter.read();
    if (actor.kind !== "access_granted")
      throw new Error("expected owner authority");

    await expect(
      adapter.perform({
        email: "staff@example.test",
        expectedIdentityGeneration: actor.identityGeneration,
        expectedSessionGeneration: actor.sessionGeneration,
        operationId: "90000000-0000-4000-8000-000000000002",
        schoolId: "11000000-0000-4000-8000-000000000002",
        targetRole: "teacher",
        type: "create_staff_invitation",
      }),
    ).resolves.toMatchObject({ result: { kind: "membership_inactive" } });
    expect(called).toBe(false);
    adapter.dispose();
  });

  it.each(["account", "session", "session during authority refresh"] as const)(
    "blocks invitation egress when %s changes after the Owner command was prepared",
    async (change) => {
      let notify: () => void = () => undefined;
      let currentAccountId = accountId;
      let assuranceReads = 0;
      const invokeInvitation = vi.fn(async () => ({
        code: "invitation_created",
        ok: true,
      }));
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => 1_788_300_000_000 },
        createBlobUrl: () => {
          throw new Error("not used");
        },
        operationIds: operationIdSource(),
        port: ownerPort({
          invokeInvitation,
          onAuthStateChange: (listener) => {
            notify = listener;
            return () => undefined;
          },
          readAccount: async () => ({
            accountId: currentAccountId,
            email: "owner@example.test",
            emailVerified: true,
          }),
          readAssurance: async () => {
            assuranceReads += 1;
            if (
              change === "session during authority refresh" &&
              assuranceReads === 2
            )
              notify();
            return {
              currentAuthenticationMethods: ["password"],
              currentLevel: "aal2",
              nextLevel: "aal2",
            };
          },
        }),
        revokeBlobUrl: () => undefined,
      });
      const actor = await adapter.read();
      if (actor.kind !== "access_granted")
        throw new Error("expected owner authority");
      if (change === "account")
        currentAccountId = "a1000000-0000-4000-8000-000000000002";
      if (change === "session") notify();

      await expect(
        adapter.perform({
          email: "new-admin@example.test",
          expectedIdentityGeneration: actor.identityGeneration,
          expectedSessionGeneration: actor.sessionGeneration,
          operationId: "90000000-0000-4000-8000-000000000004",
          schoolId,
          targetRole: "admin",
          type: "create_staff_invitation",
        }),
      ).resolves.toMatchObject({
        result: { kind: "staff_invitation_rejected" },
      });
      expect(invokeInvitation).not.toHaveBeenCalled();
      adapter.dispose();
    },
  );

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
    const actor = await adapter.read();
    if (actor.kind !== "access_granted")
      throw new Error("expected owner authority");

    await expect(
      adapter.perform({
        email: "staff@example.test",
        expectedIdentityGeneration: actor.identityGeneration,
        expectedSessionGeneration: actor.sessionGeneration,
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

  it("treats an inactive membership target as a rejected target, not actor access loss", async () => {
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        readManageableStaff: async () => [
          {
            code: "ok",
            display_name: "Ada Admin",
            email: "ada@example.test",
            membership_role: "admin",
            profile_id: targetProfileId,
            school_id: schoolId,
          },
        ],
        revokeMembership: async () => [{ code: "membership_inactive" }],
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();

    await expect(
      adapter.perform({
        operationId: "90000000-0000-4000-8000-000000000006",
        profileId: targetProfileId,
        schoolId,
        type: "revoke_staff_membership",
      }),
    ).resolves.toMatchObject({
      result: {
        actor: { identity: { profile: { id: profileId } } },
        kind: "staff_membership_revocation_rejected",
      },
    });
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

  it("returns to sign in by clearing the provider locally without an application RPC", async () => {
    const signOut = vi.fn(async () => ({ status: "signed_out" }));
    const revokeAllStaffSessions = vi.fn(async () => [{ code: "ok" }]);
    const revokeCurrentStaffSession = vi.fn(async () => [{ code: "ok" }]);
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        revokeAllStaffSessions,
        revokeCurrentStaffSession,
        signOut,
      }),
      revokeBlobUrl: () => undefined,
    });

    await expect(
      adapter.perform({
        operationId: "90000000-0000-4000-8000-000000000007",
        type: "reset_to_sign_in",
      }),
    ).resolves.toEqual({
      operationId: "90000000-0000-4000-8000-000000000007",
      result: { kind: "sign_out_complete", scope: "local" },
    });
    expect(signOut).toHaveBeenCalledWith("local");
    expect(revokeCurrentStaffSession).not.toHaveBeenCalled();
    expect(revokeAllStaffSessions).not.toHaveBeenCalled();
    adapter.dispose();
  });

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
          currentAuthenticationMethods: ["password"],
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
          currentAuthenticationMethods: ["password"],
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
          currentAuthenticationMethods: ["password"],
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

  it("emits a synchronous detail-free invalidation and defers reads behind mutations", async () => {
    let notify: () => void = () => undefined;
    let finishRevocation: ((value: unknown) => void) | undefined;
    const readSession = vi.fn(async () => ({ status: "signed_out" }));
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        onAuthStateChange: (listener) => {
          notify = listener;
          return () => undefined;
        },
        readSession,
        revokeCurrentStaffSession: () =>
          new Promise((resolve) => {
            finishRevocation = resolve;
          }),
        signOut: async () => ({ status: "signed_out" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    const eventOrder: string[] = [];
    adapter.subscribe((event) => {
      eventOrder.push(`event:${JSON.stringify(event)}`);
    });
    const mutation = adapter.perform({
      operationId: firstOperationId,
      scope: "local",
      type: "sign_out",
    });

    eventOrder.push("before");
    notify();
    eventOrder.push("after");
    const read = adapter.read();

    expect(eventOrder).toEqual([
      "before",
      'event:{"kind":"revalidation_required"}',
      "after",
    ]);
    expect(readSession).not.toHaveBeenCalled();
    finishRevocation?.([{ code: "ok" }]);
    await mutation;
    await expect(read).resolves.toEqual({ kind: "signed_out" });
    expect(readSession).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("emits every auth invalidation synchronously and reads fresh authority only on request", async () => {
    let notify: () => void = () => undefined;
    let school = schoolId;
    let contextReads = 0;
    const readSession = vi.fn(async () => ({ status: "authenticated" }));
    const events: StaffAuthAccessEvent[] = [];
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
          currentAuthenticationMethods: ["password"],
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
        readSession,
      }),
      revokeBlobUrl: () => undefined,
    });
    const initial = await adapter.read();
    expect(initial).toMatchObject({
      identityGeneration: "10000000-0000-4000-8000-000000000002",
      sessionGeneration: "10000000-0000-4000-8000-000000000001",
    });
    adapter.subscribe((event) => events.push(event));
    school = "11000000-0000-4000-8000-000000000002";
    notify();
    expect(events).toEqual([{ kind: "revalidation_required" }]);
    notify();
    expect(events).toEqual([
      { kind: "revalidation_required" },
      { kind: "revalidation_required" },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(readSession).toHaveBeenCalledOnce();
    expect(contextReads).toBe(1);

    await expect(adapter.read()).resolves.toMatchObject({
      identity: { school: { id: school } },
      identityGeneration: "10000000-0000-4000-8000-000000000004",
      kind: "access_granted",
      sessionGeneration: "10000000-0000-4000-8000-000000000003",
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(contextReads).toBe(2);
    expect(events).toHaveLength(2);
    adapter.dispose();
  });

  it("keeps invalidation detail-free when a subsequent requested authority read fails", async () => {
    let notify: () => void = () => undefined;
    let contextReads = 0;
    const events: StaffAuthAccessEvent[] = [];
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
          currentAuthenticationMethods: ["password"],
          currentLevel: "aal1",
          nextLevel: "aal1",
        }),
        readCurrentContext: async () => {
          contextReads += 1;
          if (contextReads > 1) {
            throw new Error("SENTINEL-authority-read-failure");
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
    const initial = await adapter.read();
    if (initial.kind !== "access_granted") {
      throw new Error("expected initial authority");
    }
    adapter.subscribe((event) => events.push(event));

    notify();

    expect(events).toEqual([{ kind: "revalidation_required" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(contextReads).toBe(1);

    await expect(adapter.read()).rejects.toThrow(
      "SENTINEL-authority-read-failure",
    );
    expect(contextReads).toBe(2);
    expect(events).toEqual([{ kind: "revalidation_required" }]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
    adapter.dispose();
  });

  it("unsubscribes, ignores notifications, and rejects an in-flight read after disposal", async () => {
    let notify: () => void = () => undefined;
    const contextDeferred: { resolve?: (value: unknown) => void } = {};
    let contextReads = 0;
    const unsubscribeProvider = vi.fn();
    const events: StaffAuthAccessEvent[] = [];
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        onAuthStateChange: (listener) => {
          notify = listener;
          return unsubscribeProvider;
        },
        readAccount: async () => ({
          accountId,
          email: "teacher@example.test",
          emailVerified: true,
        }),
        readAssurance: async () => ({
          currentAuthenticationMethods: ["password"],
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
    expect(events).toEqual([{ kind: "revalidation_required" }]);
    expect(contextReads).toBe(1);
    const read = adapter.read();
    const readRejection = expect(read).rejects.toThrow("disposed");
    await vi.waitFor(() =>
      expect(contextDeferred.resolve).toBeTypeOf("function"),
    );
    adapter.dispose();
    adapter.dispose();
    notify();
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
    await readRejection;

    expect(unsubscribeProvider).toHaveBeenCalledOnce();
    expect(contextReads).toBe(2);
    expect(events).toEqual([{ kind: "revalidation_required" }]);
    await expect(adapter.read()).rejects.toThrow("disposed");
  });

  it("never coalesces or replays a credential-bearing operation ID", async () => {
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
    const mismatchedCredential = adapter.perform({
      ...request,
      password: "different-sentinel-not-retained",
    });
    expect(calls).toBe(1);
    await expect(duplicate).rejects.toThrow("reused");
    await expect(mismatchedCredential).rejects.toThrow("reused");
    signInDeferred.resolve?.({ status: "rejected" });
    await expect(first).resolves.toEqual({
      operationId: request.operationId,
      result: { kind: "sign_in_rejected" },
    });
    await expect(adapter.perform(request)).rejects.toThrow("requires re-entry");
    await expect(
      adapter.perform({
        operationId: request.operationId,
        type: "resend_email_verification",
      }),
    ).rejects.toThrow("reused");
    expect(JSON.stringify(adapter)).not.toContain("sentinel-not-retained");
    expect(JSON.stringify(adapter)).not.toContain(
      "different-sentinel-not-retained",
    );
    adapter.dispose();
  });

  it("binds a non-secret operation ID to its exact scope before coalescing", async () => {
    const revocationDeferred: { resolve?: (value: unknown) => void } = {};
    const revokeCurrentStaffSession = vi.fn(
      () =>
        new Promise((resolve) => {
          revocationDeferred.resolve = resolve;
        }),
    );
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: port({
        revokeCurrentStaffSession,
        signOut: async () => ({ status: "signed_out" }),
      }),
      revokeBlobUrl: () => undefined,
    });
    const operationId = "90000000-0000-4000-8000-000000000015";
    const request = {
      operationId,
      scope: "local" as const,
      type: "sign_out" as const,
    };
    const first = adapter.perform(request);
    const duplicate = adapter.perform(request);
    await expect(
      adapter.perform({ operationId, scope: "all", type: "sign_out" }),
    ).rejects.toThrow("reused");
    expect(revokeCurrentStaffSession).toHaveBeenCalledOnce();
    revocationDeferred.resolve?.([{ code: "ok" }]);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      {
        operationId,
        result: { kind: "sign_out_complete", scope: "local" },
      },
      {
        operationId,
        result: { kind: "sign_out_complete", scope: "local" },
      },
    ]);
    await expect(
      adapter.perform({ operationId, scope: "all", type: "sign_out" }),
    ).rejects.toThrow("reused");
    adapter.dispose();
  });

  it("rejects same-type operation reuse with a different School or target tuple", async () => {
    const revokeDeferred: { resolve?: (value: unknown) => void } = {};
    const adapter = createSupabaseStaffAuthAdapter({
      clock: { now: () => 1_788_300_000_000 },
      createBlobUrl: () => "blob:not-used",
      operationIds: operationIdSource(),
      port: ownerPort({
        readManageableStaff: async () => [
          {
            code: "ok",
            display_name: "Ada Admin",
            email: "ada@example.test",
            membership_role: "admin",
            profile_id: targetProfileId,
            school_id: schoolId,
          },
        ],
        revokeMembership: async () =>
          new Promise((resolve) => {
            revokeDeferred.resolve = resolve;
          }),
      }),
      revokeBlobUrl: () => undefined,
    });
    await adapter.read();
    const operationId = "90000000-0000-4000-8000-000000000016";
    const first = adapter.perform({
      operationId,
      profileId: targetProfileId,
      schoolId,
      type: "revoke_staff_membership",
    });
    await expect(
      adapter.perform({
        operationId,
        profileId: "21000000-0000-4000-8000-000000000003",
        schoolId: "11000000-0000-4000-8000-000000000002",
        type: "revoke_staff_membership",
      }),
    ).rejects.toThrow("reused");
    await vi.waitFor(() =>
      expect(revokeDeferred.resolve).toBeTypeOf("function"),
    );
    revokeDeferred.resolve?.([{ code: "membership_revoked" }]);
    await expect(first).resolves.toMatchObject({
      result: { kind: "staff_membership_revoked" },
    });
    adapter.dispose();
  });
});

describe("delivery result composition", () => {
  it.each(["unconfirmed", "rejected"] as const)(
    "keeps the Owner's %s dispatch outcome distinct from invitation denial",
    async (outcome) => {
      const invokeInvitation = vi.fn(async () => ({
        ok: false,
        code: `invitation_delivery_${outcome}`,
      }));
      const adapter = createSupabaseStaffAuthAdapter({
        clock: { now: () => Date.parse("2026-09-03T20:00:00.000Z") },
        createBlobUrl: () => "unused",
        operationIds: operationIdSource(),
        port: ownerPort({ invokeInvitation }),
        revokeBlobUrl: () => undefined,
      });
      const actor = await adapter.read();
      if (actor.kind !== "access_granted") throw new Error("expected Owner");
      const result = await adapter.perform({
        type: "create_staff_invitation",
        operationId: firstOperationId,
        email: "invited@example.test",
        schoolId,
        targetRole: "teacher",
        expectedIdentityGeneration: actor.identityGeneration,
        expectedSessionGeneration: actor.sessionGeneration,
      });
      expect(result).toMatchObject({
        result: { kind: "staff_invitation_delivery", outcome },
      });
      expect(invokeInvitation).toHaveBeenCalledOnce();
      adapter.dispose();
    },
  );
});
