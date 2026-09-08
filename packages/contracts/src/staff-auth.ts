import { staffAuthErrorCodes } from "@desmoslock/domain";
import type {
  InvitableStaffRole,
  StaffAuthErrorCode,
  StaffAuthFailure,
} from "@desmoslock/domain";

import { parseExactArray, parseExactRecord } from "./exact-record.js";

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
  /** Transient RFC 7636 S256 challenge; never persist it in product state. */
  readonly codeChallenge: string;
  readonly email: string;
  /** Transient browser correlation identity; not a provider token. */
  readonly flowId: string;
  /** Transient callback binding; never render or log it. */
  readonly state: string;
}

export interface SelectStaffSchoolRequest {
  readonly schoolId: string;
}

export interface StaffPasswordRecoveryOperationRequest {
  readonly operationId: string;
}

/** Web-only key fragment; compose it with an already-validated backend URL. */
export interface PublicStaffAuthConfiguration {
  readonly publishableKey: string;
}

/**
 * #31 is deliberately unpaginated. DB selectors return row 501 only as an
 * overflow sentinel; adapters reject it instead of silently truncating.
 */
export const STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS = 500;

export interface ManageableStaffMember {
  readonly displayName: string;
  readonly email: string;
  readonly profileId: string;
  readonly role: InvitableStaffRole;
  readonly schoolId: string;
}

export interface ManageableStaffInvitation {
  readonly email: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly role: InvitableStaffRole;
  readonly schoolId: string;
  readonly state: "pending" | "delivery_unconfirmed";
}

export const staffAuthWireSuccessCodes = [
  "email_verified",
  "invitation_accepted",
  "invitation_created",
  "invitation_revoked",
  "login_succeeded",
  "manageable_invitations_listed",
  "manageable_staff_listed",
  "membership_revoked",
  "recovery_completed",
  "recovery_requested",
  "school_selected",
] as const;

export type StaffAuthWireSuccessCode =
  (typeof staffAuthWireSuccessCodes)[number];

type StaffAuthOperationResponse<
  Success extends StaffAuthWireSuccessCode,
  Error extends StaffAuthErrorCode,
> = { readonly code: Success; readonly ok: true } | StaffAuthFailure<Error>;

const managementListErrorCodes = [
  "authentication_required",
  "authorization_denied",
  "service_unavailable",
  "session_expired",
  "session_revoked",
  "step_up_required",
] as const satisfies readonly StaffAuthErrorCode[];

export type ManageableStaffListResponse =
  | {
      readonly code: "manageable_staff_listed";
      readonly items: readonly ManageableStaffMember[];
      readonly ok: true;
    }
  | StaffAuthFailure<(typeof managementListErrorCodes)[number]>;

