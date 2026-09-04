import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backendUrl = "https://backend.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const schoolId = "11000000-0000-4000-8000-000000000001";
const profileId = "21000000-0000-4000-8000-000000000001";
const invitationId = "41000000-0000-4000-8000-000000000001";
const operationId = "51000000-0000-4000-8000-000000000001";
const accountId = "a1000000-0000-4000-8000-000000000001";
const recoveryTokenUrl = `${backendUrl}/auth/v1/token?grant_type=pkce`;

function recoveryResponse(
  body: BodyInit | null,
  init: ResponseInit,
  options: { readonly redirected?: boolean; readonly url?: string } = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", {
    configurable: false,
    enumerable: true,
    value: options.url ?? recoveryTokenUrl,
  });
  if (options.redirected !== undefined) {
    Object.defineProperty(response, "redirected", {
      configurable: false,
      enumerable: true,
      value: options.redirected,
    });
  }
  return response;
}

function authError(code: string): object {
  const error = { code };
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("provider message must not be inspected");
    },
  });
  return error;
}

function externalFailure(): { readonly data: null; readonly error: object } {
  return { data: null, error: { code: "unexpected_provider_failure" } };
}

function fakeClient(
  overrides: {
    readonly auth?: Partial<Omit<SupabaseStaffAuthClient["auth"], "mfa">> & {
      readonly mfa?: Partial<SupabaseStaffAuthClient["auth"]["mfa"]>;
    };
    readonly functions?: Partial<SupabaseStaffAuthClient["functions"]>;
    readonly schema?: SupabaseStaffAuthClient["schema"];
  } = {},
): SupabaseStaffAuthClient {
  const unsubscribe = vi.fn();
  const { mfa: mfaOverrides, ...authOverrides } = overrides.auth ?? {};
  const mfa: SupabaseStaffAuthClient["auth"]["mfa"] = {
    challenge: async () => externalFailure(),
    enroll: async () => externalFailure(),
    getAuthenticatorAssuranceLevel: async () => externalFailure(),
    listFactors: async () => externalFailure(),
    unenroll: async () => externalFailure(),
    verify: async () => externalFailure(),
    ...mfaOverrides,
  };
  const auth: SupabaseStaffAuthClient["auth"] = {
    exchangeCodeForSession: async () => externalFailure(),
    getSession: async () => externalFailure(),
    getUser: async () => externalFailure(),
    mfa,
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }),
    resend: async () => externalFailure(),
    setSession: async () => externalFailure(),
    signInWithPassword: async () => externalFailure(),
    signOut: async () => ({ error: { code: "unexpected_provider_failure" } }),
    updateUser: async () => externalFailure(),
    verifyOtp: async () => externalFailure(),
    ...authOverrides,
  };
  return {
    auth,
    functions: {
      invoke: async () => externalFailure(),
      ...overrides.functions,
    },
    schema:
      overrides.schema ??
      (() => ({
        rpc: async () => externalFailure(),
      })),
  };
}

function createPort(
  client: SupabaseStaffAuthClient,
  recoveryFetch: typeof fetch = async () => new Response(null, { status: 503 }),
) {
  return createSupabaseStaffAuthPort({
    client,
    fetch: recoveryFetch,
    origin: "https://app.example.test",
    publishableKey,
    url: backendUrl,
  });
}

