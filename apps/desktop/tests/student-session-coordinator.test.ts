import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudentSessionCoordinator } from "../src/main/student-session-coordinator.js";
import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  type NativeStudentRecordHandle,
  type StudentSessionRecord,
} from "../src/main/student-session-store.js";
import {
  createStudentSessionTransport,
  type StudentSessionFetch,
} from "../src/main/student-session-transport.js";
import type { ProtectionCategories } from "../src/main/assessment-protection-types.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:43175",
} as const;
const code = "0123456789AB";
const unavailable = {
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
};

function harness() {
  const crypto = createStudentSessionCrypto(configuration);
  let bytes: Buffer | null = null;
  const preserved: Buffer[] = [];
  let elapsed = 0;
  let writes = 0;
  let failWrite = 0;
  let failAfterPublication = false;
  let droppedJoin = false;
  let denied = false;
  let block: Promise<void> | null = null;
  let blockedFetch: Promise<Response> | null = null;
  let quarantineFailsOnce = false;
  let writeLatency = 0;
  let fetchLatency = 0;
  let beforeResponse: ((route: string) => Promise<void>) | null = null;
  const events: string[] = [];
  const requests: {
    route: string;
    body: Record<string, unknown>;
    durable: StudentSessionRecord;
  }[] = [];
  const decode = (): StudentSessionRecord =>
    JSON.parse(bytes?.toString().slice(10) ?? "null") as StudentSessionRecord;
  const native: NativeStudentRecordHandle = {
    async loadEncryptedRecord() {
      events.push("load");
      if (bytes === null && preserved.length)
        throw new Error("STORE_RECOVERY_REQUIRED");
      return bytes === null ? null : Buffer.from(bytes);
    },
    async replaceEncryptedRecord(value) {
      writes += 1;
      events.push(`write:${writes}`);
      if (block !== null) await block;
      elapsed += writeLatency;
      if (writes === failWrite && !failAfterPublication)
        throw new Error("barrier");
      bytes = Buffer.from(value);
      if (writes === failWrite) throw new Error("barrier");
      events.push(`barrier:${writes}`);
    },
    async quarantineEncryptedRecord() {
      if (quarantineFailsOnce) {
        quarantineFailsOnce = false;
        throw new Error("quarantine temporarily unavailable");
      }
      if (bytes !== null) preserved.push(Buffer.from(bytes));
      bytes = null;
      events.push("quarantine-barrier");
    },
    async close() {
      events.push("close");
    },
  };
  const store = createStudentSessionStore({
    apiOrigin: configuration.url,
    openNativeStore: async () => {
      events.push("lock");
      return native;
    },
    codec: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`synthetic:${s}`),
      decryptString: (b) => {
        if (!b.toString().startsWith("synthetic:")) throw new Error("corrupt");
        return b.toString().slice(10);
      },
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  });
  let joinReceipt: Record<string, unknown> | null = null;
  const fetchRequest: StudentSessionFetch = async (url, init) => {
    const route = String(url).split("-").at(-1) ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const durable = decode();
    expect(durable).not.toBeNull();
    expect(
      events.at(-1)?.startsWith("barrier:") ||
        events.at(-1) === "http:challenge",
    ).toBe(true);
    events.push(`http:${route}`);
    requests.push({ route, body, durable });
    if (blockedFetch !== null) return blockedFetch;
    await beforeResponse?.(route);
    elapsed += fetchLatency;
    if (denied)
      return Response.json(
        { status: "denied", code: "STUDENT_SESSION_DENIED" },
        { status: 403 },
      );
    const serverNowMs = 1_000_000 + elapsed;
    if (route === "challenge")
      return Response.json({
        challengeId: "10000000-0000-4000-8000-000000000099",
        expiresAtMs: serverNowMs + 15_000,
      });
    if (route === "join") {
      const pending = durable.pending;
      if (pending?.kind !== "join")
        throw new Error("pending join must precede HTTP");
      expect(body.requestId).toBe(pending.requestId);
      expect(body.deviceSessionId).toBe(durable.device.deviceSessionId);
      expect(body.capabilityDigest).toBe(pending.candidates.capabilityDigest);
      const logicalOperationDigest = crypto.digestLogicalOperation({
        kind: "join",
        admissionMode: pending.admissionMode,
        requestId: pending.requestId,
        deviceSessionId: durable.device.deviceSessionId,
        joinMaterialDigest: crypto.digestJoinCode(pending.joinCode),
        capabilityDigest: pending.candidates.capabilityDigest,
        reconnectDigest: pending.candidates.reconnectDigest,
      });
      joinReceipt ??= {
        status: "accepted",
        code: "STUDENT_SESSION_ACCEPTED",
        requestId: pending.requestId,
        logicalOperationDigest,
        scope: {
          schoolId: "30000000-0000-4000-8000-000000000001",
          testId: "40000000-0000-4000-8000-000000000001",
          studentSessionId: "50000000-0000-4000-8000-000000000001",
          deviceSessionId: durable.device.deviceSessionId,
          epoch: pending.admissionMode === "initial" ? 1 : 3,
        },
        sessionRevision: pending.admissionMode === "initial" ? 1 : 4,
        syntheticDisplayName: "Student ABC",
        serverNowMs,
        capabilityIssuedAtMs: serverNowMs,
        capabilityExpiresAtMs: serverNowMs + 300_000,
        reconnectExpiresAtMs: serverNowMs + 900_000,
        allowedIntents: ["state.read", "session.forfeit"],
      };
      if (droppedJoin) {
        droppedJoin = false;
        return Response.json(unavailable, { status: 503 });
      }
      return Response.json({ ...joinReceipt, serverNowMs });
    }
    const current = durable.current;
    if (current === null) throw new Error("current scope must precede HTTP");
    const proof = body.deviceProof as { counter: number };
    expect(proof.counter).toBe(durable.lastReservedCounter);
    if (route === "read")
      return Response.json({
        status: "accepted",
        code: "STUDENT_SESSION_CURRENT",
        requestId: body.requestId,
        acceptedProofCounter: proof.counter,
        scope: current.scope,
        sessionRevision: current.sessionRevision,
        syntheticDisplayName: current.syntheticDisplayName,
        testLifecycle: "open",
        state: "active",
        serverNowMs,
        capabilityExpiresAtMs: current.capabilityExpiresAtMs,
      });
    if (route === "forfeit")
      return Response.json({
        status: "accepted",
        code: "STUDENT_SESSION_FORFEITED",
        requestId: body.requestId,
        acceptedProofCounter: proof.counter,
      });
    const pending = durable.pending;
    if (pending?.kind !== "reconnect")
      throw new Error("pending rotation must precede HTTP");
    const logicalOperationDigest = crypto.digestLogicalOperation({
      kind: "reconnect",
      requestId: pending.requestId,
      scope: current.scope,
      expectedSessionRevision: pending.expectedSessionRevision,
      reconnectDigest: crypto.digestReconnectGrant(current.reconnectGrant),
      nextCapabilityDigest: pending.candidates.capabilityDigest,
      nextReconnectDigest: pending.candidates.reconnectDigest,
    });
    return Response.json({
      status: "accepted",
      code: "STUDENT_SESSION_ACCEPTED",
      requestId: pending.requestId,
      logicalOperationDigest,
      scope: current.scope,
      sessionRevision: pending.expectedSessionRevision + 1,
      syntheticDisplayName: current.syntheticDisplayName,
      serverNowMs,
      capabilityIssuedAtMs: serverNowMs,
      capabilityExpiresAtMs: serverNowMs + 300_000,
      reconnectExpiresAtMs: serverNowMs + 900_000,
      allowedIntents: ["state.read", "session.forfeit"],
      acceptedProofCounter: proof.counter,
    });
  };
  const transport = createStudentSessionTransport(configuration, fetchRequest);
  const options = {
    apiOrigin: configuration.url,
    store,
    crypto,
    transport,
    monotonicNow: () => elapsed,
    drainTimeoutMs: 20,
  };
  const coordinator = createStudentSessionCoordinator(options);
  return {
    coordinator,
    options,
    events,
    requests,
    preserved,
    record: decode,
    storedBytes: () => (bytes === null ? null : Buffer.from(bytes)),
    setBytes(value: Buffer) {
      bytes = value;
    },
    failNextWrite(after = false) {
      failWrite = writes + 1;
      failAfterPublication = after;
    },
    failAtWrite(n: number, after = false) {
      failWrite = n;
      failAfterPublication = after;
    },
    blockWrite(value: Promise<void>) {
      block = value;
    },
    blockFetch(value: Promise<Response> | null) {
      blockedFetch = value;
    },
    failQuarantineOnce() {
      quarantineFailsOnce = true;
    },
    dropJoinResponse() {
      droppedJoin = true;
    },
    deny() {
      denied = true;
    },
    advance(ms: number) {
      elapsed += ms;
    },
    now: () => elapsed,
    latency(write: number, fetch: number) {
      writeLatency = write;
      fetchLatency = fetch;
    },
    beforeResponse(callback: ((route: string) => Promise<void>) | null) {
      beforeResponse = callback;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const preflightCategories: ProtectionCategories = {
  aac: { status: "pending", code: "awaiting_native_begin" },
  shortcuts: { status: "confirmed", code: "none" },
  applications: { status: "confirmed", code: "none" },
  persistence: { status: "confirmed", code: "none" },
  windowNetwork: { status: "confirmed", code: "none" },
};
const lockedCategories: ProtectionCategories = {
  ...preflightCategories,
  aac: { status: "confirmed", code: "none" },
};
const attemptId = "60000000-0000-4000-8000-000000000001";
async function admitForProtection(f: ReturnType<typeof harness>) {
  await f.coordinator.initialize();
  await f.coordinator.joinInitial(code);
  const result = await f.coordinator.readFreshAdmission(
    f.coordinator.readProtectionContext().admission!,
  );
  if (result.status !== "fresh")
    throw new Error("Expected real admission read");
  return result.authority;
}

describe("single-writer native protection facts", () => {
  it("preserves admission/counter, rejects fabricated or stale grants, and records began before locked", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const before = f.record();
    const start = {
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    } as const;
    expect(
      await f.coordinator.commitProtectionTransition({
        ...start,
        authority: { ...authority },
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.record()).toEqual(before);
    expect(await f.coordinator.commitProtectionTransition(start)).toEqual({
      status: "committed",
      protectionRevision: 1,
    });
    expect(f.record().current).toEqual(before.current);
    expect(f.record().lastReservedCounter).toBe(before.lastReservedCounter);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "locked",
        attemptId,
        expectedProtectionRevision: 1,
        authority,
        nativeSequence: 1,
        categories: lockedCategories,
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "began",
        attemptId,
        expectedProtectionRevision: 1,
        event: { type: "did_begin", attemptId, sequence: 1, code: "none" },
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    const replacement = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    if (replacement.status !== "fresh")
      throw new Error("Expected post-begin read");
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "locked",
        attemptId,
        expectedProtectionRevision: 2,
        authority,
        nativeSequence: 1,
        categories: lockedCategories,
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "locked",
        attemptId,
        expectedProtectionRevision: 2,
        authority: replacement.authority,
        nativeSequence: 1,
        categories: lockedCategories,
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    expect(f.record().nativeProtection?.facts.map((fact) => fact.slot)).toEqual(
      ["engaging", "began", "locked"],
    );
    expect(f.record().lastReservedCounter).toBe(before.lastReservedCounter + 1);
  });

  it("queues a genuine terminal observation behind healthy maintenance and uses the latest reserved counter", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    await f.coordinator.commitProtectionTransition({
      kind: "began",
      attemptId,
      expectedProtectionRevision: 1,
      event: { type: "did_begin", attemptId, sequence: 1, code: "none" },
    });
    const gate = deferred();
    f.blockWrite(gate.promise);
    f.advance(15_000);
    const maintenance = f.coordinator.refresh();
    const terminal = f.coordinator.commitProtectionTransition({
      kind: "native_terminal",
      attemptId,
      expectedProtectionRevision: 2,
      event: { type: "did_end", attemptId, sequence: 2, code: "none" },
    });
    let settled = false;
    void terminal.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.record().nativeProtection?.facts.map((fact) => fact.slot)).toEqual(
      ["engaging", "began"],
    );
    gate.resolve();
    await maintenance;
    expect(await terminal).toEqual({
      status: "committed",
      protectionRevision: 3,
    });
    expect(f.record().lastReservedCounter).toBe(2);
    expect(f.record().nativeProtection?.latestAttempt).toMatchObject({
      nativeDisposition: "ended",
      cleanup: "pending",
    });
    expect(
      f.requests.filter((request) => request.route === "read"),
    ).toHaveLength(2);
  });

  it("retains actual end independently of cleanup and records it after terminal Student forfeit", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    expect(f.record().current).toBeNull();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "native_terminal",
        attemptId,
        expectedProtectionRevision: 1,
        event: { type: "did_end", attemptId, sequence: 2, code: "none" },
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    const immutable = f.record().nativeProtection!.facts;
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "cleanup",
        attemptId,
        expectedProtectionRevision: 2,
        outcome: "unconfirmed",
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    expect(f.record().nativeProtection?.latestAttempt).toMatchObject({
      nativeDisposition: "ended",
      cleanup: "unconfirmed",
      phase: "recovery_required",
    });
    expect(f.record().nativeProtection!.facts.slice(0, 2)).toEqual(immutable);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "cleanup",
        attemptId,
        expectedProtectionRevision: 3,
        outcome: "complete",
      }),
    ).toEqual({ status: "committed", protectionRevision: 4 });
    expect(f.record().terminal).toBe(true);
    expect(f.record().nativeProtection?.facts.map((fact) => fact.slot)).toEqual(
      ["engaging", "native_terminal", "failure", "cleanup"],
    );
  });

  it("keeps an uncertain journal write unavailable, reconciles the exact event once, and preserves counter high water", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const command = {
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    } as const;
    f.failNextWrite(true);
    expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
      status: "unavailable",
    });
    const persisted = f.record().nativeProtection!.facts[0];
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    await f.coordinator.retryPending();
    expect(f.record().nativeProtection!.facts).toHaveLength(1);
    expect(f.record().nativeProtection!.facts[0]).toEqual(persisted);
    expect(f.record().lastReservedCounter).toBe(3);
    expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
      status: "unavailable",
    });
  });

  it("loads valid unfinished protection without quarantine and never grants a new Start after restart", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    const restored = createStudentSessionCoordinator(f.options);
    await restored.initialize();
    expect(
      restored.readProtectionContext().protection?.latestAttempt?.phase,
    ).toBe("engaging");
    expect(f.preserved).toHaveLength(0);
    await restored.retryPending();
    const fresh = restored.readProtectionContext().freshAdmission!;
    expect(fresh).not.toBeNull();
    const beforeDisposal = f.record();
    expect(
      await restored.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 1,
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.record()).toEqual(beforeDisposal);
    expect(
      await restored.commitProtectionTransition({
        kind: "engaging",
        attemptId: "60000000-0000-4000-8000-000000000002",
        expectedProtectionRevision: 1,
        authority: fresh,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.record().nativeProtection!.facts).toHaveLength(1);
  });

  it("records trusted same-process disposal without inventing a terminal event and permits a fresh attempt", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    await f.coordinator.commitProtectionTransition({
      kind: "failure",
      attemptId,
      expectedProtectionRevision: 1,
      cause: "native_failure",
    });
    const history = f.record().nativeProtection!.facts;
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 2,
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    const protection = f.record().nativeProtection!;
    expect(protection.latestAttempt).toMatchObject({
      phase: "failed",
      nativeDisposition: "disposed_without_terminal_observation",
      nativeSequence: null,
      cleanup: "complete",
    });
    expect(protection.facts.slice(0, 2)).toEqual(history);
    expect(protection.facts.at(-1)).toMatchObject({
      slot: "cleanup",
      phase: "failed",
      nativeEvent: null,
      nativeSequence: null,
    });
    expect(
      protection.facts.some((fact) => fact.slot === "native_terminal"),
    ).toBe(false);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 3,
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    const fresh = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    if (fresh.status !== "fresh") throw new Error("Expected fresh retry read");
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        attemptId: "60000000-0000-4000-8000-000000000002",
        expectedProtectionRevision: 3,
        authority: fresh.authority,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "committed", protectionRevision: 4 });
    expect(f.record().nativeProtection!.facts.slice(0, 3)).toEqual(
      protection.facts,
    );
  });

  it("keeps disposal pending until its barrier and leaves an uncertain write unavailable", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    const gate = deferred();
    f.blockWrite(gate.promise);
    f.failNextWrite();
    const disposal = f.coordinator.commitProtectionTransition({
      kind: "disposed_without_terminal_observation",
      attemptId,
      expectedProtectionRevision: 1,
    });
    let settled = false;
    void disposal.then(() => {
      settled = true;
    });
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(
      f.coordinator.readProtectionContext().protection?.latestAttempt?.cleanup,
    ).toBe("not_requested");
    expect(f.record().nativeProtection!.facts).toHaveLength(1);
    gate.resolve();
    expect(await disposal).toEqual({ status: "unavailable" });
    expect(f.record().nativeProtection!.facts).toHaveLength(1);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        attemptId: "60000000-0000-4000-8000-000000000002",
        expectedProtectionRevision: 1,
        authority,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("cannot replace a genuine native terminal observation with a disposal-only outcome", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "native_terminal",
        attemptId,
        expectedProtectionRevision: 1,
        event: {
          type: "failed_to_begin",
          attemptId,
          sequence: 1,
          code: "native_failed_to_begin",
        },
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    const before = f.record();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 2,
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.record()).toEqual(before);
  });

  it("reserves all eight immutable slots per attempt and cannot reset capacity through targeted readmission", async () => {
    const f = harness();
    await admitForProtection(f);
    for (let index = 0; index < 4; index += 1) {
      if (index !== 0) await f.coordinator.retryPending();
      const authority = f.coordinator.readProtectionContext().freshAdmission!;
      const id = `60000000-0000-4000-8000-00000000000${index + 1}`;
      let revision =
        f.coordinator.readProtectionContext().protection?.revision ?? 0;
      const commands = [
        {
          kind: "engaging",
          attemptId: id,
          authority,
          categories: preflightCategories,
        },
        {
          kind: "began",
          attemptId: id,
          event: {
            type: "did_begin",
            attemptId: id,
            sequence: 1,
            code: "none",
          },
        },
        {
          kind: "locked",
          attemptId: id,
          authority,
          nativeSequence: 1,
          categories: lockedCategories,
        },
        { kind: "ending", attemptId: id, cause: "native_failure" },
        { kind: "failure", attemptId: id, cause: "native_failure" },
        { kind: "abandoned", attemptId: id, cause: "emergency_abandonment" },
        {
          kind: "native_terminal",
          attemptId: id,
          event: { type: "did_end", attemptId: id, sequence: 2, code: "none" },
        },
        { kind: "cleanup", attemptId: id, outcome: "complete" },
      ] as const;
      for (const command of commands) {
        expect(
          await f.coordinator.commitProtectionTransition({
            ...command,
            expectedProtectionRevision: revision,
          }),
        ).toEqual({ status: "committed", protectionRevision: revision + 1 });
        revision += 1;
      }
    }
    const history = f.record().nativeProtection!;
    expect(history.facts).toHaveLength(32);
    expect(new Set(history.facts.map((fact) => fact.eventId)).size).toBe(32);
    expect(history.facts.map((fact) => fact.sequence)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    await f.coordinator.retryPending();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        attemptId: "60000000-0000-4000-8000-000000000005",
        expectedProtectionRevision: history.revision,
        authority: f.coordinator.readProtectionContext().freshAdmission!,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "unavailable" });
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.record().nativeProtection).toEqual(history);
    expect(f.preserved).toHaveLength(1);
  });

  it("does not grant engaging after a successful but late durable write consumes the receipt deadline", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    f.latency(30_000, 0);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        attemptId,
        expectedProtectionRevision: 0,
        authority,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.record().nativeProtection?.latestAttempt?.phase).toBe("engaging");
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
  });
});

