import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  type NativeEvidenceOriginBuild,
} from "@desmoslock/contracts";

import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  canReplaceInitialJoin,
  emptyNativeEvidence,
  retainNativeEvidenceSigner,
  pruneNativeEvidence,
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
  type StudentSessionRecord,
  type StoredNativeEvidence,
  type StoredNativeEvidencePendingBatch,
} from "../src/main/student-session-store.js";
import type { FreshStudentAdmission } from "../src/main/student-session-coordinator.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:43175",
} as const;
const crypto = createStudentSessionCrypto(configuration);
const requestId = "10000000-0000-4000-8000-000000000001";

function pending(
  outcome: "not_dispatched" | "uncertain" | "denied" = "not_dispatched",
): StudentSessionSuccessor {
  return {
    version: 4,
    apiOrigin: configuration.url,
    device: crypto.createEnrollment(),
    current: null,
    pending: {
      kind: "join",
      admissionMode: "initial",
      outcome,
      requestId,
      joinCode: "0123456789AB",
      candidates: crypto.createCandidates(),
    },
    lastReservedCounter: 0,
    terminal: false,
    nativeProtection: null,
    evidence: emptyNativeEvidence(),
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

function preflightJournal(
  scope: StoredNativeProtectionAttempt["scope"],
  cause: "application_policy" | "shortcut_unavailable" = "application_policy",
  status: "failed" | "unavailable" = "unavailable",
  complete = false,
): StoredNativeProtection {
  const base = protection(scope);
  const first: ProtectionFact = {
    ...base.facts[0]!,
    slot: "failure",
    phase: "failed",
    cause,
    categories: {
      ...engagingCategories,
      ...(cause === "application_policy"
        ? {
            applications: {
              status,
              code:
                status === "failed"
                  ? "prohibited_application"
                  : "application_observation_unavailable",
            } as const,
          }
        : {
            shortcuts: {
              status,
              code: "emergency_shortcut_unavailable",
            } as const,
          }),
    },
  };
  const facts: ProtectionFact[] = [first];
  if (complete)
    facts.push({
      ...first,
      sequence: 2,
      eventId: identifier(102),
      slot: "cleanup",
      cause: "none",
      categories: {
        ...first.categories,
        persistence: { status: "unavailable", code: "durability_unavailable" },
      },
    });
  return {
    ...base,
    revision: facts.length,
    facts,
    nextFactSequence: facts.length + 1,
    latestAttempt: {
      ...base.latestAttempt!,
      phase: "failed",
      nativeDisposition: complete
        ? "disposed_without_terminal_observation"
        : "not_started",
      cleanup: complete ? "complete" : "pending",
    },
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
    evidence: evidenceFor(record, protection(record.current.scope, phase)),
  };
}

const originBuild: NativeEvidenceOriginBuild = {
  kind: "build",
  identity: {
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    packageLockSha256: "c".repeat(64),
    buildId: "d".repeat(64),
  },
};

const longestCategories = {
  aac: { status: "unavailable", code: "native_unavailable" },
  shortcuts: { status: "unavailable", code: "emergency_shortcut_unavailable" },
  applications: {
    status: "unavailable",
    code: "application_observation_unavailable",
  },
  persistence: { status: "unavailable", code: "durability_unavailable" },
  windowNetwork: { status: "unavailable", code: "network_policy_unavailable" },
} as const;

function evidenceFor(
  record: StudentSessionSuccessor,
  journal: StoredNativeProtection,
): StoredNativeEvidence {
  return {
    ...emptyNativeEvidence(),
    origins: [...new Set(journal.facts.map((fact) => fact.attemptId))].map(
      (attemptId) => ({
        attemptId,
        scope: journal.facts.find((fact) => fact.attemptId === attemptId)!
          .scope,
        originalKeyThumbprint: record.device.keyThumbprint,
        originBuild,
      }),
    ),
  };
}

function batchFor(
  record: StudentSessionSuccessor,
  attemptId: string,
  length = 8,
): StoredNativeEvidencePendingBatch {
  const origin = record.evidence.origins.find(
    (item) => item.attemptId === attemptId,
  )!;
  const facts = record
    .nativeProtection!.facts.filter((fact) => fact.attemptId === attemptId)
    .slice(0, length);
  if (origin.originalKeyThumbprint === null)
    throw new Error("Synthetic signer required");
  const context = {
    apiOrigin: record.apiOrigin,
    originalKeyThumbprint: origin.originalKeyThumbprint,
    scope: origin.scope,
    originBuild: origin.originBuild,
  };
  const contentDigests = facts.map((fact) => {
    const bytes = encodeNativeProtectionFactDigestInput({ ...context, fact });
    if (bytes === null) throw new Error("Synthetic canonical fact rejected");
    return createHash("sha256").update(bytes).digest("hex");
  });
  const bytes = encodeStudentEvidenceBatchDigestInput({
    ...context,
    facts,
    contentDigests,
  });
  if (bytes === null) throw new Error("Synthetic canonical batch rejected");
  return {
    originalKeyThumbprint: origin.originalKeyThumbprint,
    attemptId,
    batchDigest: createHash("sha256").update(bytes).digest("hex"),
    events: facts.map((fact, index) => ({
      eventId: fact.eventId,
      contentDigest: contentDigests[index]!,
    })),
  };
}

function checksumPayload(payload: object): object {
  return {
    ...payload,
    integritySha256: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
}

function persisted(value: unknown): Buffer {
  let disk = value;
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    (value.version === 3 || value.version === 4) &&
    "evidence" in value
  ) {
    const record = value as StudentSessionRecord;
    disk = {
      ...record,
      evidence: {
        ...record.evidence,
        origins: record.evidence.origins.map((origin) => ({
          attemptId: origin.attemptId,
          originalKeyThumbprint: origin.originalKeyThumbprint,
          originBuild: origin.originBuild,
        })),
      },
    };
  }
  if (
    typeof disk === "object" &&
    disk !== null &&
    "version" in disk &&
    disk.version === 4
  )
    disk = checksumPayload(disk);
  return Buffer.from(`synthetic:${JSON.stringify(disk)}`);
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

function worstEvidenceRecord(attemptCount: number): StudentSessionRecord {
  const base = admitted();
  if (base.current === null) throw new Error("fixture");
  const devices = [
    base.device,
    ...Array.from({ length: 4 }, () => crypto.createEnrollment()),
  ];
  const scope = base.current.scope;
  const counts = Array.from({ length: attemptCount }, () => 2);
  let spare = 32 - attemptCount * 2;
  for (let i = 0; i < counts.length && spare > 0; i += 1) {
    const extra = Math.min(6, spare);
    counts[i]! += extra;
    spare -= extra;
  }
  const allowed: Record<number, readonly FactSlot[]> = {
    2: ["engaging", "cleanup"],
    3: ["engaging", "native_terminal", "cleanup"],
    4: ["engaging", "began", "native_terminal", "cleanup"],
    5: ["engaging", "began", "locked", "native_terminal", "cleanup"],
    6: ["engaging", "began", "locked", "failure", "native_terminal", "cleanup"],
    7: [
      "engaging",
      "began",
      "locked",
      "end_requested",
      "failure",
      "native_terminal",
      "cleanup",
    ],
    8: [
      "engaging",
      "began",
      "locked",
      "abandoned",
      "end_requested",
      "failure",
      "native_terminal",
      "cleanup",
    ],
  };
  const facts: ProtectionFact[] = [];
  const origins: StoredNativeEvidence["origins"][number][] = [];
  let latest: StoredNativeProtectionAttempt | null = null;
  for (let index = 0; index < attemptCount; index += 1) {
    const device = devices[index % 5]!;
    const attemptId = identifier(index + 1_000);
    const attemptScope = {
      ...scope,
      deviceSessionId: device.deviceSessionId,
      epoch: Number.MAX_SAFE_INTEGER,
    };
    const count = counts[index]!;
    const selected = completeJournal(attemptScope).facts.filter((fact) =>
      allowed[count]!.includes(fact.slot),
    );
    for (const fact of selected) {
      const sequence = Number.MAX_SAFE_INTEGER - 32 + facts.length;
      facts.push({
        ...fact,
        sequence,
        eventId: identifier(facts.length + 10_000),
        attemptId,
        phase:
          fact.slot === "engaging"
            ? "engaging"
            : fact.slot === "locked"
              ? "locked"
              : "recovery_required",
        cause: "persistence_unavailable",
        categories:
          fact.slot === "locked" ? confirmedCategories : longestCategories,
        nativeSequence:
          fact.nativeSequence === null
            ? null
            : fact.nativeSequence === 1
              ? Number.MAX_SAFE_INTEGER - 1
              : Number.MAX_SAFE_INTEGER,
        ...(count === 2
          ? {
              phase:
                fact.slot === "cleanup"
                  ? ("failed" as const)
                  : ("engaging" as const),
              nativeSequence: null,
            }
          : {}),
      });
    }
    origins.push({
      attemptId,
      scope: attemptScope,
      originalKeyThumbprint: device.keyThumbprint,
      originBuild,
    });
    latest = {
      attemptId,
      scope: attemptScope,
      phase: count === 2 ? "failed" : "ended",
      nativeDisposition:
        count === 2 ? "disposed_without_terminal_observation" : "ended",
      nativeSequence: count === 2 ? null : Number.MAX_SAFE_INTEGER,
      cleanup: "complete",
      abandonment: count === 8 ? "requested" : "none",
    };
  }
  let record: StudentSessionRecord = {
    ...base,
    generation: Number.MAX_SAFE_INTEGER - 1,
    lastReservedCounter: Number.MAX_SAFE_INTEGER,
    current: {
      ...base.current,
      scope: { ...scope, epoch: Number.MAX_SAFE_INTEGER },
      sessionRevision: Number.MAX_SAFE_INTEGER,
      syntheticDisplayName: "Student AAAAAAAAAAAAAAAAAAAAAAAA",
      serverNowMs: Number.MAX_SAFE_INTEGER - 1,
      capabilityIssuedAtMs: Number.MAX_SAFE_INTEGER - 900_000,
      capabilityExpiresAtMs: Number.MAX_SAFE_INTEGER - 600_000,
      reconnectExpiresAtMs: Number.MAX_SAFE_INTEGER,
    },
    pending: {
      kind: "reconnect",
      requestId,
      expectedSessionRevision: Number.MAX_SAFE_INTEGER,
      candidates: crypto.createCandidates(),
    },
    nativeProtection: {
      policyVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      latestAttempt: latest,
      nextFactSequence: Number.MAX_SAFE_INTEGER,
      facts,
    },
    evidence: {
      ...emptyNativeEvidence(),
      origins,
      retiredSigners: devices.slice(1).map((device) => ({
        device,
        lastReservedCounter: Number.MAX_SAFE_INTEGER,
      })),
      lastAttemptedSigner: devices[4]!.keyThumbprint,
    },
  };
  const allBatches = origins.map((origin) =>
    batchFor(record, origin.attemptId),
  );
  record = {
    ...record,
    evidence: {
      ...record.evidence,
      pendingBatches: devices.map(
        (device) =>
          allBatches
            .filter(
              (batch) => batch.originalKeyThumbprint === device.keyThumbprint,
            )
            .sort((a, b) => b.events.length - a.events.length)[0]!,
      ),
      acknowledgments: allBatches.flatMap((batch) =>
        batch.events.map((event) => ({
          ...event,
          receivedAt: "9999-12-31T23:59:59.999999Z",
        })),
      ),
    },
  };
  return record;
}

describe("version 4 whole-payload corruption checksum", () => {
  it("stores the compact payload SHA-256 while keeping the in-memory record checksum-free", async () => {
    const f = fixture();
    await f.store.load();
    const record = await f.store.commitDurably(0, withProtection());
    const disk = JSON.parse(f.getBytes()!.toString().slice(10)) as Record<
      string,
      unknown
    >;
    const digest = disk.integritySha256;
    delete disk.integritySha256;
    expect(digest).toBe(
      createHash("sha256").update(JSON.stringify(disk), "utf8").digest("hex"),
    );
    expect(record).not.toHaveProperty("integritySha256");
    expect(Object.keys(disk)).toEqual(Object.keys(record));
    expect(await createStudentSessionStore(f.options).load()).toEqual({
      kind: "ready",
      record,
    });
  });

  it.each(["generation", "device", "counter", "outcome", "native", "evidence"])(
    "rejects schema-valid %s corruption with the original checksum and retains all bytes",
    async (field) => {
      const base: StudentSessionRecord = {
        ...(field === "device" || field === "outcome"
          ? pending("uncertain")
          : withProtection()),
        generation: 5,
      };
      let changed: StudentSessionRecord = base;
      if (field === "generation") changed = { ...base, generation: 6 };
      if (field === "device")
        changed = { ...base, device: crypto.createEnrollment() };
      if (field === "counter") changed = { ...base, lastReservedCounter: 20 };
      if (field === "outcome") {
        if (base.pending?.kind !== "join") throw new Error("fixture");
        changed = { ...base, pending: { ...base.pending, outcome: "denied" } };
      }
      if (field === "native") {
        if (base.nativeProtection === null) throw new Error("fixture");
        changed = {
          ...base,
          nativeProtection: {
            ...base.nativeProtection,
            revision: base.nativeProtection.revision + 1,
          },
        };
      }
      if (field === "evidence")
        changed = {
          ...base,
          evidence: {
            ...base.evidence,
            lastAttemptedSigner: base.device.keyThumbprint,
          },
        };
      const valid = fixture();
      valid.setBytes(persisted(changed));
      expect(await valid.store.load()).toEqual({
        kind: "ready",
        record: changed,
      });
      const originalDisk = JSON.parse(
        persisted(base).toString().slice(10),
      ) as Record<string, unknown>;
      const corruptDisk = JSON.parse(
        persisted(changed).toString().slice(10),
      ) as Record<string, unknown>;
      corruptDisk.integritySha256 = originalDisk.integritySha256;
      const corruptBytes = Buffer.from(
        `synthetic:${JSON.stringify(corruptDisk)}`,
      );
      const f = fixture();
      f.setBytes(corruptBytes);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      await expect(f.store.commitDurably(0, changed)).rejects.toThrow();
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
      expect(f.getBytes()).toEqual(corruptBytes);
      expect(f.preserved).toEqual([]);
    },
  );

  it.each([
    undefined,
    null,
    0,
    "",
    "a".repeat(63),
    "A".repeat(64),
    "0".repeat(64),
    "a".repeat(64) + "\n",
  ])(
    "rejects missing, malformed or mismatched checksum %j without rewriting or quarantining",
    async (integritySha256) => {
      const disk = JSON.parse(
        persisted({ ...admitted(), generation: 1 })
          .toString()
          .slice(10),
      ) as Record<string, unknown>;
      disk.integritySha256 = integritySha256;
      const bytes = Buffer.from(`synthetic:${JSON.stringify(disk)}`);
      const f = fixture();
      f.setBytes(bytes);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(bytes);
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
      expect(f.preserved).toEqual([]);
    },
  );

  it("rejects a version downgrade retaining the checksum and extra fields even with a recomputed checksum", async () => {
    const disk = JSON.parse(
      persisted({ ...admitted(), generation: 1 })
        .toString()
        .slice(10),
    ) as Record<string, unknown>;
    const downgraded = { ...disk, version: 3 };
    delete disk.integritySha256;
    const extra = checksumPayload({ ...disk, unexpected: false });
    for (const payload of [downgraded, extra]) {
      const bytes = Buffer.from(`synthetic:${JSON.stringify(payload)}`);
      const f = fixture();
      f.setBytes(bytes);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(bytes);
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
    }
  });
});

describe("version 4 initial join outcome", () => {
  it.each(["not_dispatched", "uncertain", "denied"] as const)(
    "round-trips initial outcome %s without changing the enrollment or stored payload",
    async (outcome) => {
      const f = fixture();
      const record = pending(outcome);
      await f.store.load();
      const written = await f.store.commitDurably(0, record);
      expect(written).toEqual({ ...record, generation: 1 });
      expect(f.getBytes()).toEqual(persisted(written));
      expect(await createStudentSessionStore(f.options).load()).toEqual({
        kind: "ready",
        record: written,
      });
      expect(written.device).toEqual(record.device);
      expect(Object.isFrozen(written.pending)).toBe(true);
    },
  );

  it.each([1, 2, 3])(
    "normalizes v%i initial and readmission joins as uncertain without rewriting bytes",
    async (version) => {
      for (const admissionMode of ["initial", "readmission"] as const) {
        const record = pending("uncertain");
        if (record.pending?.kind !== "join") throw new Error("fixture");
        const expected = {
          ...record,
          generation: 7,
          pending: { ...record.pending, admissionMode },
        };
        const oldJoin: Record<string, unknown> = { ...expected.pending };
        delete oldJoin.outcome;
        const legacy: Record<string, unknown> = {
          ...expected,
          version,
          pending: oldJoin,
        };
        if (version < 3) delete legacy.evidence;
        if (version === 1) delete legacy.nativeProtection;
        const original = persisted(legacy);
        const f = fixture();
        f.setBytes(original);
        expect(await f.store.load()).toEqual({
          kind: "ready",
          record: expected,
        });
        expect(f.getBytes()).toEqual(original);
        expect(f.events).toEqual(["lock", "load", "decrypt"]);
        expect(canReplaceInitialJoin(expected)).toBe(false);
        const written = await f.store.commitDurably(7, expected);
        expect(written.version).toBe(4);
        expect(written.pending).toEqual(expected.pending);
        expect(f.getBytes()).toEqual(persisted(written));
      }
    },
  );

  it("normalizes compact v3 evidence without rewriting origins, counters or bytes", async () => {
    const record = worstEvidenceRecord(5);
    const original = persisted({ ...record, version: 3 });
    const f = fixture();
    f.setBytes(original);
    expect(await f.store.load()).toEqual({ kind: "ready", record });
    expect(f.getBytes()).toEqual(original);
    expect(f.events).toEqual(["lock", "load", "decrypt"]);
  });

  it.each([undefined, null, false, 0, "", "accepted", "DENIED", {}])(
    "preserves v4 bytes and rejects malformed initial outcome %j before publication",
    async (outcome) => {
      const record = pending();
      const malformed = {
        ...record,
        pending: { ...record.pending, outcome },
      };
      const f = fixture();
      await f.store.load();
      await expect(
        f.store.commitDurably(0, malformed as StudentSessionSuccessor),
      ).rejects.toThrow();
      expect(f.events).toEqual(["lock", "load"]);
      const original = persisted({ ...malformed, generation: 1 });
      f.setBytes(original);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(original);
    },
  );

  it.each(["not_dispatched", "denied"] as const)(
    "requires no prior state for replaceable outcome %s",
    async (outcome) => {
      const base = pending(outcome);
      const history = worstEvidenceRecord(5);
      const emptyJournal: StoredNativeProtection = {
        policyVersion: 1,
        revision: 0,
        latestAttempt: null,
        nextFactSequence: 1,
        facts: [],
      };
      const evidenceVariants: StoredNativeEvidence[] = [
        { ...base.evidence, origins: history.evidence.origins },
        { ...base.evidence, acknowledgments: history.evidence.acknowledgments },
        { ...base.evidence, pendingBatches: history.evidence.pendingBatches },
        { ...base.evidence, retiredSigners: history.evidence.retiredSigners },
        { ...base.evidence, lastAttemptedSigner: base.device.keyThumbprint },
      ];
      const variants: StudentSessionSuccessor[] = [
        { ...base, current: admitted().current },
        { ...base, lastReservedCounter: 1 },
        { ...base, terminal: true },
        { ...base, nativeProtection: emptyJournal },
        ...evidenceVariants.map((evidence) => ({ ...base, evidence })),
      ];
      if (base.pending?.kind !== "join") throw new Error("fixture");
      variants.push({
        ...base,
        pending: { ...base.pending, admissionMode: "readmission" },
      });
      expect(canReplaceInitialJoin(base)).toBe(true);
      for (const variant of variants) {
        expect(canReplaceInitialJoin(variant)).toBe(false);
        const f = fixture();
        await f.store.load();
        await expect(f.store.commitDurably(0, variant)).rejects.toThrow();
        expect(f.events).toEqual(["lock", "load"]);
        const original = persisted({ ...variant, generation: 1 });
        f.setBytes(original);
        expect((await f.store.load()).kind).toBe("recovery_required");
        expect(f.getBytes()).toEqual(original);
      }
    },
  );

  it("never marks absent, uncertain, admitted, terminal or targeted records as replaceable", async () => {
    const initial = pending("uncertain");
    if (initial.pending?.kind !== "join") throw new Error("fixture");
    const targeted: StudentSessionSuccessor = {
      ...initial,
      pending: { ...initial.pending, admissionMode: "readmission" },
    };
    for (const record of [
      null,
      initial,
      admitted(),
      { ...initial, current: null, pending: null, terminal: true },
      targeted,
    ])
      expect(canReplaceInitialJoin(record)).toBe(false);
    const f = fixture();
    await f.store.load();
    const written = await f.store.commitDurably(0, targeted);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });
});

describe("version 4 bounded native evidence retention", () => {
  it("fits 32 facts, five signers/pending prefixes and all ACKs across worst origin-count shapes without raising byte limits", async () => {
    const sizes: number[] = [];
    for (let attempts = 5; attempts <= 16; attempts += 1) {
      const f = fixture();
      const record = worstEvidenceRecord(attempts);
      const bytes = persisted(record);
      sizes.push(bytes.byteLength - Buffer.byteLength("synthetic:"));
      expect(record.nativeProtection?.facts).toHaveLength(32);
      expect(record.evidence.pendingBatches).toHaveLength(5);
      expect(record.evidence.retiredSigners).toHaveLength(4);
      expect(record.evidence.acknowledgments).toHaveLength(32);
      expect(sizes.at(-1)).toBeLessThan(48 * 1024);
      expect(bytes.byteLength).toBeLessThan(64 * 1024);
      f.setBytes(bytes);
      expect(await f.store.load()).toEqual({ kind: "ready", record });
      expect(f.events).not.toContain("write");
      const committed = await f.store.commitDurably(record.generation, record);
      expect(committed.generation).toBe(Number.MAX_SAFE_INTEGER);
      expect(f.getBytes()?.byteLength).toBeLessThan(64 * 1024);
    }
    expect(Math.max(...sizes), JSON.stringify(sizes)).toBeLessThan(48 * 1024);
  });

  it.each([false, true])(
    "normalizes v2 origins without disk rewrite, with missing old signer=%s",
    async (missing) => {
      const record = withProtection("locked");
      const v2: Record<string, unknown> = { ...record };
      delete v2.evidence;
      const device = missing ? crypto.createEnrollment() : record.device;
      const legacy = {
        ...v2,
        version: 2,
        generation: 9,
        device,
        current: null,
        pending: null,
        terminal: true,
      };
      const f = fixture();
      const bytes = persisted(legacy);
      f.setBytes(bytes);
      const loaded = await f.store.load();
      if (loaded.kind !== "ready")
        throw new Error("Expected legacy normalization");
      expect(loaded.record.version).toBe(4);
      expect(loaded.record.nativeProtection).toEqual(record.nativeProtection);
      expect(loaded.record.lastReservedCounter).toBe(
        record.lastReservedCounter,
      );
      expect(loaded.record.evidence.origins).toEqual([
        {
          attemptId: record.nativeProtection!.latestAttempt!.attemptId,
          scope: record.nativeProtection!.latestAttempt!.scope,
          originalKeyThumbprint: missing ? null : record.device.keyThumbprint,
          originBuild: { kind: "legacy_unknown" },
        },
      ]);
      expect(f.getBytes()).toEqual(bytes);
      expect(f.events).toEqual(["lock", "load", "decrypt"]);
      const committed = await f.store.commitDurably(9, loaded.record);
      expect(committed.evidence).toEqual(loaded.record.evidence);
      expect(f.getBytes()).toEqual(persisted(committed));
    },
  );

  it("accepts only compact v4 disk origins and reconstructs exact immutable scope from retained facts", async () => {
    const record = { ...withProtection(), generation: 7 };
    const f = fixture();
    const inflated = Buffer.from(
      `synthetic:${JSON.stringify(checksumPayload(record))}`,
    );
    f.setBytes(inflated);
    expect((await f.store.load()).kind).toBe("recovery_required");
    expect(f.getBytes()).toEqual(inflated);
    const valid = fixture();
    valid.setBytes(persisted(record));
    const loaded = await valid.store.load();
    if (loaded.kind !== "ready") throw new Error("Expected compact v4 record");
    expect(loaded.record).toEqual(record);
    expect(Object.isFrozen(loaded.record.evidence.origins[0]!.scope)).toBe(
      true,
    );
    expect(valid.events).not.toContain("write");
  });

  it("retains 16 unacknowledged origins with an unfinished latest attempt without pruning or dropping its signer", async () => {
    const full = worstEvidenceRecord(16);
    const latest = full.nativeProtection!.latestAttempt!;
    const facts = full.nativeProtection!.facts.map((fact): ProtectionFact =>
      fact.attemptId === latest.attemptId && fact.slot === "cleanup"
        ? {
            ...fact,
            slot: "began",
            nativeEvent: "did_begin",
            nativeSequence: Number.MAX_SAFE_INTEGER,
            phase: "engaging",
          }
        : fact,
    );
    const record: StudentSessionRecord = {
      ...full,
      generation: 7,
      nativeProtection: {
        ...full.nativeProtection!,
        facts,
        latestAttempt: {
          ...latest,
          phase: "engaging",
          nativeDisposition: "active",
          nativeSequence: Number.MAX_SAFE_INTEGER,
          cleanup: "not_requested",
        },
      },
      evidence: { ...full.evidence, acknowledgments: [], pendingBatches: [] },
    };
    const f = fixture();
    const bytes = persisted(record);
    expect(bytes.byteLength - 10).toBeLessThan(48 * 1024);
    f.setBytes(bytes);
    expect(await f.store.load()).toEqual({ kind: "ready", record });
    expect(pruneNativeEvidence(record).nativeProtection!.facts).toEqual(facts);
    expect(pruneNativeEvidence(record).evidence.retiredSigners).toHaveLength(4);
    expect(retainNativeEvidenceSigner(record)).toBeNull();
    expect(f.getBytes()).toEqual(bytes);
  });

  it("preserves the original parser gate against starting another attempt before previous cleanup", async () => {
    const record = withProtection();
    const first = record.nativeProtection!.facts[0]!;
    const facts = [
      first,
      {
        ...first,
        attemptId: identifier(999),
        eventId: identifier(998),
        sequence: 2,
      },
    ];
    const malformed = {
      ...record,
      nativeProtection: {
        ...record.nativeProtection!,
        facts,
        nextFactSequence: 3,
        latestAttempt: {
          ...record.nativeProtection!.latestAttempt!,
          attemptId: identifier(999),
        },
      },
    };
    const value = {
      ...malformed,
      evidence: evidenceFor(malformed, malformed.nativeProtection),
    };
    const f = fixture();
    await f.store.load();
    await expect(f.store.commitDurably(0, value)).rejects.toThrow();
    expect(f.getBytes()).toBeNull();
    expect(f.events).not.toContain("write");
  });

  it("preserves origin/build/content, exact ACK time and pending prefix through restart and counter-only retries", async () => {
    const f = fixture();
    await f.store.load();
    const initial = withProtection("locked");
    const batch = batchFor(
      initial,
      initial.nativeProtection!.latestAttempt!.attemptId,
    );
    const reserved = await f.store.commitDurably(0, {
      ...initial,
      lastReservedCounter: 20,
      evidence: {
        ...initial.evidence,
        pendingBatches: [batch],
        lastAttemptedSigner: initial.device.keyThumbprint,
      },
    });
    const restarted = createStudentSessionStore(f.options);
    expect(await restarted.load()).toEqual({ kind: "ready", record: reserved });
    const retried = await restarted.commitDurably(1, {
      ...reserved,
      lastReservedCounter: 21,
    });
    expect(retried.evidence.pendingBatches[0]).toEqual(batch);
    const accepted = await restarted.commitDurably(2, {
      ...retried,
      evidence: {
        ...retried.evidence,
        pendingBatches: [],
        acknowledgments: batch.events.map((event) => ({
          ...event,
          receivedAt: "2026-09-08T12:34:56.123456Z",
        })),
      },
    });
    expect(pruneNativeEvidence(accepted).nativeProtection).toEqual(
      accepted.nativeProtection,
    );
    expect(retainNativeEvidenceSigner(accepted)?.retiredSigners).toEqual([
      { device: accepted.device, lastReservedCounter: 21 },
    ]);
    const oldBytes = f.getBytes();
    for (const evidence of [
      {
        ...accepted.evidence,
        origins: accepted.evidence.origins.map((origin) => ({
          ...origin,
          originBuild: { kind: "unverified_build" as const },
        })),
      },
      {
        ...accepted.evidence,
        acknowledgments: accepted.evidence.acknowledgments.map((ack) => ({
          ...ack,
          receivedAt: "2026-09-08T12:34:56.123457Z",
        })),
      },
      { ...accepted.evidence, acknowledgments: [] },
    ]) {
      await expect(
        restarted.commitDurably(3, { ...accepted, evidence }),
      ).rejects.toThrow();
      expect(f.getBytes()).toEqual(oldBytes);
    }
  });

  it.each(["before", "after"] as const)(
    "never acknowledges an uncertain %s-publication barrier and recovers exact pending or ACK bytes",
    async (stage) => {
      const f = fixture();
      await f.store.load();
      const initial = withProtection();
      const batch = batchFor(
        initial,
        initial.nativeProtection!.latestAttempt!.attemptId,
      );
      const reserved = await f.store.commitDurably(0, {
        ...initial,
        evidence: { ...initial.evidence, pendingBatches: [batch] },
      });
      const successor = {
        ...reserved,
        evidence: {
          ...reserved.evidence,
          pendingBatches: [],
          acknowledgments: batch.events.map((event) => ({
            ...event,
            receivedAt: "2026-09-08T12:34:56.000001Z",
          })),
        },
      };
      f.fail(stage);
      await expect(f.store.commitDurably(1, successor)).rejects.toThrow();
      await expect(f.store.commitDurably(1, successor)).rejects.toThrow();
      const loaded = await f.store.load();
      expect(loaded).toEqual({
        kind: "ready",
        record: stage === "before" ? reserved : { ...successor, generation: 2 },
      });
    },
  );

  it("rejects cleared, replaced, reordered or forged pending references without exact acknowledgment", async () => {
    const f = fixture();
    await f.store.load();
    const initial = withProtection("locked");
    const batch = batchFor(
      initial,
      initial.nativeProtection!.latestAttempt!.attemptId,
    );
    const reserved = await f.store.commitDurably(0, {
      ...initial,
      evidence: { ...initial.evidence, pendingBatches: [batch] },
    });
    const bytes = f.getBytes();
    const variants = [
      [],
      [{ ...batch, batchDigest: "0".repeat(64) }],
      [{ ...batch, events: [...batch.events].reverse() }],
      [batchFor(initial, batch.attemptId, 1)],
      [batch, batch],
    ];
    for (const pendingBatches of variants) {
      await expect(
        f.store.commitDurably(1, {
          ...reserved,
          evidence: { ...reserved.evidence, pendingBatches },
        }),
      ).rejects.toThrow();
      expect(f.getBytes()).toEqual(bytes);
    }
    await expect(
      f.store.commitDurably(1, {
        ...reserved,
        evidence: {
          ...reserved.evidence,
          acknowledgments: [
            { ...batch.events[0]!, receivedAt: "2026-09-08T12:34:56.123456Z" },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(bytes);
  });

  it.each([
    "missing-origin",
    "extra-origin",
    "duplicate-origin",
    "orphan-origin",
    "origin-scope",
    "legacy-null-key",
    "duplicate-signer",
    "unknown-cursor",
    "ack-extra",
    "ack-digest",
    "ack-timestamp",
    "duplicate-ack",
    "pending-extra",
    "pending-accessor",
    "pending-sparse",
  ])(
    "rejects malformed v3 %s without changing the retained encrypted record",
    async (mutation) => {
      const record = worstEvidenceRecord(5);
      const evidence = structuredClone(record.evidence) as unknown as Record<
        string,
        unknown
      >;
      const origins = evidence.origins as Record<string, unknown>[];
      const acks = evidence.acknowledgments as Record<string, unknown>[];
      const pendingBatches = evidence.pendingBatches as Record<
        string,
        unknown
      >[];
      if (mutation === "missing-origin") origins.pop();
      if (mutation === "extra-origin") origins[0]!.unexpected = true;
      if (mutation === "duplicate-origin") origins[1] = origins[0]!;
      if (mutation === "orphan-origin")
        origins[0]!.attemptId = identifier(123456);
      if (mutation === "origin-scope")
        origins[0]!.scope = { ...record.evidence.origins[0]!.scope, epoch: 1 };
      if (mutation === "legacy-null-key")
        origins[0]!.originalKeyThumbprint = null;
      if (mutation === "duplicate-signer")
        evidence.retiredSigners = [
          { device: record.device, lastReservedCounter: 0 },
        ];
      if (mutation === "unknown-cursor")
        evidence.lastAttemptedSigner = "not-a-thumbprint";
      if (mutation === "ack-extra") acks[0]!.extra = null;
      if (mutation === "ack-digest") acks[0]!.contentDigest = "0".repeat(64);
      if (mutation === "ack-timestamp")
        acks[0]!.receivedAt = "2026-09-08T00:00:00.000Z";
      if (mutation === "duplicate-ack") acks[1] = acks[0]!;
      if (mutation === "pending-extra")
        pendingBatches[0]!.facts = record.nativeProtection!.facts;
      if (mutation === "pending-accessor")
        Object.defineProperty(pendingBatches, "0", {
          enumerable: true,
          get() {
            throw new Error("must not access");
          },
        });
      if (mutation === "pending-sparse") delete pendingBatches[0];
      const f = fixture();
      f.setBytes(persisted(record));
      await f.store.load();
      await expect(
        f.store.commitDurably(record.generation, {
          ...record,
          evidence,
        } as unknown as StudentSessionSuccessor),
      ).rejects.toThrow();
      expect(f.getBytes()).toEqual(persisted(record));
      expect(f.events).not.toContain("write");
    },
  );

  it("prunes only durably acknowledged whole nonlatest attempts and keeps latest signer pinned", async () => {
    const f = fixture();
    const full = worstEvidenceRecord(5);
    const record = {
      ...full,
      generation: 1,
      lastReservedCounter: 22,
      evidence: { ...full.evidence, pendingBatches: [] },
    };
    f.setBytes(persisted(record));
    expect(await f.store.load()).toEqual({ kind: "ready", record });
    const latest = record.nativeProtection!.latestAttempt!;
    const retained = record.nativeProtection!.facts.filter(
      (fact) => fact.attemptId === latest.attemptId,
    );
    const pruned = pruneNativeEvidence(record);
    expect(pruned.nativeProtection!.facts).toEqual(retained);
    expect(pruned.nativeProtection!.revision).toBe(
      record.nativeProtection!.revision,
    );
    expect(pruned.nativeProtection!.nextFactSequence).toBe(
      record.nativeProtection!.nextFactSequence,
    );
    expect(pruned.evidence.origins.map((origin) => origin.attemptId)).toEqual([
      latest.attemptId,
    ]);
    expect(pruned.evidence.retiredSigners).toHaveLength(1);
    expect(pruned.evidence.retiredSigners[0]!.device.deviceSessionId).toBe(
      latest.scope.deviceSessionId,
    );
    const committed = await f.store.commitDurably(1, pruned);
    expect(committed.device).toEqual(record.device);
    expect(committed.lastReservedCounter).toBe(22);
    const bytes = f.getBytes();
    await expect(
      f.store.commitDurably(2, {
        ...committed,
        evidence: { ...committed.evidence, retiredSigners: [] },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(bytes);
  });

  it("keeps every fact of an incompletely acknowledged or still-pending attempt and refuses partial pruning", async () => {
    const full = worstEvidenceRecord(5);
    const partial: StudentSessionRecord = {
      ...full,
      generation: 1,
      evidence: {
        ...full.evidence,
        pendingBatches: [],
        acknowledgments: full.evidence.acknowledgments.slice(1),
      },
    };
    const first = partial.nativeProtection!.facts[0]!;
    const pruned = pruneNativeEvidence(partial);
    expect(
      pruned.nativeProtection!.facts.filter(
        (fact) => fact.attemptId === first.attemptId,
      ),
    ).toHaveLength(8);
    expect(pruneNativeEvidence(full).nativeProtection!.facts).toHaveLength(32);
    const f = fixture();
    f.setBytes(persisted(partial));
    await f.store.load();
    await expect(
      f.store.commitDurably(1, {
        ...partial,
        nativeProtection: {
          ...partial.nativeProtection!,
          facts: partial.nativeProtection!.facts.slice(1),
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(persisted(partial));
  });

  it("retains the exact acknowledged latest signer/counter across replacement and late original facts", async () => {
    const f = fixture();
    await f.store.load();
    const initial = withProtection();
    const batch = batchFor(
      initial,
      initial.nativeProtection!.latestAttempt!.attemptId,
    );
    const first = await f.store.commitDurably(0, {
      ...initial,
      evidence: { ...initial.evidence, pendingBatches: [batch] },
    });
    const accepted = await f.store.commitDurably(1, {
      ...first,
      evidence: {
        ...first.evidence,
        pendingBatches: [],
        acknowledgments: batch.events.map((event) => ({
          ...event,
          receivedAt: "2026-09-08T12:34:56.000001Z",
        })),
      },
    });
    const evidence = retainNativeEvidenceSigner(accepted);
    expect(evidence?.retiredSigners).toEqual([
      { device: accepted.device, lastReservedCounter: 19 },
    ]);
    if (evidence === null) throw new Error("Expected signer retention");
    const replacement = pending("uncertain");
    if (replacement.pending?.kind !== "join") throw new Error("fixture");
    const generation = await f.store.preserveForTargetedRecovery(2);
    const replaced = await f.store.commitDurably(generation, {
      ...replacement,
      pending: { ...replacement.pending, admissionMode: "readmission" },
      nativeProtection: accepted.nativeProtection,
      evidence,
    });
    const late = protection(
      accepted.nativeProtection!.latestAttempt!.scope,
      "locked",
    );
    const appended = await f.store.commitDurably(replaced.generation, {
      ...replaced,
      nativeProtection: late,
    });
    expect(appended.evidence.origins).toEqual(accepted.evidence.origins);
    expect(appended.evidence.retiredSigners[0]!.device).toEqual(
      accepted.device,
    );
    expect(batchFor(appended, batch.attemptId).originalKeyThumbprint).toBe(
      accepted.device.keyThumbprint,
    );
    expect(appended.device.keyThumbprint).not.toBe(
      accepted.device.keyThumbprint,
    );
    expect(await f.store.load()).toEqual({ kind: "ready", record: appended });
  });

  it("refuses fifth retired signer retention before replacement and persists fairness/counter reservations per original signer", async () => {
    const full = worstEvidenceRecord(5);
    const record: StudentSessionRecord = {
      ...full,
      generation: 1,
      lastReservedCounter: 30,
      evidence: {
        ...full.evidence,
        retiredSigners: full.evidence.retiredSigners.map((signer) => ({
          ...signer,
          lastReservedCounter: 20,
        })),
      },
    };
    expect(retainNativeEvidenceSigner(record)).toBeNull();
    const f = fixture();
    f.setBytes(persisted(record));
    await f.store.load();
    const nextKey = record.evidence.retiredSigners[1]!.device.keyThumbprint;
    const reserved = await f.store.commitDurably(1, {
      ...record,
      evidence: {
        ...record.evidence,
        lastAttemptedSigner: nextKey,
        retiredSigners: record.evidence.retiredSigners.map((signer) =>
          signer.device.keyThumbprint === nextKey
            ? { ...signer, lastReservedCounter: 21 }
            : signer,
        ),
      },
    });
    const restarted = createStudentSessionStore(f.options);
    expect(await restarted.load()).toEqual({ kind: "ready", record: reserved });
    expect(reserved.evidence.pendingBatches).toEqual(
      record.evidence.pendingBatches,
    );
    expect(reserved.lastReservedCounter).toBe(30);
    const bytes = f.getBytes();
    await expect(
      restarted.commitDurably(2, {
        ...reserved,
        evidence: {
          ...reserved.evidence,
          retiredSigners: record.evidence.retiredSigners,
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(bytes);
  });

  it("refuses replacement before quarantine when acknowledged nonlatest origins still reference the current signer at capacity", async () => {
    const full = worstEvidenceRecord(5);
    const record = {
      ...full,
      generation: 7,
      evidence: { ...full.evidence, pendingBatches: [] },
    };
    expect(
      record.nativeProtection!.latestAttempt!.scope.deviceSessionId,
    ).not.toBe(record.device.deviceSessionId);
    const f = fixture();
    f.setBytes(persisted(record));
    const loaded = await f.store.load();
    if (loaded.kind !== "ready")
      throw new Error("Expected valid decoded evidence record");
    expect(retainNativeEvidenceSigner(loaded.record) === null).toBe(true);
    expect(f.getBytes()).toEqual(persisted(record));
    expect(f.events).not.toContain("quarantine");
    expect(f.events).not.toContain("write");
    const pruned = await f.store.commitDurably(
      7,
      pruneNativeEvidence(loaded.record),
    );
    expect(
      pruned.evidence.origins.some(
        (origin) =>
          origin.originalKeyThumbprint === pruned.device.keyThumbprint,
      ),
    ).toBe(false);
    expect(retainNativeEvidenceSigner(pruned)).toEqual(pruned.evidence);
  });

  it("retains an acknowledged nonlatest original signer below capacity with its exact high-water counter", async () => {
    const full = worstEvidenceRecord(5);
    const removedOrigin = full.evidence.origins[1]!;
    const facts = full.nativeProtection!.facts.filter(
      (fact) => fact.attemptId !== removedOrigin.attemptId,
    );
    const kept = new Set(facts.map((fact) => fact.eventId));
    const record: StudentSessionRecord = {
      ...full,
      generation: 1,
      lastReservedCounter: 22,
      nativeProtection: { ...full.nativeProtection!, facts },
      evidence: {
        ...full.evidence,
        pendingBatches: [],
        origins: full.evidence.origins.filter(
          (origin) => origin !== removedOrigin,
        ),
        acknowledgments: full.evidence.acknowledgments.filter((ack) =>
          kept.has(ack.eventId),
        ),
        retiredSigners: full.evidence.retiredSigners.filter(
          (signer) =>
            signer.device.keyThumbprint !== removedOrigin.originalKeyThumbprint,
        ),
      },
    };
    const f = fixture();
    f.setBytes(persisted(record));
    const loaded = await f.store.load();
    if (loaded.kind !== "ready")
      throw new Error("Expected decoded referenced signer");
    const retained = retainNativeEvidenceSigner(loaded.record);
    expect(retained?.retiredSigners.at(-1)?.lastReservedCounter).toBe(22);
    if (retained === null) throw new Error("Expected available retention slot");
    const replacement = pending("uncertain");
    if (replacement.pending?.kind !== "join") throw new Error("fixture");
    const generation = await f.store.preserveForTargetedRecovery(1);
    const next = {
      ...replacement,
      pending: {
        ...replacement.pending,
        admissionMode: "readmission" as const,
      },
      nativeProtection: record.nativeProtection,
      evidence: retained,
    };
    await expect(
      f.store.commitDurably(generation, {
        ...next,
        evidence: {
          ...retained,
          retiredSigners: retained.retiredSigners.map((signer) =>
            signer.device.keyThumbprint === record.device.keyThumbprint
              ? { ...signer, lastReservedCounter: 21 }
              : signer,
          ),
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toBeNull();
    expect(f.preserved).toEqual([persisted(record)]);
    const written = await f.store.commitDurably(generation, next);
    expect(written.evidence.retiredSigners.at(-1)?.lastReservedCounter).toBe(
      22,
    );
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });

  it("rejects an over-limit encrypted successor without replacing the prior record", async () => {
    const f = fixture();
    const original = pending();
    f.setBytes(persisted({ ...original, generation: 1 }));
    const store = createStudentSessionStore({
      ...f.options,
      codec: {
        ...f.options.codec,
        encryptString: () => Buffer.alloc(64 * 1024 + 1),
      },
    });
    await store.load();
    await expect(store.commitDurably(1, original)).rejects.toThrow();
    expect(f.getBytes()).toEqual(persisted({ ...original, generation: 1 }));
    expect(f.events).not.toContain("write");
  });

  it("enforces the plaintext ceiling before encryption even with an oversized injected configuration", async () => {
    const f = fixture();
    // The production configuration parser is stricter. The storage boundary
    // independently bounds even a caller-supplied configuration of this size.
    const apiOrigin = `https://${"a".repeat(48 * 1024)}.invalid`;
    const store = createStudentSessionStore({ ...f.options, apiOrigin });
    await store.load();
    await expect(
      store.commitDurably(0, { ...pending(), apiOrigin }),
    ).rejects.toThrow();
    expect(f.getBytes()).toBeNull();
    expect(f.events).not.toContain("encrypt");
    expect(f.events).not.toContain("write");
  });
});

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
    const next = pending("uncertain");
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
          ? { ...base, version: 5 }
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
      const original = persisted(mutated);
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
      let record = kind === "join" ? pending("uncertain") : admitted();
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
      delete legacy.evidence;
      if (record.pending?.kind === "join") {
        const legacyJoin: Record<string, unknown> = { ...record.pending };
        delete legacyJoin.outcome;
        legacy.pending = legacyJoin;
      }
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
      if (kind === "future") record.version = 5;
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
      evidence: evidenceFor(admittedRecord, journal),
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
      evidence: prior.evidence,
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
      evidence: evidenceFor(record, journal),
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
      ...pending("uncertain"),
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
      {
        ...base,
        kind: "preflight_failure",
        receipt: Object.freeze({ attemptId: base.attemptId }),
        cause: "application_policy",
        categories: preflightJournal(record.current.scope).facts[0]!.categories,
      },
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
      if ("receipt" in parsed && "receipt" in command) {
        expect(parsed.receipt).toBe(command.receipt);
        expect(parsed.categories).not.toBe(command.categories);
        expect(Object.isFrozen(parsed.categories.aac)).toBe(true);
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

describe("preflight failure history", () => {
  it.each(["before", "after"] as const)(
    "preserves the actual v4 publication after an uncertain %s first-failure write",
    async (when) => {
      const f = fixture();
      await f.store.load();
      const base = await f.store.commitDurably(0, admitted());
      const journal = preflightJournal(base.current!.scope);
      const successor = {
        ...base,
        nativeProtection: journal,
        evidence: evidenceFor(base, journal),
      };
      f.fail(when);
      await expect(
        f.store.commitDurably(base.generation, successor),
      ).rejects.toThrow();
      const retained = f.getBytes();
      f.fail("none");
      await f.store.close();
      const reopened = createStudentSessionStore(f.options);
      const expected =
        when === "before"
          ? base
          : { ...successor, generation: base.generation + 1 };
      expect(await reopened.load()).toEqual({
        kind: "ready",
        record: expected,
      });
      expect(expected.evidence.acknowledgments).toEqual([]);
      expect(expected.current).toEqual(base.current);
      expect(f.getBytes()).toEqual(retained);
    },
  );

  it("saves original-scope failure history after admission is cleared without restoring it", async () => {
    const f = fixture();
    await f.store.load();
    const base = admitted();
    const journal = preflightJournal(base.current!.scope);
    const terminal = await f.store.commitDurably(0, {
      ...base,
      current: null,
      pending: null,
      terminal: true,
      lastReservedCounter: 20,
    });
    const written = await f.store.commitDurably(terminal.generation, {
      ...terminal,
      nativeProtection: journal,
      evidence: evidenceFor(terminal, journal),
    });
    expect(written.current).toBeNull();
    expect(written.pending).toBeNull();
    expect(written.terminal).toBe(true);
    expect(written.lastReservedCounter).toBe(20);
    expect(written.nativeProtection).toEqual(journal);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });

  it("fits 32 preflight facts and five signers under v4 bounds while refusing a 33rd fact before encryption", async () => {
    const original = worstEvidenceRecord(16);
    const journal = original.nativeProtection!;
    const facts: ProtectionFact[] = journal.facts.map((fact) => ({
      ...fact,
      slot: fact.slot === "engaging" ? "failure" : "cleanup",
      phase: "failed",
      nativeEvent: null,
      nativeSequence: null,
      cause: fact.slot === "engaging" ? "application_policy" : "none",
      categories: {
        ...longestCategories,
        aac: { status: "pending", code: "awaiting_native_begin" },
      },
    }));
    let record: StudentSessionRecord = {
      ...original,
      generation: 7,
      nativeProtection: {
        ...journal,
        facts,
        latestAttempt: {
          ...journal.latestAttempt!,
          phase: "failed",
          nativeDisposition: "disposed_without_terminal_observation",
          nativeSequence: null,
          cleanup: "complete",
          abandonment: "none",
        },
      },
      evidence: {
        ...original.evidence,
        pendingBatches: [],
        acknowledgments: [],
      },
    };
    const batches = record.evidence.origins.map((origin) =>
      batchFor(record, origin.attemptId),
    );
    const digests = new Map(
      batches.flatMap((batch) =>
        batch.events.map(
          (event) => [event.eventId, event.contentDigest] as const,
        ),
      ),
    );
    record = {
      ...record,
      evidence: {
        ...record.evidence,
        pendingBatches: original.evidence.pendingBatches.map((prior) =>
          batches.find((batch) => batch.attemptId === prior.attemptId)!,
        ),
        acknowledgments: original.evidence.acknowledgments.map((ack) => ({
          ...ack,
          contentDigest: digests.get(ack.eventId)!,
        })),
      },
    };
    expect(record.nativeProtection?.facts).toHaveLength(32);
    expect(record.evidence.origins).toHaveLength(16);
    expect(record.evidence.retiredSigners).toHaveLength(4);
    expect(protectionFactReservation).toBe(8);
    const bytes = persisted(record);
    expect(bytes.byteLength - Buffer.byteLength("synthetic:")).toBeLessThan(
      48 * 1024,
    );
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    const f = fixture();
    f.setBytes(bytes);
    expect(await f.store.load()).toEqual({ kind: "ready", record });
    const next = preflightJournal(record.current!.scope);
    const extra: ProtectionFact = {
      ...next.facts[0]!,
      sequence: 33,
      attemptId: identifier(999),
      eventId: identifier(9999),
    };
    const encryptions = f.events.filter((event) => event === "encrypt").length;
    await expect(
      f.store.commitDurably(record.generation, {
        ...record,
        nativeProtection: {
          ...next,
          revision: journal.revision + 1,
          nextFactSequence: 34,
          latestAttempt: { ...next.latestAttempt!, attemptId: extra.attemptId },
          facts: [...facts, extra],
        },
        evidence: {
          ...record.evidence,
          origins: [
            ...record.evidence.origins,
            {
              attemptId: extra.attemptId,
              scope: extra.scope,
              originalKeyThumbprint: record.device.keyThumbprint,
              originBuild,
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(f.events.filter((event) => event === "encrypt")).toHaveLength(
      encryptions,
    );
    expect(f.getBytes()).toEqual(bytes);
    expect(await f.store.load()).toEqual({ kind: "ready", record });
  });

  it("refuses cleanup when the next fact cursor would exceed the safe integer limit", async () => {
    const f = fixture();
    await f.store.load();
    const record = admitted();
    const journal = preflightJournal(record.current!.scope);
    const first: ProtectionFact = {
      ...journal.facts[0]!,
      sequence: Number.MAX_SAFE_INTEGER - 1,
    };
    const written = await f.store.commitDurably(0, {
      ...record,
      nativeProtection: {
        ...journal,
        facts: [first],
        nextFactSequence: Number.MAX_SAFE_INTEGER,
      },
      evidence: evidenceFor(record, journal),
    });
    const before = f.getBytes();
    const complete = preflightJournal(
      record.current!.scope,
      "application_policy",
      "unavailable",
      true,
    );
    await expect(
      f.store.commitDurably(written.generation, {
        ...written,
        nativeProtection: {
          ...complete,
          facts: [
            first,
            { ...complete.facts[1]!, sequence: Number.MAX_SAFE_INTEGER },
          ],
          nextFactSequence: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(before);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
  });

  it("refuses unrelated causes, category pairs, extra fields and malformed report receipts without inspecting receipt contents", () => {
    let inspected = 0;
    const receipt = Object.defineProperty({}, "attemptId", {
      get() {
        inspected += 1;
        throw new Error("opaque receipt field must not be read");
      },
    });
    const categories = preflightJournal(admitted().current!.scope).facts[0]!
      .categories;
    const command = {
      kind: "preflight_failure",
      attemptId: identifier(10),
      expectedProtectionRevision: 0,
      receipt,
      cause: "application_policy",
      categories,
    };
    const parsed = parseProtectionTransition(command);
    expect(parsed !== null && "receipt" in parsed ? parsed.receipt : null).toBe(
      receipt,
    );
    for (const delta of [
      { receipt: null },
      { receipt: [] },
      { receipt: "copied receipt" },
      { cause: "native_failure" },
      { cause: "none" },
      { cause: "shortcut_unavailable" },
      { categories: {} },
      { nativeEvent: null },
      { authority: {} },
      {
        categories: { ...categories, aac: { status: "pending", code: "none" } },
      },
      {
        categories: {
          ...categories,
          aac: { status: "confirmed", code: "none" },
        },
      },
      {
        categories: {
          ...categories,
          applications: {
            status: "failed",
            code: "application_observation_unavailable",
          },
        },
      },
      {
        categories: {
          ...categories,
          applications: {
            status: "unavailable",
            code: "prohibited_application",
          },
        },
      },
      {
        categories: {
          ...categories,
          persistence: { status: "failed", code: "prohibited_application" },
        },
      },
    ])
      expect(parseProtectionTransition({ ...command, ...delta })).toBeNull();
    const accessor = Object.defineProperty({ ...command }, "receipt", {
      get() {
        inspected += 1;
        return receipt;
      },
    });
    expect(parseProtectionTransition(accessor)).toBeNull();
    expect(inspected).toBe(0);
  });

  it("rejects mixed prefixes and inconsistent summaries even with a valid v4 checksum", async () => {
    const record = admitted();
    const scope = record.current!.scope;
    const pending = preflightJournal(scope);
    const complete = preflightJournal(
      scope,
      "application_policy",
      "unavailable",
      true,
    );
    const first = pending.facts[0]!;
    const cleanup = complete.facts[1]!;
    const variants: StoredNativeProtection[] = [
      ...["engaging", "recovery_required"].map(
        (phase) =>
          ({
            ...pending,
            latestAttempt: { ...pending.latestAttempt!, phase },
          }) as StoredNativeProtection,
      ),
      ...["pending", "unknown", "active"].map(
        (nativeDisposition) =>
          ({
            ...pending,
            latestAttempt: { ...pending.latestAttempt!, nativeDisposition },
          }) as StoredNativeProtection,
      ),
      ...["not_requested", "unconfirmed", "complete"].map(
        (cleanup) =>
          ({
            ...pending,
            latestAttempt: { ...pending.latestAttempt!, cleanup },
          }) as StoredNativeProtection,
      ),
      {
        ...pending,
        latestAttempt: { ...pending.latestAttempt!, nativeSequence: 1 },
      },
      {
        ...complete,
        latestAttempt: { ...complete.latestAttempt!, cleanup: "pending" },
      },
      {
        ...complete,
        latestAttempt: {
          ...complete.latestAttempt!,
          nativeDisposition: "not_started",
        },
      },
      ...completeJournal(scope, 1)
        .facts.filter((fact) => fact.slot !== "cleanup")
        .map((later) => ({
          ...pending,
          revision: 2,
          nextFactSequence: 3,
          facts: [
            first,
            {
              ...later,
              sequence: 2,
              eventId: identifier(102),
              attemptId: first.attemptId,
              scope,
            },
          ],
        })),
      ...[
        { phase: "ended" },
        { cause: "application_policy" },
        { nativeSequence: 1 },
        {
          categories: {
            ...cleanup.categories,
            aac: { status: "confirmed", code: "none" },
          },
        },
      ].map(
        (delta) =>
          ({
            ...complete,
            facts: [first, { ...cleanup, ...delta }],
          }) as StoredNativeProtection,
      ),
      {
        ...complete,
        revision: 3,
        nextFactSequence: 4,
        facts: [
          first,
          cleanup,
          { ...cleanup, sequence: 3, eventId: identifier(103) },
        ],
      },
      {
        ...pending,
        revision: 2,
        nextFactSequence: 3,
        latestAttempt: {
          ...protection(scope).latestAttempt!,
          attemptId: identifier(11),
        },
        facts: [
          first,
          {
            ...protection(scope).facts[0]!,
            sequence: 2,
            eventId: identifier(102),
            attemptId: identifier(11),
          },
        ],
      },
    ];
    for (const nativeProtection of variants) {
      const f = fixture();
      const bytes = persisted({
        ...record,
        generation: 7,
        nativeProtection,
        evidence: evidenceFor(record, nativeProtection),
      });
      f.setBytes(bytes);
      expect(await f.store.load()).toEqual({
        kind: "recovery_required",
        generation: 0,
      });
      expect(f.getBytes()).toEqual(bytes);
      expect(f.events).not.toContain("write");
      expect(f.events).not.toContain("quarantine");
    }
  });

  it("keeps the original preflight signer and first fact through durable ACK, targeted replacement and late cleanup", async () => {
    const f = fixture();
    await f.store.load();
    const base = admitted();
    const journal = preflightJournal(base.current!.scope);
    const initial = {
      ...base,
      nativeProtection: journal,
      evidence: evidenceFor(base, journal),
    };
    const batch = batchFor(initial, journal.latestAttempt!.attemptId);
    const first = await f.store.commitDurably(0, {
      ...initial,
      evidence: { ...initial.evidence, pendingBatches: [batch] },
    });
    const acknowledged = await f.store.commitDurably(first.generation, {
      ...first,
      evidence: {
        ...first.evidence,
        pendingBatches: [],
        acknowledgments: batch.events.map((event) => ({
          ...event,
          receivedAt: "2026-09-08T12:34:56.000001Z",
        })),
      },
    });
    const evidence = retainNativeEvidenceSigner(acknowledged);
    expect(evidence?.retiredSigners).toEqual([
      { device: acknowledged.device, lastReservedCounter: 19 },
    ]);
    if (evidence === null)
      throw new Error("Expected original signer retention");
    const replacement = pending("uncertain");
    if (replacement.pending?.kind !== "join") throw new Error("fixture");
    const generation = await f.store.preserveForTargetedRecovery(
      acknowledged.generation,
    );
    const replaced = await f.store.commitDurably(generation, {
      ...replacement,
      pending: { ...replacement.pending, admissionMode: "readmission" },
      nativeProtection: acknowledged.nativeProtection,
      evidence,
    });
    const completed = await f.store.commitDurably(replaced.generation, {
      ...replaced,
      nativeProtection: preflightJournal(
        journal.latestAttempt!.scope,
        "application_policy",
        "unavailable",
        true,
      ),
    });
    expect(completed.nativeProtection?.facts[0]).toEqual(journal.facts[0]);
    expect(completed.evidence.origins).toEqual(first.evidence.origins);
    expect(completed.evidence.acknowledgments).toEqual(
      acknowledged.evidence.acknowledgments,
    );
    expect(batchFor(completed, batch.attemptId).originalKeyThumbprint).toBe(
      first.device.keyThumbprint,
    );
    expect(completed.device.keyThumbprint).not.toBe(first.device.keyThumbprint);
    expect(pruneNativeEvidence(completed).nativeProtection?.facts).toEqual(
      completed.nativeProtection?.facts,
    );
    const before = f.getBytes();
    await expect(
      f.store.commitDurably(completed.generation, {
        ...completed,
        evidence: {
          ...completed.evidence,
          origins: completed.evidence.origins.map((origin) => ({
            ...origin,
            originBuild: { kind: "unverified_build" },
          })),
        },
      }),
    ).rejects.toThrow();
    expect(f.getBytes()).toEqual(before);
    expect(await f.store.load()).toEqual({ kind: "ready", record: completed });
  });

  it.each([
    ["application_policy", "failed"],
    ["application_policy", "unavailable"],
    ["shortcut_unavailable", "failed"],
    ["shortcut_unavailable", "unavailable"],
  ] as const)(
    "persists %s/%s and later owned cleanup through exact v4 reloads without native claims",
    async (cause, status) => {
      const f = fixture();
      await f.store.load();
      const record = admitted();
      const scope = record.current!.scope;
      const journal = preflightJournal(scope, cause, status);
      const first = await f.store.commitDurably(0, {
        ...record,
        nativeProtection: journal,
        evidence: evidenceFor(record, journal),
      });
      expect(first.nativeProtection).toEqual(journal);
      expect(f.getBytes()).toEqual(persisted(first));
      await f.store.close();
      const reopened = createStudentSessionStore(f.options);
      expect(await reopened.load()).toEqual({ kind: "ready", record: first });
      const finished = await reopened.commitDurably(first.generation, {
        ...first,
        nativeProtection: preflightJournal(scope, cause, status, true),
      });
      expect(finished.nativeProtection?.facts[0]).toEqual(journal.facts[0]);
      expect(finished.evidence).toEqual(first.evidence);
      expect(finished.current).toEqual(record.current);
      expect(finished.lastReservedCounter).toBe(19);
      expect(f.getBytes()).toEqual(persisted(finished));
      await reopened.close();
      expect(await createStudentSessionStore(f.options).load()).toEqual({
        kind: "ready",
        record: finished,
      });
    },
  );

  it("snapshots the selected failure while retaining the original opaque report receipt", () => {
    const receipt = Object.freeze({ attemptId: identifier(10) });
    const categories = {
      ...engagingCategories,
      applications: {
        status: "unavailable",
        code: "application_observation_unavailable",
      },
    };
    const parsed = parseProtectionTransition({
      kind: "preflight_failure",
      attemptId: identifier(10),
      expectedProtectionRevision: 0,
      receipt,
      cause: "application_policy",
      categories,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("preflight_failure");
    expect(parsed !== null && "receipt" in parsed ? parsed.receipt : null).toBe(
      receipt,
    );
    expect(
      parsed !== null && "categories" in parsed ? parsed.categories : null,
    ).toEqual(categories);
    expect(
      parsed !== null && "categories" in parsed ? parsed.categories : null,
    ).not.toBe(categories);
    expect(Object.isFrozen(parsed)).toBe(true);
    categories.applications.code = "prohibited_application";
    expect(
      parsed !== null && "categories" in parsed
        ? parsed.categories.applications.code
        : null,
    ).toBe("application_observation_unavailable");
  });
});
