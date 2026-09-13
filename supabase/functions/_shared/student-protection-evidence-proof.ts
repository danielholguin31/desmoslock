/** Deno mirror of the native protection evidence core. Independent shared golden
 * vectors pin bytes across TS/Edge/SQL; no built Node .js graph is imported. */
import {
  parseEdgeExactArray as parseExactArray,
  parseEdgeExactRecord as parseExactRecord,
  parseEdgeStudentCounter as parseStudentCounter,
  parseEdgeStudentDigest as parseStudentDigest,
  parseEdgeStudentMaintenanceProof as parseStudentMaintenanceProof,
  parseEdgeStudentPublicKey as parseStudentPublicKey,
  parseEdgeStudentSecret as parseStudentSecret,
  parseEdgeStudentScope as parseStudentSessionScope,
  parseEdgeStudentUuid as parseStudentUuid,
  parseEdgeStudentApiOrigin,
  type EdgeStudentMaintenanceProof as StudentMaintenanceProof,
  type EdgeStudentSessionScope as StudentSessionScope,
} from "./student-session-proof.ts";
type StudentSessionFailure =
  | { readonly status: "denied"; readonly code: "STUDENT_SESSION_DENIED" }
  | {
      readonly status: "unavailable";
      readonly code: "STUDENT_SESSION_UNAVAILABLE";
    };
function parseStudentProofOrigin(value: {
  environment: string;
  url: string;
}): string | null {
  return parseEdgeStudentApiOrigin(value.environment, value.url);
}
export interface ClientBuildIdentity {
  readonly schemaVersion: 1;
  readonly sourceRepository: "danielholguin31/desmoslock";
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly packageLockSha256: string;
  readonly buildId: string;
}

function digest(value: unknown, length: 40 | 64): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/u.test(value) &&
    !/^0+$/u.test(value)
  );
}

function source(row: Record<string, unknown>): boolean {
  return (
    row.schemaVersion === 1 &&
    row.sourceRepository === "danielholguin31/desmoslock" &&
    digest(row.sourceCommit, 40) &&
    digest(row.sourceTree, 40) &&
    digest(row.packageLockSha256, 64)
  );
}

/** Syntax validation only; caller-reported identity is not release attestation. */
export function parseClientBuildIdentity(
  value: unknown,
): ClientBuildIdentity | null {
  const row = parseExactRecord(value, [
    "schemaVersion",
    "sourceRepository",
    "sourceCommit",
    "sourceTree",
    "packageLockSha256",
    "buildId",
  ]);
  if (row === null || !source(row) || !digest(row.buildId, 64)) return null;
  return Object.freeze({
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: row.sourceCommit as string,
    sourceTree: row.sourceTree as string,
    packageLockSha256: row.packageLockSha256 as string,
    buildId: row.buildId,
  });
}

export function parseStudentTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 27) return null;
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
export type NativeProtectionFactSlot =
  | "engaging"
  | "began"
  | "locked"
  | "end_requested"
  | "failure"
  | "native_terminal"
  | "cleanup"
  | "abandoned";
export type NativeProtectionFactPhase =
  "engaging" | "locked" | "ending" | "ended" | "failed" | "recovery_required";
export type NativeProtectionEvent =
  "did_begin" | "failed_to_begin" | "interrupted" | "did_end";
export type NativeProtectionCause =
  | "none"
  | "backend_unavailable"
  | "admission_changed"
  | "capability_expired"
  | "native_interrupted"
  | "native_failure"
  | "observation_timeout"
  | "application_policy"
  | "shortcut_unavailable"
  | "persistence_unavailable"
  | "window_lost"
  | "renderer_lost"
  | "suspend"
  | "display_changed"
  | "emergency_abandonment"
  | "application_quit";
export type NativeProtectionCategoryStatus =
  "pending" | "confirmed" | "failed" | "unavailable";