describe("private issued Student admission", () => {
  it("issues only after a real read and its barrier, before public listeners, and rejects copies", async () => {
    const f = harness();
    const order: string[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      order.push(value.status),
    );
    f.coordinator.subscribe(() => order.push("public"));
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    await f.coordinator.refresh();
    expect(f.requests.map((r) => r.route)).toEqual(["challenge", "join"]);
    const admission = f.coordinator.readProtectionContext().admission!;
    order.length = 0;
    const result = await f.coordinator.readFreshAdmission(admission);
    expect(result.status).toBe("fresh");
    if (result.status !== "fresh") throw new Error("Expected actual read");
    expect(order).toEqual(["fresh", "public"]);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(
      result.authority,
    );
    expect(f.coordinator.isCurrentAdmission(result.authority)).toBe(true);
    expect(f.coordinator.isCurrentAdmission({ ...result.authority })).toBe(
      false,
    );
    expect(Object.isFrozen(result.authority.scope)).toBe(true);
    expect(f.record().lastReservedCounter).toBe(1);
    expect(await f.coordinator.readFreshAdmission({ ...admission })).toEqual({
      status: "unavailable",
    });
  });

  it("delivers one identical receipt to coalesced callers and every ordinary delayed maintenance cycle", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.latency(50, 100);
    const observed: unknown[] = [];
    f.coordinator.subscribeAdmissionObservation((v) => {
      if (v.status === "fresh") observed.push(v.authority);
    });
    const admission = f.coordinator.readProtectionContext().admission!;
    const results = await Promise.all([
      f.coordinator.readFreshAdmission(admission),
      f.coordinator.readFreshAdmission(admission),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status === "fresh" && results[0].authority).toBe(
      observed[0],
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const old = f.coordinator.readProtectionContext().freshAdmission!;
      f.advance(15_000);
      expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(true);
      await f.coordinator.refresh();
      const next = f.coordinator.readProtectionContext().freshAdmission!;
      expect(next).not.toBe(old);
      expect(next.observationDeadline).toBe(next.readStartedAt + 30_000);
      expect(next.admissionGeneration).toBe(old.admissionGeneration);
      expect(f.coordinator.isCurrentAdmission(old)).toBe(false);
    }
    expect(observed).toHaveLength(4);
    expect(f.requests.filter((r) => r.route === "read")).toHaveLength(4);
  });

  it("uses the request start after reservation, not queue time or delayed publication, and expires at the exact bound", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.latency(20, 100);
    const start = f.now();
    const result = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    if (result.status !== "fresh") throw new Error("Expected actual read");
    expect(result.authority.readStartedAt).toBe(start + 20);
    expect(result.authority.observationDeadline).toBe(start + 30_020);
    f.advance(result.authority.observationDeadline - f.now() - 1);
    expect(f.coordinator.isCurrentAdmission(result.authority)).toBe(true);
    f.advance(1);
    expect(f.coordinator.isCurrentAdmission(result.authority, "sustain")).toBe(
      false,
    );
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
  });

  it("holds only the old sustain grant during same-admission renewal, then issues once after the follow-up read", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.advance(225_000);
    await f.coordinator.refresh();
    const old = f.coordinator.readProtectionContext().freshAdmission!;
    const hold = deferred();
    const entered = deferred();
    f.beforeResponse(async (route) => {
      if (route === "read") {
        entered.resolve();
        await hold.promise;
      }
    });
    f.advance(15_000);
    const renewal = f.coordinator.refresh();
    await entered.promise;
    expect(f.record().current?.sessionRevision).toBe(old.sessionRevision + 1);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(old);
    expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(true);
    expect(f.coordinator.isCurrentAdmission(old)).toBe(false);
    hold.resolve();
    await renewal;
    const current = f.coordinator.readProtectionContext().freshAdmission!;
    expect(current.admissionGeneration).toBe(old.admissionGeneration);
    expect(current.sessionRevision).toBe(old.sessionRevision + 1);
    expect(f.coordinator.isCurrentAdmission(current)).toBe(true);
    expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(false);
    expect(f.requests.slice(-2).map((r) => r.route)).toEqual([
      "reconnect",
      "read",
    ]);
  });

  it("invalidates before public denial and never issues on a read whose durability exceeds its budget", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    const order: string[] = [];
    f.coordinator.subscribeAdmissionObservation((v) => order.push(v.status));
    f.coordinator.subscribe(() => {
      order.push("public");
      expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
      throw new Error("listener");
    });
    f.deny();
    f.advance(15_000);
    await f.coordinator.refresh();
    expect(order).toEqual(["invalidated", "public"]);
    const late = harness();
    await late.coordinator.initialize();
    await late.coordinator.joinInitial(code);
    late.latency(30_000, 1);
    expect(
      await late.coordinator.readFreshAdmission(
        late.coordinator.readProtectionContext().admission!,
      ),
    ).toEqual({ status: "unavailable" });
    expect(late.coordinator.readProtectionContext().freshAdmission).toBeNull();
  });

  it("uses a sequence fence when pre-begin and post-begin read timestamps tie, sharing the one later read", async () => {
    const f = harness();
    await admitForProtection(f);
    const entered = deferred();
    const gate = deferred();
    let reads = 0;
    f.beforeResponse(async (route) => {
      if (route === "read" && reads++ === 0) {
        entered.resolve();
        await gate.promise;
      }
    });
    f.advance(15_000);
    const maintenance = f.coordinator.refresh();
    await entered.promise;
    const context = f.coordinator.readProtectionContext();
    const first = f.coordinator.readFreshAdmission(
      context.admission!,
      context.observationSequence,
    );
    const second = f.coordinator.readFreshAdmission(
      context.admission!,
      context.observationSequence,
    );
    gate.resolve();
    await maintenance;
    const [a, b] = await Promise.all([first, second]);
    if (a.status !== "fresh" || b.status !== "fresh")
      throw new Error("Expected fenced actual read");
    expect(a.authority).toBe(b.authority);
    expect(a.authority.observationSequence).toBe(
      context.observationSequence + 1,
    );
    expect(a.authority.readStartedAt).toBe(15_000);
    expect(
      f.requests.filter((request) => request.route === "read"),
    ).toHaveLength(3);
  });

  it("a failed renewal follow-up read never issues the newly persisted credential as fresh", async () => {
    const f = harness();
    await admitForProtection(f);
    f.advance(225_000);
    await f.coordinator.refresh();
    const old = f.coordinator.readProtectionContext().freshAdmission!;
    const observations: string[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      observations.push(value.status),
    );
    f.beforeResponse(async (route) => {
      if (route === "read") f.deny();
    });
    f.advance(15_000);
    await f.coordinator.refresh();
    expect(f.record().current?.sessionRevision).toBe(old.sessionRevision + 1);
    expect(observations).toEqual(["invalidated"]);
    expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(false);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
  });

  it("a held renewal read never extends the old observation and a disposed read cannot issue", async () => {
    const f = harness();
    await admitForProtection(f);
    f.advance(225_000);
    await f.coordinator.refresh();
    const old = f.coordinator.readProtectionContext().freshAdmission!;
    const entered = deferred();
    const gate = deferred();
    f.beforeResponse(async (route) => {
      if (route === "read") {
        entered.resolve();
        await gate.promise;
      }
    });
    f.advance(15_000);
    const maintenance = f.coordinator.refresh();
    await entered.promise;
    f.advance(old.observationDeadline - f.now());
    expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(false);
    gate.resolve();
    await maintenance;
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    const late = harness();
    await admitForProtection(late);
    const ready = deferred();
    const release = deferred();
    late.beforeResponse(async () => {
      ready.resolve();
      await release.promise;
    });
    const read = late.coordinator.readFreshAdmission(
      late.coordinator.readProtectionContext().admission!,
    );
    await ready.promise;
    const disposal = late.coordinator.dispose();
    release.resolve();
    expect(await read).toEqual({ status: "unavailable" });
    expect(await disposal).toBe(true);
    expect(late.coordinator.readProtectionContext().freshAdmission).toBeNull();
  });
});

