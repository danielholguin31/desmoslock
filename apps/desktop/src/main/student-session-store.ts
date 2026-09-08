import { createRequire } from "node:module";
import { createHash } from "node:crypto";

import {
  parseStudentCounter,
  parseStudentDigest,
  parseStudentTimestamp,
  parseStudentJoinCode,
  parseStudentSecret,
  parseStudentSessionScope,
  parseStudentUuid,
  type StudentAdmissionMode,
  type StudentSessionScope,
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  parseNativeEvidenceOriginBuild,
  type NativeEvidenceOriginBuild,
  type NativeEvidenceAcknowledgment,
} from "@desmoslock/contracts";

import type {
  StudentSessionCandidates,
  StudentSessionDevice,
} from "./student-session-crypto.js";
import {
  parseLocalEndCause,
  parseProtectionCategories,
  type CleanupState,
  type LocalEndCause,
  type NativeDisposition,
  type ProtectionCategories,
  type ProtectionPhase,
} from "./assessment-protection-types.js";
import type {
  NativeAssessmentEvent,
  NativeEventType,
} from "./native-protection-adapter.js";
import type { FreshStudentAdmission } from "./student-session-coordinator.js";

export { parseLocalEndCause } from "./assessment-protection-types.js";

export const protectionFactCapacity = 32;
export const protectionFactReservation = 8;

export type FactSlot =
  | "engaging"
  | "began"
  | "locked"
  | "end_requested"
  | "failure"
  | "native_terminal"
  | "cleanup"
  | "abandoned";

export interface StoredNativeProtectionAttempt {
  readonly attemptId: string;
  readonly scope: StudentSessionScope;
  readonly phase: Exclude<ProtectionPhase, "idle" | "preflight">;
  readonly nativeDisposition: NativeDisposition;
  readonly nativeSequence: number | null;
  readonly cleanup: CleanupState;
  readonly abandonment: "none" | "requested";
}

export interface ProtectionFact {
  readonly sequence: number;
  readonly eventId: string;
  readonly attemptId: string;
  readonly scope: StudentSessionScope;
  readonly policyVersion: 1;
  readonly slot: FactSlot;
  readonly phase: StoredNativeProtectionAttempt["phase"];
  readonly nativeEvent: NativeEventType | null;
  readonly nativeSequence: number | null;
  readonly categories: ProtectionCategories;
  readonly cause: LocalEndCause | "none";
}

export interface StoredNativeProtection {
  readonly policyVersion: 1;
  readonly revision: number;
  readonly latestAttempt: StoredNativeProtectionAttempt | null;
  readonly nextFactSequence: number;
  readonly facts: readonly ProtectionFact[];
}

export type ProtectionTransition =
  | {
      readonly kind: "disposed_without_terminal_observation";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
    }
  | {
      readonly kind: "engaging";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly authority: FreshStudentAdmission;
      readonly categories: ProtectionCategories;
    }
  | {
      readonly kind: "locked";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly authority: FreshStudentAdmission;
      readonly nativeSequence: number;
      readonly categories: ProtectionCategories;
    }
  | {
      readonly kind: "began";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly event: Extract<NativeAssessmentEvent, { type: "did_begin" }>;
    }
  | {
      readonly kind: "ending" | "failure" | "abandoned";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly cause: LocalEndCause;
    }
  | {
      readonly kind: "native_terminal";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly event: Extract<
        NativeAssessmentEvent,
        { type: "failed_to_begin" | "did_end" }
      >;
    }
  | {
      readonly kind: "cleanup";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly outcome: "complete" | "unconfirmed";
    };

export interface StoredStudentAuthority {
  readonly scope: StudentSessionScope;
  readonly sessionRevision: number;
  readonly syntheticDisplayName: string;
  readonly serverNowMs: number;
  readonly capabilityIssuedAtMs: number;
  readonly capabilityExpiresAtMs: number;
  readonly reconnectExpiresAtMs: number;
  readonly capabilityToken: string;
  readonly reconnectGrant: string;
}

export type PendingStudentIntent =
  | {
      readonly kind: "join";
      readonly admissionMode: StudentAdmissionMode;
      readonly requestId: string;
      readonly joinCode: string;
      readonly candidates: StudentSessionCandidates;
    }
  | {
      readonly kind: "reconnect";
      readonly requestId: string;
      readonly expectedSessionRevision: number;
      readonly candidates: StudentSessionCandidates;
    }
  | {
      readonly kind: "forfeit";
      readonly requestId: string;
      readonly expectedSessionRevision: number;
    };

export interface StudentSessionRecord {
  readonly version: 3;
  readonly generation: number;
  readonly apiOrigin: string;
  readonly device: StudentSessionDevice;
  readonly current: StoredStudentAuthority | null;
  readonly pending: PendingStudentIntent | null;
  readonly lastReservedCounter: number;
  readonly terminal: boolean;
  readonly nativeProtection: StoredNativeProtection | null;
  readonly evidence: StoredNativeEvidence;
}

export interface StoredNativeEvidenceOrigin {
  readonly attemptId: string;
  readonly scope: StudentSessionScope;
  readonly originalKeyThumbprint: string | null;
  readonly originBuild: NativeEvidenceOriginBuild;
}
export type StoredNativeEvidenceAcknowledgment = NativeEvidenceAcknowledgment;
export interface StoredNativeEvidencePendingBatch {
  readonly originalKeyThumbprint: string;
  readonly attemptId: string;
  readonly batchDigest: string;
  readonly events: readonly {
    readonly eventId: string;
    readonly contentDigest: string;
  }[];
}
export interface StoredNativeEvidenceSigner {
  readonly device: StudentSessionDevice;
  readonly lastReservedCounter: number;
}
export interface StoredNativeEvidence {
  readonly origins: readonly StoredNativeEvidenceOrigin[];
  readonly acknowledgments: readonly StoredNativeEvidenceAcknowledgment[];
  readonly pendingBatches: readonly StoredNativeEvidencePendingBatch[];
  readonly retiredSigners: readonly StoredNativeEvidenceSigner[];
  readonly lastAttemptedSigner: string | null;
}