export type NativeProtectionCategoryCode =
  | "none"
  | "awaiting_native_begin"
  | "native_unavailable"
  | "native_inactive"
  | "emergency_shortcut_unavailable"
  | "prohibited_application"
  | "application_observation_unavailable"
  | "durability_unavailable"
  | "evidence_capacity"
  | "window_unavailable"
  | "network_policy_unavailable"
  | "backend_unavailable";
export interface NativeProtectionCategoryObservation {
  readonly status: NativeProtectionCategoryStatus;
  readonly code: NativeProtectionCategoryCode;
}
export interface NativeProtectionCategories {
  readonly aac: NativeProtectionCategoryObservation;
  readonly shortcuts: NativeProtectionCategoryObservation;
  readonly applications: NativeProtectionCategoryObservation;
  readonly persistence: NativeProtectionCategoryObservation;
  readonly windowNetwork: NativeProtectionCategoryObservation;
}
export interface NativeProtectionFact {
  readonly sequence: number;
  readonly eventId: string;
  readonly attemptId: string;
  readonly scope: StudentSessionScope;
  readonly policyVersion: 1;
  readonly slot: NativeProtectionFactSlot;
  readonly phase: NativeProtectionFactPhase;
  readonly nativeEvent: NativeProtectionEvent | null;
  readonly nativeSequence: number | null;
  readonly categories: NativeProtectionCategories;
  readonly cause: NativeProtectionCause;
}
export type NativeEvidenceOriginBuild =
  | { readonly kind: "build"; readonly identity: ClientBuildIdentity }
  | { readonly kind: "unverified_build" }
  | { readonly kind: "legacy_unknown" };
export interface StudentEvidenceRequest {
  readonly version: 1;
  readonly scope: StudentSessionScope;
  readonly originBuild: NativeEvidenceOriginBuild;
  readonly facts: readonly NativeProtectionFact[];
  readonly batchDigest: string;
  readonly publicKey: string;
  readonly deviceProof: StudentMaintenanceProof;
}
export interface NativeEvidenceAcknowledgment {
  readonly eventId: string;
  readonly contentDigest: string;
  readonly receivedAt: string;
}
export interface StudentEvidenceAccepted {
  readonly status: "accepted";
  readonly code: "STUDENT_EVIDENCE_ACCEPTED";
  readonly scope: StudentSessionScope;
  readonly batchDigest: string;
  readonly acceptedProofCounter: number;
  readonly acknowledged: readonly NativeEvidenceAcknowledgment[];
}
export type StudentEvidenceResult =
  StudentEvidenceAccepted | StudentSessionFailure;

