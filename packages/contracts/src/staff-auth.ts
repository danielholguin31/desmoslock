import { staffAuthErrorCodes } from "@desmoslock/domain";
import type {
  InvitableStaffRole,
  StaffAuthErrorCode,
  StaffAuthFailure,
} from "@desmoslock/domain";

import { parseExactRecord } from "./exact-record.js";

export { staffAuthErrorCodes };
export type { StaffAuthErrorCode };

export interface CreateStaffInvitationRequest {
  readonly email: string;
  readonly role: InvitableStaffRole;
  readonly schoolId: string;
}

export interface AcceptStaffInvitationRequest {
  readonly displayName: string;
  readonly invitationId: string;
}

export interface RevokeStaffMembershipRequest {
  readonly profileId: string;
  readonly schoolId: string;
}

export interface RevokeStaffInvitationRequest {
  readonly invitationId: string;
}

export interface RequestStaffPasswordRecoveryRequest {
  readonly email: string;
}

export interface SelectStaffSchoolRequest {
  readonly schoolId: string;
}

/** Web-only key fragment; compose it with an already-validated backend URL. */
export interface PublicStaffAuthConfiguration {
  readonly publishableKey: string;
}

export const staffAuthWireSuccessCodes = [
  "email_verified",
  "invitation_accepted",
  "invitation_created",
  "invitation_revoked",
  "login_succeeded",
  "membership_revoked",
  "recovery_requested",
  "school_selected",
] as const;

export type StaffAuthWireSuccessCode =
  (typeof staffAuthWireSuccessCodes)[number];

type StaffAuthOperationResponse<
  Success extends StaffAuthWireSuccessCode,
  Error extends StaffAuthErrorCode,
> = { readonly code: Success; readonly ok: true } | StaffAuthFailure<Error>;

const createStaffInvitationErrorCodes = staffAuthErrorCodes;
const acceptStaffInvitationErrorCodes = [
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
] as const satisfies readonly StaffAuthErrorCode[];
const revokeStaffInvitationErrorCodes = [
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
] as const satisfies readonly StaffAuthErrorCode[];
const revokeStaffMembershipErrorCodes = [
  "authentication_required",
  "authorization_denied",
  "invalid_request",
  "rate_limited",
  "service_unavailable",
  "session_expired",
  "session_revoked",
  "step_up_required",
] as const satisfies readonly StaffAuthErrorCode[];
const requestStaffPasswordRecoveryErrorCodes = [
  "invalid_request",
  "rate_limited",
  "service_unavailable",
] as const satisfies readonly StaffAuthErrorCode[];
const selectStaffSchoolErrorCodes = [
  "authentication_required",
  "authorization_denied",
  "invalid_request",
  "service_unavailable",
  "session_expired",
  "session_revoked",
] as const satisfies readonly StaffAuthErrorCode[];
const staffLoginErrorCodes = [
  "authorization_denied",
  "invalid_request",
  "rate_limited",
  "service_unavailable",
] as const satisfies readonly StaffAuthErrorCode[];
const staffEmailVerificationErrorCodes = [
  "authorization_denied",
  "invalid_request",
  "rate_limited",
  "service_unavailable",
] as const satisfies readonly StaffAuthErrorCode[];

export type CreateStaffInvitationResponse = StaffAuthOperationResponse<
  "invitation_created",
  (typeof createStaffInvitationErrorCodes)[number]
>;
export type AcceptStaffInvitationResponse = StaffAuthOperationResponse<
  "invitation_accepted",
  (typeof acceptStaffInvitationErrorCodes)[number]
>;
export type RevokeStaffInvitationResponse = StaffAuthOperationResponse<
  "invitation_revoked",
  (typeof revokeStaffInvitationErrorCodes)[number]
>;
export type RevokeStaffMembershipResponse = StaffAuthOperationResponse<
  "membership_revoked",
  (typeof revokeStaffMembershipErrorCodes)[number]
>;
export type RequestStaffPasswordRecoveryResponse = StaffAuthOperationResponse<
  "recovery_requested",
  (typeof requestStaffPasswordRecoveryErrorCodes)[number]
>;
export type SelectStaffSchoolResponse = StaffAuthOperationResponse<
  "school_selected",
  (typeof selectStaffSchoolErrorCodes)[number]
>;
export type StaffLoginResponse = StaffAuthOperationResponse<
  "login_succeeded",
  (typeof staffLoginErrorCodes)[number]