export type ManageableStaffInvitationListResponse =
  | {
      readonly code: "manageable_invitations_listed";
      readonly items: readonly ManageableStaffInvitation[];
      readonly ok: true;
    }
  | StaffAuthFailure<(typeof managementListErrorCodes)[number]>;

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
const staffPasswordRecoveryCompletionErrorCodes = [
  "authentication_required",
  "authorization_denied",
  "invalid_request",
  "service_unavailable",
  "session_expired",
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
export type StaffPasswordRecoveryCompletionResponse =
  StaffAuthOperationResponse<
    "recovery_completed",
    (typeof staffPasswordRecoveryCompletionErrorCodes)[number]
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

export const staffPasswordRecoveryRpcFailureCodes = [
  "conflict",
  "email_unverified",
  "forbidden",
  "invalid_request",
  "membership_inactive",
  "recovery_expired",
  "session_expired",
  "unauthenticated",
] as const;

export type StaffPasswordRecoveryRpcFailureCode =
  (typeof staffPasswordRecoveryRpcFailureCodes)[number];

type BeginStaffPasswordRecoveryRpcFailureCode =
  StaffPasswordRecoveryRpcFailureCode;
type FinishStaffPasswordRecoveryRpcFailureCode = Exclude<
  StaffPasswordRecoveryRpcFailureCode,
  "membership_inactive"
>;

export type BeginStaffPasswordRecoveryRpcResult =
  | {
      readonly code: "recovery_completed" | "recovery_sessions_revoked";
      readonly expiresAt: string;
      readonly ok: true;
      readonly operationId: string;
    }
  | {
      readonly code: BeginStaffPasswordRecoveryRpcFailureCode;
      readonly ok: false;
    };

export type FinishStaffPasswordRecoveryRpcResult =
  | { readonly code: "recovery_completed"; readonly ok: true }
  | {
      readonly code: FinishStaffPasswordRecoveryRpcFailureCode;
      readonly ok: false;
    };

export const staffPasswordRecoveryDownstreamOutcomes = [
  "accepted",
  "account_absent",
  "dependency_unavailable",
  "delivery_failed",
  "rate_limited",
  "rejected",
  "timed_out",
  "unknown",
] as const;

export type StaffPasswordRecoveryDownstreamOutcome =
  (typeof staffPasswordRecoveryDownstreamOutcomes)[number];

export type RequestStaffPasswordRecoveryInternalResult =
  | {
      readonly code: "invalid_request" | "rate_limited" | "service_unavailable";
      readonly ok: false;
      readonly source: "perimeter";
    }
  | {
      readonly outcome: StaffPasswordRecoveryDownstreamOutcome;
      readonly source: "downstream";
    };

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

const staffPasswordRecoveryRpcFailureToProductCode = {
  conflict: "service_unavailable",
  email_unverified: "authorization_denied",
  forbidden: "authorization_denied",
  invalid_request: "invalid_request",
  membership_inactive: "authorization_denied",
  recovery_expired: "session_expired",
  session_expired: "session_expired",
  unauthenticated: "authentication_required",
} as const satisfies Record<
  StaffPasswordRecoveryRpcFailureCode,
  StaffAuthErrorCode
>;

export function mapStaffPasswordRecoveryRpcFailure(
  code: StaffPasswordRecoveryRpcFailureCode,
): StaffAuthFailure {
  return {
    code: staffPasswordRecoveryRpcFailureToProductCode[code],
    ok: false,
  };
}

export function mapRequestStaffPasswordRecoveryInternalResult(
  result: RequestStaffPasswordRecoveryInternalResult,
): RequestStaffPasswordRecoveryResponse {
  return result.source === "perimeter"
    ? { code: result.code, ok: false }
    : { code: "recovery_requested", ok: true };
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const emailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const publishableKeyPattern =
  /^sb_publishable_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{8})$/u;
const privilegedKeyLabelPattern = /secret|service|operator|database/iu;
const recoveryFlowIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const recoveryBindingPattern = /^[A-Za-z0-9_-]{43}$/u;

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

export function parseStaffDisplayName(value: unknown): string | null {
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

const managementRpcFailureCodes = [
  "email_unverified",
  "forbidden",
  "membership_inactive",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
] as const;

type ManagementRpcFailureCode = (typeof managementRpcFailureCodes)[number];
type ManagementListErrorCode = (typeof managementListErrorCodes)[number];

const managementRpcFailureToProductCode = {
  email_unverified: "authorization_denied",
  forbidden: "authorization_denied",
  membership_inactive: "authorization_denied",
  session_expired: "session_expired",
  session_revoked: "session_revoked",
  step_up_required: "step_up_required",
  unauthenticated: "authentication_required",
} as const satisfies Record<ManagementRpcFailureCode, ManagementListErrorCode>;

const manageableStaffRpcKeys = [
  "code",
  "display_name",
  "email",
  "membership_role",
  "profile_id",
  "school_id",
] as const;
const manageableInvitationRpcKeys = [
  "code",
  "expires_at",
  "invitation_id",
  "invitation_status",
  "invited_email",
  "invited_role",
  "school_id",
] as const;
const manageableStaffItemKeys = [
  "displayName",
  "email",
  "profileId",
  "role",
  "schoolId",
] as const;
const manageableInvitationItemKeys = [
  "email",
  "expiresAt",
  "invitationId",
  "role",
  "schoolId",
  "state",
] as const;
const revocableInvitationRpcStates = [
  "delivery_ready",
  "pending_acceptance",
  "pending_delivery",
] as const;

function isManagementRpcFailureCode(
  value: unknown,
): value is ManagementRpcFailureCode {
  return (
    typeof value === "string" &&
    managementRpcFailureCodes.some((code) => code === value)
  );
}

function mapManagementRpcFailure(
  code: ManagementRpcFailureCode,
): StaffAuthFailure<ManagementListErrorCode> {
  return { code: managementRpcFailureToProductCode[code], ok: false };
}

function invalidManagementList(): StaffAuthFailure<"service_unavailable"> {
  return { code: "service_unavailable", ok: false };
}

function hasOnlyNullData(
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => key === "code" || row[key] === null);
}

function parseRpcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = [
    0,
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    maximumDay === undefined ||
    day < 1 ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  const offsetDirection = match[9] === "-" ? -1 : 1;
  const offsetMilliseconds =
    offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const normalized = new Date(date.getTime() - offsetMilliseconds);
  if (!Number.isFinite(normalized.getTime())) return null;

  const canonical = normalized.toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical)
    ? canonical
    : null;
}