const categoryKeys = [
  "aac",
  "shortcuts",
  "applications",
  "persistence",
  "windowNetwork",
] as const;
const categoryFailures = {
  aac: ["native_unavailable", "native_inactive"],
  shortcuts: ["emergency_shortcut_unavailable"],
  applications: [
    "prohibited_application",
    "application_observation_unavailable",
  ],
  persistence: ["durability_unavailable", "evidence_capacity"],
  windowNetwork: [
    "window_unavailable",
    "network_policy_unavailable",
    "backend_unavailable",
  ],
} as const;
const slots = [
  "engaging",
  "began",
  "locked",
  "end_requested",
  "failure",
  "native_terminal",
  "cleanup",
  "abandoned",
] as const;
const phases = [
  "engaging",
  "locked",
  "ending",
  "ended",
  "failed",
  "recovery_required",
] as const;
const nativeEvents = [
  "did_begin",
  "failed_to_begin",
  "interrupted",
  "did_end",
] as const;
const causes = [
  "none",
  "backend_unavailable",
  "admission_changed",
  "capability_expired",
  "native_interrupted",
  "native_failure",
  "observation_timeout",
  "application_policy",
  "shortcut_unavailable",
  "persistence_unavailable",
  "window_lost",
  "renderer_lost",
  "suspend",
  "display_changed",
  "emergency_abandonment",
  "application_quit",
] as const;
function choice<T extends string>(
  value: unknown,
  values: readonly T[],
): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}
function protectionId(value: unknown): string | null {
  const parsed = parseStudentUuid(value);
  return parsed !== null && parsed[14] === "4" ? parsed : null;
}
function sameScope(a: StudentSessionScope, b: StudentSessionScope): boolean {
  return (
    a.schoolId === b.schoolId &&
    a.testId === b.testId &&
    a.studentSessionId === b.studentSessionId &&
    a.deviceSessionId === b.deviceSessionId &&
    a.epoch === b.epoch
  );
}
export function parseNativeProtectionCategories(
  value: unknown,
): NativeProtectionCategories | null {
  const row = parseExactRecord(value, categoryKeys);
  if (row === null) return null;
  const parsed = {} as Record<
    keyof NativeProtectionCategories,
    NativeProtectionCategoryObservation
  >;
  for (const key of categoryKeys) {
    const entry = parseExactRecord(row[key], ["status", "code"]);
    if (entry === null) return null;
    if (entry.status === "confirmed") {
      if (entry.code !== "none") return null;
    } else if (entry.status === "pending") {
      if (
        entry.code !== "none" &&
        !(key === "aac" && entry.code === "awaiting_native_begin")
      )
        return null;
    } else if (entry.status === "failed" || entry.status === "unavailable") {
      if (choice(entry.code, categoryFailures[key]) === null) return null;
    } else return null;
    parsed[key] = Object.freeze({
      status: entry.status,
      code: entry.code as NativeProtectionCategoryCode,
    });
  }
  return Object.freeze(parsed);
}
/** Mirrors the durable native journal's finite fact rules; this is not OS attestation. */
export function parseNativeProtectionFact(
  value: unknown,
): NativeProtectionFact | null {
  const row = parseExactRecord(value, [
    "sequence",
    "eventId",
    "attemptId",
    "scope",
    "policyVersion",
    "slot",
    "phase",
    "nativeEvent",
    "nativeSequence",
    "categories",
    "cause",
  ]);
  if (row === null) return null;
  const sequence = parseStudentCounter(row.sequence);
  const eventId = protectionId(row.eventId);
  const attemptId = protectionId(row.attemptId);
  const scope = parseStudentSessionScope(row.scope);
  const slot = choice(row.slot, slots);
  const phase = choice(row.phase, phases);
  const nativeEvent = choice(row.nativeEvent, nativeEvents);
  const nativeSequence =
    row.nativeSequence === null
      ? null
      : parseStudentCounter(row.nativeSequence);
  const categories = parseNativeProtectionCategories(row.categories);
  const cause = choice(row.cause, causes);
  if (
    sequence === null ||
    eventId === null ||
    attemptId === null ||
    scope === null ||
    row.policyVersion !== 1 ||
    slot === null ||
    phase === null ||
    categories === null ||
    cause === null ||
    (row.nativeEvent !== null && nativeEvent === null) ||
    (row.nativeSequence !== null && nativeSequence === null) ||
    (nativeEvent !== null && nativeSequence === null) ||
    (slot === "began" && nativeEvent !== "did_begin") ||
    (slot === "native_terminal" &&
      nativeEvent !== "did_end" &&
      nativeEvent !== "failed_to_begin") ||
    (slot === "failure" &&
      nativeEvent !== null &&
      nativeEvent !== "interrupted") ||
    (slot !== "began" &&
      slot !== "native_terminal" &&
      slot !== "failure" &&
      nativeEvent !== null) ||
    ((slot === "failure" || slot === "end_requested" || slot === "abandoned") &&
      cause === "none") ||
    (slot === "engaging" &&
      (phase !== "engaging" ||
        nativeSequence !== null ||
        categories.aac.status === "confirmed")) ||
    (slot === "locked" &&
      (phase !== "locked" ||
        nativeSequence === null ||
        categoryKeys.some((key) => categories[key].status !== "confirmed")))
  )
    return null;
  return Object.freeze({
    sequence,
    eventId,
    attemptId,
    scope: Object.freeze(scope),
    policyVersion: 1,
    slot,
    phase,
    nativeEvent,
    nativeSequence,
    categories,
    cause,
  });
}
export function parseNativeEvidenceOriginBuild(
  value: unknown,
): NativeEvidenceOriginBuild | null {
  const simple = parseExactRecord(value, ["kind"]);
  if (simple?.kind === "unverified_build" || simple?.kind === "legacy_unknown")
    return Object.freeze({ kind: simple.kind });
  const build = parseExactRecord(value, ["kind", "identity"]);
  if (build?.kind !== "build") return null;
  const identity = parseClientBuildIdentity(build.identity);
  return identity === null ? null : Object.freeze({ kind: "build", identity });
}
function isPreflightFailure(fact: NativeProtectionFact): boolean {
  if (fact.slot !== "failure") return false;
  const application = fact.categories.applications;
  const shortcut = fact.categories.shortcuts;
  return (
    (fact.cause === "application_policy" &&
      ((application.status === "failed" &&
        application.code === "prohibited_application") ||
        (application.status === "unavailable" &&
          application.code === "application_observation_unavailable"))) ||
    (fact.cause === "shortcut_unavailable" &&
      (shortcut.status === "failed" || shortcut.status === "unavailable") &&
      shortcut.code === "emergency_shortcut_unavailable")
  );
}
/** A complete currently known prefix for one attempt, never a suffix or sorted repair. */
export function parseNativeProtectionFactPrefix(
  value: unknown,
): readonly NativeProtectionFact[] | null {
  const values = parseExactArray(value, 8);
  if (values === null || values.length === 0) return null;
  const facts: NativeProtectionFact[] = [];
  const ids = new Set<string>();
  const seenSlots = new Set<NativeProtectionFactSlot>();
  let sequence = 0;
  let nativeSequence = 0;
  for (const value of values) {
    const fact = parseNativeProtectionFact(value);
    const first = facts[0];
    if (
      fact === null ||
      fact.sequence <= sequence ||
      ids.has(fact.eventId) ||
      seenSlots.has(fact.slot) ||
      (first === undefined
        ? fact.slot !== "engaging" && !isPreflightFailure(fact)
        : fact.attemptId !== first.attemptId ||
          !sameScope(fact.scope, first.scope)) ||
      (fact.slot === "locked" && !seenSlots.has("began")) ||
      (fact.nativeSequence !== null && fact.nativeSequence < nativeSequence) ||
      (fact.nativeEvent !== null &&
        (fact.nativeSequence ?? 0) <= nativeSequence)
    )
      return null;
    // A preflight report is a client-observed failure followed only by owned
    // cleanup. It cannot later acquire engagement or native delegate claims.
    if (
      (first ?? fact).slot === "failure" &&
      (facts.length > 1 ||
        fact.phase !== "failed" ||
        fact.nativeEvent !== null ||
        fact.nativeSequence !== null ||
        fact.categories.aac.status !== "pending" ||
        fact.categories.aac.code !== "awaiting_native_begin" ||
        (first !== undefined &&
          (fact.slot !== "cleanup" || fact.cause !== "none")))
    )
      return null;
    facts.push(fact);
    ids.add(fact.eventId);
    seenSlots.add(fact.slot);
    sequence = fact.sequence;
    nativeSequence = fact.nativeSequence ?? nativeSequence;
  }
  return Object.freeze(facts);
}
/** Structural validation only: callers must recompute batchDigest and verify the proof. */
export function parseStudentEvidenceRequest(
  value: unknown,
): StudentEvidenceRequest | null {
  const row = parseExactRecord(value, [
    "version",
    "scope",
    "originBuild",
    "facts",
    "batchDigest",
    "publicKey",
    "deviceProof",
  ]);
  if (row === null || row.version !== 1) return null;
  const scope = parseStudentSessionScope(row.scope);
  const originBuild = parseNativeEvidenceOriginBuild(row.originBuild);
  const facts = parseNativeProtectionFactPrefix(row.facts);
  const batchDigest = parseStudentDigest(row.batchDigest);
  const publicKey = parseStudentPublicKey(row.publicKey);
  const deviceProof = parseStudentMaintenanceProof(row.deviceProof);
  if (
    scope === null ||
    originBuild === null ||
    facts === null ||
    batchDigest === null ||
    publicKey === null ||
    deviceProof === null ||
    facts.some((fact) => !sameScope(fact.scope, scope))
  )
    return null;
  return Object.freeze({
    version: 1,
    scope: Object.freeze(scope),
    originBuild,
    facts,
    batchDigest,
    publicKey,
    deviceProof: Object.freeze(deviceProof),
  });
}
function digests(value: unknown, count: number): readonly string[] | null {
  const values = parseExactArray(value, 8);
  if (values === null || values.length !== count) return null;
  const parsed: string[] = [];
  for (const value of values) {
    const digest = parseStudentDigest(value);
    if (digest === null) return null;
    parsed.push(digest);
  }
  return parsed;
}
export function parseStudentEvidenceResult(
  value: unknown,
  request: StudentEvidenceRequest,
  expectedContentDigests: readonly string[],
): StudentEvidenceResult | null {
  const input = parseStudentEvidenceRequest(request);
  if (input === null) return null;
  const expected = digests(expectedContentDigests, input.facts.length);
  if (expected === null) return null;
  const failure = parseStudentSessionFailure(value);
  if (failure !== null) return failure;
  const row = parseExactRecord(value, [
    "status",
    "code",
    "scope",
    "batchDigest",
    "acceptedProofCounter",
    "acknowledged",
  ]);
  if (
    row === null ||
    row.status !== "accepted" ||
    row.code !== "STUDENT_EVIDENCE_ACCEPTED" ||
    row.batchDigest !== input.batchDigest ||
    row.acceptedProofCounter !== input.deviceProof.counter
  )
    return null;
  const scope = parseStudentSessionScope(row.scope);
  const acknowledgments = parseExactArray(row.acknowledged, 8);
  if (
    scope === null ||
    !sameScope(scope, input.scope) ||
    acknowledgments === null ||
    acknowledgments.length !== input.facts.length
  )
    return null;
  const seen = new Set<string>();
  const acknowledged: NativeEvidenceAcknowledgment[] = [];
  for (const item of acknowledgments) {
    const ack = parseExactRecord(item, [
      "eventId",
      "contentDigest",
      "receivedAt",
    ]);
    if (ack === null) return null;
    const eventId = protectionId(ack.eventId);
    const receivedAt = parseStudentTimestamp(ack.receivedAt);
    const index = input.facts.findIndex((fact) => fact.eventId === eventId);
    if (
      eventId === null ||
      receivedAt === null ||
      index < 0 ||
      seen.has(eventId) ||
      ack.contentDigest !== expected[index]
    )
      return null;
    seen.add(eventId);
    acknowledged.push(
      Object.freeze({
        eventId,
        contentDigest: expected[index] as string,
        receivedAt,
      }),
    );
  }
  return Object.freeze({
    status: "accepted",
    code: "STUDENT_EVIDENCE_ACCEPTED",
    scope: Object.freeze(scope),
    batchDigest: input.batchDigest,
    acceptedProofCounter: input.deviceProof.counter,
    acknowledged: Object.freeze(acknowledged),
  });
}

