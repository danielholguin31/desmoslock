import type { TestLifecycle } from "@desmoslock/domain";

import { parseExactArray, parseExactRecord } from "./exact-record.js";

export type { TestLifecycle } from "@desmoslock/domain";

export interface StaffTest {
  readonly id: string;
  readonly schoolId: string;
  readonly createdByProfileId: string;
  readonly title: string;
  readonly lifecycle: TestLifecycle;
  readonly revision: number;
  readonly createdAt: string;
  readonly openedAt: string | null;
  readonly endedAt: string | null;
}

export interface TestPageCursor {
  readonly createdAt: string;
  readonly testId: string;
}

export interface ReadSchoolTestsRequest {
  readonly schoolId: string;
  readonly before: TestPageCursor | null;
}

export interface ReadSchoolTestRequest {
  readonly schoolId: string;
  readonly testId: string;
}

export interface CreateSchoolTestRequest {
  readonly schoolId: string;
  readonly creationRequestId: string;
  readonly title: string;
}

export interface TestRevisionRequest {
  readonly schoolId: string;
  readonly testId: string;
  readonly expectedTestRevision: number;
}

export interface UpdateTestTitleRequest extends TestRevisionRequest {
  readonly title: string;
}

export type TestTitleValidation =
  "required" | "too_long" | "invalid_characters";
export type TestTitleDraftValidation =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: TestTitleValidation };

export interface StaffTestPage {
  readonly items: readonly StaffTest[];
  readonly nextCursor: TestPageCursor | null;
}

const testAccessFailureCodes = [
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
const testTargetFailureCodes = [
  ...testAccessFailureCodes,
  "test_unavailable",
] as const;
const testMutationFailureCodes = [
  ...testTargetFailureCodes,
  "test_revision_conflict",
  "test_transition_rejected",
] as const;

export type TestAccessFailureCode = (typeof testAccessFailureCodes)[number];
export type TestTargetFailureCode = (typeof testTargetFailureCodes)[number];
export type TestMutationFailureCode = (typeof testMutationFailureCodes)[number];
export type ReadSchoolTestsResult =
  | { readonly ok: true; readonly page: StaffTestPage }
  | { readonly ok: false; readonly code: TestAccessFailureCode };
export type ReadSchoolTestResult =
  | { readonly ok: true; readonly test: StaffTest }
  | { readonly ok: false; readonly code: TestTargetFailureCode };
export type CreateSchoolTestResult =
  | {
      readonly ok: true;
      readonly code: "test_created" | "test_creation_already_recorded";
      readonly testId: string;
    }
  | { readonly ok: false; readonly code: TestAccessFailureCode };
export type TestRevisionResult<Success extends string> =
  | { readonly ok: true; readonly code: Success }
  | { readonly ok: false; readonly code: TestMutationFailureCode };
export type UpdateTestTitleResult = TestRevisionResult<
  "test_title_updated" | "test_title_unchanged"
>;
export type OpenTestResult = TestRevisionResult<
  "test_opened" | "test_already_open"
>;
export type EndTestResult = TestRevisionResult<
  "test_ended" | "test_already_ended"
>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const testSqlKeys = [
  "code",
  "test_id",
  "school_id",
  "created_by_profile_id",
  "title",
  "lifecycle",
  "test_revision",
  "created_at",
  "opened_at",
  "ended_at",
] as const;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function validateTestTitleDraft(
  value: string,
): TestTitleDraftValidation {
  if (typeof value !== "string" || !value.isWellFormed())
    return { ok: false, reason: "invalid_characters" };
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
      return { ok: false, reason: "invalid_characters" };
  }
  const title = value.trim();
  if (title.length === 0) return { ok: false, reason: "required" };
  if (new TextEncoder().encode(title).byteLength > 160)
    return { ok: false, reason: "too_long" };
  return { ok: true, title };
}

export function parseTestTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = validateTestTitleDraft(value);
  return parsed.ok && parsed.title === value ? value : null;
}

export function parseTestTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/u.exec(value);
  if (parts === null) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= maximumDay ? value : null;
}