function parseCanonicalTimestamp(value: unknown): string | null {
  const normalized = parseRpcTimestamp(value);
  return normalized !== null && normalized === value ? normalized : null;
}

function parseManageableStaffItems(
  value: unknown,
): readonly ManageableStaffMember[] | null {
  const rows = parseExactArray(value, STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS);
  if (rows === null) return null;

  const items: ManageableStaffMember[] = [];
  const seenMemberships = new Set<string>();
  const profileByEmail = new Map<string, string>();
  const profileFacts = new Map<
    string,
    { readonly displayName: string; readonly email: string }
  >();
  for (const valueRow of rows) {
    const row = parseExactRecord(valueRow, manageableStaffItemKeys);
    if (row === null) return null;
    const displayName = parseStaffDisplayName(row.displayName);
    const email = parseCanonicalEmail(row.email);
    const profileId = parseCanonicalUuid(row.profileId);
    const schoolId = parseCanonicalUuid(row.schoolId);
    if (
      displayName === null ||
      email === null ||
      profileId === null ||
      schoolId === null ||
      (row.role !== "administrator" && row.role !== "teacher")
    ) {
      return null;
    }

    const membershipIdentity = `${schoolId}:${profileId}`;
    if (seenMemberships.has(membershipIdentity)) return null;
    seenMemberships.add(membershipIdentity);
    const knownFacts = profileFacts.get(profileId);
    if (
      knownFacts !== undefined &&
      (knownFacts.displayName !== displayName || knownFacts.email !== email)
    ) {
      return null;
    }
    const knownProfileId = profileByEmail.get(email);
    if (knownProfileId !== undefined && knownProfileId !== profileId) {
      return null;
    }
    profileByEmail.set(email, profileId);
    profileFacts.set(profileId, { displayName, email });
    items.push({ displayName, email, profileId, role: row.role, schoolId });
  }

  return items;
}

