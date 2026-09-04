import { createClient } from "@supabase/supabase-js";

import type {
  AcceptStaffInvitationRequest,
  CreateStaffInvitationRequest,
  RequestStaffPasswordRecoveryRequest,
  RevokeStaffInvitationRequest,
  RevokeStaffMembershipRequest,
} from "@desmoslock/contracts";
import {
  parseCreateStaffInvitationResponse,
  parseRequestStaffPasswordRecoveryResponse,
} from "@desmoslock/contracts";

import type { PublicWebConfiguration } from "../public-config.js";
import type { SupabaseStaffAuthPort } from "./supabase-staff-auth-adapter.js";

interface SupabaseExternalResult {
  readonly data: unknown;
  readonly error: unknown;
  readonly response?: Response;
}

interface SupabaseExternalErrorResult {
  readonly error: unknown;
}

/** The small, pinned supabase-js surface used by this adapter. */
export interface SupabaseStaffAuthClient {
  readonly auth: {
    readonly mfa: {
      challenge(input: {
        readonly factorId: string;
      }): PromiseLike<SupabaseExternalResult>;
      enroll(input: {
        readonly factorType: "totp";
      }): PromiseLike<SupabaseExternalResult>;
      getAuthenticatorAssuranceLevel(): PromiseLike<SupabaseExternalResult>;
      listFactors(): PromiseLike<SupabaseExternalResult>;
      unenroll(input: {
        readonly factorId: string;
      }): PromiseLike<SupabaseExternalResult>;
      verify(input: {
        readonly challengeId: string;
        readonly code: string;
        readonly factorId: string;
      }): PromiseLike<SupabaseExternalResult>;
    };
    getSession(): PromiseLike<SupabaseExternalResult>;
    getUser(): PromiseLike<SupabaseExternalResult>;
    onAuthStateChange(listener: (event: unknown, session: unknown) => void): {
      readonly data: {
        readonly subscription: { unsubscribe(): void };
      };
    };
    resend(input: {
      readonly email: string;
      readonly type: "signup";
    }): PromiseLike<SupabaseExternalResult>;
    setSession(input: {
      readonly access_token: string;
      readonly refresh_token: string;
    }): PromiseLike<SupabaseExternalResult>;
    signInWithPassword(input: {
      readonly email: string;
      readonly password: string;
    }): PromiseLike<SupabaseExternalResult>;
    signOut(input: {
      readonly scope: "global" | "local";
    }): PromiseLike<SupabaseExternalErrorResult>;
    updateUser(input: {
      readonly password: string;
    }): PromiseLike<SupabaseExternalResult>;
    verifyOtp(input: {
      readonly token_hash: string;
      readonly type: "invite";
    }): PromiseLike<SupabaseExternalResult>;
  };
  readonly functions: {
    invoke(
      name: string,
      options: { readonly body: unknown },
    ): PromiseLike<SupabaseExternalResult>;
  };
  schema(name: string): {
    rpc(
      name: string,
      args?: Readonly<Record<string, unknown>>,
    ): PromiseLike<SupabaseExternalResult>;
  };
}

type RecoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ExternalResultSnapshot {
  readonly data: unknown;
  readonly error: unknown;
}

function ownDataProperty(
  value: unknown,
  key: PropertyKey,
): { readonly value: unknown } | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? { value: descriptor.value as unknown }
      : null;
  } catch {
    return null;
  }
}

function externalResult(value: unknown): ExternalResultSnapshot | null {
  const data = ownDataProperty(value, "data");
  const error = ownDataProperty(value, "error");
  return data === null || error === null
    ? null
    : { data: data.value, error: error.value };
}

function authErrorCode(error: unknown): string | null {
  const code = ownDataProperty(error, "code");
  return code !== null && typeof code.value === "string" ? code.value : null;
}

function objectProperty(value: unknown, key: string): unknown {
  const property = ownDataProperty(value, key);
  return property === null ? undefined : property.value;
}

function isNonArrayObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  try {
    if (!isNonArrayObject(value)) return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[key] = descriptor.value as unknown;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function isOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
    })
  );
}

