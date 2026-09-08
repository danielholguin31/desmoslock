import { parseExactArray, parseExactRecord } from "./exact-record.js";
import { parseTestTimestamp } from "./test-workspace.js";

export type StudentAdmissionMode = "initial" | "readmission";
export type StudentAdmissionState =
  "active" | "removed" | "readmitted" | "forfeited";

export interface StudentSessionScope {
  readonly schoolId: string;
  readonly testId: string;
  readonly studentSessionId: string;
  readonly deviceSessionId: string;
  readonly epoch: number;
}
export interface StudentBootstrapProof {
  readonly challengeId: string;
  readonly expiresAtMs: number;
  readonly publicKey: string;
  readonly signature: string;
}
export interface StudentMaintenanceProof {
  readonly counter: number;
  readonly signature: string;
}
export interface StudentChallengeRequest {
  readonly requestId: string;
  readonly deviceSessionId: string;
  readonly publicKey: string;
  readonly logicalOperationDigest: string;
}
export interface StudentJoinRequest {
  readonly admissionMode: StudentAdmissionMode;
  readonly requestId: string;
  readonly deviceSessionId: string;
  readonly joinCode: string;
  readonly capabilityDigest: string;
  readonly reconnectDigest: string;
  readonly deviceProof: StudentBootstrapProof;
}
export interface StudentReadRequest {
  readonly requestId: string;
  readonly scope: StudentSessionScope;
  readonly capabilityToken: string;
  readonly deviceProof: StudentMaintenanceProof;
}
export interface StudentReconnectRequest {
  readonly requestId: string;
  readonly scope: StudentSessionScope;
  readonly expectedSessionRevision: number;
  readonly reconnectGrant: string;
  readonly nextCapabilityDigest: string;
  readonly nextReconnectDigest: string;
  readonly deviceProof: StudentMaintenanceProof;
}
export interface StudentForfeitRequest extends StudentReadRequest {
  readonly expectedSessionRevision: number;
}
export interface StudentSessionDenied {
  readonly status: "denied";
  readonly code: "STUDENT_SESSION_DENIED";
}
export interface StudentSessionUnavailable {
  readonly status: "unavailable";
  readonly code: "STUDENT_SESSION_UNAVAILABLE";
}
export type StudentSessionFailure =
  StudentSessionDenied | StudentSessionUnavailable;
export interface StudentChallengeAccepted {
  readonly challengeId: string;
  readonly expiresAtMs: number;
}
export interface StudentJoinAccepted {
  readonly status: "accepted";
  readonly code: "STUDENT_SESSION_ACCEPTED";
  readonly requestId: string;
  readonly logicalOperationDigest: string;
  readonly scope: StudentSessionScope;
  readonly sessionRevision: number;
  readonly syntheticDisplayName: string;
  readonly serverNowMs: number;
  readonly capabilityIssuedAtMs: number;
  readonly capabilityExpiresAtMs: number;
  readonly reconnectExpiresAtMs: number;
  readonly allowedIntents: readonly ["state.read", "session.forfeit"];
}
export interface StudentReconnectAccepted extends StudentJoinAccepted {
  readonly acceptedProofCounter: number;
}
export interface StudentReadAccepted {
  readonly status: "accepted";
  readonly code: "STUDENT_SESSION_CURRENT";
  readonly requestId: string;
  readonly acceptedProofCounter: number;
  readonly scope: StudentSessionScope;
  readonly sessionRevision: number;
  readonly syntheticDisplayName: string;
  readonly testLifecycle: "open";
  readonly state: "active";
  readonly serverNowMs: number;
  readonly capabilityExpiresAtMs: number;
}
export interface StudentForfeitAccepted {
  readonly status: "accepted";
  readonly code: "STUDENT_SESSION_FORFEITED";
  readonly requestId: string;
  readonly acceptedProofCounter: number;
}
export type StudentChallengeResult =
  StudentChallengeAccepted | StudentSessionFailure;
export type StudentJoinResult = StudentJoinAccepted | StudentSessionFailure;
export type StudentReconnectResult =
  StudentReconnectAccepted | StudentSessionFailure;
export type StudentReadResult = StudentReadAccepted | StudentSessionFailure;
export type StudentForfeitResult =
  StudentForfeitAccepted | StudentSessionFailure;

export interface StudentSessionViewState {
  readonly revision: number;
  readonly phase:
    | "entry"
    | "joining"
    | "active"
    | "unconfirmed"
    | "unavailable"
    | "recovery_required"
    | "forfeited";
  readonly session: {
    readonly syntheticDisplayName: string;
    readonly sessionRevision: number;
    readonly capabilityExpiresAtMs: number;
  } | null;
  readonly protection: "unavailable";
  readonly calculatorEligible: false;
  readonly pendingOperation: "join" | "reconnect" | "forfeit" | null;
}

