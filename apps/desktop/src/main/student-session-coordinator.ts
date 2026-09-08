import { randomUUID } from "node:crypto";

import {
  parseStudentJoinCode,
  type StudentJoinAccepted,
  type StudentJoinRequest,
  type StudentSessionScope,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

import type { StudentSessionCrypto } from "./student-session-crypto.js";
import type { StudentSessionTransport } from "./student-session-transport.js";
import {
  parseProtectionTransition,
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
export type FreshAdmissionResult =
  | { readonly status: "fresh"; readonly authority: FreshStudentAdmission }
  | { readonly status: "unavailable" };
export type StudentAdmissionObservation =
  | { readonly status: "fresh"; readonly authority: FreshStudentAdmission }
  | { readonly status: "invalidated" };
export interface StudentProtectionAccess {
  readProtectionContext(): {
    readonly admission: StudentAdmissionSnapshot | null;
    readonly freshAdmission: FreshStudentAdmission | null;
    readonly observationSequence: number;
    readonly protection: Readonly<StoredNativeProtection> | null;
  };
  readFreshAdmission(
    expected: StudentAdmissionSnapshot,
    afterObservationSequence?: number,
  ): Promise<FreshAdmissionResult>;
  isCurrentAdmission(
    receipt: FreshStudentAdmission,
    use?: "grant" | "sustain",
  ): boolean;
  subscribeAdmissionObservation(
    listener: (observation: StudentAdmissionObservation) => void,
  ): () => void;
  commitProtectionTransition(
    command: ProtectionTransition,
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
}): StudentSessionCoordinator {
  const now = options.monotonicNow ?? (() => performance.now());
  const requestId = options.requestId ?? randomUUID;
  let record: StudentSessionRecord | null = null;
  let storeGeneration = 0;
  let initialized = false;
  let needsReload = false;
  let recoveryLatched = false;
  let stopping = false;
  let lifetime = 0;
  let active: Promise<void> | null = null;
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
  let priorProcessUncertain = false;
  const ownedProtectionAttempts = new Set<string>();
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
      return true;
    } catch {
      needsReload = true;
      invalidateAdmission();
      throw new Error("Student session durability unavailable");
    }
  }

  async function load(generation: number): Promise<boolean> {
    const firstLoad = !initialized;
    invalidateAdmission();
    const loaded = await options.store.load();
    if (!alive(generation)) return false;
    initialized = true;
    if (loaded.kind === "unavailable") {
      publish("unavailable");
      return false;
    }
    if (loaded.kind === "recovery_required") {
      if (firstLoad) priorProcessUncertain = true;
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
    if (firstLoad) {
      const attempt = found?.nativeProtection?.latestAttempt;
      if (
        attempt != null &&
        !(
          attempt.cleanup === "complete" &&
          (attempt.nativeDisposition === "ended" ||
            attempt.nativeDisposition === "failed_to_begin" ||
            attempt.nativeDisposition ===
              "disposed_without_terminal_observation")
        )
      )
        priorProcessUncertain = true;
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
    publish(
      record?.terminal === true
        ? "forfeited"
        : record === null
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
      publish(resultPhase(challenge));
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
    const sentAt = now();
    if (!alive(generation)) return;
    const accepted = await options.transport.join(request, digest, signal);
    if (!alive(generation)) return;
    if (accepted.status !== "accepted") {
      publish(resultPhase(accepted));
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
    if (recoveryLatched) return;
    if ((!initialized || needsReload) && !(await load(generation))) return;
    if (record?.pending?.kind === "join") await attemptJoin(generation, signal);
    else await attemptMaintenance(generation, signal, true);
  }

  async function readFreshAdmission(
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

  function protectionSuccessor(
    command: ProtectionTransition,
  ): StoredNativeProtection | null {
    const protection = record?.nativeProtection;
    const revision = protection?.revision ?? 0;
    if (
      record === null ||
      needsReload ||
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
    if (command.kind === "engaging") {
      if (
        priorProcessUncertain ||
        !isCurrentAdmission(command.authority) ||
        facts.length > protectionFactCapacity - protectionFactReservation ||
        facts.some((fact) => fact.attemptId === command.attemptId) ||
        (attempt !== null &&
          !(
            attempt.cleanup === "complete" &&
            (attempt.nativeDisposition === "ended" ||
              attempt.nativeDisposition === "failed_to_begin" ||
              attempt.nativeDisposition ===
                "disposed_without_terminal_observation")
          ))
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
      if (attempt === null || attempt.attemptId !== command.attemptId)
        return null;
      const oldFact = (wanted: ProtectionFact["slot"]) =>
        facts.find(
          (fact) =>
            fact.attemptId === command.attemptId && fact.slot === wanted,
        );
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
            priorProcessUncertain ||
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
    };
  }

  async function commitProtectionTransition(
    input: ProtectionTransition,
  ): ReturnType<StudentProtectionAccess["commitProtectionTransition"]> {
    const command = parseProtectionTransition(input);
    if (command === null || stopping) return { status: "unavailable" };
    if (
      command.kind === "abandoned" &&
      command.cause === "emergency_abandonment" &&
      record?.nativeProtection?.latestAttempt?.attemptId ===
        command.attemptId &&
      record.nativeProtection.revision === command.expectedProtectionRevision
    )
      invalidateAdmission();
    while (active !== null) await active;
    if (stopping || !options.transport.isIdle())
      return { status: "unavailable" };
    let result: Awaited<
      ReturnType<StudentProtectionAccess["commitProtectionTransition"]>
    > = { status: "unavailable" };
    await run(async (generation) => {
      const next = protectionSuccessor(command);
      if (next === null || record === null) return;
      // Retain ownership even if the barrier outcome is uncertain. Only this
      // process can later prove disposal of the attempt it actually authored.
      if (command.kind === "engaging")
        ownedProtectionAttempts.add(command.attemptId);
      if (
        next !== record.nativeProtection &&
        !(await write(
          { ...successor(record), nativeProtection: next },
          generation,
        ))
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

  return {
    initialize: () =>
      run(async (generation) => {
        if (!initialized) await load(generation);
      }),
    joinInitial: (code) =>
      run(async (generation, signal) => {
        const parsedCode = parseStudentJoinCode(code);
        if (
          !initialized ||
          view.phase !== "entry" ||
          record !== null ||
          parsedCode === null
        )
          return;
        const next: StudentSessionSuccessor = {
          version: 2,
          apiOrigin: options.apiOrigin,
          device: options.crypto.createEnrollment(),
          current: null,
          pending: {
            kind: "join",
            admissionMode: "initial",
            requestId: requestId(),
            joinCode: parsedCode,
            candidates: options.crypto.createCandidates(),
          },
          lastReservedCounter: 0,
          terminal: false,
          nativeProtection: null,
        };
        publish("joining");
        if (await write(next, generation))
          await attemptJoin(generation, signal);
      }),
    beginTargetedReadmission: (code, snapshotRevision) =>
      run(async (generation, signal) => {
        const parsedCode = parseStudentJoinCode(code);
        if (
          !initialized ||
          priorProcessUncertain ||
          view.revision !== snapshotRevision ||
          !["recovery_required", "unavailable", "forfeited"].includes(
            view.phase,
          ) ||
          parsedCode === null
        )
          return;
        if (
          record?.nativeProtection?.latestAttempt != null &&
          record.nativeProtection.latestAttempt.cleanup !== "complete"
        )
          return;
        invalidateAdmission();
        if (
          needsReload &&
          !(await load(generation)) &&
          view.phase !== "recovery_required"
        )
          return;
        if (
          record?.nativeProtection?.latestAttempt != null &&
          record.nativeProtection.latestAttempt.cleanup !== "complete"
        )
          return;
        const retainedProtection = record?.nativeProtection ?? null;
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
        recoveryLatched = false;
        attemptedWrite = null;
        capabilityDeadline = 0;
        const next: StudentSessionSuccessor = {
          version: 2,
          apiOrigin: options.apiOrigin,
          device: options.crypto.createEnrollment(),
          current: null,
          pending: {
            kind: "join",
            admissionMode: "readmission",
            requestId: requestId(),
            joinCode: parsedCode,
            candidates: options.crypto.createCandidates(),
          },
          lastReservedCounter: 0,
          terminal: false,
          nativeProtection: retainedProtection,
        };
        publish("joining");
        if (await write(next, generation))
          await attemptJoin(generation, signal);
      }),
    retryPending: () => run(retry, { sequence: null, receipt: null }),
    refresh: () =>
      run(
        async (generation, signal) => {
          if (recoveryLatched) return;
          if ((!initialized || needsReload) && !(await load(generation)))
            return;
          if (record?.pending != null) return; // Only explicit retry resubmits intent.
          await attemptMaintenance(generation, signal, false);
        },
        { sequence: null, receipt: null },
      ),
    forfeit: (snapshotRevision) =>
      run(async (generation, signal) => {
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
      });
    },
    readFreshAdmission,
    isCurrentAdmission,
    subscribeAdmissionObservation(listener) {
      admissionListeners.add(listener);
      return () => {
        admissionListeners.delete(listener);
      };
    },
    commitProtectionTransition,
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