function decodeDirectPkceTokens(value: unknown): {
  readonly accessToken: string;
  readonly refreshToken: string;
} | null {
  const response = snapshotExactRecord(
    value,
    ["access_token", "expires_in", "refresh_token", "token_type", "user"],
    ["expires_at"],
  );
  if (
    response === null ||
    !isOpaqueToken(response.access_token) ||
    !isOpaqueToken(response.refresh_token) ||
    response.token_type !== "bearer" ||
    typeof response.expires_in !== "number" ||
    !Number.isInteger(response.expires_in) ||
    response.expires_in <= 0 ||
    !isNonArrayObject(response.user) ||
    (response.expires_at !== undefined &&
      (typeof response.expires_at !== "number" ||
        !Number.isInteger(response.expires_at) ||
        response.expires_at <= 0))
  ) {
    return null;
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
  };
}

function isSignedOutAuthError(code: string | null): boolean {
  return (
    code === "refresh_token_already_used" ||
    code === "refresh_token_not_found" ||
    code === "session_expired" ||
    code === "session_not_found"
  );
}

function isRejectedSignInError(code: string | null): boolean {
  return (
    code === "email_address_invalid" ||
    code === "invalid_credentials" ||
    code === "user_banned"
  );
}

function isRejectedPasswordError(code: string | null): boolean {
  return (
    code === "reauthentication_needed" ||
    code === "reauthentication_not_valid" ||
    code === "same_password" ||
    code === "weak_password"
  );
}

function isRejectedMfaVerificationError(code: string | null): boolean {
  return (
    code === "mfa_challenge_expired" ||
    code === "mfa_factor_not_found" ||
    code === "mfa_ip_address_mismatch" ||
    code === "mfa_verification_failed" ||
    code === "mfa_verification_rejected"
  );
}

function isRejectedSessionInstallError(code: string | null): boolean {
  return (
    code === "bad_jwt" ||
    code === "invalid_credentials" ||
    code === "refresh_token_already_used" ||
    code === "refresh_token_not_found" ||
    code === "session_expired" ||
    code === "session_not_found"
  );
}

function decodeSetSessionResult(
  value: unknown,
): "ready" | "rejected" | "unavailable" {
  const result = snapshotExactRecord(value, ["data", "error"]);
  if (result === null) return "unavailable";
  if (result.error !== null) {
    return isRejectedSessionInstallError(authErrorCode(result.error))
      ? "rejected"
      : "unavailable";
  }
  const data = snapshotExactRecord(result.data, ["session", "user"]);
  return data !== null &&
    isNonArrayObject(data.session) &&
    isNonArrayObject(data.user)
    ? "ready"
    : "unavailable";
}

function invitationFailureStatus(
  code: string | null,
): "expired" | "invalid" | "unavailable" {
  if (code === "otp_expired") return "expired";
  if (
    code === "bad_jwt" ||
    code === "invalid_credentials" ||
    code === "invite_not_found" ||
    code === "otp_disabled"
  ) {
    return "invalid";
  }
  return "unavailable";
}

export interface SupabaseStaffAuthPortDependencies {
  readonly client: SupabaseStaffAuthClient;
  readonly fetch: RecoveryFetch;
  readonly publishableKey: string;
  readonly url: string;
}