function parseManageableInvitationItems(
  value: unknown,
): readonly ManageableStaffInvitation[] | null {
  const rows = parseExactArray(value, STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS);
  if (rows === null) return null;

  const items: ManageableStaffInvitation[] = [];
  const seenInvitations = new Set<string>();
  const seenSchoolEmails = new Set<string>();
  for (const valueRow of rows) {
    const row = parseExactRecord(valueRow, manageableInvitationItemKeys);
    if (row === null) return null;
    const email = parseCanonicalEmail(row.email);
    const expiresAt = parseCanonicalTimestamp(row.expiresAt);
    const invitationId = parseCanonicalUuid(row.invitationId);
    const schoolId = parseCanonicalUuid(row.schoolId);
    if (
      email === null ||
      expiresAt === null ||
      invitationId === null ||
      schoolId === null ||
      (row.role !== "administrator" && row.role !== "teacher") ||
      (row.state !== "pending" && row.state !== "delivery_unconfirmed")
    ) {
      return null;
    }

    const schoolEmail = `${schoolId}:${email}`;
    if (
      seenInvitations.has(invitationId) ||
      seenSchoolEmails.has(schoolEmail)
    ) {
      return null;
    }
    seenInvitations.add(invitationId);
    seenSchoolEmails.add(schoolEmail);
    items.push({
      email,
      expiresAt,
      invitationId,
      role: row.role,
      schoolId,
      state: row.state,
    });
  }

  return items;
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

export function mapCurrentManageableStaffRpcRows(
  value: unknown,
): ManageableStaffListResponse {
  const rows = parseExactArray(
    value,
    STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS + 1,
  );
  if (rows === null || rows.length > STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS) {
    return invalidManagementList();
  }
  if (rows.length === 0) {
    return { code: "manageable_staff_listed", items: [], ok: true };
  }

  const parsedRows = rows.map((row) =>
    parseExactRecord(row, manageableStaffRpcKeys),
  );
  if (parsedRows.some((row) => row === null)) return invalidManagementList();
  const exactRows = parsedRows as ReadonlyArray<Record<string, unknown>>;
  const nonSuccessRows = exactRows.filter((row) => row.code !== "ok");
  if (nonSuccessRows.length > 0) {
    const failure = nonSuccessRows[0];
    return exactRows.length === 1 &&
      failure !== undefined &&
      isManagementRpcFailureCode(failure.code) &&
      hasOnlyNullData(failure, manageableStaffRpcKeys)
      ? mapManagementRpcFailure(failure.code)
      : invalidManagementList();
  }

  const items: ManageableStaffMember[] = [];
  const seenMemberships = new Set<string>();
  const profileByEmail = new Map<string, string>();
  const profileFacts = new Map<
    string,
    { readonly displayName: string; readonly email: string }
  >();
  for (const row of exactRows) {
    const displayName = parseStaffDisplayName(row.display_name);
    const email = parseCanonicalEmail(row.email);
    const profileId = parseCanonicalUuid(row.profile_id);
    const schoolId = parseCanonicalUuid(row.school_id);
    const role =
      row.membership_role === "admin"
        ? "administrator"
        : row.membership_role === "teacher"
          ? "teacher"
          : null;
    if (
      displayName === null ||
      email === null ||
      profileId === null ||
      schoolId === null ||
      role === null
    ) {
      return invalidManagementList();
    }

    const membershipIdentity = `${schoolId}:${profileId}`;
    if (seenMemberships.has(membershipIdentity)) {
      return invalidManagementList();
    }
    seenMemberships.add(membershipIdentity);
    const knownFacts = profileFacts.get(profileId);
    if (
      knownFacts !== undefined &&
      (knownFacts.displayName !== displayName || knownFacts.email !== email)
    ) {
      return invalidManagementList();
    }
    const knownProfileId = profileByEmail.get(email);
    if (knownProfileId !== undefined && knownProfileId !== profileId) {
      return invalidManagementList();
    }
    profileByEmail.set(email, profileId);
    profileFacts.set(profileId, { displayName, email });
    items.push({ displayName, email, profileId, role, schoolId });
  }

  return { code: "manageable_staff_listed", items, ok: true };
}

export function mapCurrentManageableStaffInvitationsRpcRows(
  value: unknown,
): ManageableStaffInvitationListResponse {
  const rows = parseExactArray(
    value,
    STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS + 1,
  );
  if (rows === null || rows.length > STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS) {
    return invalidManagementList();
  }
  if (rows.length === 0) {
    return { code: "manageable_invitations_listed", items: [], ok: true };
  }

  const parsedRows = rows.map((row) =>
    parseExactRecord(row, manageableInvitationRpcKeys),
  );
  if (parsedRows.some((row) => row === null)) return invalidManagementList();
  const exactRows = parsedRows as ReadonlyArray<Record<string, unknown>>;
  const nonSuccessRows = exactRows.filter((row) => row.code !== "ok");
  if (nonSuccessRows.length > 0) {
    const failure = nonSuccessRows[0];
    return exactRows.length === 1 &&
      failure !== undefined &&
      isManagementRpcFailureCode(failure.code) &&
      hasOnlyNullData(failure, manageableInvitationRpcKeys)
      ? mapManagementRpcFailure(failure.code)
      : invalidManagementList();
  }

  const items: ManageableStaffInvitation[] = [];
  const seenInvitations = new Set<string>();
  const seenSchoolEmails = new Set<string>();
  for (const row of exactRows) {
    const email = parseCanonicalEmail(row.invited_email);
    const expiresAt = parseRpcTimestamp(row.expires_at);
    const invitationId = parseCanonicalUuid(row.invitation_id);
    const schoolId = parseCanonicalUuid(row.school_id);
    const role =
      row.invited_role === "admin"
        ? "administrator"
        : row.invited_role === "teacher"
          ? "teacher"
          : null;
    if (
      email === null ||
      expiresAt === null ||
      invitationId === null ||
      schoolId === null ||
      role === null ||
      typeof row.invitation_status !== "string" ||
      !revocableInvitationRpcStates.some(
        (state) => state === row.invitation_status,
      )
    ) {
      return invalidManagementList();
    }

    const schoolEmail = `${schoolId}:${email}`;
    if (
      seenInvitations.has(invitationId) ||
      seenSchoolEmails.has(schoolEmail)
    ) {
      return invalidManagementList();
    }
    seenInvitations.add(invitationId);
    seenSchoolEmails.add(schoolEmail);
    items.push({
      email,
      expiresAt,
      invitationId,
      role,
      schoolId,
      state:
        row.invitation_status === "pending_acceptance"
          ? "pending"
          : "delivery_unconfirmed",
    });
  }

  return { code: "manageable_invitations_listed", items, ok: true };
}

function parseManagementListFailure(
  value: unknown,
): StaffAuthFailure<ManagementListErrorCode> | null {
  const response = parseExactRecord(value, ["code", "ok"]);
  if (
    response === null ||
    response.ok !== false ||
    typeof response.code !== "string" ||
    !managementListErrorCodes.some((code) => code === response.code)
  ) {
    return null;
  }
  return { code: response.code as ManagementListErrorCode, ok: false };
}

export function parseManageableStaffListResponse(
  value: unknown,
): ManageableStaffListResponse | null {
  const success = parseExactRecord(value, ["code", "items", "ok"]);
  if (
    success !== null &&
    success.code === "manageable_staff_listed" &&
    success.ok === true
  ) {
    const items = parseManageableStaffItems(success.items);
    return items === null
      ? null
      : { code: "manageable_staff_listed", items, ok: true };
  }
  return parseManagementListFailure(value);
}

export function parseManageableStaffInvitationListResponse(
  value: unknown,
): ManageableStaffInvitationListResponse | null {
  const success = parseExactRecord(value, ["code", "items", "ok"]);
  if (
    success !== null &&
    success.code === "manageable_invitations_listed" &&
    success.ok === true
  ) {
    const items = parseManageableInvitationItems(success.items);
    return items === null
      ? null
      : { code: "manageable_invitations_listed", items, ok: true };
  }
  return parseManagementListFailure(value);
}

function parseStaffPasswordRecoveryOperationRequest(
  value: unknown,
): StaffPasswordRecoveryOperationRequest | null {
  const request = parseExactRecord(value, ["operationId"]);
  if (request === null) return null;
  const operationId = parseCanonicalUuid(request.operationId);
  return operationId === null ? null : { operationId };
}

export function parseBeginStaffPasswordRecoveryOperationRequest(
  value: unknown,
): StaffPasswordRecoveryOperationRequest | null {
  return parseStaffPasswordRecoveryOperationRequest(value);
}

export function parseFinishStaffPasswordRecoveryOperationRequest(
  value: unknown,
): StaffPasswordRecoveryOperationRequest | null {
  return parseStaffPasswordRecoveryOperationRequest(value);
}

function isStaffPasswordRecoveryRpcFailureCode(
  value: unknown,
): value is StaffPasswordRecoveryRpcFailureCode {
  return (
    typeof value === "string" &&
    staffPasswordRecoveryRpcFailureCodes.some((code) => code === value)
  );
}

export function parseBeginStaffPasswordRecoveryRpcResult(
  value: unknown,
): BeginStaffPasswordRecoveryRpcResult | null {
  const result = parseExactRecord(value, [
    "code",
    "expires_at",
    "operation_id",
  ]);
  if (result === null) return null;

  if (
    result.code === "recovery_sessions_revoked" ||
    result.code === "recovery_completed"
  ) {
    const expiresAt = parseRpcTimestamp(result.expires_at);
    const operationId = parseCanonicalUuid(result.operation_id);
    return expiresAt === null || operationId === null
      ? null
      : { code: result.code, expiresAt, ok: true, operationId };
  }

  return isStaffPasswordRecoveryRpcFailureCode(result.code) &&
    result.expires_at === null &&
    result.operation_id === null
    ? { code: result.code, ok: false }
    : null;
}

export function parseFinishStaffPasswordRecoveryRpcResult(
  value: unknown,
): FinishStaffPasswordRecoveryRpcResult | null {
  const result = parseExactRecord(value, ["code"]);
  if (result === null) return null;
  if (result.code === "recovery_completed") {
    return { code: "recovery_completed", ok: true };
  }
  if (
    isStaffPasswordRecoveryRpcFailureCode(result.code) &&
    result.code !== "membership_inactive"
  ) {
    return { code: result.code, ok: false };
  }
  return null;
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

  const displayName = parseStaffDisplayName(request.displayName);
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
  const request = parseExactRecord(value, [
    "codeChallenge",
    "email",
    "flowId",
    "state",
  ]);
  if (request === null) return null;

  const email = parseCanonicalEmail(request.email);
  if (
    email === null ||
    typeof request.codeChallenge !== "string" ||
    !recoveryBindingPattern.test(request.codeChallenge) ||
    typeof request.flowId !== "string" ||
    !recoveryFlowIdPattern.test(request.flowId) ||
    typeof request.state !== "string" ||
    !recoveryBindingPattern.test(request.state)
  ) {
    return null;
  }

  return {
    codeChallenge: request.codeChallenge,
    email,
    flowId: request.flowId,
    state: request.state,
  };
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

export function parseStaffPasswordRecoveryCompletionResponse(
  value: unknown,
): StaffPasswordRecoveryCompletionResponse | null {
  return parseStaffAuthOperationResponse(
    value,
    "recovery_completed",
    staffPasswordRecoveryCompletionErrorCodes,
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