export function parseStaffTest(value: unknown): StaffTest | null {
  const row = parseExactRecord(value, [
    "id",
    "schoolId",
    "createdByProfileId",
    "title",
    "lifecycle",
    "revision",
    "createdAt",
    "openedAt",
    "endedAt",
  ]);
  if (row === null) return null;
  const title = parseTestTitle(row.title);
  const createdAt = parseTestTimestamp(row.createdAt);
  const openedAt =
    row.openedAt === null ? null : parseTestTimestamp(row.openedAt);
  const endedAt = row.endedAt === null ? null : parseTestTimestamp(row.endedAt);
  if (
    !isUuid(row.id) ||
    !isUuid(row.schoolId) ||
    !isUuid(row.createdByProfileId) ||
    title === null ||
    !isRevision(row.revision) ||
    createdAt === null ||
    (row.openedAt !== null && openedAt === null) ||
    (row.endedAt !== null && endedAt === null)
  )
    return null;
  const lifecycle = row.lifecycle;
  if (
    (lifecycle !== "draft" && lifecycle !== "open" && lifecycle !== "ended") ||
    (lifecycle === "draft" && (openedAt !== null || endedAt !== null)) ||
    (lifecycle === "open" && (openedAt === null || endedAt !== null)) ||
    (lifecycle === "ended" && (openedAt === null || endedAt === null)) ||
    (openedAt !== null && openedAt < createdAt) ||
    (openedAt !== null && endedAt !== null && endedAt < openedAt)
  )
    return null;
  return {
    id: row.id,
    schoolId: row.schoolId,
    createdByProfileId: row.createdByProfileId,
    title,
    lifecycle,
    revision: row.revision,
    createdAt,
    openedAt,
    endedAt,
  };
}

export function parseTestPageCursor(value: unknown): TestPageCursor | null {
  const row = parseExactRecord(value, ["createdAt", "testId"]);
  if (row === null) return null;
  const createdAt = parseTestTimestamp(row.createdAt);
  return createdAt !== null && isUuid(row.testId)
    ? { createdAt, testId: row.testId }
    : null;
}

export function parseReadSchoolTestsRequest(
  value: unknown,
): ReadSchoolTestsRequest | null {
  const row = parseExactRecord(value, ["schoolId", "before"]);
  if (row === null || !isUuid(row.schoolId)) return null;
  const before = row.before === null ? null : parseTestPageCursor(row.before);
  return row.before === null || before !== null
    ? { schoolId: row.schoolId, before }
    : null;
}

export function parseReadSchoolTestRequest(
  value: unknown,
): ReadSchoolTestRequest | null {
  const row = parseExactRecord(value, ["schoolId", "testId"]);
  return row !== null && isUuid(row.schoolId) && isUuid(row.testId)
    ? { schoolId: row.schoolId, testId: row.testId }
    : null;
}

export function parseCreateSchoolTestRequest(
  value: unknown,
): CreateSchoolTestRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "creationRequestId",
    "title",
  ]);
  if (row === null) return null;
  const title = parseTestTitle(row.title);
  return isUuid(row.schoolId) && isUuid(row.creationRequestId) && title !== null
    ? {
        schoolId: row.schoolId,
        creationRequestId: row.creationRequestId,
        title,
      }
    : null;
}

export function parseTestRevisionRequest(
  value: unknown,
): TestRevisionRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "expectedTestRevision",
  ]);
  return row !== null &&
    isUuid(row.schoolId) &&
    isUuid(row.testId) &&
    isRevision(row.expectedTestRevision)
    ? {
        schoolId: row.schoolId,
        testId: row.testId,
        expectedTestRevision: row.expectedTestRevision,
      }
    : null;
}

export function parseUpdateTestTitleRequest(
  value: unknown,
): UpdateTestTitleRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "expectedTestRevision",
    "title",
  ]);
  if (row === null) return null;
  const title = parseTestTitle(row.title);
  return isUuid(row.schoolId) &&
    isUuid(row.testId) &&
    isRevision(row.expectedTestRevision) &&
    title !== null
    ? {
        schoolId: row.schoolId,
        testId: row.testId,
        expectedTestRevision: row.expectedTestRevision,
        title,
      }
    : null;
}

function parseSqlTest(row: Record<string, unknown>): StaffTest | null {
  if (row.code !== "ok") return null;
  return parseStaffTest({
    id: row.test_id,
    schoolId: row.school_id,
    createdByProfileId: row.created_by_profile_id,
    title: row.title,
    lifecycle: row.lifecycle,
    revision: row.test_revision,
    createdAt: row.created_at,
    openedAt: row.opened_at,
    endedAt: row.ended_at,
  });
}

function hasNullTestPayload(row: Record<string, unknown>): boolean {
  return testSqlKeys.every((key) => key === "code" || row[key] === null);
}