>;
export type StaffEmailVerificationResponse = StaffAuthOperationResponse<
  "email_verified",
  (typeof staffEmailVerificationErrorCodes)[number]
>;

export const staffAuthRpcFailureCodes = [
  "conflict",
  "dependency_unavailable",
  "email_unverified",
  "forbidden",
  "invalid_request",
  "invitation_consumed",
  "invitation_expired",
  "invitation_not_found",
  "membership_inactive",
  "rate_limited",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
  "unknown",
] as const;

export type StaffAuthRpcFailureCode = (typeof staffAuthRpcFailureCodes)[number];

export const staffAuthProviderFailureCodes = [
  "dependency_unavailable",
  "existing_user_conflict",
  "rate_limited",
  "unknown",
] as const;

export type StaffAuthProviderFailureCode =
  (typeof staffAuthProviderFailureCodes)[number];

export type StaffAuthInternalFailure =
  | {
      readonly code: StaffAuthRpcFailureCode;
      readonly source: "rpc";
    }
  | {
      readonly code: StaffAuthProviderFailureCode;
      readonly source: "provider";
    };

export type CreateStaffInvitationInternalResult =
  | { readonly code: "invitation_usable"; readonly ok: true }
  | (StaffAuthInternalFailure & { readonly ok: false });

const rpcFailureToProductCode = {
  conflict: "service_unavailable",
  dependency_unavailable: "service_unavailable",
  email_unverified: "authorization_denied",
  forbidden: "authorization_denied",
  invalid_request: "invalid_request",
  invitation_consumed: "invitation_not_found",
  invitation_expired: "invitation_expired",
  invitation_not_found: "invitation_not_found",
  membership_inactive: "authorization_denied",
  rate_limited: "rate_limited",
  session_expired: "session_expired",
  session_revoked: "session_revoked",
  step_up_required: "step_up_required",
  unauthenticated: "authentication_required",
  unknown: "service_unavailable",
} as const satisfies Record<StaffAuthRpcFailureCode, StaffAuthErrorCode>;

const providerFailureToProductCode = {
  dependency_unavailable: "service_unavailable",
  existing_user_conflict: "existing_confirmed_user_unsupported",
  rate_limited: "rate_limited",
  unknown: "service_unavailable",
} as const satisfies Record<StaffAuthProviderFailureCode, StaffAuthErrorCode>;

export function mapStaffAuthInternalFailure(
  failure: StaffAuthInternalFailure,
): StaffAuthFailure {
  const code =
    failure.source === "rpc"
      ? rpcFailureToProductCode[failure.code]
      : providerFailureToProductCode[failure.code];
  return { code, ok: false };
}

export function mapCreateStaffInvitationInternalResult(
  result: CreateStaffInvitationInternalResult,
): CreateStaffInvitationResponse {
  return result.ok
    ? { code: "invitation_created", ok: true }
    : mapStaffAuthInternalFailure(result);
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const emailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const publishableKeyPattern =
  /^sb_publishable_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{8})$/u;
const privilegedKeyLabelPattern = /secret|service|operator|database/iu;

function parseCanonicalUuid(value: unknown): string | null {
  return typeof value === "string" && canonicalUuidPattern.test(value)
    ? value
    : null;
}

function parseCanonicalEmail(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !emailPattern.test(value)
  ) {
    return null;
  }

  return value;
}

function parseDisplayName(value: unknown): string | null {
  const containsControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    });
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 160 ||
    containsControlCharacter
  ) {
    return null;
  }

  return value;
}

function parseSupabasePublishableKey(value: unknown): string | null {
  if (typeof value !== "string" || privilegedKeyLabelPattern.test(value)) {
    return null;
  }

  const match = publishableKeyPattern.exec(value);
  const random = match?.[1];
  const checksum = match?.[2];
  if (
    random === undefined ||
    checksum === undefined ||
    !/[A-Za-z0-9]/u.test(random) ||
    !/[A-Za-z0-9]/u.test(checksum)
  ) {
    return null;
  }

  return value;
}

export function parsePublicStaffAuthConfiguration(
  value: unknown,
): PublicStaffAuthConfiguration | null {
  const configuration = parseExactRecord(value, ["publishableKey"]);
  if (configuration === null) return null;

  const publishableKey = parseSupabasePublishableKey(
    configuration.publishableKey,
  );
  return publishableKey === null ? null : { publishableKey };
}

