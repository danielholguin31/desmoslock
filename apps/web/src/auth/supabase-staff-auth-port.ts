import { createClient } from "@supabase/supabase-js";

import type {
  AcceptStaffInvitationRequest,
  ChangeStaffMembershipRoleRequest,
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

interface SupabaseExternalRpcRequest extends PromiseLike<SupabaseExternalResult> {
  abortSignal?(signal: AbortSignal): PromiseLike<SupabaseExternalResult>;
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
    exchangeCodeForSession(
      authorizationCode: string,
      options: { readonly flowId: string },
    ): PromiseLike<SupabaseExternalResult>;
    getSession(): PromiseLike<SupabaseExternalResult>;
    getUser(): PromiseLike<SupabaseExternalResult>;
    onAuthStateChange(listener: (event: unknown, session: unknown) => void): {
      readonly data: {
        readonly subscription: { unsubscribe(): void };
      };
    };
    resend(input: {
      readonly email: string;
      readonly options: { readonly emailRedirectTo: string };
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
    ): SupabaseExternalRpcRequest;
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

function snapshotBoundedArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const names = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumLength ||
      names.length !== length + 1
    ) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return names.some(
      (name) =>
        typeof name !== "string" ||
        (name !== "length" &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(name) || Number(name) >= length)),
    )
      ? null
      : snapshot;
  } catch {
    return null;
  }
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

function hasUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function validAuthenticationMethod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= 128 &&
    !hasUnsafeText(value)
  );
}

function decodeAuthenticationMethods(value: unknown): readonly string[] | null {
  const methods = snapshotBoundedArray(value, 32);
  if (methods === null) return null;
  if (methods.length === 0) return [];
  if (methods.every(validAuthenticationMethod)) {
    return methods as readonly string[];
  }
  if (methods.some((method) => typeof method === "string")) {
    return null;
  }
  const decoded: string[] = [];
  for (const method of methods) {
    const entry = snapshotExactRecord(method, ["method", "timestamp"]);
    if (
      entry === null ||
      !validAuthenticationMethod(entry.method) ||
      typeof entry.timestamp !== "number" ||
      !Number.isFinite(entry.timestamp) ||
      entry.timestamp < 0
    ) {
      return null;
    }
    decoded.push(entry.method);
  }
  return decoded;
}

function sanitizeFactorFriendlyName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .split("")
    .map((character) => (hasUnsafeText(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return null;
  return [...normalized].slice(0, 80).join("");
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

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown | null> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return null;
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const cancel = () => {
    // A broken stream's cancellation must not hold up the deadline.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (signal.aborted) {
      cancel();
      return null;
    }
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) return null;
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    return null;
  }
}

function decodeDirectPkceFailureCode(value: unknown): string | null {
  const current = snapshotExactRecord(value, ["code", "message"]);
  if (
    current !== null &&
    typeof current.code === "string" &&
    typeof current.message === "string"
  ) {
    return current.code;
  }
  const legacy = snapshotExactRecord(value, ["error_code", "msg"]);
  return legacy !== null &&
    typeof legacy.error_code === "string" &&
    typeof legacy.msg === "string"
    ? legacy.error_code
    : null;
}

function isRejectedDirectPkceCode(code: string | null): boolean {
  return (
    code === "bad_code_verifier" ||
    code === "flow_state_already_used" ||
    code === "flow_state_expired" ||
    code === "flow_state_not_found"
  );
}