// Fixed-width UTC microseconds and canonical UUID text preserve the native
// PostgreSQL (created_at, id) ordering without rounding or locale collation.
function isBefore(test: StaffTest, cursor: TestPageCursor): boolean {
  return (
    test.createdAt < cursor.createdAt ||
    (test.createdAt === cursor.createdAt && test.id < cursor.testId)
  );
}

export function parseReadSchoolTestsRpcResult(
  value: unknown,
  request: ReadSchoolTestsRequest,
): ReadSchoolTestsResult | null {
  const input = parseReadSchoolTestsRequest(request);
  const rows = parseExactArray(value, 51);
  if (input === null || rows === null) return null;
  const items: StaffTest[] = [];
  const ids = new Set<string>();
  let previous = input.before;
  for (const value of rows) {
    const row = parseExactRecord(value, testSqlKeys);
    if (row === null) return null;
    if (row.code !== "ok") {
      const code = testAccessFailureCodes.find((code) => code === row.code);
      return rows.length === 1 && code !== undefined && hasNullTestPayload(row)
        ? { ok: false, code }
        : null;
    }
    const test = parseSqlTest(row);
    if (
      test === null ||
      test.schoolId !== input.schoolId ||
      ids.has(test.id) ||
      (previous !== null && !isBefore(test, previous))
    )
      return null;
    ids.add(test.id);
    items.push(test);
    previous = { createdAt: test.createdAt, testId: test.id };
  }
  const lastVisible = items[49];
  const nextCursor =
    items.length === 51 && lastVisible !== undefined
      ? { createdAt: lastVisible.createdAt, testId: lastVisible.id }
      : null;
  return { ok: true, page: { items: items.slice(0, 50), nextCursor } };
}

export function parseReadSchoolTestRpcResult(
  value: unknown,
  request: ReadSchoolTestRequest,
): ReadSchoolTestResult | null {
  const input = parseReadSchoolTestRequest(request);
  const rows = parseExactArray(value, 1);
  if (input === null || rows === null || rows.length !== 1) return null;
  const row = parseExactRecord(rows[0], testSqlKeys);
  if (row === null) return null;
  if (row.code !== "ok") {
    const code = testTargetFailureCodes.find((code) => code === row.code);
    return code !== undefined && hasNullTestPayload(row)
      ? { ok: false, code }
      : null;
  }
  const test = parseSqlTest(row);
  return test !== null &&
    test.id === input.testId &&
    test.schoolId === input.schoolId
    ? { ok: true, test }
    : null;
}

export function parseCreateSchoolTestRpcResult(
  value: unknown,
): CreateSchoolTestResult | null {
  const rows = parseExactArray(value, 1);
  if (rows === null || rows.length !== 1) return null;
  const row = parseExactRecord(rows[0], ["code", "test_id"]);
  if (row === null) return null;
  if (
    row.code === "test_created" ||
    row.code === "test_creation_already_recorded"
  )
    return isUuid(row.test_id)
      ? { ok: true, code: row.code, testId: row.test_id }
      : null;
  const code = testAccessFailureCodes.find((code) => code === row.code);
  return code !== undefined && row.test_id === null
    ? { ok: false, code }
    : null;
}

function parseCodeOnly(value: unknown): Record<string, unknown> | null {
  const rows = parseExactArray(value, 1);
  return rows !== null && rows.length === 1
    ? parseExactRecord(rows[0], ["code"])
    : null;
}

function parseRevisionFailure(
  row: Record<string, unknown>,
): { readonly ok: false; readonly code: TestMutationFailureCode } | null {
  const code = testMutationFailureCodes.find((code) => code === row.code);
  return code === undefined ? null : { ok: false, code };
}

export function parseUpdateTestTitleRpcResult(
  value: unknown,
): UpdateTestTitleResult | null {
  const row = parseCodeOnly(value);
  if (row === null) return null;
  return row.code === "test_title_updated" ||
    row.code === "test_title_unchanged"
    ? { ok: true, code: row.code }
    : parseRevisionFailure(row);
}

export function parseOpenTestRpcResult(value: unknown): OpenTestResult | null {
  const row = parseCodeOnly(value);
  if (row === null) return null;
  return row.code === "test_opened" || row.code === "test_already_open"
    ? { ok: true, code: row.code }
    : parseRevisionFailure(row);
}

export function parseEndTestRpcResult(value: unknown): EndTestResult | null {
  const row = parseCodeOnly(value);
  if (row === null) return null;
  return row.code === "test_ended" || row.code === "test_already_ended"
    ? { ok: true, code: row.code }
    : parseRevisionFailure(row);
}