export function emptyNativeEvidence(): StoredNativeEvidence {
  return Object.freeze({
    origins: Object.freeze([]),
    acknowledgments: Object.freeze([]),
    pendingBatches: Object.freeze([]),
    retiredSigners: Object.freeze([]),
    lastAttemptedSigner: null,
  });
}
export type StudentSessionSuccessor = Omit<StudentSessionRecord, "generation">;
export type StudentSessionLoad =
  | { readonly kind: "empty"; readonly generation: number }
  | { readonly kind: "ready"; readonly record: StudentSessionRecord }
  | { readonly kind: "recovery_required"; readonly generation: number }
  | { readonly kind: "unavailable" };

export interface NativeStudentRecordHandle {
  loadEncryptedRecord(): Promise<Buffer | null>;
  replaceEncryptedRecord(ciphertext: Buffer): Promise<void>;
  quarantineEncryptedRecord(): Promise<void>;
  close(): Promise<void>;
}

export interface StudentRecordCodec {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface StudentSessionStore {
  load(): Promise<StudentSessionLoad>;
  commitDurably(
    expectedGeneration: number,
    record: StudentSessionSuccessor,
  ): Promise<StudentSessionRecord>;
  preserveForTargetedRecovery(expectedGeneration: number): Promise<number>;
  close(): Promise<void>;
}

const maximumPlaintextBytes = 48 * 1024;
const maximumCiphertextBytes = 64 * 1024;
const failure = (): Error => new Error("Student session storage unavailable");

// Snapshot exact data fields without invoking accessors or serializing callers.
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return null;
    result[key] = descriptor.value;
  }
  return result;
}

function natural(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

function array(value: unknown, maximum: number): readonly unknown[] | null {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return null;
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return null;
    entries.push(descriptor.value);
  }
  return entries;
}

function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function signerRequired(record: StudentSessionSuccessor, key: string): boolean {
  const origins = record.evidence.origins.filter(
    (origin) => origin.originalKeyThumbprint === key,
  );
  const latest = record.nativeProtection?.latestAttempt?.attemptId;
  if (
    origins.some((origin) => origin.attemptId === latest) ||
    record.evidence.pendingBatches.some(
      (batch) => batch.originalKeyThumbprint === key,
    )
  )
    return true;
  const acknowledged = new Set(
    record.evidence.acknowledgments.map((ack) => ack.eventId),
  );
  return origins.some((origin) =>
    record.nativeProtection?.facts.some(
      (fact) =>
        fact.attemptId === origin.attemptId && !acknowledged.has(fact.eventId),
    ),
  );
}

/** Call inside the existing writer before replacing the current device. */
export function retainNativeEvidenceSigner(
  record: StudentSessionRecord,
): StoredNativeEvidence | null {
  // Even acknowledged nonlatest origins still need their signer association
  // until a separate durable whole-attempt prune removes those references.
  if (
    !record.evidence.origins.some(
      (origin) => origin.originalKeyThumbprint === record.device.keyThumbprint,
    )
  )
    return record.evidence;
  if (
    record.evidence.retiredSigners.some(
      (signer) => signer.device.keyThumbprint === record.device.keyThumbprint,
    )
  )
    return null;
  if (record.evidence.retiredSigners.length >= 4) return null;
  return Object.freeze({
    ...record.evidence,
    retiredSigners: Object.freeze([
      ...record.evidence.retiredSigners,
      Object.freeze({
        device: record.device,
        lastReservedCounter: record.lastReservedCounter,
      }),
    ]),
  });
}

/** Whole-attempt pruning only; the caller owns and has settled all transport. */
export function pruneNativeEvidence(
  record: StudentSessionSuccessor,
): StudentSessionSuccessor {
  const protection = record.nativeProtection;
  const acknowledged = new Set(
    record.evidence.acknowledgments.map((ack) => ack.eventId),
  );
  const removable = new Set(
    record.evidence.origins
      .filter((origin) => {
        if (
          origin.attemptId === protection?.latestAttempt?.attemptId ||
          record.evidence.pendingBatches.some(
            (batch) => batch.attemptId === origin.attemptId,
          )
        )
          return false;
        const facts =
          protection?.facts.filter(
            (fact) => fact.attemptId === origin.attemptId,
          ) ?? [];
        return (
          facts.length > 0 &&
          facts.some((fact) => fact.slot === "cleanup") &&
          facts.every((fact) => acknowledged.has(fact.eventId))
        );
      })
      .map((origin) => origin.attemptId),
  );
  const facts =
    protection?.facts.filter((fact) => !removable.has(fact.attemptId)) ?? [];
  const kept = new Set(facts.map((fact) => fact.eventId));
  const pruned: StudentSessionSuccessor = {
    ...record,
    nativeProtection: protection === null ? null : { ...protection, facts },
    evidence: {
      ...record.evidence,
      origins: record.evidence.origins.filter(
        (origin) => !removable.has(origin.attemptId),
      ),
      acknowledgments: record.evidence.acknowledgments.filter((ack) =>
        kept.has(ack.eventId),
      ),
    },
  };
  return {
    ...pruned,
    evidence: {
      ...pruned.evidence,
      retiredSigners: pruned.evidence.retiredSigners.filter((signer) =>
        signerRequired(pruned, signer.device.keyThumbprint),
      ),
    },
  };
}

function factDigest(
  apiOrigin: string,
  origin: StoredNativeEvidenceOrigin,
  fact: ProtectionFact,
): string | null {
  if (origin.originalKeyThumbprint === null) return null;
  const bytes = encodeNativeProtectionFactDigestInput({
    apiOrigin,
    scope: origin.scope,
    originBuild: origin.originBuild,
    originalKeyThumbprint: origin.originalKeyThumbprint,
    fact,
  });
  return bytes === null
    ? null
    : createHash("sha256").update(bytes).digest("hex");
}

function parseProtectionId(value: unknown): string | null {
  const id = parseStudentUuid(value);
  return id !== null && id[14] === "4" ? id : null;
}

function parsePhase(
  value: unknown,
): StoredNativeProtectionAttempt["phase"] | null {
  return value === "engaging" ||
    value === "locked" ||
    value === "ending" ||
    value === "ended" ||
    value === "failed" ||
    value === "recovery_required"
    ? value
    : null;
}

function parseSlot(value: unknown): FactSlot | null {
  return value === "engaging" ||
    value === "began" ||
    value === "locked" ||
    value === "end_requested" ||
    value === "failure" ||
    value === "native_terminal" ||
    value === "cleanup" ||
    value === "abandoned"
    ? value
    : null;
}

