import { randomUUID } from "node:crypto";

import {
  parseStudentJoinCode,
  parseStudentUuid,
  parseNativeEvidenceOriginBuild,
  type NativeEvidenceOriginBuild,
  type StudentEvidenceRequest,
  type StudentJoinAccepted,
  type StudentJoinRequest,
  type StudentSessionScope,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

import type { StudentSessionCrypto } from "./student-session-crypto.js";
import type { StudentSessionTransport } from "./student-session-transport.js";
import {
  parseProtectionTransition,
  parseBootRecoveryCommand,
  emptyLocalBootRecovery,
  maySupersedeLatest,
  priorBootRecovered,
  type BootRecoveryCommand,
  protectionFactCapacity,
  protectionFactReservation,
  type ProtectionTransition,
  type ProtectionFact,
  type StoredNativeProtection,
  type PendingStudentIntent,
  type StoredStudentAuthority,
  type StudentSessionRecord,
  type StudentSessionStore,
  type StudentSessionSuccessor,
  type StoredNativeEvidencePendingBatch,
  type StoredNativeEvidenceOrigin,
  type StoredNativeEvidenceSigner,
  emptyNativeEvidence,
  canReplaceInitialJoin,
  retainNativeEvidenceSigner,
  pruneNativeEvidence,
} from "./student-session-store.js";

export interface StudentAdmissionSnapshot {
  readonly scope: StudentSessionScope;
  readonly admissionGeneration: number;
  readonly sessionRevision: number;
  readonly capabilityDeadline: number;
}
export interface FreshStudentAdmission extends StudentAdmissionSnapshot {
  readonly observationSequence: number;
  readonly readStartedAt: number;
  readonly observationDeadline: number;
}
/** Issuer-owned permission to record one preflight result, never an admission. */
export interface PreflightReportReceipt {
  readonly attemptId: string;
}
export type FreshAdmissionResult =
  | { readonly status: "fresh"; readonly authority: FreshStudentAdmission }
  | { readonly status: "unavailable" };
export type StudentAdmissionObservation =
  | { readonly status: "fresh"; readonly authority: FreshStudentAdmission }
  | { readonly status: "invalidated" };
export type StudentBootRecoveryState =
  | { readonly status: "none" }
  | { readonly status: "record_rejected" }
  | { readonly status: "write_uncertain" }
  | { readonly status: "unanchored_prior"; readonly attemptId: string }
  | {
      readonly status: "prior_process";
      readonly attemptId: string;
      readonly expectedProtectionRevision: number;
      readonly engagingBootSessionId: string;
    }
  | {
      readonly status: "prior_boot_recovery_observed";
      readonly attemptId: string;
    };
export interface StudentProtectionAccess {
  readProtectionContext(): {
    readonly admission: StudentAdmissionSnapshot | null;
    readonly freshAdmission: FreshStudentAdmission | null;
    readonly observationSequence: number;
    readonly protection: Readonly<StoredNativeProtection> | null;
    readonly delivery: "none" | "pending" | "acknowledged" | "blocked";
    readonly bootRecovery: StudentBootRecoveryState;
    readonly maySupersedeLatest: boolean;
  };
  readFreshAdmission(
    expected: StudentAdmissionSnapshot,
    afterObservationSequence?: number,
  ): Promise<FreshAdmissionResult>;
  isCurrentAdmission(
    receipt: FreshStudentAdmission,
    use?: "grant" | "sustain",
  ): boolean;
  reservePreflightReport(
    authority: FreshStudentAdmission,
    attemptId: string,
  ): PreflightReportReceipt | null;
  releasePreflightReport(receipt: PreflightReportReceipt): void;
  subscribeAdmissionObservation(
    listener: (observation: StudentAdmissionObservation) => void,
  ): () => void;
  commitProtectionTransition(
    command: ProtectionTransition,
  ): Promise<
    | { readonly status: "committed"; readonly protectionRevision: number }
    | { readonly status: "unavailable" }
  >;
  commitBootRecovery(
    command: BootRecoveryCommand,
  ): Promise<
    | { readonly status: "committed"; readonly protectionRevision: number }
    | { readonly status: "unavailable" }
  >;
}

export interface StudentSessionCoordinator extends StudentProtectionAccess {
  initialize(): Promise<void>;
  joinInitial(code: string): Promise<void>;
  beginTargetedReadmission(
    code: string,
    snapshotRevision: number,
  ): Promise<void>;
  retryPending(): Promise<void>;
  refresh(): Promise<void>;
  flushEvidence(): Promise<void>;
  forfeit(snapshotRevision: number): Promise<void>;
  readView(): StudentSessionViewState;
  subscribe(listener: (view: StudentSessionViewState) => void): () => void;
  /** False means keep the native lock until actual process exit. */
  dispose(): Promise<boolean>;
}

function successor(record: StudentSessionRecord): StudentSessionSuccessor {
  return {
    version: record.version,
    apiOrigin: record.apiOrigin,
    device: record.device,
    current: record.current,
    pending: record.pending,
    lastReservedCounter: record.lastReservedCounter,
    terminal: record.terminal,
    nativeProtection: record.nativeProtection,
    evidence: record.evidence,
  };
}
function sameRecord(
  a: StudentSessionSuccessor | null,
  b: StudentSessionSuccessor | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createStudentSessionCoordinator(options: {
  readonly apiOrigin: string;
  readonly store: StudentSessionStore;
  readonly crypto: StudentSessionCrypto;
  readonly transport: StudentSessionTransport;
  readonly monotonicNow?: () => number;
  readonly requestId?: () => string;
  readonly drainTimeoutMs?: number;
  readonly originBuild?: NativeEvidenceOriginBuild;
}): StudentSessionCoordinator {
  const now = options.monotonicNow ?? (() => performance.now());
  const requestId = options.requestId ?? randomUUID;
  const parsedOriginBuild = parseNativeEvidenceOriginBuild(
    options.originBuild ?? { kind: "unverified_build" },
  );
  if (parsedOriginBuild === null || parsedOriginBuild.kind === "legacy_unknown")
    throw new Error("Student native evidence build origin is invalid");
  const originBuild: NativeEvidenceOriginBuild = parsedOriginBuild;
  let record: StudentSessionRecord | null = null;
  let storeGeneration = 0;
  let initialized = false;
  let firstRecordLoaded = false;
  let needsReload = false;
  let recoveryLatched = false;
  let stopping = false;
  let lifetime = 0;
  let active: Promise<void> | null = null;
  let priorityWaiters = 0;
  let lastEvidenceAt = Number.NEGATIVE_INFINITY;
  let evidenceCapacityBlocked = false;
  const blockedEvidenceSigners = new Set<string>();
  let abort: AbortController | null = null;
  let attemptedWrite: {
    readonly before: StudentSessionSuccessor | null;
    readonly after: StudentSessionSuccessor;
  } | null = null;
  let capabilityDeadline = 0;
  let lastMaintenanceAt = Number.NEGATIVE_INFINITY;
  let admissionGeneration = 1;
  let admissionAvailable = false;
  let admissionSnapshot: StudentAdmissionSnapshot | null = null;
  const admissionSnapshots = new WeakSet<object>();
  let issuedAdmission: FreshStudentAdmission | null = null;
  let observationSequence = 0;
  let ownedRenewal = false;
  let nativeOwnershipUncertain = false;
  let recordRecoveryRejected = false;
  let unanchoredPriorBarrier = false;
  let priorProcessAttemptId: string | null = null;
  const ownedProtectionAttempts = new Set<string>();
  type PreflightFailure = Extract<
    ProtectionTransition,
    { readonly kind: "preflight_failure" }
  >;
  type PreflightReservation = {
    readonly receipt: PreflightReportReceipt;
    readonly lifetime: number;
    readonly scope: StudentSessionScope;
    readonly deviceSessionId: string;
    readonly publicKey: string;
    readonly keyThumbprint: string;
    readonly protectionRevision: number;
    state: "reserved" | "observed" | "engaging" | "committed" | "released";
    observed: PreflightFailure | null;
  };
  const preflightReceipts = new WeakMap<
    PreflightReportReceipt,
    PreflightReservation
  >();
  let activePreflight: PreflightReservation | null = null;
  type ReadOwner = {
    sequence: number | null;
    receipt: FreshStudentAdmission | null;
  };
  let activeReadOwner: ReadOwner | null = null;
  const admissionListeners = new Set<
    (value: StudentAdmissionObservation) => void
  >();
  const listeners = new Set<(view: StudentSessionViewState) => void>();
  let view: StudentSessionViewState = Object.freeze({
    revision: 1,
    phase: "unavailable",
    session: null,
    protection: "unavailable",
    calculatorEligible: false,
    pendingOperation: null,
  });

  function sameScope(a: StudentSessionScope, b: StudentSessionScope): boolean {
    return (
      a.schoolId === b.schoolId &&
      a.testId === b.testId &&
      a.studentSessionId === b.studentSessionId &&
      a.deviceSessionId === b.deviceSessionId &&
      a.epoch === b.epoch
    );
  }

  function notifyAdmission(value: StudentAdmissionObservation): void {
    for (const listener of [...admissionListeners]) {
      try {
        listener(value);
      } catch {
        /* One observer cannot prevent containment. */
      }
    }
  }

  function invalidateAdmission(): void {
    const hadAuthority =
      admissionAvailable ||
      issuedAdmission !== null ||
      admissionSnapshot !== null;
    admissionAvailable = false;
    admissionSnapshot = null;
    issuedAdmission = null;
    ownedRenewal = false;
    if (admissionGeneration < Number.MAX_SAFE_INTEGER) admissionGeneration += 1;
    if (hadAuthority) notifyAdmission(Object.freeze({ status: "invalidated" }));
  }

  function admissionMatches(expected: StudentAdmissionSnapshot): boolean {
    return (
      typeof expected === "object" &&
      expected !== null &&
      admissionSnapshots.has(expected) &&
      !stopping &&
      !needsReload &&
      !recoveryLatched &&
      !recordRecoveryRejected &&
      admissionAvailable &&
      record?.current != null &&
      !record.terminal &&
      admissionGeneration < Number.MAX_SAFE_INTEGER &&
      expected.admissionGeneration === admissionGeneration &&
      sameScope(expected.scope, record.current.scope) &&
      capabilityDeadline > now()
    );
  }

  function expireObservation(): void {
    if (
      issuedAdmission !== null &&
      (now() >= issuedAdmission.observationDeadline ||
        now() >= issuedAdmission.capabilityDeadline)
    )
      invalidateAdmission();
  }

  function captureAdmission(): StudentAdmissionSnapshot | null {
    expireObservation();
    if (admissionAvailable && capabilityDeadline <= now())
      invalidateAdmission();
    if (
      !admissionAvailable ||
      stopping ||
      needsReload ||
      recoveryLatched ||
      recordRecoveryRejected ||
      record?.current == null ||
      record.terminal ||
      capabilityDeadline <= now() ||
      admissionGeneration === Number.MAX_SAFE_INTEGER
    )
      return null;
    if (
      admissionSnapshot === null ||
      admissionSnapshot.sessionRevision !== record.current.sessionRevision ||
      admissionSnapshot.capabilityDeadline !== capabilityDeadline
    ) {
      admissionSnapshot = Object.freeze({
        scope: Object.freeze({ ...record.current.scope }),
        admissionGeneration,
        sessionRevision: record.current.sessionRevision,
        capabilityDeadline,
      });
      admissionSnapshots.add(admissionSnapshot);
    }
    return admissionSnapshot;
  }

  function isCurrentAdmission(
    receipt: FreshStudentAdmission,
    use: "grant" | "sustain" = "grant",
  ): boolean {
    if (
      receipt != null &&
      receipt === issuedAdmission &&
      (now() >= receipt.observationDeadline ||
        now() >= receipt.capabilityDeadline)
    )
      invalidateAdmission();
    if (
      receipt === null ||
      receipt !== issuedAdmission ||
      !admissionMatches(receipt) ||
      now() >= receipt.observationDeadline ||
      now() >= receipt.capabilityDeadline ||
      (record?.pending !== null &&
        !(ownedRenewal && record?.pending?.kind === "reconnect"))
    )
      return false;
    return (
      use === "sustain" ||
      (use === "grant" &&
        !ownedRenewal &&
        record?.pending === null &&
        receipt.sessionRevision === record.current?.sessionRevision &&
        receipt.capabilityDeadline === capabilityDeadline)
    );
  }

  function publish(phase: StudentSessionViewState["phase"]): void {
    if (stopping) return;
    if (phase !== "active") invalidateAdmission();
    else admissionAvailable = true;
    const current = record?.current;
    view = Object.freeze({
      revision: view.revision + 1,
      phase,
      session:
        current == null
          ? null
          : Object.freeze({
              syntheticDisplayName: current.syntheticDisplayName,
              sessionRevision: current.sessionRevision,
              capabilityExpiresAtMs: current.capabilityExpiresAtMs,
            }),
      protection: "unavailable",
      calculatorEligible: false,
      pendingOperation:
        record?.pending?.kind ?? attemptedWrite?.after.pending?.kind ?? null,
    });
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        /* A presentation listener cannot own the intent. */
      }
    }
  }

  function alive(generation: number): boolean {
    return !stopping && generation === lifetime;
  }

  function refreshPriorOwnership(): void {
    const protection = record?.nativeProtection ?? null;
    const latest = protection?.latestAttempt;
    nativeOwnershipUncertain = false;
    unanchoredPriorBarrier = false;
    if (
      latest == null ||
      latest.attemptId !== priorProcessAttemptId ||
      maySupersedeLatest(protection)
    )
      return;
    const anchor = protection?.localBootRecovery.anchors.find(
      (value) => value.attemptId === latest.attemptId,
    );
    if (anchor === undefined) unanchoredPriorBarrier = true;
    else nativeOwnershipUncertain = true;
  }

  function canSupersedeLatest(): boolean {
    return (
      initialized &&
      firstRecordLoaded &&
      !stopping &&
      !recordRecoveryRejected &&
      !recoveryLatched &&
      !needsReload &&
      !nativeOwnershipUncertain &&
      !unanchoredPriorBarrier &&
      maySupersedeLatest(record?.nativeProtection ?? null)
    );
  }

  function bootRecoveryState(): StudentBootRecoveryState {
    if (recordRecoveryRejected)
      return Object.freeze({ status: "record_rejected" });
    if (!firstRecordLoaded || needsReload || recoveryLatched)
      return Object.freeze({ status: "write_uncertain" });
    const protection = record?.nativeProtection ?? null;
    const latest = protection?.latestAttempt;
    if (latest == null) return Object.freeze({ status: "none" });
    if (priorBootRecovered(protection, latest.attemptId))
      return Object.freeze({
        status: "prior_boot_recovery_observed",
        attemptId: latest.attemptId,
      });
    if (unanchoredPriorBarrier)
      return Object.freeze({
        status: "unanchored_prior",
        attemptId: latest.attemptId,
      });
    if (
      nativeOwnershipUncertain &&
      latest.attemptId === priorProcessAttemptId
    ) {
      const anchor = protection!.localBootRecovery.anchors.find(
        (value) => value.attemptId === latest.attemptId,
      );
      if (anchor !== undefined && anchor.observation === null)
        return Object.freeze({
          status: "prior_process",
          attemptId: latest.attemptId,
          expectedProtectionRevision: protection!.revision,
          engagingBootSessionId: anchor.engagingBootSessionId,
        });
    }
    return Object.freeze({ status: "none" });
  }

  function run(
    work: (generation: number, signal: AbortSignal) => Promise<void>,
    readOwner: ReadOwner | null = null,
  ): Promise<void> {
    if (stopping) return Promise.resolve();
    if (active !== null) return active;
    // A caller deadline is not actual I/O settlement. No new intent may load,
    // reopen, reserve or quarantine the store while the old exchange owns it.
    if (!options.transport.isIdle()) return Promise.resolve();
    const generation = lifetime;
    const controller = new AbortController();
    abort = controller;
    // Reserve the entire intent before calling any port or listener. Reentrant
    // UI callbacks and the durable-write -> fetch gap share this same owner.
    const pending = Promise.resolve().then(async () => {
      try {
        if (alive(generation)) await work(generation, controller.signal);
      } catch {
        if (alive(generation))
          publish(
            (record?.pending !== null && record !== null) ||
              attemptedWrite !== null
              ? "unconfirmed"
              : "unavailable",
          );
      }
    });
    active = pending;
    activeReadOwner = readOwner;
    void pending.finally(() => {
      if (active === pending) {
        active = null;
        abort = null;
        activeReadOwner = null;
      }
    });
    return pending;
  }

  async function runPriority(
    work: (generation: number, signal: AbortSignal) => Promise<void>,
    readOwner: ReadOwner | null = null,
  ): Promise<void> {
    priorityWaiters += 1;
    try {
      // Every explicit command gets its own turn and rechecks its captured state.
      // A preceding waiter can become the owner as evidence settles, so waiting
      // only for evidence would silently coalesce this command onto that waiter.
      while (active !== null) await active;
      await run(work, readOwner);
    } finally {
      priorityWaiters -= 1;
    }
  }

  async function write(
    next: StudentSessionSuccessor,
    generation: number,
  ): Promise<boolean> {
    if (!alive(generation)) return false;
    attemptedWrite = {
      before: record === null ? null : successor(record),
      after: next,
    };
    try {
      const committed = await options.store.commitDurably(
        storeGeneration,
        next,
      );
      if (!alive(generation)) return false;
      record = committed;
      storeGeneration = committed.generation;
      attemptedWrite = null;
      needsReload = false;
      refreshPriorOwnership();
      settlePreflightReservation();
      return true;
    } catch {
      needsReload = true;
      invalidateAdmission();
      throw new Error("Student session durability unavailable");
    }
  }

  async function load(generation: number): Promise<boolean> {
    if (recordRecoveryRejected || recoveryLatched) return false;
    invalidateAdmission();
    const loaded = await options.store.load();
    if (!alive(generation)) return false;
    initialized = true;
    if (loaded.kind === "unavailable") {
      needsReload = true;
      publish("unavailable");
      return false;
    }
    if (loaded.kind === "recovery_required") {
      // A rejected record cannot establish native ownership, even when this
      // process previously read a valid record before an uncertain write.
      recordRecoveryRejected = true;
      storeGeneration = loaded.generation;
      needsReload = false;
      record = null;
      publish("recovery_required");
      return false;
    }
    const found = loaded.kind === "ready" ? loaded.record : null;
    const foundSuccessor = found === null ? null : successor(found);
    storeGeneration =
      (found?.generation ?? (loaded.kind === "empty" && loaded.generation)) ||
      0;
    record = found;
    if (!firstRecordLoaded) {
      firstRecordLoaded = true;
      const attempt = found?.nativeProtection?.latestAttempt;
      if (
        attempt != null &&
        (!maySupersedeLatest(found?.nativeProtection ?? null) ||
          priorBootRecovered(
            found?.nativeProtection ?? null,
            attempt.attemptId,
          ))
      )
        priorProcessAttemptId = attempt.attemptId;
    }
    needsReload = false;
    capabilityDeadline = 0; // A process restart cannot inherit a monotonic lease.
    if (attemptedWrite !== null) {
      const attempt = attemptedWrite;
      if (sameRecord(foundSuccessor, attempt.after)) {
        attemptedWrite = null;
      } else if (sameRecord(foundSuccessor, attempt.before)) {
        if (!(await write(attempt.after, generation))) return false;
      } else {
        record = null;
        recoveryLatched = true;
        publish("recovery_required");
        return false;
      }
    }
    refreshPriorOwnership();
    settlePreflightReservation();
    publish(
      record?.terminal === true
        ? "forfeited"
        : record === null || canReplaceInitialJoin(record)
          ? "entry"
          : "unconfirmed",
    );
    return true;
  }

  function currentAuthority(
    accepted: StudentJoinAccepted,
    tokens: {
      readonly capabilityToken: string;
      readonly reconnectGrant: string;
    },
  ): StoredStudentAuthority {
    return {
      scope: accepted.scope,
      sessionRevision: accepted.sessionRevision,
      syntheticDisplayName: accepted.syntheticDisplayName,
      serverNowMs: accepted.serverNowMs,
      capabilityIssuedAtMs: accepted.capabilityIssuedAtMs,
      capabilityExpiresAtMs: accepted.capabilityExpiresAtMs,
      reconnectExpiresAtMs: accepted.reconnectExpiresAtMs,
      capabilityToken: tokens.capabilityToken,
      reconnectGrant: tokens.reconnectGrant,
    };
  }

  function resultPhase(result: {
    readonly status: string;
  }): "unavailable" | "unconfirmed" {
    return result.status === "denied" ? "unavailable" : "unconfirmed";
  }

  async function attemptJoin(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (record?.pending?.kind !== "join") return;
    // A new successful barrier is mandatory even for a recovered pending join.
    if (
      !(await write(successor(record), generation)) ||
      record?.pending?.kind !== "join"
    )
      return;
    const pending = record.pending;
    const device = record.device;
    // Only this invocation can know that no earlier join may have committed.
    // A recovered or retried uncertain intent never regains that permission.
    const replaceableInitial = canReplaceInitialJoin(record);
    const digest = options.crypto.digestLogicalOperation({
      kind: "join",
      admissionMode: pending.admissionMode,
      requestId: pending.requestId,
      deviceSessionId: device.deviceSessionId,
      joinMaterialDigest: options.crypto.digestJoinCode(pending.joinCode),
      capabilityDigest: pending.candidates.capabilityDigest,
      reconnectDigest: pending.candidates.reconnectDigest,
    });
    if (!alive(generation)) return;
    const challenge = await options.transport.challenge(
      {
        requestId: pending.requestId,
        deviceSessionId: device.deviceSessionId,
        publicKey: device.publicKey,
        logicalOperationDigest: digest,
      },
      signal,
    );
    if (!alive(generation)) return;
    if (!("challengeId" in challenge)) {
      publish(replaceableInitial ? "entry" : resultPhase(challenge));
      return;
    }
    const deviceProof = options.crypto.signBootstrap(device, {
      kind: "bootstrap",
      requestId: pending.requestId,
      deviceSessionId: device.deviceSessionId,
      logicalOperationDigest: digest,
      challengeId: challenge.challengeId,
      expiresAtMs: challenge.expiresAtMs,
    });
    const request: StudentJoinRequest = {
      admissionMode: pending.admissionMode,
      requestId: pending.requestId,
      deviceSessionId: device.deviceSessionId,
      joinCode: pending.joinCode,
      capabilityDigest: pending.candidates.capabilityDigest,
      reconnectDigest: pending.candidates.reconnectDigest,
      deviceProof,
    };
    if (
      replaceableInitial &&
      !(await write(
        {
          ...successor(record),
          pending: { ...pending, outcome: "uncertain" },
        },
        generation,
      ))
    )
      return;
    const sentAt = now();
    if (!alive(generation)) return;
    const accepted = await options.transport.join(request, digest, signal);
    if (!alive(generation)) return;
    if (accepted.status !== "accepted") {
      if (replaceableInitial && accepted.status === "denied") {
        if (
          await write(
            {
              ...successor(record),
              pending: { ...pending, outcome: "denied" },
            },
            generation,
          )
        )
          publish("entry");
      } else {
        publish(resultPhase(accepted));
      }
      return;
    }
    const next = {
      ...successor(record),
      current: currentAuthority(accepted, pending.candidates),
      pending: null,
      lastReservedCounter: 0,
    };
    if (!(await write(next, generation))) return;
    // Subtract the full roundtrip conservatively. Server-relative expiry never
    // grows from a local wall-clock adjustment or duplicate acceptance.
    capabilityDeadline =
      sentAt +
      Math.max(0, accepted.capabilityExpiresAtMs - accepted.serverNowMs);
    lastMaintenanceAt = now();
    publish(capabilityDeadline > now() ? "active" : "unconfirmed");
  }

  async function reserve(generation: number): Promise<number | null> {
    if (
      record === null ||
      record.current === null ||
      record.lastReservedCounter === Number.MAX_SAFE_INTEGER
    ) {
      publish("recovery_required");
      return null;
    }
    const counter = record.lastReservedCounter + 1;
    return (await write(
      { ...successor(record), lastReservedCounter: counter },
      generation,
    ))
      ? counter
      : null;
  }

  function notifyDelivery(): void {
    if (stopping) return;
    // Delivery is private projection data. A report receipt cannot issue or
    // invalidate admission, or change the revision captured by an admission action.
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        /* Presentation does not own delivery. */
      }
    }
  }

  function evidenceSigners(): readonly StoredNativeEvidenceSigner[] {
    if (record === null) return [];
    return [
      {
        device: record.device,
        lastReservedCounter: record.lastReservedCounter,
      },
      ...record.evidence.retiredSigners,
    ];
  }

  function deliveryState(): "none" | "pending" | "acknowledged" | "blocked" {
    const facts = record?.nativeProtection?.facts ?? [];
    if (facts.length === 0) return "none";
    if (record === null || evidenceCapacityBlocked) return "blocked";
    const acknowledged = new Set(
      record.evidence.acknowledgments.map((ack) => ack.eventId),
    );
    const outstanding = facts.filter((fact) => !acknowledged.has(fact.eventId));
    if (outstanding.length === 0 && record.evidence.pendingBatches.length === 0)
      return "acknowledged";
    const signers = evidenceSigners();
    for (const fact of outstanding) {
      const origin = record.evidence.origins.find(
        (entry) => entry.attemptId === fact.attemptId,
      );
      const signer = signers.find(
        (entry) => entry.device.keyThumbprint === origin?.originalKeyThumbprint,
      );
      if (
        origin == null ||
        signer === undefined ||
        signer.lastReservedCounter === Number.MAX_SAFE_INTEGER ||
        blockedEvidenceSigners.has(signer.device.keyThumbprint)
      )
        return "blocked";
    }
    return "pending";
  }

  type EvidenceCandidate = {
    readonly signer: StoredNativeEvidenceSigner;
    readonly origin: StoredNativeEvidenceOrigin;
    readonly pending: StoredNativeEvidencePendingBatch;
    readonly facts: readonly ProtectionFact[];
    readonly contentDigests: readonly string[];
  };

  function sameEvidencePending(
    a: StoredNativeEvidencePendingBatch,
    b: StoredNativeEvidencePendingBatch,
  ): boolean {
    return (
      a.originalKeyThumbprint === b.originalKeyThumbprint &&
      a.attemptId === b.attemptId &&
      a.batchDigest === b.batchDigest &&
      a.events.length === b.events.length &&
      a.events.every(
        (event, index) =>
          event.eventId === b.events[index]?.eventId &&
          event.contentDigest === b.events[index]?.contentDigest,
      )
    );
  }

  function evidenceCandidates(): readonly EvidenceCandidate[] {
    if (record === null) return [];
    const stored = record.evidence;
    const allFacts = record.nativeProtection?.facts ?? [];
    const acknowledged = new Set(
      stored.acknowledgments.map((ack) => ack.eventId),
    );
    const candidates: EvidenceCandidate[] = [];
    for (const signer of evidenceSigners()) {
      const key = signer.device.keyThumbprint;
      if (signer.lastReservedCounter === Number.MAX_SAFE_INTEGER) continue;
      const pending = stored.pendingBatches.find(
        (batch) => batch.originalKeyThumbprint === key,
      );
      const first =
        pending === undefined
          ? allFacts.find(
              (fact) =>
                !acknowledged.has(fact.eventId) &&
                stored.origins.some(
                  (origin) =>
                    origin.attemptId === fact.attemptId &&
                    origin.originalKeyThumbprint === key,
                ),
            )
          : allFacts.find((fact) => fact.attemptId === pending.attemptId);
      if (first === undefined) continue;
      const origin = stored.origins.find(
        (entry) =>
          entry.attemptId === first.attemptId &&
          entry.originalKeyThumbprint === key,
      );
      if (
        origin === undefined ||
        origin.scope.deviceSessionId !== signer.device.deviceSessionId
      )
        continue;
      const facts = allFacts
        .filter(
          (fact) =>
            fact.attemptId === origin.attemptId &&
            (pending === undefined ||
              pending.events.some((entry) => entry.eventId === fact.eventId)),
        )
        .sort((a, b) => a.sequence - b.sequence);
      try {
        const digested = options.crypto.digestEvidence(signer.device, {
          scope: origin.scope,
          originBuild: origin.originBuild,
          facts,
        });
        const frozenPending: StoredNativeEvidencePendingBatch = {
          originalKeyThumbprint: key,
          attemptId: origin.attemptId,
          batchDigest: digested.batchDigest,
          events: facts.map((fact, index) => ({
            eventId: fact.eventId,
            contentDigest: digested.contentDigests[index]!,
          })),
        };
        if (
          pending !== undefined &&
          !sameEvidencePending(pending, frozenPending)
        ) {
          blockedEvidenceSigners.add(key);
          continue;
        }
        candidates.push({
          signer,
          origin,
          pending: pending ?? frozenPending,
          facts,
          contentDigests: digested.contentDigests,
        });
      } catch {
        // Missing legacy material or malformed retained content is not permission
        // to relabel it with the current key, origin or a smaller prefix.
        blockedEvidenceSigners.add(key);
      }
    }
    return candidates.sort((a, b) =>
      a.signer.device.keyThumbprint < b.signer.device.keyThumbprint ? -1 : 1,
    );
  }

  async function pruneEvidence(generation: number): Promise<void> {
    if (record === null || priorityWaiters !== 0) return;
    const before = successor(record);
    const pruned = pruneNativeEvidence(before);
    if (!sameRecord(before, pruned) && (await write(pruned, generation))) {
      if (record !== null && retainNativeEvidenceSigner(record) !== null)
        evidenceCapacityBlocked = false;
      notifyDelivery();
    }
  }

  async function flushEvidence(): Promise<void> {
    if (
      stopping ||
      active !== null ||
      priorityWaiters !== 0 ||
      !options.transport.isIdle() ||
      !initialized ||
      needsReload ||
      recoveryLatched ||
      recordRecoveryRejected ||
      record === null
    )
      return;
    await run(async (generation, signal) => {
      if (
        record === null ||
        needsReload ||
        recoveryLatched ||
        recordRecoveryRejected ||
        priorityWaiters !== 0
      )
        return;
      await pruneEvidence(generation);
      if (
        !alive(generation) ||
        record === null ||
        priorityWaiters !== 0 ||
        now() - lastEvidenceAt < 15_000
      )
        return;
      // Due live work wins even when a caller tries this private method outside
      // the main cycle. Terminal records remain eligible for historical reports.
      if (
        admissionAvailable &&
        capabilityDeadline > now() &&
        record.current !== null &&
        record.pending === null &&
        !record.terminal &&
        now() - lastMaintenanceAt >= 15_000
      )
        return;
      const candidates = evidenceCandidates();
      const cursor = record.evidence.lastAttemptedSigner;
      const candidate =
        candidates.find(
          (entry) =>
            cursor !== null && entry.signer.device.keyThumbprint > cursor,
        ) ?? candidates[0];
      if (candidate === undefined) {
        notifyDelivery();
        return;
      }
      const { signer, origin, pending, facts, contentDigests } = candidate;
      const key = signer.device.keyThumbprint;
      const counter = signer.lastReservedCounter + 1;
      const next = successor(record);
      const currentSigner = record.device.keyThumbprint === key;
      const reserved: StudentSessionSuccessor = {
        ...next,
        lastReservedCounter: currentSigner ? counter : next.lastReservedCounter,
        evidence: {
          ...next.evidence,
          pendingBatches: [
            ...next.evidence.pendingBatches.filter(
              (entry) => entry.originalKeyThumbprint !== key,
            ),
            pending,
          ],
          retiredSigners: next.evidence.retiredSigners.map((entry) =>
            entry.device.keyThumbprint === key
              ? { ...entry, lastReservedCounter: counter }
              : entry,
          ),
          lastAttemptedSigner: key,
        },
      };
      if (!(await write(reserved, generation)) || !alive(generation)) return;
      const request: StudentEvidenceRequest = {
        version: 1,
        scope: origin.scope,
        originBuild: origin.originBuild,
        facts,
        batchDigest: pending.batchDigest,
        publicKey: signer.device.publicKey,
        deviceProof: options.crypto.signEvidence(signer.device, {
          scope: origin.scope,
          batchDigest: pending.batchDigest,
          counter,
        }),
      };
      lastEvidenceAt = now();
      let result: Awaited<ReturnType<StudentSessionTransport["evidence"]>>;
      try {
        result = await options.transport.evidence(
          request,
          contentDigests,
          signal,
        );
      } catch {
        // Expected transport failure changes delivery only. A shared-store
        // failure below still follows the existing uncertain-write recovery path.
        if (alive(generation)) notifyDelivery();
        return;
      }
      if (!alive(generation) || record === null) return;
      if (result.status !== "accepted") {
        if (result.status === "denied") blockedEvidenceSigners.add(key);
        notifyDelivery();
        return;
      }
      const livePending = record.evidence.pendingBatches.find(
        (entry) => entry.originalKeyThumbprint === key,
      );
      const receivedIds = new Set(
        result.acknowledged.map((ack) => ack.eventId),
      );
      const exact =
        livePending !== undefined &&
        sameEvidencePending(livePending, pending) &&
        sameScope(result.scope, origin.scope) &&
        result.batchDigest === pending.batchDigest &&
        result.acceptedProofCounter === counter &&
        result.acknowledged.length === pending.events.length &&
        receivedIds.size === pending.events.length &&
        pending.events.every((entry) =>
          result.acknowledged.some(
            (ack) =>
              ack.eventId === entry.eventId &&
              ack.contentDigest === entry.contentDigest,
          ),
        ) &&
        result.acknowledged.every((ack) => {
          const previous = record!.evidence.acknowledgments.find(
            (entry) => entry.eventId === ack.eventId,
          );
          return (
            previous === undefined ||
            (previous.contentDigest === ack.contentDigest &&
              previous.receivedAt === ack.receivedAt)
          );
        });
      if (!exact) {
        notifyDelivery();
        return;
      }
      const existingIds = new Set(
        record.evidence.acknowledgments.map((ack) => ack.eventId),
      );
      if (
        !(await write(
          {
            ...successor(record),
            evidence: {
              ...record.evidence,
              acknowledgments: [
                ...record.evidence.acknowledgments,
                ...result.acknowledged.filter(
                  (ack) => !existingIds.has(ack.eventId),
                ),
              ],
              pendingBatches: record.evidence.pendingBatches.filter(
                (entry) => entry.originalKeyThumbprint !== key,
              ),
            },
          },
          generation,
        ))
      )
        return;
      blockedEvidenceSigners.delete(key);
      notifyDelivery();
      // Pruning requires ACKs already durable, and never rewrites the retained
      // latest attempt. Higher-priority native writers may defer this next step.
      await pruneEvidence(generation);
    });
  }

  async function attemptRead(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    expireObservation();
    if (record?.current == null || record.pending !== null || record.terminal)
      return;
    const counter = await reserve(generation);
    if (
      counter === null ||
      record?.current == null ||
      record.pending !== null ||
      !alive(generation)
    )
      return;
    const current = record.current;
    const readGeneration = admissionGeneration;
    const id = requestId();
    const digest = options.crypto.digestLogicalOperation({
      kind: "read",
      requestId: id,
      scope: current.scope,
      capabilityDigest: options.crypto.digestCapability(
        current.capabilityToken,
      ),
    });
    const proof = options.crypto.signMaintenance(record.device, {
      kind: "maintenance",
      operation: "read",
      requestId: id,
      scope: current.scope,
      logicalOperationDigest: digest,
      counter,
    });
    if (!alive(generation)) return;
    if (observationSequence === Number.MAX_SAFE_INTEGER) {
      publish("recovery_required");
      return;
    }
    const reservedObservation = ++observationSequence;
    const readStartedAt = now();
    if (activeReadOwner !== null)
      activeReadOwner.sequence = reservedObservation;
    const result = await options.transport.read(
      {
        requestId: id,
        scope: current.scope,
        capabilityToken: current.capabilityToken,
        deviceProof: proof,
      },
      current.capabilityExpiresAtMs,
      signal,
    );
    if (!alive(generation)) return;
    expireObservation();
    if (
      result.status !== "accepted" ||
      readGeneration !== admissionGeneration
    ) {
      publish(
        result.status === "accepted" ? "unconfirmed" : resultPhase(result),
      );
      return;
    }
    if (
      !(await write(
        {
          ...successor(record),
          current: {
            ...current,
            sessionRevision: result.sessionRevision,
            syntheticDisplayName: result.syntheticDisplayName,
          },
        },
        generation,
      ))
    )
      return;
    expireObservation();
    capabilityDeadline = Math.min(
      capabilityDeadline,
      readStartedAt + result.capabilityExpiresAtMs - result.serverNowMs,
    );
    const observationDeadline = Math.min(
      capabilityDeadline,
      readStartedAt + 30_000,
    );
    if (
      !alive(generation) ||
      readGeneration !== admissionGeneration ||
      record.current == null ||
      record.pending !== null ||
      !sameScope(current.scope, record.current.scope) ||
      now() >= observationDeadline
    ) {
      publish("unconfirmed");
      return;
    }
    ownedRenewal = false;
    admissionAvailable = true;
    const admission = captureAdmission();
    if (admission === null) {
      publish("unconfirmed");
      return;
    }
    const receipt: FreshStudentAdmission = Object.freeze({
      ...admission,
      observationSequence: reservedObservation,
      readStartedAt,
      observationDeadline,
    });
    admissionSnapshots.add(receipt);
    issuedAdmission = receipt;
    if (activeReadOwner !== null) activeReadOwner.receipt = receipt;
    notifyAdmission(Object.freeze({ status: "fresh", authority: receipt }));
    // Private observers can synchronously abandon/dispose. Never resurrect that
    // authority or publish active after delivering an invalidated receipt.
    if (alive(generation) && isCurrentAdmission(receipt)) publish("active");
  }

  async function attemptMaintenance(
    generation: number,
    signal: AbortSignal,
    force: boolean,
  ): Promise<void> {
    if (record?.current == null || record.terminal) return;
    if (!force && now() - lastMaintenanceAt < 15_000) return;
    lastMaintenanceAt = now();
    if (record.pending === null && capabilityDeadline - now() <= 60_000) {
      ownedRenewal = true;
      const pending: PendingStudentIntent = {
        kind: "reconnect",
        requestId: requestId(),
        expectedSessionRevision: record.current.sessionRevision,
        candidates: options.crypto.createCandidates(),
      };
      if (!(await write({ ...successor(record), pending }, generation))) return;
    }
    if (record.pending === null) {
      await attemptRead(generation, signal);
      return;
    }
    ownedRenewal = record.pending.kind === "reconnect";
    const counter = await reserve(generation);
    if (counter === null || record?.current == null || !alive(generation))
      return;
    const current = record.current;
    const pending = record.pending;
    const id = pending?.requestId ?? requestId();
    const kind = pending?.kind ?? "read";
    if (kind === "join") return;
    const digest = options.crypto.digestLogicalOperation(
      kind === "reconnect" && pending?.kind === "reconnect"
        ? {
            kind,
            requestId: id,
            scope: current.scope,
            expectedSessionRevision: pending.expectedSessionRevision,
            reconnectDigest: options.crypto.digestReconnectGrant(
              current.reconnectGrant,
            ),
            nextCapabilityDigest: pending.candidates.capabilityDigest,
            nextReconnectDigest: pending.candidates.reconnectDigest,
          }
        : kind === "forfeit" && pending?.kind === "forfeit"
          ? {
              kind,
              requestId: id,
              scope: current.scope,
              expectedSessionRevision: pending.expectedSessionRevision,
              capabilityDigest: options.crypto.digestCapability(
                current.capabilityToken,
              ),
            }
          : {
              kind: "read",
              requestId: id,
              scope: current.scope,
              capabilityDigest: options.crypto.digestCapability(
                current.capabilityToken,
              ),
            },
    );
    const proof = options.crypto.signMaintenance(record.device, {
      kind: "maintenance",
      operation: kind,
      requestId: id,
      scope: current.scope,
      logicalOperationDigest: digest,
      counter,
    });
    const sentAt = now();
    if (!alive(generation)) return;
    if (pending?.kind === "reconnect") {
      const result = await options.transport.reconnect(
        {
          requestId: id,
          scope: current.scope,
          expectedSessionRevision: pending.expectedSessionRevision,
          reconnectGrant: current.reconnectGrant,
          nextCapabilityDigest: pending.candidates.capabilityDigest,
          nextReconnectDigest: pending.candidates.reconnectDigest,
          deviceProof: proof,
        },
        digest,
        signal,
      );
      if (!alive(generation)) return;
      if (result.status !== "accepted") {
        publish(resultPhase(result));
        return;
      }
      if (
        !(await write(
          {
            ...successor(record),
            current: currentAuthority(result, pending.candidates),
            pending: null,
          },
          generation,
        ))
      )
        return;
      capabilityDeadline =
        sentAt + Math.max(0, result.capabilityExpiresAtMs - result.serverNowMs);
      await attemptRead(generation, signal);
    } else if (pending?.kind === "forfeit") {
      const result = await options.transport.forfeit(
        {
          requestId: id,
          scope: current.scope,
          expectedSessionRevision: pending.expectedSessionRevision,
          capabilityToken: current.capabilityToken,
          deviceProof: proof,
        },
        signal,
      );
      if (!alive(generation)) return;
      if (result.status !== "accepted") {
        publish(resultPhase(result));
        return;
      }
      if (
        await write(
          {
            ...successor(record),
            current: null,
            pending: null,
            terminal: true,
          },
          generation,
        )
      )
        publish("forfeited");
    }
  }

  async function retry(generation: number, signal: AbortSignal): Promise<void> {
    if (recoveryLatched || recordRecoveryRejected) return;
    if ((!initialized || needsReload) && !(await load(generation))) return;
    if (record?.pending?.kind === "join") await attemptJoin(generation, signal);
    else await attemptMaintenance(generation, signal, true);
  }

  async function readFreshAdmissionOwned(
    expected: StudentAdmissionSnapshot,
    afterObservationSequence?: number,
  ): Promise<FreshAdmissionResult> {
    if (
      afterObservationSequence !== undefined &&
      (!Number.isSafeInteger(afterObservationSequence) ||
        afterObservationSequence < 0)
    )
      return { status: "unavailable" };
    const fence = afterObservationSequence ?? -1;
    expireObservation();
    if (
      !admissionMatches(expected) ||
      (record?.pending !== null && !ownedRenewal)
    )
      return { status: "unavailable" };
    while (active !== null) {
      const owner = activeReadOwner;
      await active;
      if (!admissionMatches(expected)) return { status: "unavailable" };
      if (
        owner?.sequence !== null &&
        owner?.sequence !== undefined &&
        owner.sequence > fence
      ) {
        return owner.receipt !== null && isCurrentAdmission(owner.receipt)
          ? { status: "fresh", authority: owner.receipt }
          : { status: "unavailable" };
      }
    }
    if (
      !admissionMatches(expected) ||
      record?.pending !== null ||
      !options.transport.isIdle()
    )
      return { status: "unavailable" };
    const owner: ReadOwner = { sequence: null, receipt: null };
    await run(async (generation, signal) => {
      if (admissionMatches(expected) && record?.pending === null)
        await attemptMaintenance(generation, signal, true);
    }, owner);
    return owner.receipt !== null &&
      owner.receipt.observationSequence > fence &&
      admissionMatches(expected) &&
      isCurrentAdmission(owner.receipt)
      ? { status: "fresh", authority: owner.receipt }
      : { status: "unavailable" };
  }

  async function readFreshAdmission(
    expected: StudentAdmissionSnapshot,
    afterObservationSequence?: number,
  ): Promise<FreshAdmissionResult> {
    priorityWaiters += 1;
    try {
      return await readFreshAdmissionOwned(expected, afterObservationSequence);
    } finally {
      priorityWaiters -= 1;
    }
  }

  function samePreflightDevice(reservation: PreflightReservation): boolean {
    return (
      record !== null &&
      record.device.deviceSessionId === reservation.deviceSessionId &&
      record.device.publicKey === reservation.publicKey &&
      record.device.keyThumbprint === reservation.keyThumbprint
    );
  }

  function hasDurablePreflightOrigin(
    reservation: PreflightReservation,
  ): boolean {
    if (record === null || needsReload || recoveryLatched) return false;
    const origin = record.evidence.origins.find(
      (value) => value.attemptId === reservation.receipt.attemptId,
    );
    const first = record.nativeProtection?.facts.find(
      (value) => value.attemptId === reservation.receipt.attemptId,
    );
    if (
      origin === undefined ||
      first === undefined ||
      origin.originalKeyThumbprint !== reservation.keyThumbprint ||
      !sameScope(origin.scope, reservation.scope) ||
      !sameScope(first.scope, reservation.scope) ||
      JSON.stringify(origin.originBuild) !== JSON.stringify(originBuild)
    )
      return false;
    return reservation.observed === null
      ? first.slot === "engaging"
      : first.slot === "failure" &&
          first.phase === "failed" &&
          first.nativeEvent === null &&
          first.nativeSequence === null &&
          first.cause === reservation.observed.cause &&
          JSON.stringify(first.categories) ===
            JSON.stringify(reservation.observed.categories);
  }

  function settlePreflightReservation(): void {
    if (
      activePreflight !== null &&
      (activePreflight.state === "observed" ||
        activePreflight.state === "engaging") &&
      hasDurablePreflightOrigin(activePreflight)
    ) {
      activePreflight.state = "committed";
      activePreflight = null;
    }
  }

  function canReserveProtectionAttempt(id: string): boolean {
    const protection = record?.nativeProtection;
    return (
      record !== null &&
      canSupersedeLatest() &&
      (protection?.revision ?? 0) < Number.MAX_SAFE_INTEGER &&
      (protection?.nextFactSequence ?? 1) < Number.MAX_SAFE_INTEGER &&
      (protection?.facts.length ?? 0) <=
        protectionFactCapacity - protectionFactReservation &&
      !(protection?.facts.some((fact) => fact.attemptId === id) ?? false)
    );
  }

  function reservePreflightReport(
    authority: FreshStudentAdmission,
    id: string,
  ): PreflightReportReceipt | null {
    if (
      parseStudentUuid(id) === null ||
      id[14] !== "4" ||
      !isCurrentAdmission(authority) ||
      activePreflight !== null ||
      !canReserveProtectionAttempt(id) ||
      record === null
    )
      return null;
    const receipt = Object.freeze({ attemptId: id });
    const reservation: PreflightReservation = {
      receipt,
      lifetime,
      scope: Object.freeze({ ...authority.scope }),
      // Keep no extra private key. The existing owned record remains the only
      // signing key store, and replacement is blocked until origin durability.
      deviceSessionId: record.device.deviceSessionId,
      publicKey: record.device.publicKey,
      keyThumbprint: record.device.keyThumbprint,
      protectionRevision: record.nativeProtection?.revision ?? 0,
      state: "reserved",
      observed: null,
    };
    preflightReceipts.set(receipt, reservation);
    activePreflight = reservation;
    return receipt;
  }

  function releasePreflightReport(receipt: PreflightReportReceipt): void {
    const reservation = preflightReceipts.get(receipt);
    if (
      reservation === undefined ||
      reservation !== activePreflight ||
      reservation.lifetime !== lifetime ||
      reservation.state !== "reserved"
    )
      return;
    reservation.state = "released";
    activePreflight = null;
  }

  function observePreflightFailure(
    command: PreflightFailure,
  ): PreflightReservation | null {
    const reservation = preflightReceipts.get(command.receipt);
    if (
      reservation === undefined ||
      reservation.lifetime !== lifetime ||
      reservation.receipt.attemptId !== command.attemptId ||
      reservation.protectionRevision !== command.expectedProtectionRevision
    )
      return null;
    if (reservation.observed !== null) {
      return (reservation.state === "observed" ||
        reservation.state === "committed") &&
        reservation.observed.cause === command.cause &&
        JSON.stringify(reservation.observed.categories) ===
          JSON.stringify(command.categories)
        ? reservation
        : null;
    }
    if (reservation !== activePreflight || reservation.state !== "reserved")
      return null;
    // Synchronous observation precedes every writer wait. Later admission loss
    // can prevent protection, but cannot change this historical failure report.
    reservation.observed = command;
    reservation.state = "observed";
    return reservation;
  }

  function protectionSuccessor(
    command: ProtectionTransition,
  ): StoredNativeProtection | null {
    const protection = record?.nativeProtection;
    const revision = protection?.revision ?? 0;
    if (
      record === null ||
      needsReload ||
      recordRecoveryRejected ||
      recoveryLatched ||
      command.expectedProtectionRevision !== revision ||
      revision === Number.MAX_SAFE_INTEGER
    )
      return null;
    const facts = protection?.facts ?? [];
    let attempt = protection?.latestAttempt ?? null;
    let slot: ProtectionFact["slot"];
    let nativeEvent: ProtectionFact["nativeEvent"] = null;
    let cause: ProtectionFact["cause"] = "none";
    let categories = facts.at(-1)?.categories;
    if (command.kind === "preflight_failure") {
      const reservation = preflightReceipts.get(command.receipt);
      if (
        reservation === undefined ||
        reservation !== activePreflight ||
        reservation.state !== "observed" ||
        !samePreflightDevice(reservation) ||
        !canReserveProtectionAttempt(command.attemptId)
      )
        return null;
      attempt = {
        attemptId: command.attemptId,
        scope: reservation.scope,
        phase: "failed",
        nativeDisposition: "not_started",
        nativeSequence: null,
        cleanup: "pending",
        abandonment: "none",
      };
      categories = command.categories;
      cause = command.cause;
      slot = "failure";
    } else if (command.kind === "engaging") {
      if (
        !canSupersedeLatest() ||
        !isCurrentAdmission(command.authority) ||
        (activePreflight !== null &&
          (activePreflight.state !== "reserved" ||
            activePreflight.receipt.attemptId !== command.attemptId ||
            !sameScope(activePreflight.scope, command.authority.scope) ||
            !samePreflightDevice(activePreflight))) ||
        facts.length > protectionFactCapacity - protectionFactReservation ||
        facts.some((fact) => fact.attemptId === command.attemptId)
      )
        return null;
      if (command.categories.aac.status === "confirmed") return null;
      attempt = {
        attemptId: command.attemptId,
        scope: command.authority.scope,
        phase: "engaging",
        nativeDisposition: "pending",
        nativeSequence: null,
        cleanup: "not_requested",
        abandonment: "none",
      };
      categories = command.categories;
      slot = "engaging";
    } else {
      // A recovered prior owner is historical. This process cannot turn its
      // old terminal or unknown disposition into a new lifecycle/cleanup fact.
      if (
        attempt === null ||
        attempt.attemptId !== command.attemptId ||
        priorBootRecovered(protection ?? null, command.attemptId)
      )
        return null;
      const oldFact = (wanted: ProtectionFact["slot"]) =>
        facts.find(
          (fact) =>
            fact.attemptId === command.attemptId && fact.slot === wanted,
        );
      // Failure-first attempts never entered native engagement. Their only
      // continuation is this process's acknowledged disposal and cleanup.
      if (
        oldFact("engaging") === undefined &&
        command.kind !== "disposed_without_terminal_observation"
      )
        return null;
      switch (command.kind) {
        case "locked":
          if (
            attempt.phase !== "engaging" ||
            attempt.nativeDisposition !== "active" ||
            attempt.nativeSequence !== command.nativeSequence ||
            !isCurrentAdmission(command.authority) ||
            !sameScope(attempt.scope, command.authority.scope) ||
            !Object.values(command.categories).every(
              (category) => category.status === "confirmed",
            )
          )
            return null;
          attempt = { ...attempt, phase: "locked" };
          categories = command.categories;
          slot = "locked";
          break;
        case "began": {
          const previous = oldFact("began");
          if (previous !== undefined)
            return previous.nativeSequence === command.event.sequence
              ? protection!
              : null;
          if (
            attempt.nativeDisposition === "ended" ||
            attempt.nativeDisposition === "failed_to_begin" ||
            attempt.nativeDisposition ===
              "disposed_without_terminal_observation" ||
            command.event.sequence <= (attempt.nativeSequence ?? 0)
          )
            return null;
          attempt = {
            ...attempt,
            nativeDisposition: "active",
            nativeSequence: command.event.sequence,
          };
          nativeEvent = "did_begin";
          slot = "began";
          break;
        }
        case "native_terminal": {
          const previous = oldFact("native_terminal");
          if (previous !== undefined)
            return previous.nativeSequence === command.event.sequence &&
              previous.nativeEvent === command.event.type
              ? protection!
              : null;
          if (
            command.event.sequence <= (attempt.nativeSequence ?? 0) ||
            (command.event.type === "failed_to_begin" &&
              oldFact("began") !== undefined)
          )
            return null;
          attempt = {
            ...attempt,
            phase:
              command.event.type === "failed_to_begin" ? "failed" : "ending",
            nativeDisposition:
              command.event.type === "did_end" ? "ended" : "failed_to_begin",
            nativeSequence: command.event.sequence,
            cleanup: "pending",
          };
          nativeEvent = command.event.type;
          slot = "native_terminal";
          break;
        }
        case "ending":
          if (oldFact("end_requested") !== undefined) return protection!;
          if (
            attempt.cleanup === "complete" ||
            attempt.nativeDisposition === "ended" ||
            attempt.nativeDisposition === "failed_to_begin"
          )
            return null;
          attempt = { ...attempt, phase: "ending", cleanup: "pending" };
          cause = command.cause;
          slot = "end_requested";
          break;
        case "failure":
          if (oldFact("failure") !== undefined) return protection!;
          attempt = {
            ...attempt,
            phase: "recovery_required",
            cleanup: "unconfirmed",
          };
          cause = command.cause;
          slot = "failure";
          break;
        case "abandoned":
          if (command.cause !== "emergency_abandonment") return null;
          if (oldFact("abandoned") !== undefined) return protection!;
          attempt = {
            ...attempt,
            phase: "recovery_required",
            abandonment: "requested",
          };
          cause = command.cause;
          slot = "abandoned";
          break;
        case "disposed_without_terminal_observation":
          if (
            nativeOwnershipUncertain ||
            !ownedProtectionAttempts.has(command.attemptId) ||
            oldFact("native_terminal") !== undefined
          )
            return null;
          if (oldFact("cleanup") !== undefined)
            return attempt.nativeDisposition ===
              "disposed_without_terminal_observation" &&
              attempt.cleanup === "complete"
              ? protection!
              : null;
          attempt = {
            ...attempt,
            phase: "failed",
            nativeDisposition: "disposed_without_terminal_observation",
            cleanup: "complete",
          };
          slot = "cleanup";
          break;
        case "cleanup":
          if (command.outcome === "complete") {
            if (
              attempt.nativeDisposition !== "ended" &&
              attempt.nativeDisposition !== "failed_to_begin"
            )
              return null;
            if (oldFact("cleanup") !== undefined) return protection!;
            attempt = {
              ...attempt,
              phase: attempt.nativeDisposition === "ended" ? "ended" : "failed",
              cleanup: "complete",
            };
            slot = "cleanup";
          } else {
            if (attempt.cleanup === "complete") return null;
            if (
              attempt.cleanup === "unconfirmed" &&
              oldFact("failure") !== undefined
            )
              return protection!;
            attempt = {
              ...attempt,
              phase: "recovery_required",
              cleanup: "unconfirmed",
            };
            if (oldFact("failure") !== undefined)
              return {
                ...protection!,
                revision: revision + 1,
                latestAttempt: attempt,
              };
            cause = "persistence_unavailable";
            slot = "failure";
          }
          break;
      }
    }
    if (
      categories === undefined ||
      facts.length >= protectionFactCapacity ||
      (protection?.nextFactSequence ?? 1) === Number.MAX_SAFE_INTEGER
    )
      return null;
    const fact: ProtectionFact = {
      sequence: protection?.nextFactSequence ?? 1,
      eventId: requestId(),
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      policyVersion: 1,
      slot,
      phase: attempt.phase,
      nativeEvent,
      nativeSequence: attempt.nativeSequence,
      categories,
      cause,
    };
    return {
      policyVersion: 1,
      revision: revision + 1,
      latestAttempt: attempt,
      nextFactSequence: fact.sequence + 1,
      facts: [...facts, fact],
      localBootRecovery:
        command.kind === "engaging"
          ? {
              ...(protection?.localBootRecovery ?? emptyLocalBootRecovery()),
              anchors: [
                ...(protection?.localBootRecovery.anchors ?? []),
                {
                  attemptId: command.attemptId,
                  engagingBootSessionId: command.engagingBootSessionId,
                  observation: null,
                },
              ],
            }
          : (protection?.localBootRecovery ?? emptyLocalBootRecovery()),
    };
  }

  async function commitProtectionTransitionOwned(
    input: ProtectionTransition,
  ): ReturnType<StudentProtectionAccess["commitProtectionTransition"]> {
    const command = parseProtectionTransition(input);
    if (command === null || stopping) return { status: "unavailable" };
    const preflight =
      command.kind === "preflight_failure"
        ? observePreflightFailure(command)
        : null;
    if (command.kind === "preflight_failure" && preflight === null)
      return { status: "unavailable" };
    if (
      command.kind === "abandoned" &&
      command.cause === "emergency_abandonment" &&
      record?.nativeProtection?.latestAttempt?.attemptId ===
        command.attemptId &&
      record.nativeProtection.revision === command.expectedProtectionRevision &&
      !priorBootRecovered(record.nativeProtection, command.attemptId) &&
      record.nativeProtection.facts.some(
        (fact) =>
          fact.attemptId === command.attemptId && fact.slot === "engaging",
      )
    )
      invalidateAdmission();
    while (active !== null) await active;
    if (stopping || !options.transport.isIdle())
      return { status: "unavailable" };
    let result: Awaited<
      ReturnType<StudentProtectionAccess["commitProtectionTransition"]>
    > = { status: "unavailable" };
    await run(async (generation) => {
      if (preflight !== null) {
        // Reuse the exact v4 uncertain-write reconciliation. Never construct a
        // second first fact or overwrite a newer maintenance counter on retry.
        if (needsReload && !(await load(generation))) return;
        if (!alive(generation)) return;
        if (hasDurablePreflightOrigin(preflight)) {
          settlePreflightReservation();
          result = {
            status: "committed",
            protectionRevision: record!.nativeProtection!.revision,
          };
          return;
        }
      }
      const next = protectionSuccessor(command);
      if (next === null || record === null) return;
      // Retain ownership even if the barrier outcome is uncertain. Only this
      // process can later prove disposal of the attempt it actually authored.
      if (command.kind === "engaging" || command.kind === "preflight_failure")
        ownedProtectionAttempts.add(command.attemptId);
      if (command.kind === "engaging" && activePreflight !== null)
        activePreflight.state = "engaging";
      let nextRecord: StudentSessionSuccessor = {
        ...successor(record),
        nativeProtection: next,
      };
      if (
        (command.kind === "engaging" || command.kind === "preflight_failure") &&
        next !== record.nativeProtection
      ) {
        nextRecord = {
          ...nextRecord,
          evidence: {
            ...nextRecord.evidence,
            origins: [
              ...nextRecord.evidence.origins,
              {
                attemptId: command.attemptId,
                scope:
                  command.kind === "engaging"
                    ? command.authority.scope
                    : preflight!.scope,
                originalKeyThumbprint: record.device.keyThumbprint,
                originBuild,
              },
            ],
          },
        };
        nextRecord = pruneNativeEvidence(nextRecord);
      }
      if (
        next !== record.nativeProtection &&
        !(await write(nextRecord, generation))
      )
        return;
      if (
        !alive(generation) ||
        ((command.kind === "engaging" || command.kind === "locked") &&
          !isCurrentAdmission(command.authority))
      )
        return;
      result = { status: "committed", protectionRevision: next.revision };
    });
    return result;
  }

  async function commitProtectionTransition(
    input: ProtectionTransition,
  ): ReturnType<StudentProtectionAccess["commitProtectionTransition"]> {
    priorityWaiters += 1;
    try {
      return await commitProtectionTransitionOwned(input);
    } finally {
      priorityWaiters -= 1;
    }
  }

  async function commitBootRecovery(
    input: BootRecoveryCommand,
  ): ReturnType<StudentProtectionAccess["commitBootRecovery"]> {
    const command = parseBootRecoveryCommand(input);
    if (
      command === null ||
      stopping ||
      recordRecoveryRejected ||
      recoveryLatched
    )
      return { status: "unavailable" };
    let result: Awaited<
      ReturnType<StudentProtectionAccess["commitBootRecovery"]>
    > = {
      status: "unavailable",
    };
    await runPriority(async (generation) => {
      if (recordRecoveryRejected || recoveryLatched) return;
      // Reuse the writer's exact preimage/postimage reconciliation before
      // considering the local proof. A third image never becomes a new baseline.
      if ((!firstRecordLoaded || needsReload) && !(await load(generation)))
        return;
      if (
        !alive(generation) ||
        record === null ||
        recordRecoveryRejected ||
        recoveryLatched
      )
        return;
      const protection = record.nativeProtection;
      const latest = protection?.latestAttempt;
      if (
        protection === null ||
        latest == null ||
        latest.attemptId !== command.attemptId ||
        latest.attemptId !== priorProcessAttemptId ||
        ownedProtectionAttempts.has(command.attemptId)
      )
        return;
      const local = protection.localBootRecovery;
      const anchor = local.anchors.find(
        (value) => value.attemptId === command.attemptId,
      );
      if (anchor === undefined) return;
      if (anchor.observation !== null) {
        if (
          anchor.observation.observedBootSessionId !==
          command.observedBootSessionId
        ) {
          recoveryLatched = true;
          invalidateAdmission();
          publish("recovery_required");
          return;
        }
        if (
          command.expectedProtectionRevision < Number.MAX_SAFE_INTEGER &&
          protection.revision === command.expectedProtectionRevision + 1
        )
          result = {
            status: "committed",
            protectionRevision: protection.revision,
          };
        return;
      }
      if (
        !nativeOwnershipUncertain ||
        unanchoredPriorBarrier ||
        canSupersedeLatest() ||
        anchor.engagingBootSessionId === command.observedBootSessionId ||
        protection.revision !== command.expectedProtectionRevision ||
        protection.revision === Number.MAX_SAFE_INTEGER ||
        local.nextObservationSequence === Number.MAX_SAFE_INTEGER
      )
        return;
      const next: StudentSessionSuccessor = {
        ...successor(record),
        nativeProtection: {
          ...protection,
          revision: protection.revision + 1,
          localBootRecovery: {
            ...local,
            nextObservationSequence: local.nextObservationSequence + 1,
            anchors: local.anchors.map((value) =>
              value !== anchor
                ? value
                : {
                    ...value,
                    observation: {
                      sequence: local.nextObservationSequence,
                      basis: "boot_session_changed",
                      observedBootSessionId: command.observedBootSessionId,
                    },
                  },
            ),
          },
        },
      };
      if (!(await write(next, generation)) || !alive(generation)) return;
      // No historical fact, counter, disposition or cleanup changed. Publishing
      // only lets main reconstruct the exact local barrier after durability.
      publish(view.phase);
      if (alive(generation))
        result = {
          status: "committed",
          protectionRevision: protection.revision + 1,
        };
    });
    return result;
  }

  return {
    initialize: () =>
      runPriority(async (generation) => {
        if (!initialized) await load(generation);
      }),
    joinInitial: (code) =>
      runPriority(async (generation, signal) => {
        const parsedCode = parseStudentJoinCode(code);
        if (
          !initialized ||
          needsReload ||
          recoveryLatched ||
          !canSupersedeLatest() ||
          activePreflight !== null ||
          view.phase !== "entry" ||
          (record !== null && !canReplaceInitialJoin(record)) ||
          parsedCode === null
        )
          return;
        const next: StudentSessionSuccessor = {
          version: 5,
          apiOrigin: options.apiOrigin,
          device: record?.device ?? options.crypto.createEnrollment(),
          current: null,
          pending: {
            kind: "join",
            admissionMode: "initial",
            outcome: "not_dispatched",
            requestId: requestId(),
            joinCode: parsedCode,
            candidates: options.crypto.createCandidates(),
          },
          lastReservedCounter: 0,
          terminal: false,
          nativeProtection: null,
          evidence: emptyNativeEvidence(),
        };
        publish("joining");
        if (await write(next, generation))
          await attemptJoin(generation, signal);
      }),
    beginTargetedReadmission: (code, snapshotRevision) =>
      runPriority(async (generation, signal) => {
        const parsedCode = parseStudentJoinCode(code);
        if (
          !initialized ||
          recordRecoveryRejected ||
          recoveryLatched ||
          nativeOwnershipUncertain ||
          unanchoredPriorBarrier ||
          activePreflight !== null ||
          view.revision !== snapshotRevision ||
          !["recovery_required", "unavailable", "forfeited"].includes(
            view.phase,
          ) ||
          parsedCode === null
        )
          return;
        if (!maySupersedeLatest(record?.nativeProtection ?? null)) return;
        invalidateAdmission();
        if (
          needsReload &&
          !(await load(generation)) &&
          view.phase !== "recovery_required"
        )
          return;
        if (
          !canSupersedeLatest() ||
          activePreflight !== null ||
          !maySupersedeLatest(record?.nativeProtection ?? null)
        )
          return;
        const retainedProtection = record?.nativeProtection ?? null;
        const retainedEvidence =
          record === null
            ? emptyNativeEvidence()
            : retainNativeEvidenceSigner(record);
        if (retainedEvidence === null) {
          evidenceCapacityBlocked = true;
          notifyDelivery();
          return;
        }
        // Deliberate recovery is the only path that may replace local identity;
        // the targeted server material still selects the existing StudentSession.
        try {
          storeGeneration =
            await options.store.preserveForTargetedRecovery(storeGeneration);
        } catch {
          needsReload = true;
          throw new Error("Student recovery preservation unavailable");
        }
        if (!alive(generation)) return;
        record = null;
        attemptedWrite = null;
        capabilityDeadline = 0;
        const next: StudentSessionSuccessor = {
          version: 5,
          apiOrigin: options.apiOrigin,
          device: options.crypto.createEnrollment(),
          current: null,
          pending: {
            kind: "join",
            admissionMode: "readmission",
            outcome: "uncertain",
            requestId: requestId(),
            joinCode: parsedCode,
            candidates: options.crypto.createCandidates(),
          },
          lastReservedCounter: 0,
          terminal: false,
          nativeProtection: retainedProtection,
          evidence: retainedEvidence,
        };
        publish("joining");
        if (await write(next, generation))
          await attemptJoin(generation, signal);
      }),
    retryPending: () => runPriority(retry, { sequence: null, receipt: null }),
    refresh: () =>
      runPriority(
        async (generation, signal) => {
          if (recoveryLatched || recordRecoveryRejected) return;
          if ((!initialized || needsReload) && !(await load(generation)))
            return;
          if (record?.pending != null) return; // Only explicit retry resubmits intent.
          await attemptMaintenance(generation, signal, false);
        },
        { sequence: null, receipt: null },
      ),
    forfeit: (snapshotRevision) =>
      runPriority(async (generation, signal) => {
        if (
          view.revision !== snapshotRevision ||
          view.phase !== "active" ||
          record?.current == null ||
          record.pending !== null
        )
          return;
        invalidateAdmission();
        const pending: PendingStudentIntent = {
          kind: "forfeit",
          requestId: requestId(),
          expectedSessionRevision: record.current.sessionRevision,
        };
        if (await write({ ...successor(record), pending }, generation))
          await attemptMaintenance(generation, signal, true);
      }),
    readView: () => view,
    flushEvidence,
    readProtectionContext() {
      expireObservation();
      const admission = captureAdmission();
      return Object.freeze({
        admission,
        freshAdmission:
          issuedAdmission !== null &&
          isCurrentAdmission(issuedAdmission, "sustain")
            ? issuedAdmission
            : null,
        observationSequence,
        protection: record?.nativeProtection ?? null,
        delivery: deliveryState(),
        bootRecovery: bootRecoveryState(),
        maySupersedeLatest: canSupersedeLatest(),
      });
    },
    readFreshAdmission,
    isCurrentAdmission,
    reservePreflightReport,
    releasePreflightReport,
    subscribeAdmissionObservation(listener) {
      admissionListeners.add(listener);
      return () => {
        admissionListeners.delete(listener);
      };
    },
    commitProtectionTransition,
    commitBootRecovery,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      if (stopping) return false;
      stopping = true;
      lifetime += 1;
      invalidateAdmission();
      admissionListeners.clear();
      listeners.clear();
      abort?.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        (active ?? Promise.resolve()).then(async () => {
          await options.transport.drain();
          return true;
        }),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            options.drainTimeoutMs ?? 12_000,
          );
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (!drained) return false;
      try {
        await options.store.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}