describe("real desktop crypto/transport coordinator over synthetic private storage", () => {
  afterEach(() => vi.useRealTimers());
  it("persists exact bootstrap intent before both requests and never equates admission with native protection", async () => {
    const f = harness();
    await f.coordinator.initialize();
    expect(f.coordinator.readView().phase).toBe("entry");
    await f.coordinator.joinInitial(code);
    expect(f.requests.map((r) => r.route)).toEqual(["challenge", "join"]);
    expect(f.coordinator.readView()).toMatchObject({
      phase: "active",
      protection: "unavailable",
      calculatorEligible: false,
      pendingOperation: null,
    });
    const view = JSON.stringify(f.coordinator.readView());
    expect(view).not.toContain(f.record().device.privateKeyPkcs8);
    expect(view).not.toContain(f.record().current?.capabilityToken);
    expect(view).not.toContain(code);
  });

  it("failed first durable write emits zero HTTP and retry retains the same candidate/key/request", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.failNextWrite();
    await f.coordinator.joinInitial(code);
    expect(f.requests).toHaveLength(0);
    expect(f.coordinator.readView().phase).toBe("unconfirmed");
    await f.coordinator.retryPending();
    expect(f.requests.map((r) => r.route)).toEqual(["challenge", "join"]);
    expect(f.coordinator.readView().phase).toBe("active");
  });

  it("lost join response retries original logical request and candidates, with a fresh challenge proof only", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.dropJoinResponse();
    await f.coordinator.joinInitial(code);
    const pending = f.record();
    expect(f.coordinator.readView().phase).toBe("unconfirmed");
    await f.coordinator.retryPending();
    const joins = f.requests.filter((r) => r.route === "join");
    expect(joins).toHaveLength(2);
    expect(joins[1]?.durable.device).toEqual(pending.device);
    expect(joins[1]?.durable.pending).toEqual(pending.pending);
    expect(f.record().current?.capabilityToken).toBe(
      pending.pending?.kind === "join"
        ? pending.pending.candidates.capabilityToken
        : null,
    );
  });

  it("coalesces 15-second maintenance and follows a due rotation with one newly reserved read", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    await f.coordinator.refresh();
    expect(f.requests).toHaveLength(2);
    f.advance(15_000);
    await Promise.all([
      f.coordinator.refresh(),
      f.coordinator.refresh(),
      f.coordinator.refresh(),
    ]);
    expect(f.requests.map((r) => r.route)).toEqual([
      "challenge",
      "join",
      "read",
    ]);
    expect(f.record().lastReservedCounter).toBe(1);
    f.advance(225_000);
    await f.coordinator.refresh();
    expect(f.requests.map((r) => r.route)).toEqual([
      "challenge",
      "join",
      "read",
      "reconnect",
      "read",
    ]);
    expect(f.record().lastReservedCounter).toBe(3);
    expect(f.record().current?.sessionRevision).toBe(2);
  });

  it("a failed reservation emits zero maintenance HTTP, reloads published high water and reserves a greater counter", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.advance(15_000);
    f.failNextWrite(true);
    await f.coordinator.refresh();
    expect(f.requests).toHaveLength(2);
    expect(f.record().lastReservedCounter).toBe(1);
    await f.coordinator.retryPending();
    expect(f.requests.slice(-2).map((request) => request.route)).toEqual([
      "reconnect",
      "read",
    ]);
    expect(f.record().lastReservedCounter).toBe(3);
  });

  it("a failed promotion keeps original authority/pending or recovers the published successor without retrying the old join", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.failAtWrite(3, true);
    await f.coordinator.joinInitial(code);
    expect(f.coordinator.readView().phase).toBe("unconfirmed");
    const device = f.record().device;
    await f.coordinator.retryPending();
    expect(f.requests.map((r) => r.route)).toEqual([
      "challenge",
      "join",
      "reconnect",
      "read",
    ]);
    expect(f.record().device).toEqual(device);
    expect(f.coordinator.readView().phase).toBe("active");
  });

  it("generic denial exposes no invented end/removal/expiry reason and permits only explicit targeted recovery", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.deny();
    await f.coordinator.joinInitial(code);
    expect(f.coordinator.readView().phase).toBe("unavailable");
    const before = f.requests.length;
    await f.coordinator.joinInitial(code);
    expect(f.requests).toHaveLength(before);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.preserved).toHaveLength(1);
    expect(f.record().pending).toMatchObject({
      kind: "join",
      admissionMode: "readmission",
    });
    expect(JSON.stringify(f.coordinator.readView())).not.toMatch(
      /removed|ended|expired/,
    );
  });

  it("initial unreadable native uncertainty survives attempted targeted recovery, quit, and restart without replacement", async () => {
    const f = harness();
    const original = Buffer.from("opaque corrupt artifact");
    f.setBytes(original);
    await f.coordinator.initialize();
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    await f.coordinator.joinInitial(code);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision - 1,
    );
    expect(f.requests).toHaveLength(0);
    expect(f.preserved).toHaveLength(0);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.requests).toHaveLength(0);
    expect(f.preserved).toHaveLength(0);
    expect(f.events.some((event) => event.startsWith("write:"))).toBe(false);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    expect(await f.coordinator.dispose()).toBe(true);
    expect(f.storedBytes()).toEqual(original);
    const restarted = harness();
    restarted.setBytes(f.storedBytes()!);
    await restarted.coordinator.initialize();
    expect(restarted.coordinator.readView().phase).toBe("recovery_required");
    await restarted.coordinator.beginTargetedReadmission(
      code,
      restarted.coordinator.readView().revision,
    );
    await restarted.coordinator.joinInitial(code);
    expect(restarted.requests).toHaveLength(0);
    expect(restarted.preserved).toHaveLength(0);
    expect(restarted.events.some((event) => event.startsWith("write:"))).toBe(
      false,
    );
    expect(restarted.storedBytes()).toEqual(original);
    expect(restarted.coordinator.readProtectionContext().admission).toBeNull();
  });

  it("forfeit is revision-reviewed and durable before HTTP; acknowledgment promotes a terminal local record", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    await f.coordinator.forfeit(f.coordinator.readView().revision - 1);
    expect(f.requests).toHaveLength(2);
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    expect(f.requests.at(-1)?.durable.pending?.kind).toBe("forfeit");
    expect(f.record()).toMatchObject({
      terminal: true,
      current: null,
      pending: null,
    });
    expect(f.coordinator.readView().phase).toBe("forfeited");
  });

  it("shutdown fences the durable-write-to-fetch continuation and waits for the entire owned intent before close", async () => {
    const f = harness();
    await f.coordinator.initialize();
    let release: (() => void) | undefined;
    f.blockWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const joining = f.coordinator.joinInitial(code);
    await Promise.resolve();
    const disposal = f.coordinator.dispose();
    expect(f.events).not.toContain("close");
    release?.();
    await joining;
    expect(await disposal).toBe(true);
    expect(f.requests).toHaveLength(0);
    expect(f.events.at(-1)).toBe("close");
  });

  it("a failed drain retains the native lock until process exit", async () => {
    const f = harness();
    await f.coordinator.initialize();
    let release: (() => void) | undefined;
    f.blockWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const joining = f.coordinator.joinInitial(code);
    await Promise.resolve();
    expect(await f.coordinator.dispose()).toBe(false);
    expect(f.events).not.toContain("close");
    release?.();
    await joining;
    expect(f.requests).toHaveLength(0);
    expect(f.events).not.toContain("close");
  });

  it("waits for an abort-ignoring fetch to actually settle before releasing the native lock", async () => {
    const f = harness();
    await f.coordinator.initialize();
    let release: ((response: Response) => void) | undefined;
    f.blockFetch(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const joining = f.coordinator.joinInitial(code);
    await new Promise(setImmediate);
    expect(f.requests).toHaveLength(1);
    const disposal = f.coordinator.dispose();
    await joining; // The bounded caller has already observed cancellation.
    expect(f.events).not.toContain("close");
    release?.(Response.json(unavailable, { status: 503 }));
    expect(await disposal).toBe(true);
    expect(f.events.at(-1)).toBe("close");
  });

  it("does not close native storage when an abort-ignoring underlying fetch never settles", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.blockFetch(new Promise<Response>(() => undefined));
    const joining = f.coordinator.joinInitial(code);
    await new Promise(setImmediate);
    expect(f.requests).toHaveLength(1);
    expect(await f.coordinator.dispose()).toBe(false);
    await joining;
    expect(f.events).not.toContain("close");
  });

  it("blocks all store retries/reopen after a fetch deadline until underlying I/O settles, even with a queued write failure", async () => {
    vi.useFakeTimers();
    const f = harness();
    await f.coordinator.initialize();
    let release: ((response: Response) => void) | undefined;
    f.blockFetch(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const joining = f.coordinator.joinInitial(code);
    await vi.advanceTimersByTimeAsync(5_000);
    await joining;
    expect(f.requests).toHaveLength(1);
    const retained = structuredClone(f.record());
    const before = [...f.events];
    f.failNextWrite();
    await f.coordinator.retryPending();
    await f.coordinator.refresh();
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.events).toEqual(before);
    expect(f.record()).toEqual(retained);
    expect(f.events).not.toContain("close");
    release?.(Response.json(unavailable, { status: 503 }));
    f.blockFetch(null);
    await vi.advanceTimersByTimeAsync(0);
    await f.coordinator.retryPending(); // Only now may the queued write fail.
    expect(f.events).not.toContain("close");
    await f.coordinator.retryPending(); // Idle transport permits controlled reopen.
    expect(f.events).toContain("close");
    expect(f.requests.map((request) => request.route)).toEqual([
      "challenge",
      "challenge",
      "join",
    ]);
    expect(f.coordinator.readView().phase).toBe("active");
  });

  it("latches a mismatched uncertain readback through subsequent retry and refresh with zero write or HTTP", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    const previous = structuredClone(f.record());
    f.advance(15_000);
    f.failNextWrite(true);
    await f.coordinator.refresh();
    f.setBytes(
      Buffer.from(
        `synthetic:${JSON.stringify({ ...previous, generation: previous.generation + 4, lastReservedCounter: 7 })}`,
      ),
    );
    await f.coordinator.retryPending();
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    const events = [...f.events];
    const count = f.requests.length;
    await f.coordinator.retryPending();
    await f.coordinator.refresh();
    expect(f.events).toEqual(events);
    expect(f.requests).toHaveLength(count);
    expect(f.coordinator.readView()).toMatchObject({
      phase: "recovery_required",
      session: null,
    });
  });

  it("reopens after a once-failing quarantine of a known terminal record and preserves exact old bytes", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    const original = f.storedBytes();
    const requests = f.requests.length;
    f.failQuarantineOnce();
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.requests).toHaveLength(requests);
    await f.coordinator.retryPending();
    expect(f.coordinator.readView().phase).toBe("forfeited");
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.preserved).toEqual([original]);
    expect(f.requests.at(-1)?.body.admissionMode).toBe("readmission");
  });
});