export function parseStudentUuid(value: unknown): string | null {
  return typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
    ? value
    : null;
}
export function parseStudentDigest(value: unknown): string | null {
  return typeof value === "string" &&
    value.length === 64 &&
    /^[0-9a-f]{64}$/u.test(value)
    ? value
    : null;
}
export function parseStudentSecret(value: unknown): string | null {
  // A 32-byte value has two zero trailing bits in its 43rd base64url sextet.
  return typeof value === "string" &&
    value.length === 43 &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
    ? value
    : null;
}
export function parseStudentPublicKey(value: unknown): string | null {
  return parseStudentSecret(value);
}
export function parseStudentSignature(value: unknown): string | null {
  // A 64-byte value has four zero trailing bits in its final sextet.
  return typeof value === "string" &&
    value.length === 86 &&
    /^[A-Za-z0-9_-]{85}[AQgw]$/u.test(value)
    ? value
    : null;
}
export function parseStudentCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}
export function parseStudentJoinCode(value: unknown): string | null {
  return typeof value === "string" &&
    value.length === 12 &&
    /^[0-9A-HJKMNP-TV-Z]{12}$/u.test(value)
    ? value
    : null;
}
export function parseStudentTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length === 27
    ? parseTestTimestamp(value)
    : null;
}
function parseMilliseconds(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
    ? value
    : null;
}
function parseSyntheticDisplayName(value: unknown): string | null {
  return typeof value === "string" &&
    /^Student [A-Z0-9][A-Z0-9-]{1,23}$/u.exec(value)?.[0] === value
    ? value
    : null;
}
function parseAdmissionState(value: unknown): StudentAdmissionState | null {
  return value === "active" ||
    value === "removed" ||
    value === "readmitted" ||
    value === "forfeited"
    ? value
    : null;
}
export function parseStudentSessionScope(
  value: unknown,
): StudentSessionScope | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "studentSessionId",
    "deviceSessionId",
    "epoch",
  ]);
  if (row === null) return null;
  const schoolId = parseStudentUuid(row.schoolId);
  const testId = parseStudentUuid(row.testId);
  const studentSessionId = parseStudentUuid(row.studentSessionId);
  const deviceSessionId = parseStudentUuid(row.deviceSessionId);
  const epoch = parseStudentCounter(row.epoch);
  return schoolId !== null &&
    testId !== null &&
    studentSessionId !== null &&
    deviceSessionId !== null &&
    epoch !== null
    ? { schoolId, testId, studentSessionId, deviceSessionId, epoch }
    : null;
}
export function parseStudentBootstrapProof(
  value: unknown,
): StudentBootstrapProof | null {
  const row = parseExactRecord(value, [
    "challengeId",
    "expiresAtMs",
    "publicKey",
    "signature",
  ]);
  if (row === null) return null;
  const challengeId = parseStudentUuid(row.challengeId);
  const expiresAtMs = parseMilliseconds(row.expiresAtMs);
  const publicKey = parseStudentPublicKey(row.publicKey);
  const signature = parseStudentSignature(row.signature);
  return challengeId !== null &&
    expiresAtMs !== null &&
    publicKey !== null &&
    signature !== null
    ? { challengeId, expiresAtMs, publicKey, signature }
    : null;
}
export function parseStudentMaintenanceProof(
  value: unknown,
): StudentMaintenanceProof | null {
  const row = parseExactRecord(value, ["counter", "signature"]);
  if (row === null) return null;
  const counter = parseStudentCounter(row.counter);
  const signature = parseStudentSignature(row.signature);
  return counter !== null && signature !== null ? { counter, signature } : null;
}
export function parseStudentChallengeRequest(
  value: unknown,
): StudentChallengeRequest | null {
  const row = parseExactRecord(value, [
    "requestId",
    "deviceSessionId",
    "publicKey",
    "logicalOperationDigest",
  ]);
  if (row === null) return null;
  const requestId = parseStudentUuid(row.requestId);
  const deviceSessionId = parseStudentUuid(row.deviceSessionId);
  const publicKey = parseStudentPublicKey(row.publicKey);
  const logicalOperationDigest = parseStudentDigest(row.logicalOperationDigest);
  return requestId !== null &&
    deviceSessionId !== null &&
    publicKey !== null &&
    logicalOperationDigest !== null
    ? { requestId, deviceSessionId, publicKey, logicalOperationDigest }
    : null;
}
export function parseStudentJoinRequest(
  value: unknown,
): StudentJoinRequest | null {
  const row = parseExactRecord(value, [
    "admissionMode",
    "requestId",
    "deviceSessionId",
    "joinCode",
    "capabilityDigest",
    "reconnectDigest",
    "deviceProof",
  ]);
  if (row === null) return null;
  const admissionMode = row.admissionMode;
  const requestId = parseStudentUuid(row.requestId);
  const deviceSessionId = parseStudentUuid(row.deviceSessionId);
  const joinCode = parseStudentJoinCode(row.joinCode);
  const capabilityDigest = parseStudentDigest(row.capabilityDigest);
  const reconnectDigest = parseStudentDigest(row.reconnectDigest);
  const deviceProof = parseStudentBootstrapProof(row.deviceProof);
  return (admissionMode === "initial" || admissionMode === "readmission") &&
    requestId !== null &&
    deviceSessionId !== null &&
    joinCode !== null &&
    capabilityDigest !== null &&
    reconnectDigest !== null &&
    deviceProof !== null
    ? {
        admissionMode,
        requestId,
        deviceSessionId,
        joinCode,
        capabilityDigest,
        reconnectDigest,
        deviceProof,
      }
    : null;
}
export function parseStudentReadRequest(
  value: unknown,
): StudentReadRequest | null {
  const row = parseExactRecord(value, [
    "requestId",
    "scope",
    "capabilityToken",
    "deviceProof",
  ]);
  if (row === null) return null;
  const requestId = parseStudentUuid(row.requestId);
  const scope = parseStudentSessionScope(row.scope);
  const capabilityToken = parseStudentSecret(row.capabilityToken);
  const deviceProof = parseStudentMaintenanceProof(row.deviceProof);
  return requestId !== null &&
    scope !== null &&
    capabilityToken !== null &&
    deviceProof !== null
    ? { requestId, scope, capabilityToken, deviceProof }
    : null;
}
export function parseStudentForfeitRequest(
  value: unknown,
): StudentForfeitRequest | null {
  const row = parseExactRecord(value, [
    "requestId",
    "scope",
    "expectedSessionRevision",
    "capabilityToken",
    "deviceProof",
  ]);
  if (row === null) return null;
  const read = parseStudentReadRequest({
    requestId: row.requestId,
    scope: row.scope,
    capabilityToken: row.capabilityToken,
    deviceProof: row.deviceProof,
  });
  const expectedSessionRevision = parseStudentCounter(
    row.expectedSessionRevision,
  );
  return read !== null && expectedSessionRevision !== null
    ? { ...read, expectedSessionRevision }
    : null;
}
export function parseStudentReconnectRequest(
  value: unknown,
): StudentReconnectRequest | null {
  const row = parseExactRecord(value, [
    "requestId",
    "scope",
    "expectedSessionRevision",
    "reconnectGrant",
    "nextCapabilityDigest",
    "nextReconnectDigest",
    "deviceProof",
  ]);
  if (row === null) return null;
  const requestId = parseStudentUuid(row.requestId);
  const scope = parseStudentSessionScope(row.scope);
  const expectedSessionRevision = parseStudentCounter(
    row.expectedSessionRevision,
  );
  const reconnectGrant = parseStudentSecret(row.reconnectGrant);
  const nextCapabilityDigest = parseStudentDigest(row.nextCapabilityDigest);
  const nextReconnectDigest = parseStudentDigest(row.nextReconnectDigest);
  const deviceProof = parseStudentMaintenanceProof(row.deviceProof);
  return requestId !== null &&
    scope !== null &&
    expectedSessionRevision !== null &&
    reconnectGrant !== null &&
    nextCapabilityDigest !== null &&
    nextReconnectDigest !== null &&
    deviceProof !== null
    ? {
        requestId,
        scope,
        expectedSessionRevision,
        reconnectGrant,
        nextCapabilityDigest,
        nextReconnectDigest,
        deviceProof,
      }
    : null;
}
export function parseStudentSessionFailure(
  value: unknown,
): StudentSessionFailure | null {
  const row = parseExactRecord(value, ["status", "code"]);
  if (row === null) return null;
  if (row.status === "denied" && row.code === "STUDENT_SESSION_DENIED")
    return { status: "denied", code: "STUDENT_SESSION_DENIED" };
  if (
    row.status === "unavailable" &&
    row.code === "STUDENT_SESSION_UNAVAILABLE"
  )
    return { status: "unavailable", code: "STUDENT_SESSION_UNAVAILABLE" };
  return null;
}
function sameScope(
  left: StudentSessionScope,
  right: StudentSessionScope,
): boolean {
  return (
    left.schoolId === right.schoolId &&
    left.testId === right.testId &&
    left.studentSessionId === right.studentSessionId &&
    left.deviceSessionId === right.deviceSessionId &&
    left.epoch === right.epoch
  );
}
export function parseStudentChallengeResult(
  value: unknown,
): StudentChallengeResult | null {
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  const row = parseExactRecord(value, ["challengeId", "expiresAtMs"]);
  if (row === null) return null;
  const challengeId = parseStudentUuid(row.challengeId);
  // The response has no server clock. Local wall-clock skew cannot determine
  // its age; the transaction checks the authoritative 15-second expiry.
  const expiresAtMs = parseStudentCounter(row.expiresAtMs);
  return challengeId !== null && expiresAtMs !== null
    ? { challengeId, expiresAtMs }
    : null;
}
const issuanceKeys = [
  "status",
  "code",
  "requestId",
  "logicalOperationDigest",
  "scope",
  "sessionRevision",
  "syntheticDisplayName",
  "serverNowMs",
  "capabilityIssuedAtMs",
  "capabilityExpiresAtMs",
  "reconnectExpiresAtMs",
  "allowedIntents",
] as const;
function parseIssuance(
  row: Record<string, unknown>,
): StudentJoinAccepted | null {
  const requestId = parseStudentUuid(row.requestId);
  const logicalOperationDigest = parseStudentDigest(row.logicalOperationDigest);
  const scope = parseStudentSessionScope(row.scope);
  const sessionRevision = parseStudentCounter(row.sessionRevision);
  const syntheticDisplayName = parseSyntheticDisplayName(
    row.syntheticDisplayName,
  );
  const serverNowMs = parseMilliseconds(row.serverNowMs);
  const capabilityIssuedAtMs = parseMilliseconds(row.capabilityIssuedAtMs);
  const capabilityExpiresAtMs = parseMilliseconds(row.capabilityExpiresAtMs);
  const reconnectExpiresAtMs = parseMilliseconds(row.reconnectExpiresAtMs);
  const intents = parseExactArray(row.allowedIntents, 2);
  if (
    row.status !== "accepted" ||
    row.code !== "STUDENT_SESSION_ACCEPTED" ||
    requestId === null ||
    logicalOperationDigest === null ||
    scope === null ||
    sessionRevision === null ||
    syntheticDisplayName === null ||
    serverNowMs === null ||
    capabilityIssuedAtMs === null ||
    capabilityExpiresAtMs === null ||
    reconnectExpiresAtMs === null ||
    intents === null ||
    intents.length !== 2 ||
    intents[0] !== "state.read" ||
    intents[1] !== "session.forfeit"
  )
    return null;
  // Receipt recovery keeps the original lifetimes. Access may have expired, but
  // the original refresh must still be live; the caller must rotate before read.
  if (
    capabilityIssuedAtMs > serverNowMs ||
    capabilityExpiresAtMs <= capabilityIssuedAtMs ||
    capabilityExpiresAtMs - capabilityIssuedAtMs > 300_000 ||
    reconnectExpiresAtMs < capabilityExpiresAtMs ||
    reconnectExpiresAtMs - capabilityIssuedAtMs > 900_000 ||
    reconnectExpiresAtMs <= serverNowMs
  )
    return null;
  return {
    status: "accepted",
    code: "STUDENT_SESSION_ACCEPTED",
    requestId,
    logicalOperationDigest,
    scope,
    sessionRevision,
    syntheticDisplayName,
    serverNowMs,
    capabilityIssuedAtMs,
    capabilityExpiresAtMs,
    reconnectExpiresAtMs,
    allowedIntents: ["state.read", "session.forfeit"],
  };
}
export function parseStudentJoinResult(
  value: unknown,
  request: StudentJoinRequest,
  expectedLogicalOperationDigest: string,
): StudentJoinResult | null {
  const input = parseStudentJoinRequest(request);
  if (
    input === null ||
    parseStudentDigest(expectedLogicalOperationDigest) === null
  )
    return null;
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  const row = parseExactRecord(value, issuanceKeys);
  const result = row === null ? null : parseIssuance(row);
  if (
    result === null ||
    result.requestId !== input.requestId ||
    result.logicalOperationDigest !== expectedLogicalOperationDigest ||
    result.scope.deviceSessionId !== input.deviceSessionId
  )
    return null;
  if (
    input.admissionMode === "initial"
      ? result.scope.epoch !== 1 || result.sessionRevision !== 1
      : result.scope.epoch < 2 || result.sessionRevision < 3
  )
    return null;
  return result;
}
export function parseStudentReconnectResult(
  value: unknown,
  request: StudentReconnectRequest,
  expectedLogicalOperationDigest: string,
): StudentReconnectResult | null {
  const input = parseStudentReconnectRequest(request);
  if (
    input === null ||
    parseStudentDigest(expectedLogicalOperationDigest) === null
  )
    return null;
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  const row = parseExactRecord(value, [
    ...issuanceKeys,
    "acceptedProofCounter",
  ]);
  const result = row === null ? null : parseIssuance(row);
  if (
    row === null ||
    result === null ||
    result.requestId !== input.requestId ||
    result.logicalOperationDigest !== expectedLogicalOperationDigest ||
    !sameScope(result.scope, input.scope) ||
    input.expectedSessionRevision === Number.MAX_SAFE_INTEGER ||
    result.sessionRevision !== input.expectedSessionRevision + 1 ||
    row.acceptedProofCounter !== input.deviceProof.counter
  )
    return null;
  return { ...result, acceptedProofCounter: input.deviceProof.counter };
}
export function parseStudentReadResult(
  value: unknown,
  request: StudentReadRequest,
  expectedCapabilityExpiresAtMs: number,
): StudentReadResult | null {
  const input = parseStudentReadRequest(request);
  if (
    input === null ||
    parseMilliseconds(expectedCapabilityExpiresAtMs) === null
  )
    return null;
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  const row = parseExactRecord(value, [
    "status",
    "code",
    "requestId",
    "acceptedProofCounter",
    "scope",
    "sessionRevision",
    "syntheticDisplayName",
    "testLifecycle",
    "state",
    "serverNowMs",
    "capabilityExpiresAtMs",
  ]);
  if (row === null) return null;
  const scope = parseStudentSessionScope(row.scope);
  const sessionRevision = parseStudentCounter(row.sessionRevision);
  const syntheticDisplayName = parseSyntheticDisplayName(
    row.syntheticDisplayName,
  );
  const serverNowMs = parseMilliseconds(row.serverNowMs);
  const capabilityExpiresAtMs = parseMilliseconds(row.capabilityExpiresAtMs);
  if (
    row.status !== "accepted" ||
    row.code !== "STUDENT_SESSION_CURRENT" ||
    row.requestId !== input.requestId ||
    row.acceptedProofCounter !== input.deviceProof.counter ||
    scope === null ||
    !sameScope(scope, input.scope) ||
    sessionRevision === null ||
    syntheticDisplayName === null ||
    row.testLifecycle !== "open" ||
    row.state !== "active" ||
    serverNowMs === null ||
    capabilityExpiresAtMs === null ||
    capabilityExpiresAtMs !== expectedCapabilityExpiresAtMs ||
    capabilityExpiresAtMs <= serverNowMs ||
    capabilityExpiresAtMs - serverNowMs > 300_000
  )
    return null;
  return {
    status: "accepted",
    code: "STUDENT_SESSION_CURRENT",
    requestId: input.requestId,
    acceptedProofCounter: input.deviceProof.counter,
    scope,
    sessionRevision,
    syntheticDisplayName,
    testLifecycle: "open",
    state: "active",
    serverNowMs,
    capabilityExpiresAtMs,
  };
}
export function parseStudentForfeitResult(
  value: unknown,
  request: StudentForfeitRequest,
): StudentForfeitResult | null {
  const input = parseStudentForfeitRequest(request);
  if (input === null) return null;
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  if (
    input.expectedSessionRevision === Number.MAX_SAFE_INTEGER ||
    input.scope.epoch === Number.MAX_SAFE_INTEGER
  )
    return null;
  const row = parseExactRecord(value, [
    "status",
    "code",
    "requestId",
    "acceptedProofCounter",
  ]);
  return row !== null &&
    row.status === "accepted" &&
    row.code === "STUDENT_SESSION_FORFEITED" &&
    row.requestId === input.requestId &&
    row.acceptedProofCounter === input.deviceProof.counter
    ? {
        status: "accepted",
        code: "STUDENT_SESSION_FORFEITED",
        requestId: input.requestId,
        acceptedProofCounter: input.deviceProof.counter,
      }
    : null;
}