function parseNativeEvent(value: unknown): NativeEventType | null {
  return value === "did_begin" ||
    value === "failed_to_begin" ||
    value === "interrupted" ||
    value === "did_end"
    ? value
    : null;
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

function parseAttempt(value: unknown): StoredNativeProtectionAttempt | null {
  const row = object(value, [
    "attemptId",
    "scope",
    "phase",
    "nativeDisposition",
    "nativeSequence",
    "cleanup",
    "abandonment",
  ]);
  if (row === null) return null;
  const attemptId = parseProtectionId(row.attemptId);
  const scope = parseStudentSessionScope(row.scope);
  const phase = parsePhase(row.phase);
  const sequence =
    row.nativeSequence === null
      ? null
      : parseStudentCounter(row.nativeSequence);
  if (
    attemptId === null ||
    scope === null ||
    phase === null ||
    (row.nativeSequence !== null && sequence === null) ||
    (row.nativeDisposition !== "not_started" &&
      row.nativeDisposition !== "pending" &&
      row.nativeDisposition !== "active" &&
      row.nativeDisposition !== "failed_to_begin" &&
      row.nativeDisposition !== "ended" &&
      row.nativeDisposition !== "disposed_without_terminal_observation" &&
      row.nativeDisposition !== "unknown") ||
    (row.cleanup !== "not_requested" &&
      row.cleanup !== "pending" &&
      row.cleanup !== "complete" &&
      row.cleanup !== "unconfirmed") ||
    (row.abandonment !== "none" && row.abandonment !== "requested")
  )
    return null;
  if (
    ((row.nativeDisposition === "active" ||
      row.nativeDisposition === "ended" ||
      row.nativeDisposition === "failed_to_begin") &&
      sequence === null) ||
    ((row.nativeDisposition === "not_started" ||
      row.nativeDisposition === "pending") &&
      sequence !== null) ||
    (row.cleanup === "complete" &&
      row.nativeDisposition !== "ended" &&
      row.nativeDisposition !== "failed_to_begin" &&
      row.nativeDisposition !== "disposed_without_terminal_observation") ||
    (row.nativeDisposition === "disposed_without_terminal_observation" &&
      (phase !== "failed" || row.cleanup !== "complete")) ||
    (phase === "locked" && row.nativeDisposition !== "active") ||
    (phase === "ended" && row.nativeDisposition !== "ended")
  )
    return null;
  return Object.freeze({
    attemptId,
    scope: Object.freeze(scope),
    phase,
    nativeDisposition: row.nativeDisposition,
    nativeSequence: sequence,
    cleanup: row.cleanup,
    abandonment: row.abandonment,
  });
}

function parseFact(value: unknown): ProtectionFact | null {
  const row = object(value, [
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
  const eventId = parseProtectionId(row.eventId);
  const attemptId = parseProtectionId(row.attemptId);
  const scope = parseStudentSessionScope(row.scope);
  const slot = parseSlot(row.slot);
  const phase = parsePhase(row.phase);
  const nativeEvent = parseNativeEvent(row.nativeEvent);
  const nativeSequence =
    row.nativeSequence === null
      ? null
      : parseStudentCounter(row.nativeSequence);
  const categories = parseProtectionCategories(row.categories);
  const cause = row.cause === "none" ? "none" : parseLocalEndCause(row.cause);
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
        Object.values(categories).some(
          (category) => category.status !== "confirmed",
        )))
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

function parseStoredNativeProtection(
  value: unknown,
): StoredNativeProtection | null {
  const row = object(value, [
    "policyVersion",
    "revision",
    "latestAttempt",
    "nextFactSequence",
    "facts",
  ]);
  if (
    row === null ||
    row.policyVersion !== 1 ||
    !natural(row.revision) ||
    parseStudentCounter(row.nextFactSequence) === null ||
    !Array.isArray(row.facts) ||
    row.facts.length > protectionFactCapacity ||
    Object.getPrototypeOf(row.facts) !== Array.prototype
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(row.facts);
  if (Reflect.ownKeys(descriptors).length !== row.facts.length + 1) return null;
  const latestAttempt =
    row.latestAttempt === null ? null : parseAttempt(row.latestAttempt);
  if (row.latestAttempt !== null && latestAttempt === null) return null;
  const facts: ProtectionFact[] = [];
  const eventIds = new Set<string>();
  const attempts = new Map<
    string,
    { scope: StudentSessionScope; slots: Set<FactSlot>; sequence: number }
  >();
  let previousSequence = 0;
  let latestAttemptId: string | null = null;
  for (let index = 0; index < row.facts.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return null;
    const fact = parseFact(descriptor.value);
    if (
      fact === null ||
      fact.sequence <= previousSequence ||
      eventIds.has(fact.eventId)
    )
      return null;
    const attempt = attempts.get(fact.attemptId);
    if (attempt === undefined) {
      if (fact.slot !== "engaging") return null;
      if (
        latestAttemptId !== null &&
        !attempts.get(latestAttemptId)?.slots.has("cleanup")
      )
        return null;
      attempts.set(fact.attemptId, {
        scope: fact.scope,
        slots: new Set([fact.slot]),
        sequence: fact.nativeSequence ?? 0,
      });
      latestAttemptId = fact.attemptId;
    } else {
      if (
        latestAttemptId !== fact.attemptId ||
        !sameScope(attempt.scope, fact.scope) ||
        attempt.slots.has(fact.slot) ||
        (fact.slot === "locked" && !attempt.slots.has("began")) ||
        (fact.nativeSequence !== null &&
          fact.nativeSequence < attempt.sequence) ||
        (fact.nativeEvent !== null &&
          (fact.nativeSequence ?? 0) <= attempt.sequence)
      )
        return null;
      attempt.slots.add(fact.slot);
      attempt.sequence = fact.nativeSequence ?? attempt.sequence;
    }
    facts.push(fact);
    eventIds.add(fact.eventId);
    previousSequence = fact.sequence;
  }
  if (
    row.nextFactSequence !== previousSequence + 1 ||
    (facts.length === 0
      ? latestAttempt !== null || row.revision !== 0
      : latestAttempt === null ||
        row.revision === 0 ||
        facts.at(-1)?.attemptId !== latestAttempt.attemptId)
  )
    return null;
  if (latestAttempt !== null) {
    const retained = attempts.get(latestAttempt.attemptId);
    const terminal = facts.find(
      (fact) =>
        fact.attemptId === latestAttempt.attemptId &&
        fact.slot === "native_terminal",
    );
    if (
      retained === undefined ||
      !sameScope(retained.scope, latestAttempt.scope) ||
      (latestAttempt.nativeSequence ?? 0) < retained.sequence ||
      (latestAttempt.phase === "locked" && !retained.slots.has("locked")) ||
      (latestAttempt.nativeDisposition === "active" &&
        !retained.slots.has("began")) ||
      (latestAttempt.nativeDisposition === "ended" &&
        terminal?.nativeEvent !== "did_end") ||
      (latestAttempt.nativeDisposition === "failed_to_begin" &&
        terminal?.nativeEvent !== "failed_to_begin") ||
      ((latestAttempt.nativeDisposition === "ended" ||
        latestAttempt.nativeDisposition === "failed_to_begin") &&
        latestAttempt.nativeSequence !== terminal?.nativeSequence) ||
      (latestAttempt.cleanup === "complete" &&
        !retained.slots.has("cleanup")) ||
      (latestAttempt.nativeDisposition ===
        "disposed_without_terminal_observation" &&
        terminal !== undefined) ||
      (latestAttempt.abandonment === "requested") !==
        retained.slots.has("abandoned")
    )
      return null;
  }
  return Object.freeze({
    policyVersion: 1,
    revision: row.revision,
    latestAttempt,
    nextFactSequence: row.nextFactSequence as number,
    facts: Object.freeze(facts),
  });
}

/** Structural snapshot only. The Student writer validates the retained issuer. */
export function parseProtectionTransition(
  value: unknown,
): ProtectionTransition | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
    const kind: unknown =
      kindDescriptor !== undefined && "value" in kindDescriptor
        ? kindDescriptor.value
        : null;
    const common = ["kind", "attemptId", "expectedProtectionRevision"];
    const additional =
      kind === "engaging"
        ? ["authority", "categories"]
        : kind === "locked"
          ? ["authority", "categories", "nativeSequence"]
          : kind === "began" || kind === "native_terminal"
            ? ["event"]
            : kind === "ending" || kind === "failure" || kind === "abandoned"
              ? ["cause"]
              : kind === "cleanup"
                ? ["outcome"]
                : kind === "disposed_without_terminal_observation"
                  ? []
                  : null;
    if (additional === null) return null;
    const row = object(value, [...common, ...additional]);
    if (
      row === null ||
      row.kind !== kind ||
      !natural(row.expectedProtectionRevision)
    )
      return null;
    const attemptId = parseProtectionId(row.attemptId);
    if (attemptId === null) return null;
    const base = {
      attemptId,
      expectedProtectionRevision: row.expectedProtectionRevision,
    };
    if (kind === "disposed_without_terminal_observation")
      return Object.freeze({ ...base, kind });
    if (kind === "engaging" || kind === "locked") {
      const categories = parseProtectionCategories(row.categories);
      if (
        categories === null ||
        typeof row.authority !== "object" ||
        row.authority === null ||
        Array.isArray(row.authority)
      )
        return null;
      const authority = row.authority as FreshStudentAdmission;
      if (kind === "engaging")
        return Object.freeze({ ...base, kind, authority, categories });
      const nativeSequence = parseStudentCounter(row.nativeSequence);
      return nativeSequence === null
        ? null
        : Object.freeze({
            ...base,
            kind,
            authority,
            categories,
            nativeSequence,
          });
    }
    if (kind === "ending" || kind === "failure" || kind === "abandoned") {
      const cause = parseLocalEndCause(row.cause);
      return cause === null ? null : Object.freeze({ ...base, kind, cause });
    }
    if (kind === "cleanup")
      return row.outcome === "complete" || row.outcome === "unconfirmed"
        ? Object.freeze({ ...base, kind, outcome: row.outcome })
        : null;
    const event = object(row.event, ["type", "attemptId", "sequence", "code"]);
    if (event === null || event.attemptId !== attemptId) return null;
    const sequence = parseStudentCounter(event.sequence);
    if (sequence === null) return null;
    if (kind === "began" && event.type === "did_begin" && event.code === "none")
      return Object.freeze({
        ...base,
        kind,
        event: Object.freeze({
          type: "did_begin",
          attemptId,
          sequence,
          code: "none",
        }),
      });
    if (
      kind !== "native_terminal" ||
      (event.type !== "failed_to_begin" && event.type !== "did_end")
    )
      return null;
    const type = event.type;
    const code = event.code;
    if (
      code !== "none" &&
      code !== "native_failed_to_begin" &&
      code !== "content_hide_failed"
    )
      return null;
    if (
      code !== "content_hide_failed" &&
      code !== (type === "failed_to_begin" ? "native_failed_to_begin" : "none")
    )
      return null;
    const terminalEvent: Extract<
      NativeAssessmentEvent,
      { type: "failed_to_begin" | "did_end" }
    > = { type, attemptId, sequence, code };
    return Object.freeze({
      ...base,
      kind,
      event: Object.freeze(terminalEvent),
    });
  } catch {
    return null;
  }
}

export function createStudentSessionStore(options: {
  readonly apiOrigin: string;
  readonly openNativeStore: () => Promise<NativeStudentRecordHandle>;
  readonly codec: StudentRecordCodec;
  readonly validateDevice: (value: unknown) => StudentSessionDevice | null;
  readonly validateCandidates: (
    value: unknown,
  ) => StudentSessionCandidates | null;
}): StudentSessionStore {
  let handle: NativeStudentRecordHandle | null = null;
  let busy = false;
  let closed = false;
  let loaded = false;
  let mustReopen = false;
  let generation = 0;
  let requiresRecovery = false;
  let targetedOnly = false;
  let lastRecord: StudentSessionRecord | null = null;

  function parseEvidence(
    value: unknown,
    device: StudentSessionDevice,
    protection: StoredNativeProtection | null,
    compactOrigins = false,
  ): StoredNativeEvidence | null {
    const row = object(value, [
      "origins",
      "acknowledgments",
      "pendingBatches",
      "retiredSigners",
      "lastAttemptedSigner",
    ]);
    if (row === null) return null;
    const originsRaw = array(row.origins, 32);
    const acknowledgmentsRaw = array(row.acknowledgments, 32);
    const pendingRaw = array(row.pendingBatches, 5);
    const retiredRaw = array(row.retiredSigners, 4);
    if (
      originsRaw === null ||
      acknowledgmentsRaw === null ||
      pendingRaw === null ||
      retiredRaw === null ||
      (row.lastAttemptedSigner !== null &&
        parseStudentSecret(row.lastAttemptedSigner) === null)
    )
      return null;
    const signers = new Map([[device.keyThumbprint, device]]);
    const deviceIds = new Set([device.deviceSessionId]);
    const retiredSigners: StoredNativeEvidenceSigner[] = [];
    for (const raw of retiredRaw) {
      const item = object(raw, ["device", "lastReservedCounter"]);
      if (item === null || !natural(item.lastReservedCounter)) return null;
      const retired = options.validateDevice(item.device);
      if (
        retired === null ||
        signers.has(retired.keyThumbprint) ||
        deviceIds.has(retired.deviceSessionId)
      )
        return null;
      signers.set(retired.keyThumbprint, retired);
      deviceIds.add(retired.deviceSessionId);
      retiredSigners.push(
        Object.freeze({
          device: Object.freeze(retired),
          lastReservedCounter: item.lastReservedCounter,
        }),
      );
    }
    const facts = protection?.facts ?? [];
    const attempts = new Map<string, readonly ProtectionFact[]>();
    for (const fact of facts)
      if (!attempts.has(fact.attemptId))
        attempts.set(
          fact.attemptId,
          facts.filter((item) => item.attemptId === fact.attemptId),
        );
    const origins = new Map<string, StoredNativeEvidenceOrigin>();
    const signerScopes = new Map<string, StudentSessionScope>();
    for (const raw of originsRaw) {
      const item = object(
        raw,
        compactOrigins
          ? ["attemptId", "originalKeyThumbprint", "originBuild"]
          : ["attemptId", "scope", "originalKeyThumbprint", "originBuild"],
      );
      if (item === null) return null;
      const attemptId = parseProtectionId(item.attemptId);
      const scope = compactOrigins
        ? attemptId === null
          ? null
          : (attempts.get(attemptId)?.[0]?.scope ?? null)
        : parseStudentSessionScope(item.scope);
      const originBuild = parseNativeEvidenceOriginBuild(item.originBuild);
      const key =
        item.originalKeyThumbprint === null
          ? null
          : parseStudentSecret(item.originalKeyThumbprint);
      if (
        attemptId === null ||
        scope === null ||
        originBuild === null ||
        origins.has(attemptId) ||
        !sameScope(scope, attempts.get(attemptId)?.[0]?.scope ?? scope) ||
        !attempts.has(attemptId) ||
        (item.originalKeyThumbprint !== null && key === null) ||
        (key === null
          ? originBuild.kind !== "legacy_unknown"
          : signers.get(key)?.deviceSessionId !== scope.deviceSessionId)
      )
        return null;
      if (key !== null) {
        const associated = signerScopes.get(key);
        if (associated !== undefined && !sameScope(associated, scope))
          return null;
        signerScopes.set(key, scope);
      }
      origins.set(
        attemptId,
        Object.freeze({
          attemptId,
          scope: Object.freeze(scope),
          originalKeyThumbprint: key,
          originBuild,
        }),
      );
    }
    if (
      origins.size !== attempts.size ||
      retiredSigners.some(
        (signer) =>
          ![...origins.values()].some(
            (origin) =>
              origin.originalKeyThumbprint === signer.device.keyThumbprint,
          ),
      )
    )
      return null;
    const digests = new Map<string, string | null>();
    for (const fact of facts) {
      const origin = origins.get(fact.attemptId)!;
      const digest = factDigest(options.apiOrigin, origin, fact);
      if (origin.originalKeyThumbprint !== null && digest === null) return null;
      digests.set(fact.eventId, digest);
    }
    const acknowledgments: StoredNativeEvidenceAcknowledgment[] = [];
    const acked = new Set<string>();
    for (const raw of acknowledgmentsRaw) {
      const item = object(raw, ["eventId", "contentDigest", "receivedAt"]);
      if (item === null) return null;
      const eventId = parseProtectionId(item.eventId);
      const contentDigest = parseStudentDigest(item.contentDigest);
      const receivedAt = parseStudentTimestamp(item.receivedAt);
      if (
        eventId === null ||
        contentDigest === null ||
        receivedAt === null ||
        acked.has(eventId) ||
        digests.get(eventId) !== contentDigest
      )
        return null;
      acked.add(eventId);
      acknowledgments.push(
        Object.freeze({ eventId, contentDigest, receivedAt }),
      );
    }
    const pendingBatches: StoredNativeEvidencePendingBatch[] = [];
    const pendingKeys = new Set<string>();
    for (const raw of pendingRaw) {
      const item = object(raw, [
        "originalKeyThumbprint",
        "attemptId",
        "batchDigest",
        "events",
      ]);
      if (item === null) return null;
      const key = parseStudentSecret(item.originalKeyThumbprint);
      const attemptId = parseProtectionId(item.attemptId);
      const batchDigest = parseStudentDigest(item.batchDigest);
      const entries = array(item.events, 8);
      const origin = attemptId === null ? undefined : origins.get(attemptId);
      if (
        key === null ||
        attemptId === null ||
        batchDigest === null ||
        origin === undefined ||
        origin.originalKeyThumbprint !== key ||
        pendingKeys.has(key) ||
        entries === null ||
        entries.length === 0
      )
        return null;
      const prefix = attempts.get(attemptId)!.slice(0, entries.length);
      if (prefix.length !== entries.length) return null;
      const events: {
        readonly eventId: string;
        readonly contentDigest: string;
      }[] = [];
      for (const [index, rawEvent] of entries.entries()) {
        const event = object(rawEvent, ["eventId", "contentDigest"]);
        const fact = prefix[index]!;
        if (
          event === null ||
          event.eventId !== fact.eventId ||
          event.contentDigest !== digests.get(fact.eventId) ||
          typeof event.contentDigest !== "string"
        )
          return null;
        events.push(
          Object.freeze({
            eventId: fact.eventId,
            contentDigest: event.contentDigest,
          }),
        );
      }
      const encoded = encodeStudentEvidenceBatchDigestInput({
        apiOrigin: options.apiOrigin,
        originalKeyThumbprint: key,
        scope: origin.scope,
        originBuild: origin.originBuild,
        facts: prefix,
        contentDigests: events.map((event) => event.contentDigest),
      });
      if (
        encoded === null ||
        createHash("sha256").update(encoded).digest("hex") !== batchDigest
      )
        return null;
      pendingKeys.add(key);
      pendingBatches.push(
        Object.freeze({
          originalKeyThumbprint: key,
          attemptId,
          batchDigest,
          events: Object.freeze(events),
        }),
      );
    }
    return Object.freeze({
      origins: Object.freeze([...origins.values()]),
      acknowledgments: Object.freeze(acknowledgments),
      pendingBatches: Object.freeze(pendingBatches),
      retiredSigners: Object.freeze(retiredSigners),
      lastAttemptedSigner: row.lastAttemptedSigner as string | null,
    });
  }

  function parseRecord(
    value: unknown,
    allowLegacy = false,
  ): StudentSessionRecord | null {
    const keys = [
      "version",
      "generation",
      "apiOrigin",
      "device",
      "current",
      "pending",
      "lastReservedCounter",
      "terminal",
    ];
    const legacy = allowLegacy ? object(value, keys) : null;
    const v2 = allowLegacy
      ? object(value, [...keys, "nativeProtection"])
      : null;
    const row =
      legacy?.version === 1
        ? legacy
        : v2?.version === 2
          ? v2
          : object(value, [...keys, "nativeProtection", "evidence"]);
    if (
      row === null ||
      (row === legacy
        ? row.version !== 1
        : row === v2
          ? row.version !== 2
          : row.version !== 3) ||
      parseStudentCounter(row.generation) === null ||
      row.apiOrigin !== options.apiOrigin ||
      !natural(row.lastReservedCounter) ||
      typeof row.terminal !== "boolean"
    )
      return null;
    const device = options.validateDevice(row.device);
    if (device === null) return null;
    const nativeProtection =
      row === legacy || row.nativeProtection === null
        ? null
        : parseStoredNativeProtection(row.nativeProtection);
    if (
      row !== legacy &&
      row.nativeProtection !== null &&
      nativeProtection === null
    )
      return null;
    let current: StoredStudentAuthority | null = null;
    if (row.current !== null) {
      const c = object(row.current, [
        "scope",
        "sessionRevision",
        "syntheticDisplayName",
        "serverNowMs",
        "capabilityIssuedAtMs",
        "capabilityExpiresAtMs",
        "reconnectExpiresAtMs",
        "capabilityToken",
        "reconnectGrant",
      ]);
      if (c === null) return null;
      const scope = parseStudentSessionScope(c.scope);
      const revision = parseStudentCounter(c.sessionRevision);
      const capabilityToken = parseStudentSecret(c.capabilityToken);
      const reconnectGrant = parseStudentSecret(c.reconnectGrant);
      if (
        scope === null ||
        scope.deviceSessionId !== device.deviceSessionId ||
        revision === null ||
        capabilityToken === null ||
        reconnectGrant === null ||
        capabilityToken === reconnectGrant ||
        typeof c.syntheticDisplayName !== "string" ||
        !/^Student [A-Z0-9][A-Z0-9-]{1,23}$/.test(c.syntheticDisplayName) ||
        !natural(c.serverNowMs) ||
        !natural(c.capabilityIssuedAtMs) ||
        !natural(c.capabilityExpiresAtMs) ||
        !natural(c.reconnectExpiresAtMs) ||
        c.capabilityExpiresAtMs - c.capabilityIssuedAtMs !== 300_000 ||
        c.reconnectExpiresAtMs - c.capabilityIssuedAtMs !== 900_000 ||
        c.serverNowMs < c.capabilityIssuedAtMs ||
        c.serverNowMs >= c.reconnectExpiresAtMs
      )
        return null;
      current = {
        scope,
        sessionRevision: revision,
        syntheticDisplayName: c.syntheticDisplayName,
        serverNowMs: c.serverNowMs,
        capabilityIssuedAtMs: c.capabilityIssuedAtMs,
        capabilityExpiresAtMs: c.capabilityExpiresAtMs,
        reconnectExpiresAtMs: c.reconnectExpiresAtMs,
        capabilityToken,
        reconnectGrant,
      };
    }
    let pending: PendingStudentIntent | null = null;
    if (row.pending !== null) {
      const join = object(row.pending, [
        "kind",
        "admissionMode",
        "requestId",
        "joinCode",
        "candidates",
      ]);
      const rotate = object(row.pending, [
        "kind",
        "requestId",
        "expectedSessionRevision",
        "candidates",
      ]);
      const forfeit = object(row.pending, [
        "kind",
        "requestId",
        "expectedSessionRevision",
      ]);
      if (join !== null && join.kind === "join") {
        const requestId = parseStudentUuid(join.requestId);
        const joinCode = parseStudentJoinCode(join.joinCode);
        const candidates = options.validateCandidates(join.candidates);
        if (
          requestId === null ||
          joinCode === null ||
          candidates === null ||
          (join.admissionMode !== "initial" &&
            join.admissionMode !== "readmission") ||
          current !== null ||
          row.lastReservedCounter !== 0
        )
          return null;
        pending = {
          kind: "join",
          admissionMode: join.admissionMode,
          requestId,
          joinCode,
          candidates,
        };
      } else if (rotate !== null && rotate.kind === "reconnect") {
        const requestId = parseStudentUuid(rotate.requestId);
        const expectedSessionRevision = parseStudentCounter(
          rotate.expectedSessionRevision,
        );
        const candidates = options.validateCandidates(rotate.candidates);
        if (
          requestId === null ||
          expectedSessionRevision === null ||
          candidates === null ||
          current === null ||
          expectedSessionRevision !== current.sessionRevision ||
          candidates.capabilityToken === current.capabilityToken ||
          candidates.reconnectGrant === current.reconnectGrant
        )
          return null;
        pending = {
          kind: "reconnect",
          requestId,
          expectedSessionRevision,
          candidates,
        };
      } else if (forfeit !== null && forfeit.kind === "forfeit") {
        const requestId = parseStudentUuid(forfeit.requestId);
        const expectedSessionRevision = parseStudentCounter(
          forfeit.expectedSessionRevision,
        );
        if (
          requestId === null ||
          expectedSessionRevision === null ||
          current === null ||
          expectedSessionRevision !== current.sessionRevision
        )
          return null;
        pending = { kind: "forfeit", requestId, expectedSessionRevision };
      } else return null;
    }
    if (
      row.terminal
        ? current !== null || pending !== null
        : current === null && pending?.kind !== "join"
    )
      return null;
    const normalizedEvidence: StoredNativeEvidence = {
      ...emptyNativeEvidence(),
      origins: [
        ...new Set(nativeProtection?.facts.map((fact) => fact.attemptId) ?? []),
      ].map((attemptId) => {
        const scope = nativeProtection!.facts.find(
          (fact) => fact.attemptId === attemptId,
        )!.scope;
        return {
          attemptId,
          scope,
          originalKeyThumbprint:
            scope.deviceSessionId === device.deviceSessionId
              ? device.keyThumbprint
              : null,
          originBuild: { kind: "legacy_unknown" },
        };
      }),
    };
    const evidence = parseEvidence(
      row === legacy || row === v2 ? normalizedEvidence : row.evidence,
      device,
      nativeProtection,
      allowLegacy && row !== legacy && row !== v2,
    );
    if (evidence === null) return null;
    return Object.freeze({
      version: 3,
      generation: row.generation as number,
      apiOrigin: options.apiOrigin,
      device: Object.freeze(device),
      current:
        current === null
          ? null
          : Object.freeze({ ...current, scope: Object.freeze(current.scope) }),
      pending: pending === null ? null : Object.freeze(pending),
      lastReservedCounter: row.lastReservedCounter,
      terminal: row.terminal,
      nativeProtection,
      evidence,
    });
  }

  function validEvidenceSuccessor(next: StudentSessionRecord): boolean {
    const before = lastRecord;
    const priorFacts = before?.nativeProtection?.facts ?? [];
    const nextFacts = next.nativeProtection?.facts ?? [];
    const oldOrigins = new Map(
      before?.evidence.origins.map((origin) => [origin.attemptId, origin]) ??
        [],
    );
    const nextOrigins = new Map(
      next.evidence.origins.map((origin) => [origin.attemptId, origin]),
    );
    const nextAcks = new Map(
      next.evidence.acknowledgments.map((ack) => [ack.eventId, ack]),
    );
    const oldAcks = new Map(
      before?.evidence.acknowledgments.map((ack) => [ack.eventId, ack]) ?? [],
    );
    for (const origin of next.evidence.origins) {
      const prior = oldOrigins.get(origin.attemptId);
      if (
        prior !== undefined
          ? !sameData(prior, origin)
          : origin.originBuild.kind === "legacy_unknown" ||
            origin.originalKeyThumbprint !== next.device.keyThumbprint ||
            origin.scope.deviceSessionId !== next.device.deviceSessionId
      )
        return false;
    }
    if (before === null)
      return (
        next.evidence.acknowledgments.length === 0 &&
        next.evidence.retiredSigners.length === 0
      );
    const removable = new Set(
      before.evidence.origins
        .filter((origin) => {
          if (
            origin.attemptId ===
              next.nativeProtection?.latestAttempt?.attemptId ||
            before.evidence.pendingBatches.some(
              (batch) => batch.attemptId === origin.attemptId,
            )
          )
            return false;
          const facts = priorFacts.filter(
            (fact) => fact.attemptId === origin.attemptId,
          );
          return (
            facts.some((fact) => fact.slot === "cleanup") &&
            facts.every((fact) => oldAcks.has(fact.eventId))
          );
        })
        .map((origin) => origin.attemptId),
    );
    for (const fact of priorFacts) {
      const replacement = nextFacts.find(
        (item) => item.eventId === fact.eventId,
      );
      if (replacement !== undefined) {
        if (!sameData(fact, replacement) || !nextOrigins.has(fact.attemptId))
          return false;
      } else if (
        !removable.has(fact.attemptId) ||
        nextFacts.some((item) => item.attemptId === fact.attemptId) ||
        nextOrigins.has(fact.attemptId)
      )
        return false;
    }
    if (
      before.nativeProtection !== null &&
      (next.nativeProtection === null ||
        next.nativeProtection.nextFactSequence <
          before.nativeProtection.nextFactSequence ||
        next.nativeProtection.revision < before.nativeProtection.revision)
    )
      return false;
    for (const fact of nextFacts)
      if (
        !priorFacts.some((prior) => prior.eventId === fact.eventId) &&
        fact.sequence < (before.nativeProtection?.nextFactSequence ?? 1)
      )
        return false;
    for (const ack of before.evidence.acknowledgments) {
      const replacement = nextAcks.get(ack.eventId);
      if (
        replacement !== undefined
          ? !sameData(ack, replacement)
          : nextFacts.some((fact) => fact.eventId === ack.eventId)
      )
        return false;
    }
    for (const ack of next.evidence.acknowledgments)
      if (
        !oldAcks.has(ack.eventId) &&
        !before.evidence.pendingBatches.some((batch) =>
          batch.events.some(
            (event) =>
              event.eventId === ack.eventId &&
              event.contentDigest === ack.contentDigest,
          ),
        )
      )
        return false;
    for (const batch of before.evidence.pendingBatches) {
      const replacement = next.evidence.pendingBatches.find(
        (item) => item.originalKeyThumbprint === batch.originalKeyThumbprint,
      );
      if (
        replacement !== undefined
          ? !sameData(batch, replacement)
          : !batch.events.every(
              (event) =>
                nextAcks.get(event.eventId)?.contentDigest ===
                event.contentDigest,
            )
      )
        return false;
      if (
        batch.events.some(
          (event) => !oldAcks.has(event.eventId) && nextAcks.has(event.eventId),
        ) &&
        (replacement !== undefined ||
          !batch.events.every((event) => nextAcks.has(event.eventId)))
      )
        return false;
    }
    const nextSigners = new Map(
      next.evidence.retiredSigners.map((signer) => [
        signer.device.keyThumbprint,
        signer,
      ]),
    );
    const sameDevice = sameData(before.device, next.device);
    if (sameDevice) {
      if (next.lastReservedCounter < before.lastReservedCounter) return false;
    } else {
      if (!targetedOnly) return false;
      const retained = nextSigners.get(before.device.keyThumbprint);
      if (
        (retained !== undefined &&
          (!sameData(retained.device, before.device) ||
            retained.lastReservedCounter !== before.lastReservedCounter)) ||
        (signerRequired(before, before.device.keyThumbprint) &&
          retained === undefined)
      )
        return false;
    }
    for (const signer of before.evidence.retiredSigners) {
      const replacement = nextSigners.get(signer.device.keyThumbprint);
      if (
        replacement === undefined
          ? signerRequired(next, signer.device.keyThumbprint)
          : !sameData(replacement.device, signer.device) ||
            replacement.lastReservedCounter < signer.lastReservedCounter
      )
        return false;
    }
    for (const signer of next.evidence.retiredSigners)
      if (
        !before.evidence.retiredSigners.some(
          (old) => old.device.keyThumbprint === signer.device.keyThumbprint,
        ) &&
        (sameDevice || !sameData(signer.device, before.device))
      )
        return false;
    return true;
  }

  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (closed || busy) throw failure();
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  }

  async function lockedHandle(): Promise<NativeStudentRecordHandle> {
    if (mustReopen && handle !== null) {
      await handle.close();
      handle = null;
    }
    handle ??= await options.openNativeStore();
    mustReopen = false;
    return handle;
  }

  return {
    async load() {
      try {
        return await exclusive(async (): Promise<StudentSessionLoad> => {
          loaded = false;
          lastRecord = null;
          const native = await lockedHandle();
          if (!options.codec.isEncryptionAvailable())
            return { kind: "unavailable" };
          let ciphertext: Buffer | null;
          try {
            ciphertext = await native.loadEncryptedRecord();
          } catch {
            requiresRecovery = true;
            targetedOnly = true;
            loaded = true;
            return { kind: "recovery_required", generation };
          }
          if (ciphertext === null) {
            generation = 0;
            requiresRecovery = false;
            loaded = true;
            return { kind: "empty", generation };
          }
          try {
            if (
              ciphertext.byteLength === 0 ||
              ciphertext.byteLength > maximumCiphertextBytes
            )
              throw failure();
            const plaintext = options.codec.decryptString(
              Buffer.from(ciphertext),
            );
            if (Buffer.byteLength(plaintext, "utf8") > maximumPlaintextBytes)
              throw failure();
            const record = parseRecord(JSON.parse(plaintext), true);
            if (record === null) throw failure();
            lastRecord = record;
            generation = record.generation;
            requiresRecovery = false;
            loaded = true;
            return { kind: "ready", record };
          } catch {
            requiresRecovery = true;
            targetedOnly = true;
            loaded = true;
            return { kind: "recovery_required", generation };
          }
        });
      } catch {
        return { kind: "unavailable" };
      }
    },
    commitDurably(expectedGeneration, successor) {
      return exclusive(async () => {
        if (
          !loaded ||
          requiresRecovery ||
          mustReopen ||
          handle === null ||
          generation !== expectedGeneration ||
          generation === Number.MAX_SAFE_INTEGER ||
          !options.codec.isEncryptionAvailable()
        )
          throw failure();
        const record = parseRecord({
          ...successor,
          generation: generation + 1,
        });
        if (record === null || !validEvidenceSuccessor(record)) throw failure();
        if (
          targetedOnly &&
          (record.current !== null ||
            record.pending?.kind !== "join" ||
            record.pending.admissionMode !== "readmission")
        )
          throw failure();
        // The origin's exact scope already belongs to every immutable fact in
        // the attempt. Store that association once; reconstruct it on load.
        const plaintext = JSON.stringify({
          ...record,
          evidence: {
            ...record.evidence,
            origins: record.evidence.origins.map((origin) => ({
              attemptId: origin.attemptId,
              originalKeyThumbprint: origin.originalKeyThumbprint,
              originBuild: origin.originBuild,
            })),
          },
        });
        if (Buffer.byteLength(plaintext, "utf8") > maximumPlaintextBytes)
          throw failure();
        const ciphertext = options.codec.encryptString(plaintext);
        if (
          !Buffer.isBuffer(ciphertext) ||
          ciphertext.byteLength === 0 ||
          ciphertext.byteLength > maximumCiphertextBytes
        )
          throw failure();
        try {
          await handle.replaceEncryptedRecord(Buffer.from(ciphertext));
        } catch {
          // Publication may already have occurred. Loading the owned slot after
          // reopening recovers its high-water value; only a NEW durable write
          // may authorize another egress, never readback or counter rollback.
          loaded = false;
          mustReopen = true;
          throw failure();
        }
        generation = record.generation;
        lastRecord = record;
        targetedOnly = false;
        return record;
      });
    },
    preserveForTargetedRecovery(expectedGeneration) {
      return exclusive(async () => {
        if (
          !loaded ||
          mustReopen ||
          handle === null ||
          generation !== expectedGeneration ||
          generation === Number.MAX_SAFE_INTEGER
        )
          throw failure();
        try {
          await handle.quarantineEncryptedRecord();
        } catch {
          loaded = false;
          mustReopen = true;
          throw failure();
        }
        // This in-memory fence also prevents a late old-record promotion. The
        // next write stores its successor; a crash before it leaves quarantine.
        generation += 1;
        requiresRecovery = false;
        targetedOnly = true;
        return generation;
      });
    },
    async close() {
      if (closed) return;
      await exclusive(async () => {
        await handle?.close();
        handle = null;
        closed = true;
        loaded = false;
      });
    },
  };
}

/** Fixed main-relative addon; paths and descriptors are never IPC inputs. */
export function openNativeStudentRecordStore(
  ownedDirectory: string,
): Promise<NativeStudentRecordHandle> {
  if (process.platform !== "darwin") return Promise.reject(failure());
  try {
    const addon: unknown = createRequire(import.meta.url)(
      "./native/durable-record.node",
    );
    if (
      typeof addon !== "object" ||
      addon === null ||
      !("openStore" in addon) ||
      typeof addon.openStore !== "function"
    )
      return Promise.reject(failure());
    return addon.openStore(
      ownedDirectory,
    ) as Promise<NativeStudentRecordHandle>;
  } catch {
    return Promise.reject(failure());
  }
}