describe("Supabase staff auth port", () => {
  it("uses only the desmoslock_v2 schema and maps every RPC to its exact arguments", async () => {
    const rpc = vi.fn(
      async (name: string, args?: Readonly<Record<string, unknown>>) => ({
        data: [{ args: args ?? null, name }],
        error: null,
      }),
    );
    const schema = vi.fn(() => ({ rpc }));
    const port = createPort(fakeClient({ schema }));

    await expect(port.readCurrentContext()).resolves.toEqual([
      { args: null, name: "current_staff_context" },
    ]);
    await port.readCurrentInvitations();
    await port.readManageableStaff();
    await port.readManageableInvitations();
    await port.acceptInvitation({
      displayName: "Taylor Teacher",
      invitationId,
    });
    await port.revokeInvitation({ invitationId });
    await port.revokeMembership({ profileId, schoolId });
    await port.revokeAllStaffSessions();
    await port.revokeCurrentStaffSession();
    await port.beginPasswordRecovery(operationId);
    await port.finishPasswordRecovery(operationId);

    expect(schema).toHaveBeenCalledTimes(1);
    expect(schema).toHaveBeenCalledWith("desmoslock_v2");
    expect(rpc.mock.calls).toEqual([
      ["current_staff_context"],
      ["current_staff_invitations"],
      ["current_manageable_staff"],
      ["current_manageable_staff_invitations"],
      [
        "accept_staff_invitation",
        { display_name: "Taylor Teacher", invitation_id: invitationId },
      ],
      ["revoke_staff_invitation", { invitation_id: invitationId }],
      ["revoke_membership", { profile_id: profileId, workspace_id: schoolId }],
      ["revoke_all_current_user_staff_sessions"],
      ["revoke_current_staff_session"],
      [
        "begin_staff_password_recovery",
        { requested_operation_id: operationId },
      ],
      ["finish_staff_password_recovery", { operation_id: operationId }],
    ]);
  });

  it("invokes the exact Edge functions and returns only parsed product responses", async () => {
    const invitationRequest = {
      email: "teacher@example.test",
      role: "teacher" as const,
      schoolId,
    };
    const recoveryRequest = {
      codeChallenge: "c".repeat(43),
      email: "teacher@example.test",
      flowId: "flow-1",
      state: "state-1",
    };
    const invoke = vi.fn(async (name: string) =>
      name === "staff-invitations"
        ? {
            data: { code: "invitation_created", ok: true },
            error: null,
          }
        : {
            data: { code: "recovery_requested", ok: true },
            error: null,
          },
    );
    const port = createPort(fakeClient({ functions: { invoke } }));

    await expect(port.invokeInvitation(invitationRequest)).resolves.toEqual({
      code: "invitation_created",
      ok: true,
    });
    await expect(port.invokeRecovery(recoveryRequest)).resolves.toEqual({
      code: "recovery_requested",
      ok: true,
    });
    expect(invoke.mock.calls).toEqual([
      ["staff-invitations", { body: invitationRequest }],
      ["account-recovery", { body: recoveryRequest }],
    ]);
  });

  it("recovers only sanitized non-2xx Edge envelopes and rejects malformed bodies", async () => {
    const invoke = vi
      .fn<SupabaseStaffAuthClient["functions"]["invoke"]>()
      .mockResolvedValueOnce({
        data: null,
        error: { context: "not exposed" },
        response: new Response(
          JSON.stringify({ code: "rate_limited", ok: false }),
          {
            headers: { "content-type": "application/json" },
            status: 429,
          },
        ),
      })
      .mockResolvedValueOnce({
        data: null,
        error: { context: "not exposed" },
        response: new Response(
          JSON.stringify({
            code: "recovery_requested",
            ok: true,
            providerDebug: "must not escape",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        ),
      });
    const port = createPort(fakeClient({ functions: { invoke } }));

    await expect(
      port.invokeInvitation({
        email: "teacher@example.test",
        role: "teacher",
        schoolId,
      }),
    ).resolves.toEqual({ code: "rate_limited", ok: false });
    await expect(
      port.invokeRecovery({
        codeChallenge: "c".repeat(43),
        email: "teacher@example.test",
        flowId: "flow-1",
        state: "state-1",
      }),
    ).resolves.toEqual({ code: "service_unavailable", ok: false });
  });

  it("normalizes session and trusted account reads without returning SDK objects", async () => {
    const sdkSession = { access_token: "synthetic-session-token" };
    const sdkUser = {
      email: "teacher@example.test",
      email_confirmed_at: "2026-09-03T12:00:00Z",
      id: accountId,
      privateMetadata: "must not escape",
    };
    const getSession = vi.fn(async () => ({
      data: { session: sdkSession },
      error: null,
    }));
    const getUser = vi.fn(async () => ({
      data: { user: sdkUser },
      error: null,
    }));
    const port = createPort(fakeClient({ auth: { getSession, getUser } }));

    await expect(port.readSession()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(port.readAccount()).resolves.toEqual({
      accountId,
      email: "teacher@example.test",
      emailVerified: true,
    });
    expect(getSession).toHaveBeenCalledWith();
    expect(getUser).toHaveBeenCalledWith();
  });

  it("maps absent and expired sessions to signed out and unknown failures to unavailable", async () => {
    const getSession = vi
      .fn<SupabaseStaffAuthClient["auth"]["getSession"]>()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: { session: null },
        error: authError("session_expired"),
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { getSession } }));

    await expect(port.readSession()).resolves.toEqual({
      status: "signed_out",
    });
    await expect(port.readSession()).resolves.toEqual({
      status: "signed_out",
    });
    await expect(port.readSession()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps sign-in errors only by stable auth code and sends exact credentials", async () => {
    const signInWithPassword = vi
      .fn<SupabaseStaffAuthClient["auth"]["signInWithPassword"]>()
      .mockResolvedValueOnce({
        data: { session: {}, user: {} },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("email_not_confirmed"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("invalid_credentials"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { signInWithPassword } }));
    const credentials = {
      email: "teacher@example.test",
      password: "synthetic password only",
    };

    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "authenticated",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "email_verification_required",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.signIn(credentials)).resolves.toEqual({
      status: "unavailable",
    });
    expect(signInWithPassword).toHaveBeenCalledTimes(4);
    expect(signInWithPassword).toHaveBeenNthCalledWith(1, credentials);
  });

  it("maps resend and invitation verification to exact SDK calls and sanitized statuses", async () => {
    const resend = vi.fn(async () => ({ data: {}, error: null }));
    const verifyOtp = vi
      .fn<SupabaseStaffAuthClient["auth"]["verifyOtp"]>()
      .mockResolvedValueOnce({
        data: {
          session: { access_token: "synthetic-session-token" },
          user: { email: "teacher@example.test", id: accountId },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("otp_expired"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("invite_not_found"),
      })
      .mockResolvedValueOnce({
        data: { session: null, user: null },
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { resend, verifyOtp } }));
    const tokenHash = "a".repeat(56);

    await expect(
      port.resendEmailVerification("teacher@example.test"),
    ).resolves.toEqual({ status: "sent" });
    expect(resend).toHaveBeenCalledWith({
      email: "teacher@example.test",
      options: {
        emailRedirectTo: "https://app.example.test/?auth=email-verification",
      },
      type: "signup",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      accountId,
      email: "teacher@example.test",
      status: "verified",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "expired",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "invalid",
    });
    await expect(port.verifyInvitationToken(tokenHash)).resolves.toEqual({
      status: "unavailable",
    });
    expect(verifyOtp).toHaveBeenNthCalledWith(1, {
      token_hash: tokenHash,
      type: "invite",
    });
  });

  it("exchanges email verification through the exact SDK-owned PKCE flow slot", async () => {
    const authorizationCode = "synthetic-email-verification-code";
    const flowId = "0123456789abcdef0123456789abcdef";
    const exchangeCodeForSession = vi
      .fn<SupabaseStaffAuthClient["auth"]["exchangeCodeForSession"]>()
      .mockResolvedValueOnce({
        data: { redirectType: null, session: {}, user: { id: accountId } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("flow_state_already_used"),
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("pkce_code_verifier_not_found"),
      })
      .mockResolvedValueOnce({
        data: { redirectType: null, session: null, user: null },
        error: authError("unexpected_failure"),
      });
    const port = createPort(fakeClient({ auth: { exchangeCodeForSession } }));

    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "rejected" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "rejected" });
    await expect(
      port.exchangeEmailVerificationCode({ authorizationCode, flowId }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(exchangeCodeForSession).toHaveBeenNthCalledWith(
      1,
      authorizationCode,
      { flowId },
    );
  });

  it("maps password updates and sign-out scopes without exposing auth failures", async () => {
    const updateUser = vi
      .fn<SupabaseStaffAuthClient["auth"]["updateUser"]>()
      .mockResolvedValueOnce({ data: { user: {} }, error: null })
      .mockResolvedValueOnce({
        data: { user: null },
        error: authError("weak_password"),
      })
      .mockResolvedValueOnce({
        data: { user: null },
        error: authError("unclassified_provider_failure"),
      });
    const signOut = vi.fn(async () => ({ error: null }));
    const port = createPort(fakeClient({ auth: { signOut, updateUser } }));

    await expect(
      port.updatePassword("synthetic replacement password"),
    ).resolves.toEqual({ status: "updated" });
    await expect(
      port.updatePassword("synthetic replacement password"),
    ).resolves.toEqual({ status: "rejected" });
    await expect(
      port.updatePassword("synthetic replacement password"),
    ).resolves.toEqual({ status: "unavailable" });
    expect(updateUser).toHaveBeenNthCalledWith(1, {
      password: "synthetic replacement password",
    });

    await expect(port.signOut("local")).resolves.toEqual({
      status: "signed_out",
    });
    await expect(port.signOut("all")).resolves.toEqual({
      status: "signed_out",
    });
    expect(signOut.mock.calls).toEqual([
      [{ scope: "local" }],
      [{ scope: "global" }],
    ]);
  });

  it("normalizes assurance, all TOTP factors, enrollment, challenge, verification, and removal", async () => {
    const factorId = "61000000-0000-4000-8000-000000000001";
    const unverifiedFactorId = "61000000-0000-4000-8000-000000000002";
    const challengeId = "71000000-0000-4000-8000-000000000001";
    const getAuthenticatorAssuranceLevel = vi.fn(async () => ({
      data: {
        currentAuthenticationMethods: [{ method: "password" }],
        currentLevel: "aal1",
        nextLevel: "aal2",
      },
      error: null,
    }));
    const listFactors = vi.fn(async () => ({
      data: {
        all: [
          {
            factor_type: "totp",
            id: factorId,
            status: "verified",
            updated_at: "not returned",
          },
          {
            factor_type: "totp",
            id: unverifiedFactorId,
            status: "unverified",
          },
          {
            factor_type: "phone",
            id: "61000000-0000-4000-8000-000000000003",
            status: "verified",
          },
        ],
        phone: [],
        totp: [],
        webauthn: [],
      },
      error: null,
    }));
    const enroll = vi.fn(async () => ({
      data: {
        id: unverifiedFactorId,
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E",
          secret: "synthetic-secret-must-not-escape",
          uri: "otpauth://synthetic-must-not-escape",
        },
        type: "totp",
      },
      error: null,
    }));
    const challenge = vi.fn(async () => ({
      data: { expires_at: 1_788_300_300, id: challengeId, type: "totp" },
      error: null,
    }));
    const verify = vi.fn(async () => ({
      data: {
        access_token: "synthetic-access-token-must-not-escape",
        expires_at: 1_788_303_600,
        expires_in: 3600,
        refresh_token: "synthetic-refresh-token-must-not-escape",
        token_type: "bearer",
        user: { id: accountId },
      },
      error: null,
    }));
    const unenroll = vi.fn(async () => ({
      data: { id: unverifiedFactorId },
      error: null,
    }));
    const port = createPort(
      fakeClient({
        auth: {
          mfa: {
            challenge,
            enroll,
            getAuthenticatorAssuranceLevel,
            listFactors,
            unenroll,
            verify,
          },
        },
      }),
    );

    await expect(port.readAssurance()).resolves.toEqual({
      currentLevel: "aal1",
      nextLevel: "aal2",
    });
    await expect(port.readTotpFactors()).resolves.toEqual({
      factors: [
        { factorId, status: "verified" },
        { factorId: unverifiedFactorId, status: "unverified" },
      ],
    });
    await expect(port.enrollTotp()).resolves.toEqual({
      factorId: unverifiedFactorId,
      qrCode: "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E",
      status: "enrolled",
    });
    await expect(port.challengeTotp(factorId)).resolves.toEqual({
      challengeId,
      status: "challenged",
    });
    await expect(
      port.verifyTotp({ challengeId, code: "123456", factorId }),
    ).resolves.toEqual({ status: "verified" });
    await expect(port.removeTotpFactor(unverifiedFactorId)).resolves.toEqual({
      status: "removed",
    });

    expect(enroll).toHaveBeenCalledWith({ factorType: "totp" });
    expect(challenge).toHaveBeenCalledWith({ factorId });
    expect(verify).toHaveBeenCalledWith({
      challengeId,
      code: "123456",
      factorId,
    });
    expect(unenroll).toHaveBeenCalledWith({ factorId: unverifiedFactorId });
  });

  it("maps known MFA verification failures to rejected and unknowns to unavailable", async () => {
    const verify = vi
      .fn<SupabaseStaffAuthClient["auth"]["mfa"]["verify"]>()
      .mockResolvedValueOnce({
        data: null,
        error: authError("mfa_verification_failed"),
      })
      .mockResolvedValueOnce({
        data: null,
        error: authError("unclassified_provider_failure"),
      });
    const port = createPort(fakeClient({ auth: { mfa: { verify } } }));
    const input = {
      challengeId: "71000000-0000-4000-8000-000000000001",
      code: "123456",
      factorId: "61000000-0000-4000-8000-000000000001",
    };

    await expect(port.verifyTotp(input)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.verifyTotp(input)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("exchanges an exact transient PKCE verifier once and installs only a decoded session", async () => {
    const accessToken = "synthetic-access-token";
    const refreshToken = "synthetic-refresh-token";
    const authorizationCode = "synthetic-authorization-code";
    const verifier = "v".repeat(43);
    const recoveryFetch = vi.fn(async () =>
      recoveryResponse(
        JSON.stringify({
          access_token: accessToken,
          expires_at: 1_788_303_600,
          expires_in: 3600,
          refresh_token: refreshToken,
          token_type: "bearer",
          user: { id: accountId },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );
    const setSession = vi.fn(async () => ({
      data: {
        session: { access_token: "sdk-session-must-not-escape" },
        user: { id: accountId },
      },
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({ authorizationCode, verifier }),
    ).resolves.toEqual({ status: "ready" });
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(recoveryFetch).toHaveBeenCalledWith(
      "https://backend.example.test/auth/v1/token?grant_type=pkce",
      {
        body: JSON.stringify({
          auth_code: authorizationCode,
          code_verifier: verifier,
        }),
        headers: {
          apikey: publishableKey,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
      },
    );
    expect(setSession).toHaveBeenCalledWith({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  });

  it("rejects known PKCE failures and treats malformed, extra, or failed session results as unavailable", async () => {
    const validTokenBody = {
      access_token: "synthetic-access-token",
      expires_in: 3600,
      refresh_token: "synthetic-refresh-token",
      token_type: "bearer",
      user: { id: accountId },
    };
    const recoveryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({
            error_code: "bad_code_verifier",
            msg: "synthetic",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({ ...validTokenBody, provider_debug: "not allowed" }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        recoveryResponse(JSON.stringify(validTokenBody), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        recoveryResponse(
          JSON.stringify({
            error_code: "unexpected_failure",
            msg: "synthetic",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        ),
      );
    const setSession = vi.fn(async () => ({
      data: { session: {}, user: {} },
      debug: "unexpected SDK field",
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );
    const input = {
      authorizationCode: "synthetic-authorization-code",
      verifier: "v".repeat(43),
    };

    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "rejected",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(port.exchangeRecoveryCode(input)).resolves.toEqual({
      status: "unavailable",
    });
    expect(setSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["flow_state_not_found", 404],
    ["flow_state_expired", 422],
    ["flow_state_already_used", 400],
  ] as const)(
    "treats stable %s PKCE failures as terminal regardless of HTTP status",
    async (errorCode, status) => {
      const recoveryFetch = vi.fn(async () =>
        recoveryResponse(
          JSON.stringify({ error_code: errorCode, msg: "synthetic" }),
          { headers: { "content-type": "application/json" }, status },
        ),
      );
      const setSession = vi.fn(async () => ({
        data: { session: {}, user: {} },
        error: null,
      }));
      const port = createPort(
        fakeClient({ auth: { setSession } }),
        recoveryFetch,
      );

      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "rejected" });
      expect(recoveryFetch).toHaveBeenCalledOnce();
      expect(setSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    [JSON.stringify({ error_code: "unknown_failure", msg: "synthetic" }), 400],
    [JSON.stringify({ code: "flow_state_expired" }), 422],
    ["not-json", 404],
    [
      JSON.stringify({
        error_code: "flow_state_expired",
        msg: "x".repeat(4_097),
      }),
      422,
    ],
  ] as const)(
    "keeps malformed or unknown PKCE failure payloads retryable",
    async (body, status) => {
      const port = createPort(
        fakeClient(),
        vi.fn(async () =>
          recoveryResponse(body, {
            headers: { "content-type": "application/json" },
            status,
          }),
        ),
      );
      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "unavailable" });
    },
  );

  it.each([
    { url: "https://redirected.example.test/auth/v1/token?grant_type=pkce" },
    { redirected: true },
  ])(
    "rejects a PKCE response outside the exact final URL boundary",
    async (options) => {
      const setSession = vi.fn(async () => ({
        data: { session: {}, user: {} },
        error: null,
      }));
      const port = createPort(
        fakeClient({ auth: { setSession } }),
        vi.fn(async () =>
          recoveryResponse(
            JSON.stringify({
              access_token: "synthetic-access-token",
              expires_in: 3600,
              refresh_token: "synthetic-refresh-token",
              token_type: "bearer",
              user: { id: accountId },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
            options,
          ),
        ),
      );
      await expect(
        port.exchangeRecoveryCode({
          authorizationCode: "synthetic-authorization-code",
          verifier: "v".repeat(43),
        }),
      ).resolves.toEqual({ status: "unavailable" });
      expect(setSession).not.toHaveBeenCalled();
    },
  );

  it("maps stable setSession authentication failures without retaining returned tokens", async () => {
    const recoveryFetch = vi.fn(async () =>
      recoveryResponse(
        JSON.stringify({
          access_token: "synthetic-access-token",
          expires_in: 3600,
          refresh_token: "synthetic-refresh-token",
          token_type: "bearer",
          user: { id: accountId },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );
    const setSession = vi.fn(async () => ({
      data: { session: null, user: null },
      error: authError("bad_jwt"),
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({
        authorizationCode: "synthetic-authorization-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("refuses PKCE redirects without retrying or installing a returned session", async () => {
    const recoveryFetch = vi.fn(
      async (...request: [RequestInfo | URL, RequestInit?]) => {
        void request;
        throw new TypeError("redirect mode is error");
      },
    );
    const setSession = vi.fn(async () => ({
      data: { session: {}, user: {} },
      error: null,
    }));
    const port = createPort(
      fakeClient({ auth: { setSession } }),
      recoveryFetch,
    );

    await expect(
      port.exchangeRecoveryCode({
        authorizationCode: "synthetic-authorization-code",
        verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(recoveryFetch).toHaveBeenCalledOnce();
    expect(recoveryFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(setSession).not.toHaveBeenCalled();
  });

  it("forwards auth state changes without event data and unsubscribes exactly once", () => {
    const unsubscribe = vi.fn();
    let sdkListener: ((event: unknown, session: unknown) => void) | undefined;
    const onAuthStateChange = vi.fn(
      (listener: (event: unknown, session: unknown) => void) => {
        sdkListener = listener;
        return { data: { subscription: { unsubscribe } } };
      },
    );
    const listener = vi.fn();
    const port = createPort(fakeClient({ auth: { onAuthStateChange } }));

    const stop = port.onAuthStateChange(listener);
    sdkListener?.("SIGNED_IN", { access_token: "must not escape" });
    expect(listener).toHaveBeenCalledWith();
    stop();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
