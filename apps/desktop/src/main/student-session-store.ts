import { createRequire } from "node:module";

import {
  parseStudentCounter,
  parseStudentJoinCode,
  parseStudentSecret,
  parseStudentSessionScope,
  parseStudentUuid,
  type StudentAdmissionMode,
  type StudentSessionScope,
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
  readonly version: 2;
  readonly generation: number;
  readonly apiOrigin: string;
  readonly device: StudentSessionDevice;
  readonly current: StoredStudentAuthority | null;
  readonly pending: PendingStudentIntent | null;
  readonly lastReservedCounter: number;
  readonly terminal: boolean;
  readonly nativeProtection: StoredNativeProtection | null;
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

  function parseRecord(
    value: unknown,
    allowVersion1 = false,
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
    const legacy = allowVersion1 ? object(value, keys) : null;
    const row =
      legacy?.version === 1
        ? legacy
        : object(value, [...keys, "nativeProtection"]);
    if (
      row === null ||
      (row === legacy ? row.version !== 1 : row.version !== 2) ||
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
    return {
      version: 2,
      generation: row.generation as number,
      apiOrigin: options.apiOrigin,
      device,
      current,
      pending,
      lastReservedCounter: row.lastReservedCounter,
      terminal: row.terminal,
      nativeProtection,
    };
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
        if (record === null) throw failure();
        if (
          targetedOnly &&
          (record.current !== null ||
            record.pending?.kind !== "join" ||
            record.pending.admissionMode !== "readmission")
        )
          throw failure();
        const plaintext = JSON.stringify(record);
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