export interface StaffStudentSession {
  readonly id: string;
  readonly schoolId: string;
  readonly testId: string;
  readonly syntheticDisplayName: string;
  readonly state: StudentAdmissionState;
  readonly epoch: number;
  readonly revision: number;
  readonly createdAt: string;
}
export interface StudentSessionPageCursor {
  readonly createdAt: string;
  readonly sessionId: string;
}
export interface StaffStudentSessionPage {
  readonly items: readonly StaffStudentSession[];
  readonly nextCursor: StudentSessionPageCursor | null;
}
export interface ReadStudentSessionsRequest {
  readonly schoolId: string;
  readonly testId: string;
  readonly before: StudentSessionPageCursor | null;
}
export interface IssueTestJoinCodeRequest {
  readonly schoolId: string;
  readonly testId: string;
  readonly expectedTestRevision: number;
  readonly issuanceRequestId: string;
  readonly joinMaterialDigest: string;
}
export interface RemoveStudentSessionRequest {
  readonly schoolId: string;
  readonly testId: string;
  readonly studentSessionId: string;
  readonly expectedSessionRevision: number;
}
export interface PrepareStudentReadmissionRequest extends RemoveStudentSessionRequest {
  readonly issuanceRequestId: string;
  readonly joinMaterialDigest: string;
}
const staffAccessFailureCodes = [
  "email_unverified",
  "forbidden",
  "invalid_request",
  "membership_inactive",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
  "dependency_unavailable",
  "test_unavailable",
] as const;
const staffMutationFailureCodes = [
  ...staffAccessFailureCodes,
  "test_revision_conflict",
  "test_transition_rejected",
  "student_session_unavailable",
  "student_session_revision_conflict",
  "student_session_transition_rejected",
] as const;
export type StudentSessionAccessFailureCode =
  (typeof staffAccessFailureCodes)[number];
