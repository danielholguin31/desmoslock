import { randomUUID } from "node:crypto";

import {
  parseStudentJoinCode,
  type StudentJoinAccepted,
  type StudentJoinRequest,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

import type { StudentSessionCrypto } from "./student-session-crypto.js";
import type { StudentSessionTransport } from "./student-session-transport.js";
import type {
  PendingStudentIntent,
  StoredStudentAuthority,
  StudentSessionRecord,
  StudentSessionStore,
  StudentSessionSuccessor,
} from "./student-session-store.js";

export interface StudentSessionCoordinator {
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
  const listeners = new Set<(view: StudentSessionViewState) => void>();
  let view: StudentSessionViewState = Object.freeze({
    revision: 1,
    phase: "unavailable",
    session: null,
    protection: "unavailable",
    calculatorEligible: false,
    pendingOperation: null,
  });

  function publish(phase: StudentSessionViewState["phase"]): void {
    if (stopping) return;
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
    void pending.finally(() => {
      if (active === pending) {
        active = null;
        abort = null;
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
      throw new Error("Student session durability unavailable");
    }
  }

  async function load(generation: number): Promise<boolean> {
    const loaded = await options.store.load();
    if (!alive(generation)) return false;
    initialized = true;
    if (loaded.kind === "unavailable") {
      publish("unavailable");
      return false;
    }
    if (loaded.kind === "recovery_required") {
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

  async function attemptMaintenance(
    generation: number,
    signal: AbortSignal,
    force: boolean,
  ): Promise<void> {
    if (record?.current == null || record.terminal) return;
    if (!force && now() - lastMaintenanceAt < 15_000) return;
    lastMaintenanceAt = now();
    if (record.pending === null && capabilityDeadline - now() <= 60_000) {
      const pending: PendingStudentIntent = {
        kind: "reconnect",
        requestId: requestId(),
        expectedSessionRevision: record.current.sessionRevision,
        candidates: options.crypto.createCandidates(),
      };
      if (!(await write({ ...successor(record), pending }, generation))) return;
    }
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
      publish(capabilityDeadline > now() ? "active" : "unconfirmed");
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
    } else {
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
      if (result.status !== "accepted") {
        publish(resultPhase(result));
        return;
      }
      // Read cannot extend expiry. Persist only its authoritative revision/name;
      // the already reserved counter survives any lost read response.
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
      capabilityDeadline = Math.min(
        capabilityDeadline,
        sentAt + result.capabilityExpiresAtMs - result.serverNowMs,
      );
      publish(capabilityDeadline > now() ? "active" : "unconfirmed");
    }
  }

  async function retry(generation: number, signal: AbortSignal): Promise<void> {
    if (recoveryLatched) return;
    if ((!initialized || needsReload) && !(await load(generation))) return;
    if (record?.pending?.kind === "join") await attemptJoin(generation, signal);
    else await attemptMaintenance(generation, signal, true);
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
          version: 1,
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
          view.revision !== snapshotRevision ||
          !["recovery_required", "unavailable", "forfeited"].includes(
            view.phase,
          ) ||
          parsedCode === null
        )
          return;
        if (
          needsReload &&
          !(await load(generation)) &&
          view.phase !== "recovery_required"
        )
          return;
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
          version: 1,
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
        };
        publish("joining");
        if (await write(next, generation))
          await attemptJoin(generation, signal);
      }),
    retryPending: () => run(retry),
    refresh: () =>
      run(async (generation, signal) => {
        if (recoveryLatched) return;
        if ((!initialized || needsReload) && !(await load(generation))) return;
        if (record?.pending != null) return; // Only explicit retry resubmits intent.
        await attemptMaintenance(generation, signal, false);
      }),
    forfeit: (snapshotRevision) =>
      run(async (generation, signal) => {
        if (
          view.revision !== snapshotRevision ||
          view.phase !== "active" ||
          record?.current == null ||
          record.pending !== null
        )
          return;
        const pending: PendingStudentIntent = {
          kind: "forfeit",
          requestId: requestId(),
          expectedSessionRevision: record.current.sessionRevision,
        };
        if (await write({ ...successor(record), pending }, generation))
          await attemptMaintenance(generation, signal, true);
      }),
    readView: () => view,
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