function isExpectedDirectResponse(response: Response, url: string): boolean {
  return response.redirected === false && response.url === url;
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

function isRejectedEmailVerificationExchangeError(
  code: string | null,
): boolean {
  return (
    code === "bad_code_verifier" ||
    code === "flow_state_already_used" ||
    code === "flow_state_expired" ||
    code === "flow_state_not_found" ||
    code === "pkce_code_verifier_not_found" ||
    code === "otp_expired"
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
  readonly origin: string;
  readonly publishableKey: string;
  readonly url: string;
}

export function createSupabaseStaffAuthPort(
  dependencies: SupabaseStaffAuthPortDependencies,
): SupabaseStaffAuthPort {
  const database = dependencies.client.schema("desmoslock_v2");
  let recoveryAuthority: {
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  function clearRecoveryAuthority(): void {
    if (recoveryAuthority !== null) clearTimeout(recoveryAuthority.timeout);
    recoveryAuthority = null;
  }

  let authorityGeneration = 0;
  type AuthorityPurpose = "password" | "staff_management";
  const capturedAuthorities = new Map<
    string,
    {
      readonly accessToken: string;
      readonly accountId: string;
      readonly expiresAt: number;
      readonly purpose: AuthorityPurpose;
      readonly timeout: ReturnType<typeof setTimeout>;
      passwordAttempted: boolean;
    }
  >();

  function releaseCapturedAuthority(handle: string): void {
    const authority = capturedAuthorities.get(handle);
    if (authority === undefined) return;
    clearTimeout(authority.timeout);
    capturedAuthorities.delete(handle);
  }

  function capturedAuthority(handle: string, purpose: AuthorityPurpose) {
    const authority = capturedAuthorities.get(handle);
    if (authority === undefined || authority.purpose !== purpose) return null;
    if (Date.now() >= authority.expiresAt) {
      releaseCapturedAuthority(handle);
      return null;
    }
    return authority;
  }

  function passwordAuthority(handle: string) {
    return capturedAuthority(handle, "password");
  }

  function releasePasswordAuthority(handle: string): void {
    if (capturedAuthorities.get(handle)?.purpose === "password") {
      releaseCapturedAuthority(handle);
    }
  }

  function releaseStaffManagementAuthority(handle: string): void {
    if (capturedAuthorities.get(handle)?.purpose === "staff_management") {
      releaseCapturedAuthority(handle);
    }
  }

  async function directAuthorityRequest(
    accessToken: string,
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown } | null> {
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = new URL(path, dependencies.url).toString();
      const request = async () => {
        const response = await dependencies.fetch(url, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: "omit",
          headers: {
            apikey: dependencies.publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            ...(path.startsWith("/rest/v1/")
              ? { "content-profile": "desmoslock_v2" }
              : path.startsWith("/functions/v1/")
                ? { "x-client-info": "desmoslock-web" }
                : { "x-supabase-api-version": "2024-01-01" }),
          },
          method,
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: abort.signal,
        });
        if (abort.signal.aborted || !isExpectedDirectResponse(response, url)) {
          void response.body?.cancel().catch(() => undefined);
          return null;
        }
        if (
          response.status === 204 ||
          (path.startsWith("/auth/v1/logout?") && response.ok)
        ) {
          return { body: null, status: response.status };
        }
        const result = await readBoundedJson(
          response,
          response.ok ? 65_536 : 4_096,
          abort.signal,
        );
        return abort.signal.aborted
          ? null
          : { body: result, status: response.status };
      };
      return await Promise.race([
        request(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            resolve(null);
            abort.abort();
          }, 5_000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  }

  async function authorityRpc(
    handle: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const authority = passwordAuthority(handle);
    if (authority === null) return null;
    const result = await directAuthorityRequest(
      authority.accessToken,
      `/rest/v1/rpc/${name}`,
      "POST",
      args,
    );
    return result?.status === 200 ? result.body : null;
  }

  async function staffManagementRpc(
    handle: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const authority = capturedAuthority(handle, "staff_management");
    if (authority === null) return null;
    const result = await directAuthorityRequest(
      authority.accessToken,
      `/rest/v1/rpc/${name}`,
      "POST",
      args,
    );
    return result?.status === 200 ? result.body : null;
  }

  async function snapshotSessionAuthority(): Promise<
    | {
        readonly status: "ready";
        readonly accessToken: string;
        readonly accountId: string;
      }
    | { readonly status: "ended" | "unavailable" }
  > {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = externalResult(
        await Promise.race([
          Promise.resolve(dependencies.client.auth.getSession()),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 5_000);
          }),
        ]),
      );
      if (result?.error !== null) return { status: "unavailable" };
      const session = ownDataProperty(result.data, "session");
      if (session?.value === null) return { status: "ended" };
      const accessToken = objectProperty(session?.value, "access_token");
      const accountId = objectProperty(
        objectProperty(session?.value, "user"),
        "id",
      );
      return isOpaqueToken(accessToken) &&
        typeof accountId === "string" &&
        accountId.length > 0
        ? { accessToken, accountId, status: "ready" }
        : { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  function isEndedAuthorityResponse(
    result: Awaited<ReturnType<typeof directAuthorityRequest>>,
  ): boolean {
    if (result === null || (result.status !== 401 && result.status !== 403)) {
      return false;
    }
    const code = decodeDirectPkceFailureCode(result.body);
    return code === "session_not_found" || code === "session_expired";
  }

  async function boundedAuthorityRead(
    read: (signal: AbortSignal) => PromiseLike<unknown>,
  ): Promise<unknown> {
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Release the caller even when an SDK operation ignores cancellation.
      // SDK-owned session refresh may still finish internally; its late result
      // cannot resume this authority read or publish an old access grant.
      return await Promise.race([
        Promise.resolve().then(() => read(abort.signal)),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            resolve(null);
            abort.abort();
          }, 5_000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  }

  async function readAuthorityRpc(
    name:
      | "current_staff_context"
      | "current_staff_invitations"
      | "current_manageable_staff"
      | "current_manageable_staff_invitations",
  ): Promise<unknown> {
    const result = await boundedAuthorityRead((signal) => {
      const request = database.rpc(name);
      return request.abortSignal === undefined
        ? request
        : request.abortSignal(signal);
    });
    const snapshot = externalResult(result);
    return snapshot?.error === null ? snapshot.data : null;
  }

  async function invokeProductFunction(
    name: "account-recovery",
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

  async function captureAccountAuthority(
    expectedAccountId: string,
    purpose: AuthorityPurpose,
  ) {
    const generation = authorityGeneration;
    try {
      const snapshot = await snapshotSessionAuthority();
      if (generation !== authorityGeneration) return { status: "unavailable" };
      if (snapshot.status !== "ready") return { status: snapshot.status };
      if (snapshot.accountId !== expectedAccountId) {
        return { status: "rejected" };
      }
      const verified = await directAuthorityRequest(
        snapshot.accessToken,
        "/auth/v1/user",
        "GET",
      );
      if (generation !== authorityGeneration) return { status: "unavailable" };
      if (isEndedAuthorityResponse(verified)) return { status: "ended" };
      if (verified?.status !== 200) return { status: "unavailable" };
      const accountId = objectProperty(
        objectProperty(verified.body, "user") ?? verified.body,
        "id",
      );
      if (typeof accountId !== "string" || accountId.length === 0) {
        return { status: "unavailable" };
      }
      if (accountId !== snapshot.accountId) return { status: "rejected" };
      if (capturedAuthorities.size >= 16) return { status: "unavailable" };
      const handle = crypto.randomUUID();
      capturedAuthorities.set(handle, {
        accessToken: snapshot.accessToken,
        accountId,
        expiresAt: Date.now() + 60_000,
        passwordAttempted: false,
        purpose,
        timeout: setTimeout(() => releaseCapturedAuthority(handle), 60_000),
      });
      return { authorityHandle: handle, status: "ready" };
    } catch {
      return { status: "unavailable" };
    }
  }

  return {
    captureSignOutAuthority(expectedAccountId: string) {
      return captureAccountAuthority(expectedAccountId, "password");
    },
    captureStaffManagementAuthority(expectedAccountId: string) {
      return captureAccountAuthority(expectedAccountId, "staff_management");
    },
    releaseStaffManagementAuthority,
    clearPrivateAuthContinuations() {
      authorityGeneration += 1;
      clearRecoveryAuthority();
      for (const handle of capturedAuthorities.keys()) {
        releaseCapturedAuthority(handle);
      }
    },
    async capturePasswordAuthority(expectedAccountId?: string) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const recovery =
          expectedAccountId === undefined ? recoveryAuthority : null;
        if (
          expectedAccountId === undefined &&
          (recovery === null || Date.now() >= recovery.expiresAt)
        ) {
          clearRecoveryAuthority();
          return null;
        }
        // Snapshot once. No later SDK mutation may select the account for this
        // operation from storage, which another tab can replace at any await.
        const sessionResult = await Promise.race([
          Promise.resolve(dependencies.client.auth.getSession()),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 5_000);
          }),
        ]);
        clearTimeout(timeout);
        const snapshot = externalResult(sessionResult);
        if (snapshot?.error !== null) return null;
        const session = objectProperty(snapshot.data, "session");
        const accessToken = objectProperty(session, "access_token");
        if (!isOpaqueToken(accessToken)) return null;
        if (
          recovery !== null &&
          (recovery !== recoveryAuthority ||
            Date.now() >= recovery.expiresAt ||
            accessToken !== recovery.accessToken)
        ) {
          return null;
        }
        // Even auth.getUser(token) can remove the *current* SDK session when a
        // stale token returns session_not_found. Verify directly to stay inert.
        const verified = await directAuthorityRequest(
          accessToken,
          "/auth/v1/user",
          "GET",
        );
        if (verified?.status !== 200) return null;
        if (
          recovery !== null &&
          (recovery !== recoveryAuthority || Date.now() >= recovery.expiresAt)
        ) {
          return null;
        }
        const user = objectProperty(verified.body, "user") ?? verified.body;
        const accountId = objectProperty(user, "id");
        if (
          typeof accountId !== "string" ||
          accountId.length === 0 ||
          (expectedAccountId !== undefined && accountId !== expectedAccountId)
        ) {
          return null;
        }
        if (capturedAuthorities.size >= 16) return null;
        const handle = crypto.randomUUID();
        capturedAuthorities.set(handle, {
          accessToken,
          accountId,
          expiresAt: Date.now() + 60_000,
          passwordAttempted: false,
          purpose: "password",
          timeout: setTimeout(() => releaseCapturedAuthority(handle), 60_000),
        });
        return handle;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
    releasePasswordAuthority,
    acceptInvitation(
      request: AcceptStaffInvitationRequest,
      authorityHandle: string,
    ) {
      return authorityRpc(authorityHandle, "accept_staff_invitation", {
        display_name: request.displayName,
        invitation_id: request.invitationId,
      });
    },
    beginPasswordRecovery(
      requestedOperationId: string,
      authorityHandle: string,
    ) {
      return authorityRpc(authorityHandle, "begin_staff_password_recovery", {
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
    async exchangeEmailVerificationCode(input: {
      readonly authorizationCode: string;
      readonly flowId: string;
    }) {
      try {
        const result = externalResult(
          await dependencies.client.auth.exchangeCodeForSession(
            input.authorizationCode,
            { flowId: input.flowId },
          ),
        );
        if (result === null) return { status: "unavailable" };
        if (result.error !== null) {
          return {
            status: isRejectedEmailVerificationExchangeError(
              authErrorCode(result.error),
            )
              ? "rejected"
              : "unavailable",
          };
        }
        const data = snapshotExactRecord(result.data, [
          "redirectType",
          "session",
          "user",
        ]);
        return {
          status:
            data !== null &&
            (data.redirectType === null ||
              typeof data.redirectType === "string") &&
            isNonArrayObject(data.session) &&
            isNonArrayObject(data.user)
              ? "ready"
              : "unavailable",
        };
      } catch (error: unknown) {
        return {
          status: isRejectedEmailVerificationExchangeError(authErrorCode(error))
            ? "rejected"
            : "unavailable",
        };
      }
    },
    async exchangeRecoveryCode(input: {
      readonly authorizationCode: string;
      readonly verifier: string;
    }) {
      clearRecoveryAuthority();
      const abort = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const tokenUrl = new URL(
          "/auth/v1/token?grant_type=pkce",
          dependencies.url,
        ).toString();
        const readResponse = async (): Promise<
          | {
              readonly status: "decoded";
              readonly tokens: NonNullable<
                ReturnType<typeof decodeDirectPkceTokens>
              >;
            }
          | { readonly status: "rejected" | "unavailable" }
        > => {
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
            signal: abort.signal,
          });
          if (abort.signal.aborted) {
            void response.body?.cancel().catch(() => undefined);
            return { status: "unavailable" };
          }
          if (!isExpectedDirectResponse(response, tokenUrl)) {
            return { status: "unavailable" };
          }
          if (!response.ok) {
            const code = decodeDirectPkceFailureCode(
              await readBoundedJson(response, 4_096, abort.signal),
            );
            return {
              status: isRejectedDirectPkceCode(code)
                ? "rejected"
                : "unavailable",
            };
          }
          if (response.status !== 200) {
            return { status: "unavailable" };
          }
          const tokens = decodeDirectPkceTokens(
            await readBoundedJson(response, 65_536, abort.signal),
          );
          return tokens === null
            ? { status: "unavailable" }
            : { status: "decoded", tokens };
        };
        // One deadline covers both headers and the complete bounded body.
        // Racing also settles callers whose fetch/stream ignores abort. Session
        // installation happens only after the race, so late tokens stay inert.
        const result = await Promise.race([
          readResponse(),
          new Promise<{ readonly status: "unavailable" }>((resolve) => {
            timeout = setTimeout(() => {
              resolve({ status: "unavailable" });
              abort.abort();
            }, 5_000);
          }),
        ]);
        clearTimeout(timeout);
        if (result.status !== "decoded") return { status: result.status };
        const installed = decodeSetSessionResult(
          await dependencies.client.auth.setSession({
            access_token: result.tokens.accessToken,
            refresh_token: result.tokens.refreshToken,
          }),
        );
        if (installed === "ready") {
          clearRecoveryAuthority();
          recoveryAuthority = {
            accessToken: result.tokens.accessToken,
            expiresAt: Date.now() + 300_000,
            timeout: setTimeout(clearRecoveryAuthority, 300_000),
          };
        }
        return { status: installed };
      } catch (error: unknown) {
        return {
          status: isRejectedSessionInstallError(authErrorCode(error))
            ? "rejected"
            : "unavailable",
        };
      } finally {
        clearTimeout(timeout);
        abort.abort();
      }
    },
    finishPasswordRecovery(operationId: string, authorityHandle: string) {
      return authorityRpc(authorityHandle, "finish_staff_password_recovery", {
        operation_id: operationId,
      });
    },
    async invokeInvitation(
      request: CreateStaffInvitationRequest,
      authorityHandle: string,
    ) {
      const authority = capturedAuthority(authorityHandle, "staff_management");
      if (authority === null) return { code: "service_unavailable", ok: false };
      const result = await directAuthorityRequest(
        authority.accessToken,
        "/functions/v1/staff-invitations",
        "POST",
        request,
      );
      const parsed = parseCreateStaffInvitationResponse(result?.body);
      return result !== null &&
        parsed !== null &&
        ((result.status >= 200 && result.status < 300) || !parsed.ok)
        ? parsed
        : { code: "service_unavailable", ok: false };
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
        const snapshot = await snapshotSessionAuthority();
        if (snapshot.status === "ended") return { status: "signed_out" };
        if (snapshot.status !== "ready") return null;
        const verified = await directAuthorityRequest(
          snapshot.accessToken,
          "/auth/v1/user",
          "GET",
        );
        if (isEndedAuthorityResponse(verified)) return { status: "signed_out" };
        if (verified?.status !== 200) return null;
        const user = objectProperty(verified.body, "user") ?? verified.body;
        if (!isNonArrayObject(user)) return null;
        const accountId = objectProperty(user, "id");
        const email = objectProperty(user, "email");
        const confirmedAt = ownDataProperty(user, "email_confirmed_at");
        if (
          accountId !== snapshot.accountId ||
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
          await boundedAuthorityRead(() =>
            dependencies.client.auth.mfa.getAuthenticatorAssuranceLevel(),
          ),
        );
        if (result === null || result.error !== null) return null;
        const currentLevel = objectProperty(result.data, "currentLevel");
        const nextLevel = objectProperty(result.data, "nextLevel");
        const currentAuthenticationMethods = decodeAuthenticationMethods(
          objectProperty(result.data, "currentAuthenticationMethods"),
        );
        if (
          (currentLevel !== "aal1" && currentLevel !== "aal2") ||
          (nextLevel !== "aal1" && nextLevel !== "aal2") ||
          currentAuthenticationMethods === null
        ) {
          return null;
        }
        return { currentAuthenticationMethods, currentLevel, nextLevel };
      } catch {
        return null;
      }
    },
    readCurrentContext() {
      return readAuthorityRpc("current_staff_context");
    },
    readCurrentInvitations() {
      return readAuthorityRpc("current_staff_invitations");
    },
    readManageableInvitations() {
      return readAuthorityRpc("current_manageable_staff_invitations");
    },
    readManageableStaff() {
      return readAuthorityRpc("current_manageable_staff");
    },
    async readSession() {
      try {
        const result = externalResult(
          await boundedAuthorityRead(() =>
            dependencies.client.auth.getSession(),
          ),
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
          await boundedAuthorityRead(() =>
            dependencies.client.auth.mfa.listFactors(),
          ),
        );
        if (result === null || result.error !== null) return null;
        const all = objectProperty(result.data, "all");
        if (!Array.isArray(all)) return null;
        const factors: Array<{
          readonly factorId: string;
          readonly friendlyName: string | null;
          readonly status: "unverified" | "verified";
        }> = [];
        for (const factor of all) {
          if (!isNonArrayObject(factor)) return null;
          if (objectProperty(factor, "factor_type") !== "totp") continue;
          const factorId = objectProperty(factor, "id");
          const friendlyName = sanitizeFactorFriendlyName(
            objectProperty(factor, "friendly_name"),
          );
          const status = objectProperty(factor, "status");
          if (
            typeof factorId !== "string" ||
            (status !== "unverified" && status !== "verified")
          ) {
            return null;
          }
          factors.push({ factorId, friendlyName, status });
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
          await dependencies.client.auth.resend({
            email,
            options: {
              emailRedirectTo: `${dependencies.origin}/?auth=email-verification`,
            },
            type: "signup",
          }),
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
    revokeAllStaffSessions(authorityHandle: string) {
      return authorityRpc(
        authorityHandle,
        "revoke_all_current_user_staff_sessions",
        {},
      );
    },
    revokeCurrentStaffSession(authorityHandle: string) {
      return authorityRpc(authorityHandle, "revoke_current_staff_session", {});
    },
    revokeInvitation(
      request: RevokeStaffInvitationRequest,
      authorityHandle: string,
    ) {
      return staffManagementRpc(authorityHandle, "revoke_staff_invitation", {
        invitation_id: request.invitationId,
      });
    },
    revokeMembership(
      request: RevokeStaffMembershipRequest,
      authorityHandle: string,
    ) {
      return staffManagementRpc(authorityHandle, "revoke_membership", {
        expected_role_revision: request.expectedRoleRevision,
        profile_id: request.profileId,
        workspace_id: request.schoolId,
      });
    },
    changeMembershipRole(
      request: ChangeStaffMembershipRoleRequest,
      authorityHandle: string,
    ) {
      return staffManagementRpc(authorityHandle, "change_membership_role", {
        expected_role_revision: request.expectedRoleRevision,
        profile_id: request.profileId,
        role: request.role === "administrator" ? "admin" : request.role,
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
    async signOut(scope: "all" | "local", authorityHandle: string) {
      const authority = passwordAuthority(authorityHandle);
      if (authority === null) return { status: "unavailable" };
      const result = await directAuthorityRequest(
        authority.accessToken,
        `/auth/v1/logout?scope=${scope === "all" ? "global" : "local"}`,
        "POST",
      );
      if (
        result !== null &&
        result.status >= 200 &&
        result.status < 300 &&
        recoveryAuthority?.accessToken === authority.accessToken
      ) {
        clearRecoveryAuthority();
      }
      // Do not call SDK signOut: it can revoke or erase another account that
      // became active after this operation captured its authority.
      return {
        status:
          result !== null && result.status >= 200 && result.status < 300
            ? "signed_out"
            : "unavailable",
      };
    },
    async updatePassword(password: string, authorityHandle: string) {
      const authority = passwordAuthority(authorityHandle);
      if (authority === null || authority.passwordAttempted) {
        return { status: "unavailable" };
      }
      authority.passwordAttempted = true;
      const result = await directAuthorityRequest(
        authority.accessToken,
        "/auth/v1/user",
        "PUT",
        { password },
      );
      if (result?.status === 200) {
        return {
          status:
            objectProperty(
              objectProperty(result.body, "user") ?? result.body,
              "id",
            ) === authority.accountId
              ? "updated"
              : "unavailable",
        };
      }
      return {
        status:
          result !== null &&
          result.status >= 400 &&
          result.status < 500 &&
          isRejectedPasswordError(authErrorCode(result.body))
            ? "rejected"
            : "unavailable",
      };
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
  configuration: Pick<
    PublicWebConfiguration,
    "origin" | "publishableKey" | "url"
  >,
  fetchImplementation: RecoveryFetch = globalThis.fetch,
): SupabaseStaffAuthPort {
  const client = createClient(configuration.url, configuration.publishableKey, {
    auth: {
      detectSessionInUrl: false,
      experimental: { appendPkceFlowIdToRedirects: true },
      flowType: "pkce",
    },
    db: { schema: "desmoslock_v2" },
    global: { fetch: fetchImplementation },
  });
  return createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: fetchImplementation,
    origin: configuration.origin,
    publishableKey: configuration.publishableKey,
    url: configuration.url,
  });
}