export type StudentSessionMutationFailureCode =
  (typeof staffMutationFailureCodes)[number];
export type ReadStudentSessionsResult =
  | { readonly ok: true; readonly page: StaffStudentSessionPage }
  | { readonly ok: false; readonly code: StudentSessionAccessFailureCode };
export type IssueTestJoinCodeResult =
  | {
      readonly ok: true;
      readonly code: "join_code_issued" | "join_code_already_issued";
      readonly testId: string;
      readonly testRevision: number;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly code: StudentSessionMutationFailureCode };
export type RemoveStudentSessionResult =
  | {
      readonly ok: true;
      readonly code:
        "student_session_removed" | "student_session_already_removed";
      readonly testId: string;
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly epoch: number;
    }
  | { readonly ok: false; readonly code: StudentSessionMutationFailureCode };
export type PrepareStudentReadmissionResult =
  | {
      readonly ok: true;
      readonly code:
        "student_readmission_prepared" | "student_readmission_already_prepared";
      readonly testId: string;
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly epoch: number;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly code: StudentSessionMutationFailureCode };

export function parseStaffStudentSession(
  value: unknown,
): StaffStudentSession | null {
  const row = parseExactRecord(value, [
    "id",
    "schoolId",
    "testId",
    "syntheticDisplayName",
    "state",
    "epoch",
    "revision",
    "createdAt",
  ]);
  if (row === null) return null;
  const id = parseStudentUuid(row.id);
  const schoolId = parseStudentUuid(row.schoolId);
  const testId = parseStudentUuid(row.testId);
  const syntheticDisplayName = parseSyntheticDisplayName(
    row.syntheticDisplayName,
  );
  const state = parseAdmissionState(row.state);
  const epoch = parseStudentCounter(row.epoch);
  const revision = parseStudentCounter(row.revision);
  const createdAt = parseStudentTimestamp(row.createdAt);
  return id !== null &&
    schoolId !== null &&
    testId !== null &&
    syntheticDisplayName !== null &&
    state !== null &&
    epoch !== null &&
    revision !== null &&
    createdAt !== null
    ? {
        id,
        schoolId,
        testId,
        syntheticDisplayName,
        state,
        epoch,
        revision,
        createdAt,
      }
    : null;
}
export function parseStudentSessionPageCursor(
  value: unknown,
): StudentSessionPageCursor | null {
  const row = parseExactRecord(value, ["createdAt", "sessionId"]);
  if (row === null) return null;
  const createdAt = parseStudentTimestamp(row.createdAt);
  const sessionId = parseStudentUuid(row.sessionId);
  return createdAt !== null && sessionId !== null
    ? { createdAt, sessionId }
    : null;
}
export function parseReadStudentSessionsRequest(
  value: unknown,
): ReadStudentSessionsRequest | null {
  const row = parseExactRecord(value, ["schoolId", "testId", "before"]);
  if (row === null) return null;
  const schoolId = parseStudentUuid(row.schoolId);
  const testId = parseStudentUuid(row.testId);
  const before =
    row.before === null ? null : parseStudentSessionPageCursor(row.before);
  return schoolId !== null &&
    testId !== null &&
    (row.before === null || before !== null)
    ? { schoolId, testId, before }
    : null;
}
export function parseIssueTestJoinCodeRequest(
  value: unknown,
): IssueTestJoinCodeRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "expectedTestRevision",
    "issuanceRequestId",
    "joinMaterialDigest",
  ]);
  if (row === null) return null;
  const schoolId = parseStudentUuid(row.schoolId);
  const testId = parseStudentUuid(row.testId);
  const expectedTestRevision = parseStudentCounter(row.expectedTestRevision);
  const issuanceRequestId = parseStudentUuid(row.issuanceRequestId);
  const joinMaterialDigest = parseStudentDigest(row.joinMaterialDigest);
  return schoolId !== null &&
    testId !== null &&
    expectedTestRevision !== null &&
    issuanceRequestId !== null &&
    joinMaterialDigest !== null
    ? {
        schoolId,
        testId,
        expectedTestRevision,
        issuanceRequestId,
        joinMaterialDigest,
      }
    : null;
}
export function parseRemoveStudentSessionRequest(
  value: unknown,
): RemoveStudentSessionRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "studentSessionId",
    "expectedSessionRevision",
  ]);
  if (row === null) return null;
  const schoolId = parseStudentUuid(row.schoolId);
  const testId = parseStudentUuid(row.testId);
  const studentSessionId = parseStudentUuid(row.studentSessionId);
  const expectedSessionRevision = parseStudentCounter(
    row.expectedSessionRevision,
  );
  return schoolId !== null &&
    testId !== null &&
    studentSessionId !== null &&
    expectedSessionRevision !== null
    ? { schoolId, testId, studentSessionId, expectedSessionRevision }
    : null;
}
export function parsePrepareStudentReadmissionRequest(
  value: unknown,
): PrepareStudentReadmissionRequest | null {
  const row = parseExactRecord(value, [
    "schoolId",
    "testId",
    "studentSessionId",
    "expectedSessionRevision",
    "issuanceRequestId",
    "joinMaterialDigest",
  ]);
  if (row === null) return null;
  const target = parseRemoveStudentSessionRequest({
    schoolId: row.schoolId,
    testId: row.testId,
    studentSessionId: row.studentSessionId,
    expectedSessionRevision: row.expectedSessionRevision,
  });
  const issuanceRequestId = parseStudentUuid(row.issuanceRequestId);
  const joinMaterialDigest = parseStudentDigest(row.joinMaterialDigest);
  return target !== null &&
    issuanceRequestId !== null &&
    joinMaterialDigest !== null
    ? { ...target, issuanceRequestId, joinMaterialDigest }
    : null;
}
const staffListKeys = [
  "code",
  "session_id",
  "school_id",
  "test_id",
  "synthetic_display_name",
  "state",
  "epoch",
  "session_revision",
  "created_at",
] as const;
const staffMutationKeys = [
  "code",
  "test_id",
  "session_id",
  "session_revision",
  "test_revision",
  "epoch",
  "expires_at",
] as const;
function isBefore(
  session: StaffStudentSession,
  cursor: StudentSessionPageCursor,
): boolean {
  return (
    session.createdAt < cursor.createdAt ||
    (session.createdAt === cursor.createdAt && session.id < cursor.sessionId)
  );
}
export function parseStaffStudentSessionPage(
  value: unknown,
  request: ReadStudentSessionsRequest,
): StaffStudentSessionPage | null {
  const input = parseReadStudentSessionsRequest(request);
  const row = parseExactRecord(value, ["items", "nextCursor"]);
  if (input === null || row === null) return null;
  const values = parseExactArray(row.items, 50);
  const nextCursor =
    row.nextCursor === null
      ? null
      : parseStudentSessionPageCursor(row.nextCursor);
  if (values === null || (row.nextCursor !== null && nextCursor === null))
    return null;
  const items: StaffStudentSession[] = [];
  const ids = new Set<string>();
  let previous = input.before;
  for (const value of values) {
    const session = parseStaffStudentSession(value);
    if (
      session === null ||
      session.schoolId !== input.schoolId ||
      session.testId !== input.testId ||
      ids.has(session.id) ||
      (previous !== null && !isBefore(session, previous))
    )
      return null;
    ids.add(session.id);
    items.push(session);
    previous = { createdAt: session.createdAt, sessionId: session.id };
  }
  if (
    nextCursor !== null &&
    (items.length !== 50 ||
      previous === null ||
      nextCursor.createdAt !== previous.createdAt ||
      nextCursor.sessionId !== previous.sessionId)
  )
    return null;
  return { items, nextCursor };
}
export function parseReadStudentSessionsRpcResult(
  value: unknown,
  request: ReadStudentSessionsRequest,
): ReadStudentSessionsResult | null {
  const input = parseReadStudentSessionsRequest(request);
  const rows = parseExactArray(value, 51);
  if (input === null || rows === null) return null;
  const items: StaffStudentSession[] = [];
  const ids = new Set<string>();
  let previous = input.before;
  for (const value of rows) {
    const row = parseExactRecord(value, staffListKeys);
    if (row === null) return null;
    if (row.code !== "ok") {
      const code = staffAccessFailureCodes.find((code) => code === row.code);
      return rows.length === 1 &&
        code !== undefined &&
        staffListKeys.every((key) => key === "code" || row[key] === null)
        ? { ok: false, code }
        : null;
    }
    const session = parseStaffStudentSession({
      id: row.session_id,
      schoolId: row.school_id,
      testId: row.test_id,
      syntheticDisplayName: row.synthetic_display_name,
      state: row.state,
      epoch: row.epoch,
      revision: row.session_revision,
      createdAt: row.created_at,
    });
    if (
      session === null ||
      session.schoolId !== input.schoolId ||
      session.testId !== input.testId ||
      ids.has(session.id) ||
      (previous !== null && !isBefore(session, previous))
    )
      return null;
    ids.add(session.id);
    items.push(session);
    previous = { createdAt: session.createdAt, sessionId: session.id };
  }
  const lastVisible = items[49];
  const nextCursor =
    items.length === 51 && lastVisible !== undefined
      ? { createdAt: lastVisible.createdAt, sessionId: lastVisible.id }
      : null;
  return { ok: true, page: { items: items.slice(0, 50), nextCursor } };
}
function parseStaffMutationRow(value: unknown): Record<string, unknown> | null {
  const rows = parseExactArray(value, 1);
  return rows !== null && rows.length === 1
    ? parseExactRecord(rows[0], staffMutationKeys)
    : null;
}
function parseStaffMutationFailure(row: Record<string, unknown>): {
  readonly ok: false;
  readonly code: StudentSessionMutationFailureCode;
} | null {
  const code = staffMutationFailureCodes.find((code) => code === row.code);
  return code !== undefined &&
    staffMutationKeys.every((key) => key === "code" || row[key] === null)
    ? { ok: false, code }
    : null;
}
export function parseIssueTestJoinCodeRpcResult(
  value: unknown,
  request: IssueTestJoinCodeRequest,
): IssueTestJoinCodeResult | null {
  const input = parseIssueTestJoinCodeRequest(request);
  const row = parseStaffMutationRow(value);
  if (input === null || row === null) return null;
  if (
    row.code !== "join_code_issued" &&
    row.code !== "join_code_already_issued"
  )
    return parseStaffMutationFailure(row);
  const testRevision = parseStudentCounter(row.test_revision);
  const expiresAt = parseStudentTimestamp(row.expires_at);
  return row.test_id === input.testId &&
    row.session_id === null &&
    row.session_revision === null &&
    row.epoch === null &&
    testRevision !== null &&
    input.expectedTestRevision < Number.MAX_SAFE_INTEGER &&
    testRevision === input.expectedTestRevision + 1 &&
    expiresAt !== null
    ? {
        ok: true,
        code: row.code,
        testId: input.testId,
        testRevision,
        expiresAt,
      }
    : null;
}
export function parseRemoveStudentSessionRpcResult(
  value: unknown,
  request: RemoveStudentSessionRequest,
): RemoveStudentSessionResult | null {
  const input = parseRemoveStudentSessionRequest(request);
  const row = parseStaffMutationRow(value);
  if (input === null || row === null) return null;
  if (
    row.code !== "student_session_removed" &&
    row.code !== "student_session_already_removed"
  )
    return parseStaffMutationFailure(row);
  const sessionRevision = parseStudentCounter(row.session_revision);
  const epoch = parseStudentCounter(row.epoch);
  const expectedRevision =
    row.code === "student_session_already_removed"
      ? input.expectedSessionRevision
      : input.expectedSessionRevision + 1;
  return row.test_id === input.testId &&
    row.session_id === input.studentSessionId &&
    row.test_revision === null &&
    row.expires_at === null &&
    sessionRevision !== null &&
    sessionRevision === expectedRevision &&
    epoch !== null
    ? {
        ok: true,
        code: row.code,
        testId: input.testId,
        sessionId: input.studentSessionId,
        sessionRevision,
        epoch,
      }
    : null;
}
export function parsePrepareStudentReadmissionRpcResult(
  value: unknown,
  request: PrepareStudentReadmissionRequest,
): PrepareStudentReadmissionResult | null {
  const input = parsePrepareStudentReadmissionRequest(request);
  const row = parseStaffMutationRow(value);
  if (input === null || row === null) return null;
  if (
    row.code !== "student_readmission_prepared" &&
    row.code !== "student_readmission_already_prepared"
  )
    return parseStaffMutationFailure(row);
  const sessionRevision = parseStudentCounter(row.session_revision);
  const epoch = parseStudentCounter(row.epoch);
  const expiresAt = parseStudentTimestamp(row.expires_at);
  return row.test_id === input.testId &&
    row.session_id === input.studentSessionId &&
    row.test_revision === null &&
    sessionRevision !== null &&
    input.expectedSessionRevision < Number.MAX_SAFE_INTEGER &&
    sessionRevision === input.expectedSessionRevision + 1 &&
    epoch !== null &&
    expiresAt !== null
    ? {
        ok: true,
        code: row.code,
        testId: input.testId,
        sessionId: input.studentSessionId,
        sessionRevision,
        epoch,
        expiresAt,
      }
    : null;
}
export function parseStudentSessionViewState(
  value: unknown,
): StudentSessionViewState | null {
  const row = parseExactRecord(value, [
    "revision",
    "phase",
    "session",
    "protection",
    "calculatorEligible",
    "pendingOperation",
  ]);
  if (row === null) return null;
  const revision = parseMilliseconds(row.revision);
  const phase = row.phase;
  const pendingOperation = row.pendingOperation;
  if (
    revision === null ||
    (phase !== "entry" &&
      phase !== "joining" &&
      phase !== "active" &&
      phase !== "unconfirmed" &&
      phase !== "unavailable" &&
      phase !== "recovery_required" &&
      phase !== "forfeited") ||
    row.protection !== "unavailable" ||
    row.calculatorEligible !== false ||
    (pendingOperation !== null &&
      pendingOperation !== "join" &&
      pendingOperation !== "reconnect" &&
      pendingOperation !== "forfeit")
  )
    return null;
  let session: StudentSessionViewState["session"] = null;
  if (row.session !== null) {
    const own = parseExactRecord(row.session, [
      "syntheticDisplayName",
      "sessionRevision",
      "capabilityExpiresAtMs",
    ]);
    if (own === null) return null;
    const syntheticDisplayName = parseSyntheticDisplayName(
      own.syntheticDisplayName,
    );
    const sessionRevision = parseStudentCounter(own.sessionRevision);
    const capabilityExpiresAtMs = parseMilliseconds(own.capabilityExpiresAtMs);
    if (
      syntheticDisplayName === null ||
      sessionRevision === null ||
      capabilityExpiresAtMs === null
    )
      return null;
    session = { syntheticDisplayName, sessionRevision, capabilityExpiresAtMs };
  }
  if (phase === "active" && session === null) return null;
  return {
    revision,
    phase,
    session,
    protection: "unavailable",
    calculatorEligible: false,
    pendingOperation,
  };
}