function origin(value: unknown): string | null {
  return typeof value !== "string"
    ? null
    : parseStudentProofOrigin({
        environment: value.startsWith("http:") ? "local" : "staging",
        url: value,
      });
}
function scopeArray(scope: StudentSessionScope) {
  return [
    scope.schoolId,
    scope.testId,
    scope.studentSessionId,
    scope.deviceSessionId,
    scope.epoch,
  ];
}
function buildArray(build: NativeEvidenceOriginBuild) {
  return build.kind !== "build"
    ? [build.kind]
    : [
        "build",
        1,
        build.identity.sourceRepository,
        build.identity.sourceCommit,
        build.identity.sourceTree,
        build.identity.packageLockSha256,
        build.identity.buildId,
      ];
}
function factArray(fact: NativeProtectionFact) {
  return [
    fact.policyVersion,
    fact.sequence,
    fact.eventId,
    fact.attemptId,
    fact.slot,
    fact.phase,
    fact.nativeEvent,
    fact.nativeSequence,
    categoryKeys.map((key) => [
      fact.categories[key].status,
      fact.categories[key].code,
    ]),
    fact.cause,
  ];
}
function digestContext(row: Record<string, unknown>) {
  const apiOrigin = origin(row.apiOrigin);
  const originalKeyThumbprint = parseStudentSecret(row.originalKeyThumbprint);
  const scope = parseStudentSessionScope(row.scope);
  const originBuild = parseNativeEvidenceOriginBuild(row.originBuild);
  return apiOrigin === null ||
    originalKeyThumbprint === null ||
    scope === null ||
    originBuild === null
    ? null
    : { apiOrigin, originalKeyThumbprint, scope, originBuild };
}
/** UTF-8(domain + NUL + compact fixed array JSON), no newline; hash these bytes. */
export function encodeNativeProtectionFactDigestInput(
  value: unknown,
): Uint8Array | null {
  const row = parseExactRecord(value, [
    "apiOrigin",
    "originalKeyThumbprint",
    "scope",
    "originBuild",
    "fact",
  ]);
  if (row === null) return null;
  const context = digestContext(row);
  const fact = parseNativeProtectionFact(row.fact);
  if (
    context === null ||
    fact === null ||
    !sameScope(fact.scope, context.scope)
  )
    return null;
  return new TextEncoder().encode(
    "desmoslock/native-protection-fact/v1\0" +
      JSON.stringify([
        1,
        context.apiOrigin,
        context.originalKeyThumbprint,
        scopeArray(context.scope),
        buildArray(context.originBuild),
        factArray(fact),
      ]),
  );
}
/** contentDigests align with the validated complete prefix's original sequence. */
export function encodeStudentEvidenceBatchDigestInput(
  value: unknown,
): Uint8Array | null {
  const row = parseExactRecord(value, [
    "apiOrigin",
    "originalKeyThumbprint",
    "scope",
    "originBuild",
    "facts",
    "contentDigests",
  ]);
  if (row === null) return null;
  const context = digestContext(row);
  const facts = parseNativeProtectionFactPrefix(row.facts);
  if (
    context === null ||
    facts === null ||
    facts.some((fact) => !sameScope(fact.scope, context.scope))
  )
    return null;
  const contentDigests = digests(row.contentDigests, facts.length);
  const first = facts[0];
  if (contentDigests === null || first === undefined) return null;
  return new TextEncoder().encode(
    "desmoslock/native-protection-batch/v1\0" +
      JSON.stringify([
        1,
        context.apiOrigin,
        context.originalKeyThumbprint,
        scopeArray(context.scope),
        buildArray(context.originBuild),
        first.attemptId,
        facts.map((fact, index) => [fact.eventId, contentDigests[index]]),
      ]),
  );
}
/** Fixed evidence proof domain and intent cannot be supplied by a caller. */
export function encodeStudentEvidenceProof(value: unknown): Uint8Array | null {
  const row = parseExactRecord(value, [
    "apiOrigin",
    "originalKeyThumbprint",
    "scope",
    "batchDigest",
    "counter",
  ]);
  if (row === null) return null;
  const apiOrigin = origin(row.apiOrigin);
  const originalKeyThumbprint = parseStudentSecret(row.originalKeyThumbprint);
  const scope = parseStudentSessionScope(row.scope);
  const batchDigest = parseStudentDigest(row.batchDigest);
  const counter = parseStudentCounter(row.counter);
  if (
    apiOrigin === null ||
    originalKeyThumbprint === null ||
    scope === null ||
    batchDigest === null ||
    counter === null
  )
    return null;
  return new TextEncoder().encode(
    JSON.stringify([
      "desmoslock/student-evidence-proof/v1",
      apiOrigin,
      "evidence.ingest",
      scopeArray(scope),
      originalKeyThumbprint,
      batchDigest,
      counter,
    ]),
  );
}
