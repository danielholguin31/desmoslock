import { staffAuthErrorCodes, staffAuthSuccessCodes } from "@desmoslock/domain";
import type {
  InvitableStaffRole,
  StaffAuthErrorCode,
  StaffAuthSuccessCode,
} from "@desmoslock/domain";

import { parseExactRecord } from "./exact-record.js";

export { staffAuthErrorCodes, staffAuthSuccessCodes };
export type { StaffAuthErrorCode, StaffAuthSuccessCode };

export interface CreateStaffInvitationRequest {
  readonly email: string;
  readonly role: InvitableStaffRole;
  readonly schoolId: string;
}

export interface AcceptStaffInvitationRequest {
  readonly invitationId: string;
}

export interface RevokeStaffMembershipRequest {
  readonly membershipId: string;
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

export type StaffAuthResponse =
  | {
      readonly code: StaffAuthSuccessCode;
      readonly ok: true;
    }
  | {
      readonly code: StaffAuthErrorCode;
      readonly ok: false;
    };

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const emailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const successCodeSet = new Set<string>(staffAuthSuccessCodes);
const errorCodeSet = new Set<string>(staffAuthErrorCodes);

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
  const request = parseExactRecord(value, ["invitationId"]);
  if (request === null) return null;

  const invitationId = parseCanonicalUuid(request.invitationId);
  return invitationId === null ? null : { invitationId };
}

export function parseRevokeStaffMembershipRequest(
  value: unknown,
): RevokeStaffMembershipRequest | null {
  const request = parseExactRecord(value, ["membershipId", "schoolId"]);
  if (request === null) return null;

  const membershipId = parseCanonicalUuid(request.membershipId);
  const schoolId = parseCanonicalUuid(request.schoolId);
  return membershipId === null || schoolId === null
    ? null
    : { membershipId, schoolId };
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

export function parseStaffAuthResponse(
  value: unknown,
): StaffAuthResponse | null {
  const response = parseExactRecord(value, ["code", "ok"]);
  if (
    response === null ||
    typeof response.ok !== "boolean" ||
    typeof response.code !== "string"
  ) {
    return null;
  }

  if (response.ok && successCodeSet.has(response.code)) {
    return { code: response.code as StaffAuthSuccessCode, ok: true };
  }
  if (!response.ok && errorCodeSet.has(response.code)) {
    return { code: response.code as StaffAuthErrorCode, ok: false };
  }

  return null;
}