export function createSupabaseStaffAuthPort(
  dependencies: SupabaseStaffAuthPortDependencies,
): SupabaseStaffAuthPort {
  const database = dependencies.client.schema("desmoslock_v2");

  async function rpc(
    name: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    try {
      const result =
        args === undefined
          ? await database.rpc(name)
          : await database.rpc(name, args);
      const snapshot = externalResult(result);
      return snapshot?.error === null ? snapshot.data : null;
    } catch {
      return null;
    }
  }

  async function invokeProductFunction(
    name: "account-recovery" | "staff-invitations",
    body: unknown,
    parse: (value: unknown) => { readonly ok: boolean } | null,
  ): Promise<unknown> {
    try {
      const result = await dependencies.client.functions.invoke(name, { body });
      const snapshot = externalResult(result);
      if (snapshot?.error === null) {
        return (
          parse(snapshot.data) ?? { code: "service_unavailable", ok: false }
        );
      }
      const response = ownDataProperty(result, "response")?.value;
      if (response instanceof Response && !response.ok) {
        const parsed = parse(await response.clone().json());
        if (parsed !== null && !parsed.ok) return parsed;
      }
    } catch {
      // External failures are intentionally reduced to the public product code.
    }
    return { code: "service_unavailable", ok: false };
  }

  return {
    acceptInvitation(request: AcceptStaffInvitationRequest) {
      return rpc("accept_staff_invitation", {
        display_name: request.displayName,
        invitation_id: request.invitationId,
      });
    },
    beginPasswordRecovery(requestedOperationId: string) {
      return rpc("begin_staff_password_recovery", {
        requested_operation_id: requestedOperationId,
      });
    },
    async challengeTotp(factorId: string) {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.challenge({ factorId }),
        );
        if (result === null || result.error !== null) {
          return { status: "unavailable" };
        }
        const challengeId = objectProperty(result.data, "id");
        const expiresAt = objectProperty(result.data, "expires_at");
        const type = objectProperty(result.data, "type");
        return typeof challengeId === "string" &&
          type === "totp" &&
          typeof expiresAt === "number" &&
          Number.isFinite(expiresAt)
          ? { challengeId, status: "challenged" }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
    async enrollTotp() {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.enroll({ factorType: "totp" }),
        );
        if (result === null || result.error !== null) {
          return { status: "unavailable" };
        }
        const factorId = objectProperty(result.data, "id");
        const type = objectProperty(result.data, "type");
        const totp = objectProperty(result.data, "totp");
        const qrCode = objectProperty(totp, "qr_code");
        return typeof factorId === "string" &&
          type === "totp" &&
          typeof qrCode === "string"
          ? { factorId, qrCode, status: "enrolled" }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
    async exchangeRecoveryCode(input: {
      readonly authorizationCode: string;
      readonly verifier: string;
    }) {
      try {
        const tokenUrl = new URL(
          "/auth/v1/token?grant_type=pkce",
          dependencies.url,
        ).toString();
        const response = await dependencies.fetch(tokenUrl, {
          body: JSON.stringify({
            auth_code: input.authorizationCode,
            code_verifier: input.verifier,
          }),
          headers: {
            apikey: dependencies.publishableKey,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
        });
        if (!response.ok) {
          return {
            status:
              response.status === 400 || response.status === 401
                ? "rejected"
                : "unavailable",
          };
        }
        if (
          response.status !== 200 ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          return { status: "unavailable" };
        }
        const tokens = decodeDirectPkceTokens(await response.json());
        if (tokens === null) return { status: "unavailable" };
        const installed = decodeSetSessionResult(
          await dependencies.client.auth.setSession({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          }),
        );
        return { status: installed };
      } catch (error: unknown) {
        return {
          status: isRejectedSessionInstallError(authErrorCode(error))
            ? "rejected"
            : "unavailable",
        };
      }
    },
    finishPasswordRecovery(operationId: string) {
      return rpc("finish_staff_password_recovery", {
        operation_id: operationId,
      });
    },
    invokeInvitation(request: CreateStaffInvitationRequest) {
      return invokeProductFunction(
        "staff-invitations",
        request,
        parseCreateStaffInvitationResponse,
      );
    },
    invokeRecovery(request: RequestStaffPasswordRecoveryRequest) {
      return invokeProductFunction(
        "account-recovery",
        request,
        parseRequestStaffPasswordRecoveryResponse,
      );
    },
    onAuthStateChange(listener: () => void) {
      const { subscription } = dependencies.client.auth.onAuthStateChange(() =>
        listener(),
      ).data;
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscription.unsubscribe();
      };
    },
    async readAccount() {
      try {
        const result = externalResult(await dependencies.client.auth.getUser());
        if (result === null || result.error !== null) return null;
        const user = objectProperty(result.data, "user");
        if (!isNonArrayObject(user)) return null;
        const accountId = objectProperty(user, "id");
        const email = objectProperty(user, "email");
        const confirmedAt = ownDataProperty(user, "email_confirmed_at");
        if (
          typeof accountId !== "string" ||
          typeof email !== "string" ||
          (confirmedAt !== null &&
            confirmedAt.value !== null &&
            typeof confirmedAt.value !== "string")
        ) {
          return null;
        }
        return {
          accountId,
          email,
          emailVerified:
            confirmedAt !== null &&
            typeof confirmedAt.value === "string" &&
            confirmedAt.value.length > 0,
        };
      } catch {
        return null;
      }
    },
    async readAssurance() {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.getAuthenticatorAssuranceLevel(),
        );
        if (result === null || result.error !== null) return null;
        const currentLevel = objectProperty(result.data, "currentLevel");
        const nextLevel = objectProperty(result.data, "nextLevel");
        if (
          (currentLevel !== "aal1" && currentLevel !== "aal2") ||
          (nextLevel !== "aal1" && nextLevel !== "aal2")
        ) {
          return null;
        }
        return { currentLevel, nextLevel };
      } catch {
        return null;
      }
    },
    readCurrentContext() {
      return rpc("current_staff_context");
    },
    readCurrentInvitations() {
      return rpc("current_staff_invitations");
    },
    readManageableInvitations() {
      return rpc("current_manageable_staff_invitations");
    },
    readManageableStaff() {
      return rpc("current_manageable_staff");
    },
    async readSession() {
      try {
        const result = externalResult(
          await dependencies.client.auth.getSession(),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          return {
            status: isSignedOutAuthError(authErrorCode(result.error))
              ? "signed_out"
              : "unavailable",
          };
        }
        const session = objectProperty(result.data, "session");
        return {
          status:
            session === null
              ? "signed_out"
              : isNonArrayObject(session)
                ? "authenticated"
                : "unavailable",
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    async readTotpFactors() {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.listFactors(),
        );
        if (result === null || result.error !== null) return null;
        const all = objectProperty(result.data, "all");
        if (!Array.isArray(all)) return null;
        const factors: Array<{
          readonly factorId: string;
          readonly status: "unverified" | "verified";
        }> = [];
        for (const factor of all) {
          if (!isNonArrayObject(factor)) return null;
          if (objectProperty(factor, "factor_type") !== "totp") continue;
          const factorId = objectProperty(factor, "id");
          const status = objectProperty(factor, "status");
          if (
            typeof factorId !== "string" ||
            (status !== "unverified" && status !== "verified")
          ) {
            return null;
          }
          factors.push({ factorId, status });
        }
        return { factors };
      } catch {
        return null;
      }
    },
    async removeTotpFactor(factorId: string) {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.unenroll({ factorId }),
        );
        return result !== null &&
          result.error === null &&
          objectProperty(result.data, "id") === factorId
          ? { status: "removed" }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
    async resendEmailVerification(email: string) {
      try {
        const result = externalResult(
          await dependencies.client.auth.resend({ email, type: "signup" }),
        );
        if (result?.error === null) return { status: "sent" };
        const code = result === null ? null : authErrorCode(result.error);
        return {
          status:
            code === "email_address_invalid" ||
            code === "over_email_send_rate_limit" ||
            code === "over_request_rate_limit" ||
            code === "user_banned"
              ? "rejected"
              : "unavailable",
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    revokeAllStaffSessions() {
      return rpc("revoke_all_current_user_staff_sessions");
    },
    revokeCurrentStaffSession() {
      return rpc("revoke_current_staff_session");
    },
    revokeInvitation(request: RevokeStaffInvitationRequest) {
      return rpc("revoke_staff_invitation", {
        invitation_id: request.invitationId,
      });
    },
    revokeMembership(request: RevokeStaffMembershipRequest) {
      return rpc("revoke_membership", {
        profile_id: request.profileId,
        workspace_id: request.schoolId,
      });
    },
    async signIn(input: { readonly email: string; readonly password: string }) {
      try {
        const result = externalResult(
          await dependencies.client.auth.signInWithPassword(input),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          const code = authErrorCode(result.error);
          return {
            status:
              code === "email_not_confirmed"
                ? "email_verification_required"
                : isRejectedSignInError(code)
                  ? "rejected"
                  : "unavailable",
          };
        }
        const session = objectProperty(result.data, "session");
        const user = objectProperty(result.data, "user");
        return {
          status:
            isNonArrayObject(session) && isNonArrayObject(user)
              ? "authenticated"
              : "unavailable",
        };
      } catch (error: unknown) {
        const code = authErrorCode(error);
        return {
          status:
            code === "email_not_confirmed"
              ? "email_verification_required"
              : isRejectedSignInError(code)
                ? "rejected"
                : "unavailable",
        };
      }
    },
    async signOut(scope: "all" | "local") {
      try {
        const result = await dependencies.client.auth.signOut({
          scope: scope === "all" ? "global" : "local",
        });
        const error = ownDataProperty(result, "error");
        if (
          error !== null &&
          (error.value === null ||
            isSignedOutAuthError(authErrorCode(error.value)))
        ) {
          return { status: "signed_out" };
        }
      } catch {
        // Unexpected provider errors are intentionally collapsed.
      }
      return { status: "unavailable" };
    },
    async updatePassword(password: string) {
      try {
        const result = externalResult(
          await dependencies.client.auth.updateUser({ password }),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          return {
            status: isRejectedPasswordError(authErrorCode(result.error))
              ? "rejected"
              : "unavailable",
          };
        }
        return {
          status: isNonArrayObject(objectProperty(result.data, "user"))
            ? "updated"
            : "unavailable",
        };
      } catch (error: unknown) {
        return {
          status: isRejectedPasswordError(authErrorCode(error))
            ? "rejected"
            : "unavailable",
        };
      }
    },
    async verifyInvitationToken(tokenHash: string) {
      try {
        const result = externalResult(
          await dependencies.client.auth.verifyOtp({
            token_hash: tokenHash,
            type: "invite",
          }),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          return {
            status: invitationFailureStatus(authErrorCode(result.error)),
          };
        }
        const session = objectProperty(result.data, "session");
        const user = objectProperty(result.data, "user");
        if (!isNonArrayObject(session) || !isNonArrayObject(user)) {
          return { status: "unavailable" };
        }
        const accountId = objectProperty(user, "id");
        const email = objectProperty(user, "email");
        return typeof accountId === "string" && typeof email === "string"
          ? { accountId, email, status: "verified" }
          : { status: "unavailable" };
      } catch (error: unknown) {
        return { status: invitationFailureStatus(authErrorCode(error)) };
      }
    },
    async verifyTotp(input: {
      readonly challengeId: string;
      readonly code: string;
      readonly factorId: string;
    }) {
      try {
        const result = externalResult(
          await dependencies.client.auth.mfa.verify(input),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          return {
            status: isRejectedMfaVerificationError(authErrorCode(result.error))
              ? "rejected"
              : "unavailable",
          };
        }
        const verified = snapshotExactRecord(
          result.data,
          ["access_token", "expires_in", "refresh_token", "token_type", "user"],
          ["expires_at"],
        );
        return {
          status:
            verified !== null &&
            isOpaqueToken(verified.access_token) &&
            typeof verified.expires_in === "number" &&
            Number.isInteger(verified.expires_in) &&
            verified.expires_in > 0 &&
            (verified.expires_at === undefined ||
              (typeof verified.expires_at === "number" &&
                Number.isInteger(verified.expires_at) &&
                verified.expires_at > 0)) &&
            isOpaqueToken(verified.refresh_token) &&
            verified.token_type === "bearer" &&
            isNonArrayObject(verified.user)
              ? "verified"
              : "unavailable",
        };
      } catch (error: unknown) {
        return {
          status: isRejectedMfaVerificationError(authErrorCode(error))
            ? "rejected"
            : "unavailable",
        };
      }
    },
  };
}

export function createProductionSupabaseStaffAuthPort(
  configuration: Pick<PublicWebConfiguration, "publishableKey" | "url">,
  fetchImplementation: RecoveryFetch = globalThis.fetch,
): SupabaseStaffAuthPort {
  const client = createClient(configuration.url, configuration.publishableKey, {
    auth: { detectSessionInUrl: false, flowType: "pkce" },
    db: { schema: "desmoslock_v2" },
    global: { fetch: fetchImplementation },
  });
  return createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: fetchImplementation,
    publishableKey: configuration.publishableKey,
    url: configuration.url,
  });
}
