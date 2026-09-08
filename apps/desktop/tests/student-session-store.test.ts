import { describe, expect, it } from "vitest";

import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  parseProtectionTransition,
  protectionFactCapacity,
  protectionFactReservation,
  type FactSlot,
  type NativeStudentRecordHandle,
  type ProtectionFact,
  type ProtectionTransition,
  type StoredNativeProtection,
  type StoredNativeProtectionAttempt,
  type StudentSessionSuccessor,
} from "../src/main/student-session-store.js";
import type { FreshStudentAdmission } from "../src/main/student-session-coordinator.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:43175",
} as const;
const crypto = createStudentSessionCrypto(configuration);
const requestId = "10000000-0000-4000-8000-000000000001";

function pending(): StudentSessionSuccessor {
  return {
    version: 2,
    apiOrigin: configuration.url,
    device: crypto.createEnrollment(),
    current: null,
    pending: {
      kind: "join",
      admissionMode: "initial",
      requestId,
      joinCode: "0123456789AB",
      candidates: crypto.createCandidates(),
    },
    lastReservedCounter: 0,
    terminal: false,
    nativeProtection: null,
  };
}

const confirmedCategories = {
  aac: { status: "confirmed", code: "none" },
  shortcuts: { status: "confirmed", code: "none" },
  applications: { status: "confirmed", code: "none" },
  persistence: { status: "confirmed", code: "none" },
  windowNetwork: { status: "confirmed", code: "none" },
} as const;
const engagingCategories = {
  ...confirmedCategories,
  aac: { status: "pending", code: "awaiting_native_begin" },
} as const;
const identifier = (value: number) =>
  `20000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

function admitted(): StudentSessionSuccessor {
  const initial = pending();
  const candidates = crypto.createCandidates();
  return {
    ...initial,
    current: {
      scope: {
        schoolId: identifier(1),
        testId: identifier(2),
        studentSessionId: identifier(3),
        deviceSessionId: initial.device.deviceSessionId,
        epoch: 1,
      },
      sessionRevision: 3,
      syntheticDisplayName: "Student 0123456789AB",
      serverNowMs: 1_000,
      capabilityIssuedAtMs: 0,
      capabilityExpiresAtMs: 300_000,
      reconnectExpiresAtMs: 900_000,
      capabilityToken: candidates.capabilityToken,
      reconnectGrant: candidates.reconnectGrant,
    },
    pending: null,
    lastReservedCounter: 19,
  };
}

function protection(
  scope: StoredNativeProtectionAttempt["scope"],
  phase: "engaging" | "locked" | "ending" | "recovery_required" = "engaging",
): StoredNativeProtection {
  const attemptId = identifier(10);
  const first: ProtectionFact = {
    sequence: 1,
    eventId: identifier(101),
    attemptId,
    scope,
    policyVersion: 1,
    slot: "engaging",
    phase: "engaging",
    nativeEvent: null,
    nativeSequence: null,
    categories: engagingCategories,
    cause: "none",
  };
  const facts: ProtectionFact[] = [first];
  if (phase !== "engaging") {
    facts.push({
      ...first,
      sequence: 2,
      eventId: identifier(102),
      slot: "began",
      nativeEvent: "did_begin",
      nativeSequence: 1,
      categories: confirmedCategories,
    });
    facts.push({
      ...first,
      sequence: 3,
      eventId: identifier(103),
      slot: "locked",
      phase: "locked",
      nativeSequence: 1,
      categories: confirmedCategories,
    });
  }
  return {
    policyVersion: 1,
    revision: facts.length,
    latestAttempt: {
      attemptId,
      scope,
      phase,
      nativeDisposition: phase === "engaging" ? "pending" : "active",
      nativeSequence: phase === "engaging" ? null : 1,
      cleanup:
        phase === "ending"
          ? "pending"
          : phase === "recovery_required"
            ? "unconfirmed"
            : "not_requested",
      abandonment: "none",
    },
    nextFactSequence: facts.length + 1,
    facts,
  };
}

function completeJournal(
  scope: StoredNativeProtectionAttempt["scope"],
  count = 1,
): StoredNativeProtection {
  const facts: ProtectionFact[] = [];
  const slots: readonly FactSlot[] = [
    "engaging",
    "began",
    "locked",
    "abandoned",
    "end_requested",
    "failure",
    "native_terminal",
    "cleanup",
  ];
  let latestAttempt: StoredNativeProtectionAttempt | null = null;
  for (let attempt = 0; attempt < count; attempt += 1) {
    const attemptId = identifier(10 + attempt);
    for (const slot of slots) {
      const sequence = facts.length + 1;
      facts.push({
        sequence,
        eventId: identifier(100 + sequence),
        attemptId,
        scope,
        policyVersion: 1,
        slot,
        phase:
          slot === "engaging" || slot === "began"
            ? "engaging"
            : slot === "locked"
              ? "locked"
              : slot === "cleanup"
                ? "ended"
                : "ending",
        nativeEvent:
          slot === "began"
            ? "did_begin"
            : slot === "native_terminal"
              ? "did_end"
              : null,
        nativeSequence:
          slot === "engaging"
            ? null
            : slot === "native_terminal" || slot === "cleanup"
              ? 2
              : 1,
        categories:
          slot === "engaging" ? engagingCategories : confirmedCategories,
        cause:
          slot === "failure"
            ? "persistence_unavailable"
            : slot === "abandoned" || slot === "end_requested"
              ? "emergency_abandonment"
              : "none",
      });
    }
    latestAttempt = {
      attemptId,
      scope,
      phase: "ended",
      nativeDisposition: "ended",
      nativeSequence: 2,
      cleanup: "complete",
      abandonment: "requested",
    };
  }
  return {
    policyVersion: 1,
    revision: facts.length,
    latestAttempt,
    nextFactSequence: facts.length + 1,
    facts,
  };
}

function withProtection(
  phase: Parameters<typeof protection>[1] = "engaging",
): StudentSessionSuccessor {
  const record = admitted();
  if (record.current === null) throw new Error("fixture");
  return {
    ...record,
    nativeProtection: protection(record.current.scope, phase),
  };
}

function persisted(value: unknown): Buffer {
  return Buffer.from(`synthetic:${JSON.stringify(value)}`);
}

function fixture() {
  let bytes: Buffer | null = null;
  let writeFailure: "none" | "before" | "after" = "none";
  let quarantineFailure = false;
  let blockedWrite: Promise<void> | null = null;
  const preserved: Buffer[] = [];
  const events: string[] = [];
  const native: NativeStudentRecordHandle = {
    async loadEncryptedRecord() {
      events.push("load");
      if (bytes === null && preserved.length > 0)
        throw new Error("STORE_RECOVERY_REQUIRED");
      return bytes === null ? null : Buffer.from(bytes);
    },
    async replaceEncryptedRecord(value) {
      events.push("write");
      if (blockedWrite !== null) await blockedWrite;
      if (writeFailure === "before") throw new Error("before");
      bytes = Buffer.from(value);
      if (writeFailure === "after") throw new Error("after");
      events.push("barrier");
    },
    async quarantineEncryptedRecord() {
      events.push("quarantine");
      if (quarantineFailure) throw new Error("quarantine");
      if (bytes !== null) preserved.push(Buffer.from(bytes));
      bytes = null;
    },
    async close() {
      events.push("close");
    },
  };
  const options = {
    apiOrigin: configuration.url,
    openNativeStore: async () => {
      events.push("lock");
      return native;
    },
    codec: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => {
        events.push("encrypt");
        return Buffer.from(`synthetic:${value}`);
      },
      decryptString: (value: Buffer) => {
        events.push("decrypt");
        if (!value.toString().startsWith("synthetic:"))
          throw new Error("invalid");
        return value.toString().slice(10);
      },
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  };
  return {
    store: createStudentSessionStore(options),
    options,
    events,
    preserved,
    setBytes(value: Buffer) {
      bytes = value;
    },
    getBytes: () => (bytes === null ? null : Buffer.from(bytes)),
    fail(value: typeof writeFailure) {
      writeFailure = value;
    },
    failQuarantine() {
      quarantineFailure = true;
    },
    blockWrite(value: Promise<void>) {
      blockedWrite = value;
    },
  };
}

describe("private Student record durability adapter (synthetic codec/native)", () => {
  it("locks before loading or decrypting, writes one bounded encrypted successor, and reloads exact private intent", async () => {
    const f = fixture();
    expect(await f.store.load()).toEqual({ kind: "empty", generation: 0 });
    const intended = pending();
    const written = await f.store.commitDurably(0, intended);
    expect(written.generation).toBe(1);
    expect(f.events).toEqual(["lock", "load", "encrypt", "write", "barrier"]);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
    expect(f.events.indexOf("lock")).toBeLessThan(f.events.indexOf("decrypt"));
    await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
    expect(f.events.filter((v) => v === "write")).toHaveLength(1);
  });

  it.each(["before", "after"] as const)(
    "does not treat %s-publication failure or readback as a successful barrier",
    async (stage) => {
      const f = fixture();
      await f.store.load();
      const intended = pending();
      f.fail(stage);
      await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
      await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
      const loaded = await f.store.load();
      expect(loaded.kind).toBe(stage === "before" ? "empty" : "ready");
      const generation = loaded.kind === "ready" ? loaded.record.generation : 0;
      f.fail("none");
      await f.store.commitDurably(generation, intended);
      expect(f.events.filter((v) => v === "barrier")).toHaveLength(1);
      expect(f.events.filter((v) => v === "lock")).toHaveLength(2);
    },
  );

  it("rejects a second write and close while a complete native write is pending", async () => {
    const f = fixture();
    await f.store.load();
    let release: (() => void) | undefined;
    f.blockWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const first = f.store.commitDurably(0, pending());
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    await expect(f.store.close()).rejects.toThrow();
    expect(f.events).not.toContain("close");
    release?.();
    await first;
    await f.store.close();
    expect(f.events.at(-1)).toBe("close");
  });

  it("retains corrupt bytes and requires successful quarantine before targeted pending publication", async () => {
    const f = fixture();
    const corrupt = Buffer.from("unreadable-preserved-artifact");
    f.setBytes(corrupt);
    expect(await f.store.load()).toEqual({
      kind: "recovery_required",
      generation: 0,
    });
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    const nextGeneration = await f.store.preserveForTargetedRecovery(0);
    expect(f.preserved).toEqual([corrupt]);
    await expect(
      f.store.commitDurably(nextGeneration, pending()),
    ).rejects.toThrow();
    const next = pending();
    if (next.pending?.kind !== "join") throw new Error("fixture");
    const targeted = {
      ...next,
      pending: { ...next.pending, admissionMode: "readmission" as const },
    };
    await f.store.commitDurably(nextGeneration, targeted);
    expect(f.preserved).toEqual([corrupt]);
  });

  it("retains targeted-only recovery after the quarantine-to-pending crash gap", async () => {
    const f = fixture();
    f.setBytes(Buffer.from("corrupt"));
    await f.store.load();
    await f.store.preserveForTargetedRecovery(0);
    await f.store.close();
    const restarted = createStudentSessionStore(f.options);
    expect(await restarted.load()).toEqual({
      kind: "recovery_required",
      generation: 0,
    });
    await expect(restarted.commitDurably(0, pending())).rejects.toThrow();
  });

  it("failed quarantine preserves artifact and cannot open an initial-admission path", async () => {
    const f = fixture();
    const corrupt = Buffer.from("corrupt");
    f.setBytes(corrupt);
    await f.store.load();
    f.failQuarantine();
    await expect(f.store.preserveForTargetedRecovery(0)).rejects.toThrow();
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    expect(f.getBytes()).toEqual(corrupt);
  });

  it.each([
    "version",
    "origin",
    "key",
    "candidate",
    "extra",
    "counter",
    "mode",
  ])(
    "rejects noncanonical persisted %s without overwriting bytes",
    async (kind) => {
      const f = fixture();
      const base = { ...pending(), generation: 1 };
      const mutated =
        kind === "version"
          ? { ...base, version: 3 }
          : kind === "origin"
            ? { ...base, apiOrigin: "https://other.example" }
            : kind === "key"
              ? {
                  ...base,
                  device: { ...base.device, privateKeyPkcs8: "invalid" },
                }
              : kind === "candidate" && base.pending?.kind === "join"
                ? {
                    ...base,
                    pending: {
                      ...base.pending,
                      candidates: {
                        ...base.pending.candidates,
                        capabilityDigest: "0".repeat(64),
                      },
                    },
                  }
                : kind === "counter"
                  ? { ...base, lastReservedCounter: 1 }
                  : kind === "mode" && base.pending?.kind === "join"
                    ? {
                        ...base,
                        pending: {
                          ...base.pending,
                          admissionMode: "automatic",
                        },
                      }
                    : { ...base, extra: true };
      const original = Buffer.from(`synthetic:${JSON.stringify(mutated)}`);
      f.setBytes(original);
      expect((await f.store.load()).kind).toBe("recovery_required");
      expect(f.getBytes()).toEqual(original);
      expect(f.events).not.toContain("write");
    },
  );

  it("fails closed before record access when native lock or encryption is unavailable", async () => {
    const f = fixture();
    const noLock = createStudentSessionStore({
      ...f.options,
      openNativeStore: async () => {
        throw new Error("in use");
      },
    });
    expect((await noLock.load()).kind).toBe("unavailable");
    const noCodec = createStudentSessionStore({
      ...f.options,
      codec: { ...f.options.codec, isEncryptionAvailable: () => false },
    });
    expect((await noCodec.load()).kind).toBe("unavailable");
    expect(f.events).toEqual(["lock"]);
  });
});

describe("versioned native protection record (synthetic codec/native)", () => {
  it.each(["join", "active", "reconnect", "forfeit", "terminal"] as const)(
    "normalizes exact v1 %s without writing or changing identity, pending material or counters",
    async (kind) => {
      const f = fixture();
      let record = kind === "join" ? pending() : admitted();
      if (kind === "reconnect")
        record = {
          ...record,
          pending: {
            kind: "reconnect",
            requestId,
            expectedSessionRevision: 3,
            candidates: crypto.createCandidates(),
          },
        };
      if (kind === "forfeit")
        record = {
          ...record,
          pending: {
            kind: "forfeit",
            requestId,
            expectedSessionRevision: 3,
          },
        };
      if (kind === "terminal")
        record = { ...record, current: null, terminal: true };
      const legacy: Record<string, unknown> = {
        ...record,
        version: 1,
        generation: 41,
      };
      delete legacy.nativeProtection;
      const original = persisted(legacy);
      f.setBytes(original);
      const loaded = await f.store.load();
      expect(loaded).toEqual({
        kind: "ready",
        record: { ...record, generation: 41 },
      });
      expect(f.getBytes()).toEqual(original);
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
      if (loaded.kind !== "ready") throw new Error("fixture");
      const written = await f.store.commitDurably(41, loaded.record);
      expect(written).toEqual({ ...record, generation: 42 });
      expect(f.getBytes()).toEqual(persisted(written));
      expect(f.events.slice(-3)).toEqual(["encrypt", "write", "barrier"]);
    },
  );

  it.each(["v1-extra", "v1-native", "v2-missing-native", "future"] as const)(
    "preserves unsupported or inexact %s bytes for targeted recovery",
    async (kind) => {
      const f = fixture();
      const record: Record<string, unknown> = { ...pending(), generation: 7 };
      if (kind.startsWith("v1")) record.version = 1;
      if (kind === "v1-extra") {
        delete record.nativeProtection;
        record.extra = false;
      }
      if (kind === "v2-missing-native") delete record.nativeProtection;
      if (kind === "future") record.version = 3;
      const original = persisted(record);
      f.setBytes(original);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(original);
      expect(f.events).not.toContain("write");
      expect(f.events).not.toContain("quarantine");
    },
  );

  it.each(["engaging", "locked", "ending", "recovery_required"] as const)(
    "loads unfinished %s intact for coordinator recovery without quarantining admission",
    async (phase) => {
      const f = fixture();
      const record = {
        ...withProtection(phase),
        generation: 7,
        pending: {
          kind: "forfeit" as const,
          requestId,
          expectedSessionRevision: 3,
        },
      };
      f.setBytes(persisted(record));
      const loaded = await f.store.load();
      expect(loaded).toEqual({ kind: "ready", record });
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
      if (loaded.kind !== "ready") throw new Error("fixture");
      expect(Object.isFrozen(loaded.record.nativeProtection)).toBe(true);
      expect(Object.isFrozen(loaded.record.nativeProtection?.facts)).toBe(true);
      expect(
        Object.isFrozen(loaded.record.nativeProtection?.facts[0]?.scope),
      ).toBe(true);
      await f.store.close();
      expect(await createStudentSessionStore(f.options).load()).toEqual({
        kind: "ready",
        record,
      });
    },
  );

  it("retains ended/cleanup facts after authority is cleared, including old epoch history", async () => {
    const f = fixture();
    await f.store.load();
    const admittedRecord = admitted();
    if (admittedRecord.current === null) throw new Error("fixture");
    const journal = completeJournal(admittedRecord.current.scope);
    const prior = await f.store.commitDurably(0, {
      ...admittedRecord,
      nativeProtection: journal,
    });
    const terminal = await f.store.commitDurably(prior.generation, {
      ...prior,
      current: null,
      pending: null,
      terminal: true,
    });
    expect(terminal.nativeProtection).toEqual(journal);
    expect(terminal.lastReservedCounter).toBe(19);
    expect(await f.store.load()).toEqual({ kind: "ready", record: terminal });
    const newer = await f.store.commitDurably(terminal.generation, {
      ...admittedRecord,
      current: {
        ...admittedRecord.current,
        scope: { ...admittedRecord.current.scope, epoch: 2 },
      },
      nativeProtection: journal,
    });
    expect(newer.current?.scope.epoch).toBe(2);
    expect(newer.nativeProtection?.facts[0]?.scope.epoch).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "preserves native facts and reserved protocol material through %s-publication failure",
    async (stage) => {
      const f = fixture();
      await f.store.load();
      const original = await f.store.commitDurably(0, {
        ...withProtection(),
        pending: {
          kind: "reconnect",
          requestId,
          expectedSessionRevision: 3,
          candidates: crypto.createCandidates(),
        },
      });
      if (original.current === null) throw new Error("fixture");
      const successor = {
        ...original,
        nativeProtection: protection(original.current.scope, "locked"),
      };
      f.fail(stage);
      await expect(
        f.store.commitDurably(original.generation, successor),
      ).rejects.toThrow();
      await expect(
        f.store.commitDurably(original.generation, successor),
      ).rejects.toThrow();
      const loaded = await f.store.load();
      if (loaded.kind !== "ready") throw new Error("fixture");
      expect(loaded.record).toEqual(
        stage === "before" ? original : { ...successor, generation: 2 },
      );
      expect(loaded.record.pending).toEqual(original.pending);
      expect(loaded.record.lastReservedCounter).toBe(19);
      expect(f.events.filter((event) => event === "barrier")).toHaveLength(1);
      f.fail("none");
      const written = await f.store.commitDurably(loaded.record.generation, {
        ...loaded.record,
        nativeProtection: successor.nativeProtection,
      });
      expect(written.lastReservedCounter).toBe(19);
      expect(written.pending).toEqual(original.pending);
      expect(f.events.filter((event) => event === "barrier")).toHaveLength(2);
    },
  );

  it("rejects a stale journal successor after a newer counter reservation", async () => {
    const f = fixture();
    await f.store.load();
    const first = await f.store.commitDurably(0, withProtection());
    const reserved = await f.store.commitDurably(first.generation, {
      ...first,
      lastReservedCounter: 20,
    });
    await expect(
      f.store.commitDurably(first.generation, first),
    ).rejects.toThrow();
    expect(await f.store.load()).toEqual({ kind: "ready", record: reserved });
    expect(f.events.filter((event) => event === "barrier")).toHaveLength(2);
  });

  it("fits all 32 unacknowledged facts within existing encryption bounds and preserves them at capacity", async () => {
    const f = fixture();
    await f.store.load();
    const record = admitted();
    if (record.current === null) throw new Error("fixture");
    const journal = completeJournal(record.current.scope, 4);
    expect(protectionFactCapacity).toBe(32);
    expect(protectionFactReservation).toBe(8);
    const written = await f.store.commitDurably(0, {
      ...record,
      nativeProtection: journal,
    });
    expect(written.nativeProtection?.facts).toHaveLength(32);
    expect(Buffer.byteLength(JSON.stringify(written), "utf8")).toBeLessThan(
      48 * 1024,
    );
    expect(f.getBytes()?.byteLength).toBeLessThan(64 * 1024);
    const lastBytes = f.getBytes();
    await expect(
      f.store.commitDurably(written.generation, {
        ...written,
        nativeProtection: completeJournal(record.current.scope, 5),
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(lastBytes);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });

  it("refuses untyped version-one successor downgrade", async () => {
    const f = fixture();
    await f.store.load();
    const downgrade: unknown = { ...pending(), version: 1 };
    await expect(
      f.store.commitDurably(0, downgrade as StudentSessionSuccessor),
    ).rejects.toThrow();
    expect(f.events).toEqual(["lock", "load"]);
  });

  it("round-trips an explicit empty native journal without fabricating an attempt", async () => {
    const f = fixture();
    await f.store.load();
    const nativeProtection: StoredNativeProtection = {
      policyVersion: 1,
      revision: 0,
      latestAttempt: null,
      nextFactSequence: 1,
      facts: [],
    };
    const written = await f.store.commitDurably(0, {
      ...pending(),
      nativeProtection,
    });
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
    expect(written.nativeProtection).toEqual(nativeProtection);
  });

  it("keeps actual failed-start disposition distinct from observed did_end after durable cleanup", async () => {
    const f = fixture();
    await f.store.load();
    const record = withProtection();
    const nativeProtection = record.nativeProtection;
    const attempt = nativeProtection?.latestAttempt;
    const first = nativeProtection?.facts[0];
    if (nativeProtection === null || attempt == null || first === undefined)
      throw new Error("fixture");
    const failed: StoredNativeProtection = {
      ...nativeProtection,
      revision: 3,
      nextFactSequence: 4,
      latestAttempt: {
        ...attempt,
        phase: "failed",
        nativeDisposition: "failed_to_begin",
        nativeSequence: 1,
        cleanup: "complete",
      },
      facts: [
        first,
        {
          ...first,
          sequence: 2,
          eventId: identifier(102),
          slot: "native_terminal",
          phase: "failed",
          nativeEvent: "failed_to_begin",
          nativeSequence: 1,
        },
        {
          ...first,
          sequence: 3,
          eventId: identifier(103),
          slot: "cleanup",
          phase: "failed",
          nativeSequence: 1,
        },
      ],
    };
    const written = await f.store.commitDurably(0, {
      ...record,
      nativeProtection: failed,
    });
    expect(written.nativeProtection).toEqual(failed);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });

  it.each(["engaging", "locked"] as const)(
    "round-trips acknowledged disposal from %s without inventing a terminal observation",
    async (phase) => {
      const f = fixture();
      await f.store.load();
      const record = withProtection(phase);
      const prior = record.nativeProtection;
      const attempt = prior?.latestAttempt;
      const first = prior?.facts[0];
      if (prior === null || attempt == null || first === undefined)
        throw new Error("fixture");
      const failureFact: ProtectionFact = {
        ...first,
        sequence: prior.nextFactSequence,
        eventId: identifier(200),
        slot: "failure",
        phase: "recovery_required",
        nativeSequence: attempt.nativeSequence,
        cause: "observation_timeout",
      };
      const disposed: StoredNativeProtection = {
        ...prior,
        revision: prior.revision + 2,
        nextFactSequence: prior.nextFactSequence + 2,
        latestAttempt: {
          ...attempt,
          phase: "failed",
          nativeDisposition: "disposed_without_terminal_observation",
          cleanup: "complete",
        },
        facts: [
          ...prior.facts,
          failureFact,
          {
            ...first,
            sequence: prior.nextFactSequence + 1,
            eventId: identifier(201),
            slot: "cleanup",
            phase: "failed",
            nativeSequence: attempt.nativeSequence,
          },
        ],
      };
      const written = await f.store.commitDurably(0, {
        ...record,
        nativeProtection: disposed,
      });
      expect(await f.store.load()).toEqual({ kind: "ready", record: written });
      expect(written.nativeProtection?.facts).not.toContainEqual(
        expect.objectContaining({ slot: "native_terminal" }),
      );
      expect(
        written.nativeProtection?.facts.find((fact) => fact.slot === "failure"),
      ).toEqual(failureFact);
      expect(written.nativeProtection?.latestAttempt?.nativeDisposition).toBe(
        "disposed_without_terminal_observation",
      );
      expect(written.lastReservedCounter).toBe(record.lastReservedCounter);
    },
  );

  const invalidJournalCases: readonly [
    string,
    (journal: StoredNativeProtection) => unknown,
  ][] = [
    [
      "complete without cleanup fact",
      (j) => ({ ...j, facts: j.facts.slice(0, -1), nextFactSequence: 8 }),
    ],
    [
      "ended without terminal fact",
      (j) => ({
        ...j,
        facts: j.facts.filter((fact) => fact.slot !== "native_terminal"),
      }),
    ],
    [
      "terminal disposition/event mismatch",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          phase: "failed",
          nativeDisposition: "failed_to_begin",
        },
      }),
    ],
    [
      "abandonment without fact",
      (j) => ({
        ...j,
        facts: j.facts.filter((fact) => fact.slot !== "abandoned"),
      }),
    ],
    [
      "locked without began fact",
      (j) => ({ ...j, facts: j.facts.filter((fact) => fact.slot !== "began") }),
    ],
    [
      "unobserved disposal with terminal fact",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          phase: "failed",
          nativeDisposition: "disposed_without_terminal_observation",
        },
      }),
    ],
    [
      "unobserved disposal wrong phase",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          nativeDisposition: "disposed_without_terminal_observation",
        },
      }),
    ],
    [
      "unobserved disposal without complete cleanup",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          phase: "failed",
          nativeDisposition: "disposed_without_terminal_observation",
          cleanup: "unconfirmed",
        },
      }),
    ],
    [
      "confirmed AAC before begin",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "engaging" ? { ...f, categories: confirmedCategories } : f,
        ),
      }),
    ],
    [
      "native callback sequence duplicate",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "native_terminal" ? { ...f, nativeSequence: 1 } : f,
        ),
      }),
    ],
    [
      "native callback on wrong slot",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "cleanup" ? { ...f, nativeEvent: "did_end" } : f,
        ),
      }),
    ],
    [
      "failure without finite cause",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "failure" ? { ...f, cause: "none" } : f,
        ),
      }),
    ],
    ["policy version", (j) => ({ ...j, policyVersion: 2 })],
    ["negative revision", (j) => ({ ...j, revision: -1 })],
    [
      "unsafe revision",
      (j) => ({ ...j, revision: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["missing latest attempt", (j) => ({ ...j, latestAttempt: null })],
    [
      "latest extra field",
      (j) => ({ ...j, latestAttempt: { ...j.latestAttempt, injected: true } }),
    ],
    [
      "latest wrong scope",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          scope: { ...j.latestAttempt?.scope, epoch: 2 },
        },
      }),
    ],
    [
      "latest wrong attempt",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, attemptId: identifier(50) },
      }),
    ],
    [
      "latest idle phase",
      (j) => ({ ...j, latestAttempt: { ...j.latestAttempt, phase: "idle" } }),
    ],
    [
      "latest unknown disposition",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, nativeDisposition: "unlocked" },
      }),
    ],
    [
      "terminal missing sequence",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, nativeSequence: null },
      }),
    ],
    [
      "latest sequence rollback",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, nativeSequence: 1 },
      }),
    ],
    [
      "cleanup before native terminal",
      (j) => ({
        ...j,
        latestAttempt: {
          ...j.latestAttempt,
          phase: "recovery_required",
          nativeDisposition: "active",
        },
      }),
    ],
    [
      "unknown cleanup",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, cleanup: "restored" },
      }),
    ],
    [
      "unknown abandonment",
      (j) => ({
        ...j,
        latestAttempt: { ...j.latestAttempt, abandonment: "accepted" },
      }),
    ],
    ["next sequence rollback", (j) => ({ ...j, nextFactSequence: 8 })],
    ["next sequence gap", (j) => ({ ...j, nextFactSequence: 10 })],
    [
      "next unsafe sequence",
      (j) => ({ ...j, nextFactSequence: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["non-array facts", (j) => ({ ...j, facts: {} })],
    ["journal extra field", (j) => ({ ...j, delivered: true })],
    [
      "fact extra field",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, token: "synthetic-extra" })),
      }),
    ],
    [
      "fact policy",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, policyVersion: 2 })),
      }),
    ],
    [
      "fact sequence zero",
      (j) => ({ ...j, facts: j.facts.map((f) => ({ ...f, sequence: 0 })) }),
    ],
    [
      "fact sequence duplicate",
      (j) => ({ ...j, facts: j.facts.map((f) => ({ ...f, sequence: 1 })) }),
    ],
    [
      "fact event ID duplicate",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, eventId: identifier(101) })),
      }),
    ],
    [
      "fact non-v4 event ID",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({
          ...f,
          eventId: f.eventId.replace("-4000-", "-7000-"),
        })),
      }),
    ],
    [
      "fact non-v4 attempt",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({
          ...f,
          attemptId: f.attemptId.replace("-4000-", "-7000-"),
        })),
      }),
    ],
    [
      "fact scope mismatch",
      (j) => ({
        ...j,
        facts: j.facts.map((f, i) =>
          i === 1 ? { ...f, scope: { ...f.scope, epoch: 2 } } : f,
        ),
      }),
    ],
    [
      "fact malformed scope",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, scope: { ...f.scope, epoch: 0 } })),
      }),
    ],
    [
      "duplicate attempt slot",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({
          ...f,
          slot: "engaging",
          nativeEvent: null,
          nativeSequence: null,
        })),
      }),
    ],
    [
      "unknown slot",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, slot: "uploaded" })),
      }),
    ],
    [
      "fact preflight phase",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, phase: "preflight" })),
      }),
    ],
    [
      "fact arbitrary cause",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, cause: "private error details" })),
      }),
    ],
    [
      "fact category absent",
      (j) => ({ ...j, facts: j.facts.map((f) => ({ ...f, categories: {} })) }),
    ],
    [
      "fact category inapplicable code",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({
          ...f,
          categories: {
            ...f.categories,
            aac: { status: "failed", code: "prohibited_application" },
          },
        })),
      }),
    ],
    [
      "locked pending category",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "locked" ? { ...f, categories: engagingCategories } : f,
        ),
      }),
    ],
    [
      "fact invented native event",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, nativeEvent: "watchdog_end" })),
      }),
    ],
    [
      "began without actual event",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "began" ? { ...f, nativeEvent: null } : f,
        ),
      }),
    ],
    [
      "native terminal with interruption",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "native_terminal"
            ? { ...f, nativeEvent: "interrupted" }
            : f,
        ),
      }),
    ],
    [
      "native event without sequence",
      (j) => ({
        ...j,
        facts: j.facts.map((f) => ({ ...f, nativeSequence: null })),
      }),
    ],
    [
      "native sequence rollback",
      (j) => ({
        ...j,
        facts: j.facts.map((f) =>
          f.slot === "cleanup" ? { ...f, nativeSequence: 1 } : f,
        ),
      }),
    ],
  ];

  it.each(invalidJournalCases)(
    "rejects persisted %s and preserves original bytes",
    async (_name, mutate) => {
      const f = fixture();
      const record = admitted();
      if (record.current === null) throw new Error("fixture");
      const original = persisted({
        ...record,
        generation: 8,
        nativeProtection: mutate(completeJournal(record.current.scope)),
      });
      f.setBytes(original);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(original);
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
    },
  );

  it("rejects accessor, sparse and extended fact arrays before encryption without invoking getters", async () => {
    const f = fixture();
    await f.store.load();
    const record = withProtection();
    if (record.nativeProtection === null) throw new Error("fixture");
    let invoked = 0;
    const getterFacts = [...record.nativeProtection.facts];
    Object.defineProperty(getterFacts, "0", {
      get() {
        invoked += 1;
        return null;
      },
      enumerable: true,
    });
    const sparseFacts = new Array<ProtectionFact>(1);
    const extraFacts = Object.assign([...record.nativeProtection.facts], {
      extra: true,
    });
    for (const facts of [getterFacts, sparseFacts, extraFacts]) {
      await expect(
        f.store.commitDurably(0, {
          ...record,
          nativeProtection: { ...record.nativeProtection, facts },
        }),
      ).rejects.toThrow();
    }
    expect(invoked).toBe(0);
    expect(f.events).toEqual(["lock", "load"]);
  });
});

describe("private protection transition snapshots", () => {
  function commands(): readonly ProtectionTransition[] {
    const record = admitted();
    if (record.current === null) throw new Error("fixture");
    const authority: FreshStudentAdmission = Object.freeze({
      scope: Object.freeze(record.current.scope),
      admissionGeneration: 1,
      sessionRevision: 3,
      capabilityDeadline: 299_000,
      observationSequence: 1,
      readStartedAt: 10,
      observationDeadline: 30_010,
    });
    const base = { attemptId: identifier(10), expectedProtectionRevision: 0 };
    return [
      { ...base, kind: "engaging", authority, categories: engagingCategories },
      {
        ...base,
        kind: "locked",
        authority,
        categories: confirmedCategories,
        nativeSequence: 1,
      },
      {
        ...base,
        kind: "began",
        event: {
          type: "did_begin",
          attemptId: base.attemptId,
          sequence: 1,
          code: "none",
        },
      },
      { ...base, kind: "ending", cause: "application_quit" },
      { ...base, kind: "failure", cause: "native_failure" },
      { ...base, kind: "abandoned", cause: "emergency_abandonment" },
      {
        ...base,
        kind: "native_terminal",
        event: {
          type: "did_end",
          attemptId: base.attemptId,
          sequence: 2,
          code: "none",
        },
      },
      {
        ...base,
        kind: "native_terminal",
        event: {
          type: "failed_to_begin",
          attemptId: base.attemptId,
          sequence: 1,
          code: "native_failed_to_begin",
        },
      },
      { ...base, kind: "cleanup", outcome: "complete" },
      { ...base, kind: "cleanup", outcome: "unconfirmed" },
      { ...base, kind: "disposed_without_terminal_observation" },
    ];
  }

  it("snapshots all exact command forms immutably while retaining the original issuer reference", () => {
    for (const command of commands()) {
      const parsed = parseProtectionTransition(command);
      expect(parsed).toEqual(command);
      expect(Object.isFrozen(parsed)).toBe(true);
      if (parsed === null) throw new Error("fixture");
      if ("authority" in parsed && "authority" in command) {
        expect(parsed.authority).toBe(command.authority);
        expect(parsed.categories).not.toBe(command.categories);
        expect(Object.isFrozen(parsed.categories.aac)).toBe(true);
      }
      if ("event" in parsed && "event" in command) {
        expect(parsed.event).not.toBe(command.event);
        expect(Object.isFrozen(parsed.event)).toBe(true);
      }
    }
  });

  it("preserves finite content-hide failure for actual terminal observations only", () => {
    for (const command of commands()) {
      if (command.kind === "native_terminal") {
        const failedHide = {
          ...command,
          event: { ...command.event, code: "content_hide_failed" },
        };
        expect(parseProtectionTransition(failedHide)).toEqual(failedHide);
      }
      if (command.kind === "began")
        expect(
          parseProtectionTransition({
            ...command,
            event: { ...command.event, code: "content_hide_failed" },
          }),
        ).toBeNull();
    }
  });

  it("rejects invalid identity, revision, shape and unknown union values for every command", () => {
    for (const command of commands()) {
      for (const invalid of [
        { ...command, attemptId: "arbitrary" },
        {
          ...command,
          attemptId: command.attemptId.replace("-4000-", "-7000-"),
        },
        { ...command, expectedProtectionRevision: -0 },
        { ...command, expectedProtectionRevision: -1 },
        { ...command, expectedProtectionRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...command, expectedProtectionRevision: "0" },
        { ...command, kind: "unknown" },
        { ...command, eventId: identifier(99) },
        Object.assign(Object.create({ inherited: true }), command) as unknown,
        { ...command, [Symbol("extra")]: true },
      ])
        expect(parseProtectionTransition(invalid)).toBeNull();
      if ("authority" in command) {
        expect(
          parseProtectionTransition({ ...command, authority: null }),
        ).toBeNull();
        expect(
          parseProtectionTransition({ ...command, categories: {} }),
        ).toBeNull();
      }
      if ("event" in command) {
        for (const event of [
          { ...command.event, attemptId: identifier(11) },
          { ...command.event, sequence: 0 },
          { ...command.event, sequence: Number.MAX_SAFE_INTEGER + 1 },
          { ...command.event, code: "raw platform error" },
          { ...command.event, type: "interrupted" },
          { ...command.event, extra: true },
        ])
          expect(parseProtectionTransition({ ...command, event })).toBeNull();
      }
      if ("cause" in command)
        expect(
          parseProtectionTransition({ ...command, cause: "none" }),
        ).toBeNull();
      if ("outcome" in command)
        expect(
          parseProtectionTransition({ ...command, outcome: "restored" }),
        ).toBeNull();
      if (command.kind === "locked")
        expect(
          parseProtectionTransition({ ...command, nativeSequence: 0 }),
        ).toBeNull();
      if (command.kind === "disposed_without_terminal_observation") {
        expect(
          parseProtectionTransition({ ...command, nativeEvent: "did_end" }),
        ).toBeNull();
        expect(
          parseProtectionTransition({ ...command, outcome: "complete" }),
        ).toBeNull();
      }
    }
  });

  it("does not evaluate getters, inspect authority fields, or leak hostile reflection exceptions", () => {
    const command = commands()[0];
    if (command?.kind !== "engaging") throw new Error("fixture");
    let invoked = 0;
    const accessor = { ...command };
    Object.defineProperty(accessor, "kind", {
      get() {
        invoked += 1;
        return "engaging";
      },
    });
    expect(parseProtectionTransition(accessor)).toBeNull();
    const authority = Object.defineProperty({}, "scope", {
      get() {
        invoked += 1;
        throw new Error("not inspected");
      },
    });
    const parsed = parseProtectionTransition({ ...command, authority });
    expect(
      parsed !== null && "authority" in parsed ? parsed.authority : null,
    ).toBe(authority);
    expect(
      parseProtectionTransition(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("reflection");
            },
          },
        ),
      ),
    ).toBeNull();
    expect(invoked).toBe(0);
  });
});
