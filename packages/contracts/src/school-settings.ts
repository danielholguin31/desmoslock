import { parseExactArray, parseExactRecord } from "./exact-record.js";

export interface SchoolSettings {
  readonly schoolId: string;
  readonly displayName: string;
  readonly settingsRevision: number;
}

export interface UpdateSchoolDisplayNameRequest {
  readonly schoolId: string;
  readonly displayName: string;
  readonly expectedSettingsRevision: number;
}

export type SchoolNameValidation =
  "required" | "too_long" | "invalid_characters";

export type SchoolDisplayNameDraftValidation =
  | { readonly ok: true; readonly displayName: string }
  | { readonly ok: false; readonly reason: SchoolNameValidation };

export const updateSchoolDisplayNameRpcSuccessCodes = [
  "school_display_name_updated",
  "school_display_name_unchanged",
] as const;

export const updateSchoolDisplayNameRpcFailureCodes = [
  "school_settings_revision_conflict",
  "email_unverified",
  "forbidden",
  "invalid_request",
  "membership_inactive",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
  "dependency_unavailable",
] as const;

export type UpdateSchoolDisplayNameRpcSuccessCode =
  (typeof updateSchoolDisplayNameRpcSuccessCodes)[number];

export type UpdateSchoolDisplayNameRpcFailureCode =
  (typeof updateSchoolDisplayNameRpcFailureCodes)[number];

export type UpdateSchoolDisplayNameRpcResult =
  | { readonly ok: true; readonly code: UpdateSchoolDisplayNameRpcSuccessCode }
  | {
      readonly ok: false;
      readonly code: UpdateSchoolDisplayNameRpcFailureCode;
    };

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

function isSettingsRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function validateSchoolDisplayNameDraft(
  value: string,
): SchoolDisplayNameDraftValidation {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return { ok: false, reason: "invalid_characters" };
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return { ok: false, reason: "invalid_characters" };
    }
  }

  const displayName = value.trim();
  if (displayName.length === 0) return { ok: false, reason: "required" };
  if (new TextEncoder().encode(displayName).byteLength > 160) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, displayName };
}

export function parseSchoolDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const validation = validateSchoolDisplayNameDraft(value);
  return validation.ok && value === validation.displayName
    ? validation.displayName
    : null;
}

export function parseSchoolSettings(value: unknown): SchoolSettings | null {
  const record = parseExactRecord(value, [
    "schoolId",
    "displayName",
    "settingsRevision",
  ]);
  if (record === null) return null;
  const displayName = parseSchoolDisplayName(record.displayName);
  return isCanonicalUuid(record.schoolId) &&
    displayName !== null &&
    isSettingsRevision(record.settingsRevision)
    ? {
        schoolId: record.schoolId,
        displayName,
        settingsRevision: record.settingsRevision,
      }
    : null;
}

export function parseUpdateSchoolDisplayNameRequest(
  value: unknown,
): UpdateSchoolDisplayNameRequest | null {
  const record = parseExactRecord(value, [
    "schoolId",
    "displayName",
    "expectedSettingsRevision",
  ]);
  if (record === null) return null;
  const displayName = parseSchoolDisplayName(record.displayName);
  return isCanonicalUuid(record.schoolId) &&
    displayName !== null &&
    isSettingsRevision(record.expectedSettingsRevision)
    ? {
        schoolId: record.schoolId,
        displayName,
        expectedSettingsRevision: record.expectedSettingsRevision,
      }
    : null;
}

export function parseUpdateSchoolDisplayNameRpcResult(
  value: unknown,
): UpdateSchoolDisplayNameRpcResult | null {
  const rows = parseExactArray(value, 1);
  if (rows === null || rows.length !== 1) return null;
  const row = parseExactRecord(rows[0], ["code"]);
  if (row === null) return null;
  const successCode = updateSchoolDisplayNameRpcSuccessCodes.find(
    (code) => code === row.code,
  );
  if (successCode !== undefined) return { ok: true, code: successCode };
  const failureCode = updateSchoolDisplayNameRpcFailureCodes.find(
    (code) => code === row.code,
  );
  return failureCode === undefined ? null : { ok: false, code: failureCode };
}