export function parseCreateStaffInvitationRequest(
  value: unknown,
): CreateStaffInvitationRequest | null {
  const request = parseExactRecord(value, ["email", "role", "schoolId"]);
  if (request === null) return null;

  const email = parseCanonicalEmail(request.email);
  const schoolId = parseCanonicalUuid(request.schoolId);
  if (
    email === null ||
    schoolId === null ||
    (request.role !== "administrator" && request.role !== "teacher")
  ) {
    return null;
  }

  return { email, role: request.role, schoolId };
}

export function parseAcceptStaffInvitationRequest(
  value: unknown,
): AcceptStaffInvitationRequest | null {
  const request = parseExactRecord(value, ["displayName", "invitationId"]);
  if (request === null) return null;

  const displayName = parseDisplayName(request.displayName);
  const invitationId = parseCanonicalUuid(request.invitationId);
  return displayName === null || invitationId === null
    ? null
    : { displayName, invitationId };
}

export function parseRevokeStaffMembershipRequest(
  value: unknown,
): RevokeStaffMembershipRequest | null {
  const request = parseExactRecord(value, ["profileId", "schoolId"]);
  if (request === null) return null;

  const profileId = parseCanonicalUuid(request.profileId);
  const schoolId = parseCanonicalUuid(request.schoolId);
  return profileId === null || schoolId === null
    ? null
    : { profileId, schoolId };
}

export function parseRevokeStaffInvitationRequest(
  value: unknown,
): RevokeStaffInvitationRequest | null {
  const request = parseExactRecord(value, ["invitationId"]);
  if (request === null) return null;

  const invitationId = parseCanonicalUuid(request.invitationId);
  return invitationId === null ? null : { invitationId };
}

export function parseRequestStaffPasswordRecoveryRequest(
  value: unknown,
): RequestStaffPasswordRecoveryRequest | null {
  const request = parseExactRecord(value, ["email"]);
  if (request === null) return null;

  const email = parseCanonicalEmail(request.email);
  return email === null ? null : { email };
}

export function parseSelectStaffSchoolRequest(
  value: unknown,
): SelectStaffSchoolRequest | null {
  const request = parseExactRecord(value, ["schoolId"]);
  if (request === null) return null;

  const schoolId = parseCanonicalUuid(request.schoolId);
  return schoolId === null ? null : { schoolId };
}

function parseStaffAuthOperationResponse<
  Success extends StaffAuthWireSuccessCode,
  ErrorCodes extends readonly StaffAuthErrorCode[],
>(
  value: unknown,
  successCode: Success,
  errorCodes: ErrorCodes,
): StaffAuthOperationResponse<Success, ErrorCodes[number]> | null {
  const response = parseExactRecord(value, ["code", "ok"]);
  if (
    response === null ||
    typeof response.ok !== "boolean" ||
    typeof response.code !== "string"
  ) {
    return null;
  }

  if (response.ok === true && response.code === successCode) {
    return { code: successCode, ok: true };
  }
  const errorCode = response.code as ErrorCodes[number];
  if (response.ok === false && errorCodes.includes(errorCode)) {
    return { code: errorCode, ok: false };
  }

  return null;
}

export function parseCreateStaffInvitationResponse(
  value: unknown,
): CreateStaffInvitationResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "invitation_created",
    createStaffInvitationErrorCodes,
  );
}

export function parseAcceptStaffInvitationResponse(
  value: unknown,
): AcceptStaffInvitationResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "invitation_accepted",
    acceptStaffInvitationErrorCodes,
  );
}

export function parseRevokeStaffInvitationResponse(
  value: unknown,
): RevokeStaffInvitationResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "invitation_revoked",
    revokeStaffInvitationErrorCodes,
  );
}

export function parseRevokeStaffMembershipResponse(
  value: unknown,
): RevokeStaffMembershipResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "membership_revoked",
    revokeStaffMembershipErrorCodes,
  );
}

export function parseRequestStaffPasswordRecoveryResponse(
  value: unknown,
): RequestStaffPasswordRecoveryResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "recovery_requested",
    requestStaffPasswordRecoveryErrorCodes,
  );
}

export function parseSelectStaffSchoolResponse(
  value: unknown,
): SelectStaffSchoolResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "school_selected",
    selectStaffSchoolErrorCodes,
  );
}

export function parseStaffLoginResponse(
  value: unknown,
): StaffLoginResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "login_succeeded",
    staffLoginErrorCodes,
  );
}

export function parseStaffEmailVerificationResponse(
  value: unknown,
): StaffEmailVerificationResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "email_verified",
    staffEmailVerificationErrorCodes,
  );
}
