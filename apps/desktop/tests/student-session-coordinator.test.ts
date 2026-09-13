import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NativeEvidenceOriginBuild,
  StudentSessionScope,
} from "@desmoslock/contracts";

import { createStudentSessionCoordinator } from "../src/main/student-session-coordinator.js";
import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  type NativeStudentRecordHandle,
  type ProtectionFact,
  type ProtectionTransition,
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

function syntheticStoredRecord(value: object): Buffer {
  const payload: Record<string, unknown> = { ...value };
  delete payload.integritySha256;
  const stored =
    payload.version === 4 || payload.version === 5
      ? {
          ...payload,
          integritySha256: createHash("sha256")
            .update(JSON.stringify(payload), "utf8")
            .digest("hex"),
        }
      : payload;
  return Buffer.from(`synthetic:${JSON.stringify(stored)}`);
}

function fixtureServer() {
  return {
    joins: new Map<string, Record<string, unknown>>(),
    receipts: new Map<
      string,
      { eventId: string; contentDigest: string; receivedAt: string }
    >(),
    epoch: 0,
  };
}

function harness(
  server = fixtureServer(),
  originBuild?: NativeEvidenceOriginBuild,
) {
  const crypto = createStudentSessionCrypto(configuration);
  let bytes: Buffer | null = null;
  const preserved: Buffer[] = [];
  let elapsed = 0;
  let writes = 0;
  let failWrite = 0;
  let failAfterPublication = false;
  let droppedJoin = false;
  let denied = false;
  let denialRoute: string | null = null;
  let joinReply: (() => Response) | null = null;
  let block: Promise<void> | null = null;
  let blockedFetch: Promise<Response> | null = null;
  let quarantineFailsOnce = false;
  let writeLatency = 0;
  let fetchLatency = 0;
  let beforeResponse: ((route: string) => Promise<void>) | null = null;
  const evidenceResults = new Map<string, "denied" | "unavailable" | "lost">();
  let evidenceReply: ((reply: Record<string, unknown>) => Response) | null =
    null;
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
    if (denied && (denialRoute === null || denialRoute === route))
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
      if (joinReply !== null) return joinReply();
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
      const joinReceipt = server.joins.get(pending.requestId) ?? {
        status: "accepted",
        code: "STUDENT_SESSION_ACCEPTED",
        requestId: pending.requestId,
        logicalOperationDigest,
        scope: {
          schoolId: "30000000-0000-4000-8000-000000000001",
          testId: "40000000-0000-4000-8000-000000000001",
          studentSessionId: "50000000-0000-4000-8000-000000000001",
          deviceSessionId: durable.device.deviceSessionId,
          epoch: ++server.epoch,
        },
        sessionRevision: pending.admissionMode === "initial" ? 1 : 4,
        syntheticDisplayName: "Student ABC",
        serverNowMs,
        capabilityIssuedAtMs: serverNowMs,
        capabilityExpiresAtMs: serverNowMs + 300_000,
        reconnectExpiresAtMs: serverNowMs + 900_000,
        allowedIntents: ["state.read", "session.forfeit"],
      };
      server.joins.set(pending.requestId, joinReceipt);
      if (droppedJoin) {
        droppedJoin = false;
        return Response.json(unavailable, { status: 503 });
      }
      return Response.json({ ...joinReceipt, serverNowMs });
    }
    if (route === "evidence") {
      const signer = [
        {
          device: durable.device,
          lastReservedCounter: durable.lastReservedCounter,
        },
        ...durable.evidence.retiredSigners,
      ].find((candidate) => candidate.device.publicKey === body.publicKey);
      expect(signer).toBeDefined();
      const pending = durable.evidence.pendingBatches.find(
        (candidate) =>
          candidate.originalKeyThumbprint === signer!.device.keyThumbprint,
      );
      expect(pending).toBeDefined();
      expect(body.batchDigest).toBe(pending!.batchDigest);
      expect(durable.evidence.lastAttemptedSigner).toBe(
        signer!.device.keyThumbprint,
      );
      const facts = body.facts as ProtectionFact[];
      expect(facts.map((fact) => fact.eventId)).toEqual(
        pending!.events.map((event) => event.eventId),
      );
      const scope = body.scope as StudentSessionScope;
      expect(scope.deviceSessionId).toBe(signer!.device.deviceSessionId);
      const proof = body.deviceProof as { counter: number; signature: string };
      expect(proof.counter).toBe(signer!.lastReservedCounter);
      // Verify the real Ed25519 signature independently over the locked wire
      // array; the synthetic responder grants no admission or native authority.
      expect(
        verify(
          null,
          Buffer.from(
            JSON.stringify([
              "desmoslock/student-evidence-proof/v1",
              configuration.url,
              "evidence.ingest",
              [
                scope.schoolId,
                scope.testId,
                scope.studentSessionId,
                scope.deviceSessionId,
                scope.epoch,
              ],
              signer!.device.keyThumbprint,
              body.batchDigest,
              proof.counter,
            ]),
          ),
          createPublicKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b6570032100", "hex"),
              Buffer.from(signer!.device.publicKey, "base64url"),
            ]),
            format: "der",
            type: "spki",
          }),
          Buffer.from(proof.signature, "base64url"),
        ),
      ).toBe(true);
      const outcome = evidenceResults.get(signer!.device.keyThumbprint);
      if (outcome === "denied")
        return Response.json(
          { status: "denied", code: "STUDENT_SESSION_DENIED" },
          { status: 403 },
        );
      if (outcome === "unavailable")
        return Response.json(unavailable, { status: 503 });
      const acknowledged = pending!.events.map((event) => {
        const prior = server.receipts.get(event.eventId);
        if (prior !== undefined) {
          expect(prior.contentDigest).toBe(event.contentDigest);
          return prior;
        }
        const receipt = {
          ...event,
          receivedAt: `2026-09-08T14:00:00.${String(server.receipts.size + 1).padStart(6, "0")}Z`,
        };
        server.receipts.set(event.eventId, receipt);
        return receipt;
      });
      if (outcome === "lost")
        return Response.json(unavailable, { status: 503 });
      const reply = {
        status: "accepted",
        code: "STUDENT_EVIDENCE_ACCEPTED",
        scope,
        batchDigest: body.batchDigest,
        acceptedProofCounter: proof.counter,
        acknowledged,
      };
      return evidenceReply === null
        ? Response.json(reply)
        : evidenceReply(reply);
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
    ...(originBuild === undefined ? {} : { originBuild }),
  };
  const coordinator = createStudentSessionCoordinator(options);
  return {
    coordinator,
    options,
    server,
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
    deny(route?: string) {
      denied = true;
      denialRoute = route ?? null;
    },
    allow() {
      denied = false;
    },
    replyToJoin(reply: () => Response) {
      joinReply = reply;
    },
    evidenceResult(
      signer: string,
      result: "denied" | "unavailable" | "lost" | null,
    ) {
      if (result === null) evidenceResults.delete(signer);
      else evidenceResults.set(signer, result);
    },
    evidenceReply(
      callback: ((reply: Record<string, unknown>) => Response) | null,
    ) {
      evidenceReply = callback;
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
const bootA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const bootB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
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

async function beginEvidenceAttempt(
  f: ReturnType<typeof harness>,
  id = attemptId,
) {
  const authority = await admitForProtection(f);
  const revision =
    f.coordinator.readProtectionContext().protection?.revision ?? 0;
  expect(
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      engagingBootSessionId: bootA,
      attemptId: id,
      expectedProtectionRevision: revision,
      authority,
      categories: preflightCategories,
    }),
  ).toEqual({ status: "committed", protectionRevision: revision + 1 });
  return authority;
}

async function completeEvidenceAttempt(
  f: ReturnType<typeof harness>,
  id = attemptId,
) {
  await beginEvidenceAttempt(f, id);
  let revision = f.record().nativeProtection!.revision;
  expect(
    await f.coordinator.commitProtectionTransition({
      kind: "native_terminal",
      attemptId: id,
      expectedProtectionRevision: revision,
      event: {
        type: "failed_to_begin",
        attemptId: id,
        sequence: 1,
        code: "native_failed_to_begin",
      },
    }),
  ).toEqual({ status: "committed", protectionRevision: ++revision });
  expect(
    await f.coordinator.commitProtectionTransition({
      kind: "cleanup",
      attemptId: id,
      expectedProtectionRevision: revision,
      outcome: "complete",
    }),
  ).toEqual({ status: "committed", protectionRevision: revision + 1 });
}

async function rebindEvidenceDevice(f: ReturnType<typeof harness>) {
  const prior = f.record().device;
  await f.coordinator.forfeit(f.coordinator.readView().revision);
  expect(f.record().terminal).toBe(true);
  await f.coordinator.beginTargetedReadmission(
    code,
    f.coordinator.readView().revision,
  );
  expect(f.coordinator.readView().phase).toBe("active");
  expect(f.record().device.keyThumbprint).not.toBe(prior.keyThumbprint);
  return prior;
}

function evidenceRequests(f: ReturnType<typeof harness>) {
  return f.requests.filter((request) => request.route === "evidence");
}

async function anchoredPrior() {
  const original = harness();
  await beginEvidenceAttempt(original);
  const bytes = original.storedBytes()!;
  await original.coordinator.dispose();
  const restored = harness(original.server);
  restored.setBytes(bytes);
  await restored.coordinator.initialize();
  return restored;
}

const bootRecovery = {
  attemptId,
  expectedProtectionRevision: 1,
  observedBootSessionId: bootB,
};

function unrelatedBootRecord(record: StudentSessionRecord): string {
  const raw = { ...record } as Record<string, unknown>;
  delete raw.generation;
  delete raw.integritySha256;
  const protection = { ...record.nativeProtection! } as Record<string, unknown>;
  delete protection.revision;
  delete protection.localBootRecovery;
  return JSON.stringify({ ...raw, nativeProtection: protection });
}

describe("local prior-boot recovery", () => {
  it("never converts a recovered prior-process terminal with pending cleanup into actual cleanup", async () => {
    const first = harness();
    await beginEvidenceAttempt(first);
    await first.coordinator.commitProtectionTransition({
      kind: "native_terminal",
      attemptId,
      expectedProtectionRevision: 1,
      event: {
        type: "failed_to_begin",
        attemptId,
        sequence: 1,
        code: "native_failed_to_begin",
      },
    });
    const saved = first.storedBytes()!;
    await first.coordinator.dispose();
    const f = harness(first.server);
    f.setBytes(saved);
    await f.coordinator.initialize();
    expect(
      await f.coordinator.commitBootRecovery({
        ...bootRecovery,
        expectedProtectionRevision: 2,
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    const before = f.storedBytes();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "cleanup",
        attemptId,
        expectedProtectionRevision: 3,
        outcome: "complete",
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.storedBytes()).toEqual(before);
    expect(f.record().nativeProtection?.latestAttempt?.cleanup).toBe("pending");
  });

  it("queues local recovery behind evidence settlement and preserves the resulting ACK and reserved counter", async () => {
    const f = await anchoredPrior();
    const hold = deferred();
    const entered = deferred();
    f.beforeResponse(async (route) => {
      if (route === "evidence") {
        entered.resolve();
        await hold.promise;
      }
    });
    const delivery = f.coordinator.flushEvidence();
    await entered.promise;
    const pending = structuredClone(f.record());
    const recovery = f.coordinator.commitBootRecovery(bootRecovery);
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
    hold.resolve();
    await delivery;
    expect(await recovery).toEqual({
      status: "committed",
      protectionRevision: 2,
    });
    expect(f.record().lastReservedCounter).toBe(pending.lastReservedCounter);
    expect(f.record().nativeProtection?.facts).toEqual(
      pending.nativeProtection?.facts,
    );
    expect(f.record().evidence.pendingBatches).toHaveLength(0);
    expect(f.record().evidence.acknowledgments).toHaveLength(1);
    expect(f.requests.map((request) => request.route)).toEqual(["evidence"]);
  });

  it("keeps a held recovery owned through shutdown and never returns a late release", async () => {
    const f = await anchoredPrior();
    const hold = deferred();
    f.blockWrite(hold.promise);
    const recovery = f.coordinator.commitBootRecovery(bootRecovery);
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.startsWith("write:"))).toBe(true),
    );
    expect(await f.coordinator.dispose()).toBe(false);
    expect(f.events).not.toContain("close");
    hold.resolve();
    expect(await recovery).toEqual({ status: "unavailable" });
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
    expect(f.events).not.toContain("close");
    expect(f.requests).toEqual([]);
  });

  it("allows a fresh preflight after recovery while retaining the unresolved older attempt without cleanup", async () => {
    const f = await anchoredPrior();
    await f.coordinator.commitBootRecovery(bootRecovery);
    const first = f.record().nativeProtection!.facts[0];
    await f.coordinator.joinInitial(code);
    expect(f.record().nativeProtection!.facts).toHaveLength(1);
    await f.coordinator.retryPending();
    const admission = f.coordinator.readProtectionContext().admission!;
    const fresh = await f.coordinator.readFreshAdmission(admission);
    if (fresh.status !== "fresh") throw new Error("Expected new fresh read");
    const nextId = "60000000-0000-4000-8000-000000000002";
    const receipt = f.coordinator.reservePreflightReport(
      fresh.authority,
      nextId,
    );
    expect(receipt).not.toBeNull();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "preflight_failure",
        attemptId: nextId,
        receipt: receipt!,
        expectedProtectionRevision: 2,
        cause: "shortcut_unavailable",
        categories: {
          ...preflightCategories,
          shortcuts: {
            status: "failed",
            code: "emergency_shortcut_unavailable",
          },
        },
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    expect(f.record().nativeProtection?.facts.map((fact) => fact.slot)).toEqual(
      ["engaging", "failure"],
    );
    expect(f.record().nativeProtection?.facts[0]).toEqual(first);
    expect(
      f.record().nativeProtection?.localBootRecovery.anchors[0]?.observation
        ?.observedBootSessionId,
    ).toBe(bootB);
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "none",
    });
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
  });

  it("retains a fully acknowledged recovered-unknown signer through targeted rebind and later engaging", async () => {
    const f = await anchoredPrior();
    await f.coordinator.commitBootRecovery(bootRecovery);
    await f.coordinator.flushEvidence();
    expect(f.record().evidence.acknowledgments).toHaveLength(1);
    await f.coordinator.retryPending();
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    const original = structuredClone(f.record());
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.coordinator.readView().phase).toBe("active");
    const fresh = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    if (fresh.status !== "fresh") throw new Error("Expected rebound grant");
    const nextId = "60000000-0000-4000-8000-000000000002";
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        attemptId: nextId,
        authority: fresh.authority,
        expectedProtectionRevision: 2,
        engagingBootSessionId: bootB,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "committed", protectionRevision: 3 });
    const next = f.record();
    expect(next.nativeProtection?.facts.map((fact) => fact.slot)).toEqual([
      "engaging",
      "engaging",
    ]);
    expect(next.nativeProtection?.facts[0]).toEqual(
      original.nativeProtection?.facts[0],
    );
    expect(next.evidence.origins[0]).toEqual(original.evidence.origins[0]);
    expect(next.evidence.acknowledgments).toEqual(
      original.evidence.acknowledgments,
    );
    expect(next.evidence.retiredSigners).toContainEqual({
      device: original.device,
      lastReservedCounter: original.lastReservedCounter,
    });
    expect(next.nativeProtection?.localBootRecovery.anchors).toHaveLength(2);
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "none",
    });
    expect(
      await f.coordinator.commitBootRecovery({
        attemptId: nextId,
        expectedProtectionRevision: 3,
        observedBootSessionId: bootA,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it.each([
    bootA,
    "",
    bootB.toUpperCase(),
    "wrong",
    bootB + "\n",
    bootB + "\r",
    null,
    5,
    {},
  ])(
    "refuses same or malformed observed boot %j without any write or egress",
    async (observedBootSessionId) => {
      const f = await anchoredPrior();
      const before = f.storedBytes();
      const events = [...f.events];
      expect(
        await f.coordinator.commitBootRecovery({
          ...bootRecovery,
          observedBootSessionId: observedBootSessionId as string,
        }),
      ).toEqual({ status: "unavailable" });
      expect(f.storedBytes()).toEqual(before);
      expect(f.events).toEqual(events);
      expect(f.requests).toEqual([]);
      expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
        false,
      );
      expect(f.coordinator.readProtectionContext().bootRecovery.status).toBe(
        "prior_process",
      );
    },
  );

  it("never uses boot recovery for an attempt authored by this process or a mismatched attempt/revision", async () => {
    const own = harness();
    await beginEvidenceAttempt(own);
    const before = own.storedBytes();
    expect(await own.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    expect(own.storedBytes()).toEqual(before);
    const f = await anchoredPrior();
    const retained = f.storedBytes();
    for (const delta of [
      { attemptId: "60000000-0000-4000-8000-000000000002" },
      { expectedProtectionRevision: 0 },
      { expectedProtectionRevision: 2 },
      { extra: true },
    ]) {
      expect(
        await f.coordinator.commitBootRecovery({ ...bootRecovery, ...delta }),
      ).toEqual({ status: "unavailable" });
    }
    expect(f.storedBytes()).toEqual(retained);
    expect(f.requests).toEqual([]);
  });

  it("retains the prior barrier while the exact recovery write is held", async () => {
    const f = await anchoredPrior();
    const hold = deferred();
    f.blockWrite(hold.promise);
    let finished = false;
    const recovery = f.coordinator
      .commitBootRecovery(bootRecovery)
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.startsWith("write:"))).toBe(true),
    );
    expect(finished).toBe(false);
    expect(f.coordinator.readProtectionContext().bootRecovery.status).toBe(
      "prior_process",
    );
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
    await f.coordinator.flushEvidence();
    expect(f.requests).toEqual([]);
    hold.resolve();
    expect(await recovery).toEqual({
      status: "committed",
      protectionRevision: 2,
    });
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(true);
    expect(f.coordinator.readProtectionContext().admission).toBeNull();
  });

  it.each([false, true])(
    "reconciles exact recovery publication (%s) without duplicate observation or an optimistic release",
    async (published) => {
      const f = await anchoredPrior();
      const before = f.record();
      f.failNextWrite(published);
      expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
        status: "unavailable",
      });
      expect(f.coordinator.readProtectionContext().bootRecovery.status).toBe(
        "write_uncertain",
      );
      expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
        false,
      );
      expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
        status: "committed",
        protectionRevision: 2,
      });
      const committed = f.storedBytes();
      expect(unrelatedBootRecord(f.record())).toBe(unrelatedBootRecord(before));
      expect(
        f.record().nativeProtection?.localBootRecovery.nextObservationSequence,
      ).toBe(2);
      expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
        status: "committed",
        protectionRevision: 2,
      });
      expect(f.storedBytes()).toEqual(committed);
      expect(f.requests).toEqual([]);
    },
  );

  it("keeps a third valid recovery image and every later exact image latched without rewriting or egress", async () => {
    const f = await anchoredPrior();
    f.failNextWrite(true);
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    const exact = f.storedBytes()!;
    const third = syntheticStoredRecord({
      ...f.record(),
      lastReservedCounter: f.record().lastReservedCounter + 1,
    });
    f.setBytes(third);
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    expect(f.storedBytes()).toEqual(third);
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
    f.setBytes(exact);
    const events = [...f.events];
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    await f.coordinator.retryPending();
    await f.coordinator.refresh();
    await f.coordinator.flushEvidence();
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.events).toEqual(events);
    expect(f.requests).toEqual([]);
    expect(f.preserved).toEqual([]);
  });

  it("keeps general rejected v5 data blocked even if valid anchored bytes later appear", async () => {
    const prior = await anchoredPrior();
    const valid = prior.storedBytes()!;
    await prior.coordinator.dispose();
    const f = harness(prior.server);
    const damaged = { ...prior.record() } as Record<string, unknown>;
    delete damaged.integritySha256;
    f.setBytes(Buffer.from(`synthetic:${JSON.stringify(damaged)}`));
    await f.coordinator.initialize();
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "record_rejected",
    });
    f.setBytes(valid);
    const events = [...f.events];
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    await f.coordinator.retryPending();
    await f.coordinator.refresh();
    await f.coordinator.joinInitial(code);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    await f.coordinator.flushEvidence();
    expect(f.events).toEqual(events);
    expect(f.storedBytes()).toEqual(valid);
    expect(f.coordinator.readProtectionContext().bootRecovery.status).toBe(
      "record_rejected",
    );
    expect(f.requests).toEqual([]);
    expect(f.preserved).toEqual([]);
  });

  it("preserves readable unanchored legacy history and refuses retroactive recovery", async () => {
    const original = await anchoredPrior();
    const { localBootRecovery, ...protection } =
      original.record().nativeProtection!;
    expect(localBootRecovery.anchors).toHaveLength(1);
    const legacy = syntheticStoredRecord({
      ...original.record(),
      version: 4,
      nativeProtection: protection,
    });
    await original.coordinator.dispose();
    const f = harness(original.server);
    f.setBytes(legacy);
    await f.coordinator.initialize();
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "unanchored_prior",
      attemptId,
    });
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "unavailable",
    });
    expect(f.storedBytes()).toEqual(legacy);
    expect(f.requests).toEqual([]);
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
  });

  it("preserves pending evidence, original signer and counter bytes through a local recovery after forfeit", async () => {
    const f = await anchoredPrior();
    await f.coordinator.retryPending();
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    f.evidenceResult(f.record().device.keyThumbprint, "lost");
    await f.coordinator.flushEvidence();
    expect(f.record().evidence.pendingBatches).toHaveLength(1);
    const before = f.record();
    const requests = f.requests.length;
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "committed",
      protectionRevision: 2,
    });
    expect(unrelatedBootRecord(f.record())).toBe(unrelatedBootRecord(before));
    expect(f.requests).toHaveLength(requests);
    expect(f.record().terminal).toBe(true);
    expect(f.record().current).toBeNull();
  });

  it("loads a committed observation as recovered but refuses same-process cleanup and conflicting observations", async () => {
    const first = await anchoredPrior();
    await first.coordinator.commitBootRecovery(bootRecovery);
    const bytes = first.storedBytes()!;
    await first.coordinator.dispose();
    const f = harness(first.server);
    f.setBytes(bytes);
    await f.coordinator.initialize();
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "prior_boot_recovery_observed",
      attemptId,
    });
    expect(await f.coordinator.commitBootRecovery(bootRecovery)).toEqual({
      status: "committed",
      protectionRevision: 2,
    });
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 2,
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.storedBytes()).toEqual(bytes);
    expect(
      await f.coordinator.commitBootRecovery({
        ...bootRecovery,
        observedBootSessionId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    expect(f.coordinator.readProtectionContext().maySupersedeLatest).toBe(
      false,
    );
    expect(f.storedBytes()).toEqual(bytes);
    expect(f.requests).toEqual([]);
  });

  it("atomically anchors engaging and recovers only a prior-loaded attempt without changing history", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    expect(f.coordinator.readProtectionContext().bootRecovery).toEqual({
      status: "none",
    });
    expect(f.record().nativeProtection?.localBootRecovery.anchors).toEqual([
      { attemptId, engagingBootSessionId: bootA, observation: null },
    ]);
    await f.coordinator.dispose();
    const recovered = harness(f.server);
    recovered.setBytes(f.storedBytes()!);
    const restarted = recovered.coordinator;
    await restarted.initialize();
    expect(restarted.readProtectionContext().bootRecovery).toEqual({
      status: "prior_process",
      attemptId,
      expectedProtectionRevision: 1,
      engagingBootSessionId: bootA,
    });
    const before = structuredClone(f.record());
    const requests = recovered.requests.length;
    expect(
      await restarted.commitBootRecovery({
        attemptId,
        expectedProtectionRevision: 1,
        observedBootSessionId: bootB,
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    expect(restarted.readProtectionContext().bootRecovery).toEqual({
      status: "prior_boot_recovery_observed",
      attemptId,
    });
    expect(restarted.readProtectionContext().maySupersedeLatest).toBe(true);
    const after = recovered.record();
    expect(after.nativeProtection?.facts).toEqual(
      before.nativeProtection?.facts,
    );
    expect(after.nativeProtection?.latestAttempt).toEqual(
      before.nativeProtection?.latestAttempt,
    );
    expect(after.evidence).toEqual(before.evidence);
    expect(after.lastReservedCounter).toBe(before.lastReservedCounter);
    expect(after.current).toEqual(before.current);
    expect(recovered.requests).toHaveLength(requests);
  });
});

describe("reserved preflight failure history", () => {
  it("issues historical receipts only to a current grant and rejects forged receipt objects", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const before = f.storedBytes();
    expect(
      f.coordinator.reservePreflightReport({ ...authority }, attemptId),
    ).toBeNull();
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId);
    expect(receipt).toEqual({ attemptId });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(f.storedBytes()).toEqual(before);
    const command = {
      kind: "preflight_failure",
      receipt: receipt!,
      attemptId,
      expectedProtectionRevision: 0,
      cause: "application_policy",
      categories: {
        ...preflightCategories,
        applications: { status: "failed", code: "prohibited_application" },
      },
    } as const;
    expect(
      await f.coordinator.commitProtectionTransition({
        ...command,
        receipt: { ...receipt! },
      }),
    ).toEqual({ status: "unavailable" });
    expect(f.storedBytes()).toEqual(before);
    const other = harness();
    const otherAuthority = await admitForProtection(other);
    expect(
      await f.coordinator.commitProtectionTransition({
        ...command,
        receipt: other.coordinator.reservePreflightReport(
          otherAuthority,
          attemptId,
        )!,
      }),
    ).toEqual({ status: "unavailable" });
    expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
      status: "committed",
      protectionRevision: 1,
    });
    expect(f.record().nativeProtection?.facts).toMatchObject([
      {
        attemptId,
        slot: "failure",
        phase: "failed",
        nativeEvent: null,
        nativeSequence: null,
        cause: "application_policy",
        scope: authority.scope,
      },
    ]);
    expect(f.record().evidence.origins).toMatchObject([
      {
        attemptId,
        originalKeyThumbprint: f.record().device.keyThumbprint,
        originBuild: { kind: "unverified_build" },
      },
    ]);
  });

  it("bounds an unobserved receipt to one live reservation and releases only that issuer identity", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const before = f.storedBytes();
    for (const id of ["invalid", attemptId.replace("4000", "1000")])
      expect(f.coordinator.reservePreflightReport(authority, id)).toBeNull();
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    expect(
      f.coordinator.reservePreflightReport(authority, attemptId),
    ).toBeNull();
    f.coordinator.releasePreflightReport({ ...receipt });
    expect(
      f.coordinator.reservePreflightReport(authority, attemptId),
    ).toBeNull();
    f.coordinator.releasePreflightReport(receipt);
    const next = f.coordinator.reservePreflightReport(authority, attemptId)!;
    expect(next).not.toBe(receipt);
    f.coordinator.releasePreflightReport(next);
    f.advance(30_000);
    expect(
      f.coordinator.reservePreflightReport(authority, attemptId),
    ).toBeNull();
    expect(f.storedBytes()).toEqual(before);
  });

  it.each([
    ["application_policy", "applications", "failed", "prohibited_application"],
    [
      "application_policy",
      "applications",
      "unavailable",
      "application_observation_unavailable",
    ],
    [
      "shortcut_unavailable",
      "shortcuts",
      "failed",
      "emergency_shortcut_unavailable",
    ],
    [
      "shortcut_unavailable",
      "shortcuts",
      "unavailable",
      "emergency_shortcut_unavailable",
    ],
  ] as const)(
    "records only failure then owned cleanup for %s/%s/%s",
    async (cause, key, status, failureCode) => {
      const f = harness();
      const authority = await admitForProtection(f);
      const receipt = f.coordinator.reservePreflightReport(
        authority,
        attemptId,
      )!;
      const command = {
        kind: "preflight_failure",
        receipt,
        attemptId,
        expectedProtectionRevision: 0,
        cause,
        categories: {
          ...preflightCategories,
          [key]: { status, code: failureCode },
        },
      } as const;
      expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
        status: "committed",
        protectionRevision: 1,
      });
      const before = f.storedBytes();
      const invalid: ProtectionTransition[] = [
        {
          kind: "began",
          attemptId,
          expectedProtectionRevision: 1,
          event: { type: "did_begin", attemptId, sequence: 1, code: "none" },
        },
        {
          kind: "native_terminal",
          attemptId,
          expectedProtectionRevision: 1,
          event: { type: "did_end", attemptId, sequence: 1, code: "none" },
        },
        {
          kind: "ending",
          attemptId,
          expectedProtectionRevision: 1,
          cause: "application_policy",
        },
        {
          kind: "failure",
          attemptId,
          expectedProtectionRevision: 1,
          cause: "persistence_unavailable",
        },
        {
          kind: "abandoned",
          attemptId,
          expectedProtectionRevision: 1,
          cause: "emergency_abandonment",
        },
        {
          kind: "cleanup",
          attemptId,
          expectedProtectionRevision: 1,
          outcome: "unconfirmed",
        },
      ];
      for (const value of invalid)
        expect(await f.coordinator.commitProtectionTransition(value)).toEqual({
          status: "unavailable",
        });
      expect(f.storedBytes()).toEqual(before);
      expect(f.coordinator.isCurrentAdmission(authority)).toBe(true);
      expect(
        await f.coordinator.commitProtectionTransition({
          kind: "disposed_without_terminal_observation",
          attemptId,
          expectedProtectionRevision: 1,
        }),
      ).toEqual({ status: "committed", protectionRevision: 2 });
      expect(f.record().nativeProtection?.latestAttempt).toMatchObject({
        phase: "failed",
        nativeDisposition: "disposed_without_terminal_observation",
        nativeSequence: null,
        cleanup: "complete",
        abandonment: "none",
      });
      expect(
        f
          .record()
          .nativeProtection?.facts.map((fact) => [
            fact.slot,
            fact.nativeEvent,
            fact.nativeSequence,
            fact.cause,
          ]),
      ).toEqual([
        ["failure", null, null, cause],
        ["cleanup", null, null, "none"],
      ]);
      const completed = f.storedBytes();
      expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
        status: "committed",
        protectionRevision: 2,
      });
      expect(f.storedBytes()).toEqual(completed);
    },
  );

  it.each(["expiry", "denied_read", "renewal", "forfeit"] as const)(
    "preserves the latest writer counter and original scope after queued %s",
    async (scenario) => {
      const f = harness();
      const authority = await admitForProtection(f);
      const receipt = f.coordinator.reservePreflightReport(
        authority,
        attemptId,
      )!;
      const original = structuredClone(f.record());
      const hold = deferred();
      const entered = deferred();
      f.beforeResponse(async (route) => {
        if (
          route ===
          (scenario === "forfeit"
            ? "forfeit"
            : scenario === "renewal"
              ? "reconnect"
              : "read")
        ) {
          entered.resolve();
          await hold.promise;
        }
      });
      if (scenario === "renewal") f.advance(241_000);
      else if (scenario !== "forfeit") f.advance(15_000);
      const work =
        scenario === "forfeit"
          ? f.coordinator.forfeit(f.coordinator.readView().revision)
          : f.coordinator.refresh();
      await entered.promise;
      const categories = {
        ...preflightCategories,
        applications: { status: "failed", code: "prohibited_application" },
      } satisfies ProtectionCategories;
      const command = {
        kind: "preflight_failure",
        receipt,
        attemptId,
        expectedProtectionRevision: 0,
        cause: "application_policy",
        categories,
      } as const;
      const report = f.coordinator.commitProtectionTransition(command);
      // Neither release nor a changed command may overwrite the first observation.
      f.coordinator.releasePreflightReport(receipt);
      Object.assign(categories, {
        applications: { status: "confirmed", code: "none" },
      });
      expect(
        await f.coordinator.commitProtectionTransition({
          ...command,
          categories: {
            ...preflightCategories,
            shortcuts: {
              status: "failed",
              code: "emergency_shortcut_unavailable",
            },
          },
          cause: "shortcut_unavailable",
        }),
      ).toEqual({ status: "unavailable" });
      if (scenario === "expiry") f.advance(310_000);
      if (scenario === "denied_read") f.deny("read");
      expect(f.record().nativeProtection).toBeNull();
      hold.resolve();
      await work;
      expect(await report).toEqual({
        status: "committed",
        protectionRevision: 1,
      });
      const current = f.record();
      expect(current.lastReservedCounter).toBeGreaterThan(
        original.lastReservedCounter,
      );
      expect(current.device).toEqual(original.device);
      expect(current.nativeProtection?.facts[0]).toMatchObject({
        scope: authority.scope,
        categories: {
          applications: { status: "failed", code: "prohibited_application" },
        },
      });
      expect(current.evidence.origins[0]?.originalKeyThumbprint).toBe(
        original.device.keyThumbprint,
      );
      expect(current.pending).toBeNull();
      if (scenario === "forfeit") {
        expect(current.current).toBeNull();
        expect(current.terminal).toBe(true);
      } else if (scenario === "renewal") {
        expect(current.current?.sessionRevision).toBe(
          original.current!.sessionRevision + 1,
        );
      } else {
        expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
      }
    },
  );

  it.each([false, true])(
    "reconciles an uncertain first publication (%s) without a second fact, origin, or counter rewind",
    async (published) => {
      const f = harness();
      const authority = await admitForProtection(f);
      const receipt = f.coordinator.reservePreflightReport(
        authority,
        attemptId,
      )!;
      const command = {
        kind: "preflight_failure",
        receipt,
        attemptId,
        expectedProtectionRevision: 0,
        cause: "shortcut_unavailable",
        categories: {
          ...preflightCategories,
          shortcuts: {
            status: "unavailable",
            code: "emergency_shortcut_unavailable",
          },
        },
      } as const;
      f.failNextWrite(published);
      expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
        status: "unavailable",
      });
      f.coordinator.releasePreflightReport(receipt);
      const originalDevice = f.record().device;
      await f.coordinator.beginTargetedReadmission(
        code,
        f.coordinator.readView().revision,
      );
      expect(f.record().device).toEqual(originalDevice);
      expect(f.preserved).toEqual([]);
      expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
        status: "committed",
        protectionRevision: 1,
      });
      await f.coordinator.retryPending();
      const durable = f.storedBytes();
      const counter = f.record().lastReservedCounter;
      expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
        status: "committed",
        protectionRevision: 1,
      });
      expect(f.storedBytes()).toEqual(durable);
      expect(f.record().lastReservedCounter).toBe(counter);
      expect(f.record().nativeProtection?.facts).toHaveLength(1);
      expect(f.record().evidence.origins).toHaveLength(1);
      expect(
        await f.coordinator.commitProtectionTransition({
          ...command,
          expectedProtectionRevision: 1,
        }),
      ).toEqual({ status: "unavailable" });
    },
  );

  it("blocks replacement before the first origin and retains that signer after prefix ACK, cleanup, and rebind", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    const original = structuredClone(f.record().device);
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.record().device).toEqual(original);
    expect(f.preserved).toEqual([]);
    const hold = deferred();
    f.blockWrite(hold.promise);
    const command = {
      kind: "preflight_failure",
      receipt,
      attemptId,
      expectedProtectionRevision: 0,
      cause: "application_policy",
      categories: {
        ...preflightCategories,
        applications: { status: "failed", code: "prohibited_application" },
      },
    } as const;
    const report = f.coordinator.commitProtectionTransition(command);
    const rebind = f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    f.coordinator.releasePreflightReport(receipt);
    hold.resolve();
    expect(await report).toEqual({
      status: "committed",
      protectionRevision: 1,
    });
    await rebind;
    expect(f.record().device).toEqual(original);
    await f.coordinator.flushEvidence();
    const prefix = evidenceRequests(f).at(-1)!;
    expect(prefix.body.facts).toHaveLength(1);
    expect(f.record().evidence.acknowledgments).toHaveLength(1);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 1,
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.record().device.keyThumbprint).not.toBe(original.keyThumbprint);
    expect(
      f
        .record()
        .evidence.retiredSigners.map((signer) => signer.device.keyThumbprint),
    ).toContain(original.keyThumbprint);
    f.advance(15_001);
    await f.coordinator.refresh();
    await f.coordinator.flushEvidence();
    const complete = evidenceRequests(f).at(-1)!;
    expect(complete.body.scope).toEqual(authority.scope);
    expect(complete.body.facts).toHaveLength(2);
    expect((complete.body.facts as readonly ProtectionFact[])[0]).toEqual(
      (prefix.body.facts as readonly ProtectionFact[])[0],
    );
    expect(complete.body.originBuild).toEqual(prefix.body.originBuild);
    expect(f.record().evidence.acknowledgments).toHaveLength(2);
  });

  it("consumes a normal engaging reservation only after its uncertain origin is reconciled", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    f.failNextWrite(true);
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "engaging",
        engagingBootSessionId: bootA,
        authority,
        attemptId,
        expectedProtectionRevision: 0,
        categories: preflightCategories,
      }),
    ).toEqual({ status: "unavailable" });
    f.coordinator.releasePreflightReport(receipt);
    await f.coordinator.retryPending();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 1,
      }),
    ).toEqual({ status: "committed", protectionRevision: 2 });
    const nextAuthority = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    expect(nextAuthority.status).toBe("fresh");
    if (nextAuthority.status !== "fresh")
      throw new Error("Missing fresh admission");
    expect(
      f.coordinator.reservePreflightReport(
        nextAuthority.authority,
        "60000000-0000-4000-8000-000000000002",
      ),
    ).not.toBeNull();
  });

  it("refuses a prior-process receipt and keeps an unfinished failure uncertain across restart", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    const command = {
      kind: "preflight_failure",
      receipt,
      attemptId,
      expectedProtectionRevision: 0,
      cause: "application_policy",
      categories: {
        ...preflightCategories,
        applications: { status: "failed", code: "prohibited_application" },
      },
    } as const;
    await f.coordinator.commitProtectionTransition(command);
    await f.coordinator.dispose();
    const restarted = createStudentSessionCoordinator(f.options);
    await restarted.initialize();
    await restarted.retryPending();
    expect(await restarted.commitProtectionTransition(command)).toEqual({
      status: "unavailable",
    });
    expect(
      await restarted.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId,
        expectedProtectionRevision: 1,
      }),
    ).toEqual({ status: "unavailable" });
    const fresh = restarted.readProtectionContext().freshAdmission;
    if (fresh !== null)
      expect(
        restarted.reservePreflightReport(
          fresh,
          "60000000-0000-4000-8000-000000000002",
        ),
      ).toBeNull();
    await restarted.forfeit(restarted.readView().revision);
    await restarted.beginTargetedReadmission(
      code,
      restarted.readView().revision,
    );
    expect(f.preserved).toEqual([]);
    expect(f.record().nativeProtection?.facts).toHaveLength(1);
  });

  it("rejects malformed first observations without consuming an unobserved reservation", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    const before = f.storedBytes();
    for (const categories of [
      {
        ...preflightCategories,
        applications: {
          status: "failed",
          code: "application_observation_unavailable",
        },
      },
      {
        ...preflightCategories,
        applications: { status: "unavailable", code: "prohibited_application" },
      },
      {
        ...preflightCategories,
        aac: { status: "confirmed", code: "none" },
        applications: { status: "failed", code: "prohibited_application" },
      },
    ] as const) {
      expect(
        await f.coordinator.commitProtectionTransition({
          kind: "preflight_failure",
          receipt,
          attemptId,
          expectedProtectionRevision: 0,
          cause: "application_policy",
          categories,
        }),
      ).toEqual({ status: "unavailable" });
    }
    f.coordinator.releasePreflightReport(receipt);
    expect(
      f.coordinator.reservePreflightReport(authority, attemptId),
    ).not.toBeNull();
    expect(f.storedBytes()).toEqual(before);
  });

  it("releases an unobserved reservation so intentional readmission can replace the identity", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    const original = f.record().device.keyThumbprint;
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.record().device.keyThumbprint).toBe(original);
    f.coordinator.releasePreflightReport(receipt);
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.record().device.keyThumbprint).not.toBe(original);
    expect(f.record().nativeProtection).toBeNull();
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "preflight_failure",
        receipt,
        attemptId,
        expectedProtectionRevision: 0,
        cause: "shortcut_unavailable",
        categories: {
          ...preflightCategories,
          shortcuts: {
            status: "failed",
            code: "emergency_shortcut_unavailable",
          },
        },
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("keeps the actual held write owned through shutdown and refuses late receipt publication", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const receipt = f.coordinator.reservePreflightReport(authority, attemptId)!;
    const command = {
      kind: "preflight_failure",
      receipt,
      attemptId,
      expectedProtectionRevision: 0,
      cause: "application_policy",
      categories: {
        ...preflightCategories,
        applications: { status: "failed", code: "prohibited_application" },
      },
    } as const;
    const hold = deferred();
    f.blockWrite(hold.promise);
    const writes = f.events.filter((event) =>
      event.startsWith("write:"),
    ).length;
    const report = f.coordinator.commitProtectionTransition(command);
    await vi.waitFor(() =>
      expect(
        f.events.filter((event) => event.startsWith("write:")),
      ).toHaveLength(writes + 1),
    );
    expect(await f.coordinator.dispose()).toBe(false);
    expect(f.events).not.toContain("close");
    hold.resolve();
    expect(await report).toEqual({ status: "unavailable" });
    expect(await f.coordinator.commitProtectionTransition(command)).toEqual({
      status: "unavailable",
    });
    expect(f.events).not.toContain("close");
  });

  it("reserves eight existing slots and denies the next attempt without writing at capacity", async () => {
    const f = harness();
    for (let i = 0; i < 13; i += 1) {
      const authority = await admitForProtection(f);
      const id = `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      const receipt = f.coordinator.reservePreflightReport(authority, id)!;
      expect(receipt).not.toBeNull();
      expect(
        await f.coordinator.commitProtectionTransition({
          kind: "preflight_failure",
          receipt,
          attemptId: id,
          expectedProtectionRevision: i * 2,
          cause: "shortcut_unavailable",
          categories: {
            ...preflightCategories,
            shortcuts: {
              status: "failed",
              code: "emergency_shortcut_unavailable",
            },
          },
        }),
      ).toEqual({ status: "committed", protectionRevision: i * 2 + 1 });
      await f.coordinator.commitProtectionTransition({
        kind: "disposed_without_terminal_observation",
        attemptId: id,
        expectedProtectionRevision: i * 2 + 1,
      });
    }
    const authority = await admitForProtection(f);
    const before = f.storedBytes();
    expect(f.record().nativeProtection?.facts).toHaveLength(26);
    expect(
      f.coordinator.reservePreflightReport(
        authority,
        "60000000-0000-4000-8000-000000000014",
      ),
    ).toBeNull();
    expect(f.storedBytes()).toEqual(before);
  });
});

describe("single-writer native protection facts", () => {
  it("durably reserves an immutable evidence prefix before upload without issuing admission", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    await f.coordinator.commitProtectionTransition({
      kind: "engaging",
      engagingBootSessionId: bootA,
      attemptId,
      expectedProtectionRevision: 0,
      authority,
      categories: preflightCategories,
    });
    const before = structuredClone(f.record());
    const observed: unknown[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      observed.push(value),
    );
    await f.coordinator.flushEvidence();
    const exchange = f.requests.find((request) => request.route === "evidence");
    expect(exchange).toBeDefined();
    expect(exchange!.durable.evidence.pendingBatches).toHaveLength(1);
    expect(exchange!.body.facts).toEqual(before.nativeProtection!.facts);
    expect(exchange!.durable.lastReservedCounter).toBe(
      before.lastReservedCounter + 1,
    );
    expect(f.record().evidence.pendingBatches).toEqual([]);
    expect(f.record().evidence.acknowledgments).toHaveLength(1);
    expect(f.record().nativeProtection).toEqual(before.nativeProtection);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(
      authority,
    );
    expect(observed).toEqual([]);
  });

  it("preserves admission/counter, rejects fabricated or stale grants, and records began before locked", async () => {
    const f = harness();
    const authority = await admitForProtection(f);
    const before = f.record();
    const start = {
      kind: "engaging",
      engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
        engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
        engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
        engagingBootSessionId: bootA,
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
      engagingBootSessionId: bootA,
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
          engagingBootSessionId: bootA,
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
        engagingBootSessionId: bootA,
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
        engagingBootSessionId: bootA,
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

describe("single-writer evidence delivery", () => {
  afterEach(() => vi.useRealTimers());

  it("reports no delivery before any fact and never interprets absent reports as acknowledged", async () => {
    const f = harness();
    await admitForProtection(f);
    expect(f.coordinator.readProtectionContext().delivery).toBe("none");
    const before = f.storedBytes();
    await f.coordinator.flushEvidence();
    expect(evidenceRequests(f)).toEqual([]);
    expect(f.storedBytes()).toEqual(before);
    await beginEvidenceAttempt(f);
    expect(f.coordinator.readProtectionContext().delivery).toBe("pending");
    await f.coordinator.flushEvidence();
    expect(f.coordinator.readProtectionContext().delivery).toBe("acknowledged");
  });

  it("pins the acknowledged latest original signer through targeted rebind and signs a permitted late fact with it", async () => {
    const originBuild: NativeEvidenceOriginBuild = { kind: "unverified_build" };
    const f = harness(undefined, originBuild);
    await completeEvidenceAttempt(f);
    const original = structuredClone(f.record());
    await f.coordinator.flushEvidence();
    expect(f.record().evidence.acknowledgments).toHaveLength(3);
    expect(f.record().nativeProtection).toEqual(original.nativeProtection);
    const oldDevice = await rebindEvidenceDevice(f);
    const rebound = structuredClone(f.record());
    expect(rebound.current!.scope.epoch).toBeGreaterThan(
      original.current!.scope.epoch,
    );
    expect(rebound.evidence.retiredSigners).toEqual([
      expect.objectContaining({
        device: oldDevice,
        lastReservedCounter: expect.any(Number),
      }),
    ]);
    expect(rebound.evidence.origins).toEqual(original.evidence.origins);
    const oldCounter = rebound.evidence.retiredSigners[0]!.lastReservedCounter;
    // This unused finite failure slot is accepted by the real Student writer;
    // it is not a fabricated native terminal callback or a new admission grant.
    expect(
      await f.coordinator.commitProtectionTransition({
        kind: "failure",
        attemptId,
        expectedProtectionRevision: rebound.nativeProtection!.revision,
        cause: "native_failure",
      }),
    ).toEqual({
      status: "committed",
      protectionRevision: rebound.nativeProtection!.revision + 1,
    });
    f.advance(15_000);
    await f.coordinator.refresh();
    const currentCounter = f.record().lastReservedCounter;
    await f.coordinator.flushEvidence();
    const late = evidenceRequests(f).at(-1)!;
    expect(late.body.publicKey).toBe(oldDevice.publicKey);
    expect(late.body.scope).toEqual(original.current!.scope);
    expect(late.body.originBuild).toEqual(originBuild);
    expect(late.body.deviceProof).toMatchObject({ counter: oldCounter + 1 });
    expect(late.body.facts).toEqual(f.record().nativeProtection!.facts);
    expect(f.record().evidence.acknowledgments).toHaveLength(4);
    expect(f.record().lastReservedCounter).toBe(currentCounter);
    expect(f.record().device).toEqual(rebound.device);
    expect(f.record().evidence.retiredSigners).toHaveLength(1);
  });

  it("releases an acknowledged old signer only after durable safe superseding engaging and prunes whole old attempts", async () => {
    const f = harness();
    await completeEvidenceAttempt(f);
    await f.coordinator.flushEvidence();
    const original = structuredClone(f.record());
    await rebindEvidenceDevice(f);
    expect(f.record().evidence.retiredSigners).toHaveLength(1);
    await beginEvidenceAttempt(f, "60000000-0000-4000-8000-000000000002");
    f.advance(15_000);
    await f.coordinator.flushEvidence();
    const next = f.record();
    expect(next.evidence.retiredSigners).toEqual([]);
    expect(next.nativeProtection!.facts).toHaveLength(1);
    expect(next.nativeProtection!.facts[0]!.sequence).toBe(
      original.nativeProtection!.nextFactSequence,
    );
    expect(next.nativeProtection!.nextFactSequence).toBe(
      original.nativeProtection!.nextFactSequence + 1,
    );
    expect(next.nativeProtection!.revision).toBe(
      original.nativeProtection!.revision + 1,
    );
    expect(next.evidence.origins.map((origin) => origin.attemptId)).toEqual([
      "60000000-0000-4000-8000-000000000002",
    ]);
  });

  it("gives five signers fair bounded opportunities across denial, unavailability and a real store reopen", async () => {
    const f = harness();
    const signers: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) await rebindEvidenceDevice(f);
      await completeEvidenceAttempt(
        f,
        `60000000-0000-4000-8000-00000000000${index + 1}`,
      );
      signers.push(f.record().device.keyThumbprint);
    }
    expect(f.record().evidence.retiredSigners).toHaveLength(4);
    signers
      .slice(0, 4)
      .forEach((signer, index) =>
        f.evidenceResult(signer, index === 0 ? "denied" : "unavailable"),
      );
    await f.coordinator.flushEvidence();
    const first = evidenceRequests(f)[0]!;
    const bytes = f.storedBytes()!;
    expect(await f.coordinator.dispose()).toBe(true);
    const restored = harness(f.server);
    restored.setBytes(bytes);
    signers
      .slice(0, 4)
      .forEach((signer, index) =>
        restored.evidenceResult(signer, index === 0 ? "denied" : "unavailable"),
      );
    await restored.coordinator.initialize();
    expect(restored.record().evidence.lastAttemptedSigner).toBe(
      first.durable.evidence.lastAttemptedSigner,
    );
    for (let index = 0; index < 4; index += 1) {
      restored.advance(15_000);
      await restored.coordinator.flushEvidence();
    }
    const attempts = [first, ...evidenceRequests(restored)];
    expect(attempts).toHaveLength(5);
    expect(
      new Set(
        attempts.map((request) => request.durable.evidence.lastAttemptedSigner),
      ),
    ).toEqual(new Set(signers));
    expect(restored.record().evidence.pendingBatches).toHaveLength(4);
    expect(restored.record().evidence.acknowledgments).toHaveLength(3);
    expect(restored.record().nativeProtection!.facts).toHaveLength(15);
    expect(
      restored.coordinator.readProtectionContext().freshAdmission,
    ).toBeNull();
    await restored.coordinator.retryPending();
    await restored.coordinator.forfeit(
      restored.coordinator.readView().revision,
    );
    const full = restored.storedBytes();
    const requests = restored.requests.length;
    await restored.coordinator.beginTargetedReadmission(
      code,
      restored.coordinator.readView().revision,
    );
    expect(restored.storedBytes()).toEqual(full);
    expect(restored.requests).toHaveLength(requests);
    expect(restored.preserved).toEqual([]);
    expect(restored.coordinator.readProtectionContext().delivery).toBe(
      "blocked",
    );
  });

  it("freezes the uploading prefix while a real late terminal queues, then acknowledges only that exact prefix", async () => {
    const f = harness();
    const authority = await beginEvidenceAttempt(f);
    await f.coordinator.commitProtectionTransition({
      kind: "began",
      attemptId,
      expectedProtectionRevision: 1,
      event: { type: "did_begin", attemptId, sequence: 1, code: "none" },
    });
    const entered = deferred();
    const hold = deferred();
    f.beforeResponse(async (route) => {
      if (route === "evidence") {
        entered.resolve();
        await hold.promise;
      }
    });
    const upload = f.coordinator.flushEvidence();
    await entered.promise;
    const frozen = structuredClone(
      evidenceRequests(f)[0]!.durable.evidence.pendingBatches[0]!,
    );
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
    expect(f.record().nativeProtection!.facts).toHaveLength(2);
    f.advance(authority.observationDeadline - f.now());
    expect(f.coordinator.isCurrentAdmission(authority, "sustain")).toBe(false);
    hold.resolve();
    await upload;
    expect(await terminal).toEqual({
      status: "committed",
      protectionRevision: 3,
    });
    expect(evidenceRequests(f)[0]!.durable.evidence.pendingBatches[0]).toEqual(
      frozen,
    );
    expect(
      f.record().evidence.acknowledgments.map((ack) => ack.eventId),
    ).toEqual(frozen.events.map((event) => event.eventId));
    expect(f.record().nativeProtection!.facts).toHaveLength(3);
    expect(f.coordinator.readProtectionContext().delivery).toBe("pending");
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    f.beforeResponse(null);
    f.advance(15_000);
    await f.coordinator.flushEvidence();
    expect(evidenceRequests(f).at(-1)!.body.facts).toEqual(
      f.record().nativeProtection!.facts,
    );
    expect(f.record().evidence.acknowledgments).toHaveLength(3);
  });

  it("coalesces upload opportunities and preserves the renewed read as the only source of freshness", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    f.latency(20, 100);
    f.advance(225_000);
    await f.coordinator.refresh();
    f.advance(15_000);
    await f.coordinator.refresh();
    const fresh = f.coordinator.readProtectionContext().freshAdmission!;
    const observations: unknown[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      observations.push(value),
    );
    const before = f.requests.length;
    await Promise.all([
      f.coordinator.flushEvidence(),
      f.coordinator.flushEvidence(),
      f.coordinator.flushEvidence(),
    ]);
    await f.coordinator.flushEvidence();
    expect(f.requests.slice(before).map((request) => request.route)).toEqual([
      "evidence",
    ]);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(fresh);
    expect(observations).toEqual([]);
    expect(fresh.observationDeadline).toBe(fresh.readStartedAt + 30_000);
    expect(f.requests.slice(-3).map((request) => request.route)).toEqual([
      "reconnect",
      "read",
      "evidence",
    ]);
    f.advance(fresh.observationDeadline - f.now());
    expect(f.coordinator.isCurrentAdmission(fresh, "sustain")).toBe(false);
  });

  it("sustains three locked maintenance cycles with upload latency and no extra read, transition or freshness publication", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    await f.coordinator.commitProtectionTransition({
      kind: "began",
      attemptId,
      expectedProtectionRevision: 1,
      event: { type: "did_begin", attemptId, sequence: 1, code: "none" },
    });
    const result = await f.coordinator.readFreshAdmission(
      f.coordinator.readProtectionContext().admission!,
    );
    if (result.status !== "fresh")
      throw new Error("Expected post-begin admission");
    await f.coordinator.commitProtectionTransition({
      kind: "locked",
      attemptId,
      expectedProtectionRevision: 2,
      authority: result.authority,
      nativeSequence: 1,
      categories: lockedCategories,
    });
    const protection = structuredClone(f.record().nativeProtection);
    f.evidenceResult(f.record().device.keyThumbprint, "unavailable");
    f.latency(40, 100);
    const observations: unknown[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      observations.push(value),
    );
    const before = f.requests.length;
    for (let index = 0; index < 3; index += 1) {
      f.advance(15_000);
      await f.coordinator.refresh();
      const fresh = f.coordinator.readProtectionContext().freshAdmission!;
      const viewRevision = f.coordinator.readView().revision;
      await f.coordinator.flushEvidence();
      expect(f.coordinator.readProtectionContext().freshAdmission).toBe(fresh);
      expect(f.coordinator.isCurrentAdmission(fresh, "sustain")).toBe(true);
      expect(f.coordinator.readView().revision).toBe(viewRevision);
      expect(f.record().nativeProtection).toEqual(protection);
    }
    expect(f.requests.slice(before).map((request) => request.route)).toEqual([
      "read",
      "evidence",
      "read",
      "evidence",
      "read",
      "evidence",
    ]);
    expect(observations).toHaveLength(3);
  });

  it("queues due same-owner renewal behind a held upload without dropping maintenance or resetting its shared counter", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    f.advance(225_000);
    await f.coordinator.refresh();
    const old = f.coordinator.readProtectionContext().freshAdmission!;
    f.advance(14_000);
    const entered = deferred();
    const hold = deferred();
    f.beforeResponse(async (route) => {
      if (route === "evidence") {
        entered.resolve();
        await hold.promise;
      }
    });
    const upload = f.coordinator.flushEvidence();
    await entered.promise;
    const reservation = f.record().lastReservedCounter;
    const facts = structuredClone(f.record().nativeProtection);
    f.advance(1_000);
    const renewal = f.coordinator.refresh();
    await Promise.resolve();
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(old);
    expect(f.coordinator.isCurrentAdmission(old, "sustain")).toBe(true);
    expect(f.requests.at(-1)!.route).toBe("evidence");
    hold.resolve();
    await upload;
    await renewal;
    expect(f.requests.slice(-3).map((request) => request.route)).toEqual([
      "evidence",
      "reconnect",
      "read",
    ]);
    expect(f.record().lastReservedCounter).toBe(reservation + 2);
    expect(f.record().nativeProtection).toEqual(facts);
    const fresh = f.coordinator.readProtectionContext().freshAdmission!;
    expect(fresh.admissionGeneration).toBe(old.admissionGeneration);
    expect(fresh.sessionRevision).toBe(old.sessionRevision + 1);
    expect(f.coordinator.isCurrentAdmission(fresh, "sustain")).toBe(true);
  });

  it.each(["readmission", "forfeit"] as const)(
    "preserves a valid %s queued after a no-op refresh behind held evidence",
    async (action) => {
      const f = harness();
      await completeEvidenceAttempt(f);
      if (action === "readmission")
        await f.coordinator.forfeit(f.coordinator.readView().revision);
      const original = structuredClone(f.record());
      const revision = f.coordinator.readView().revision;
      const entered = deferred();
      const hold = deferred();
      f.beforeResponse(async (route) => {
        if (route === "evidence") {
          entered.resolve();
          await hold.promise;
        }
      });
      const before = f.requests.length;
      const upload = f.coordinator.flushEvidence();
      await entered.promise;
      const refresh = f.coordinator.refresh();
      const command =
        action === "readmission"
          ? f.coordinator.beginTargetedReadmission(code, revision)
          : f.coordinator.forfeit(revision);
      let settled = false;
      void command.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.coordinator.readView().revision).toBe(revision);
      expect(f.preserved).toEqual([]);
      hold.resolve();
      await Promise.all([upload, refresh, command]);
      expect(f.record().nativeProtection).toEqual(original.nativeProtection);
      expect(f.record().evidence.pendingBatches).toEqual([]);
      expect(f.record().evidence.acknowledgments).toHaveLength(3);
      if (action === "readmission") {
        expect(f.coordinator.readView().phase).toBe("active");
        expect(f.record().device.keyThumbprint).not.toBe(
          original.device.keyThumbprint,
        );
        expect(f.record().current!.scope.epoch).toBeGreaterThan(
          original.nativeProtection!.latestAttempt!.scope.epoch,
        );
        expect(f.preserved).toHaveLength(1);
        expect(f.requests.at(-1)!.durable.pending).toMatchObject({
          kind: "join",
          admissionMode: "readmission",
        });
      } else {
        expect(f.coordinator.readView().phase).toBe("forfeited");
        expect(f.record().terminal).toBe(true);
        expect(
          f.requests.slice(before).map((request) => request.route),
        ).toEqual(["evidence", "forfeit"]);
        expect(f.record().lastReservedCounter).toBe(
          original.lastReservedCounter + 2,
        );
      }
    },
  );

  it("rechecks a queued forfeit revision after a due refresh takes the next writer turn", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    const entered = deferred();
    const hold = deferred();
    f.beforeResponse(async (route) => {
      if (route === "evidence") {
        entered.resolve();
        await hold.promise;
      }
    });
    const before = f.requests.length;
    const upload = f.coordinator.flushEvidence();
    await entered.promise;
    f.advance(15_000);
    const revision = f.coordinator.readView().revision;
    const refresh = f.coordinator.refresh();
    const forfeit = f.coordinator.forfeit(revision);
    hold.resolve();
    await Promise.all([upload, refresh, forfeit]);
    expect(f.coordinator.readView().revision).toBeGreaterThan(revision);
    expect(f.coordinator.readView().phase).toBe("active");
    expect(f.record().terminal).toBe(false);
    expect(f.record().pending).toBeNull();
    expect(f.requests.slice(before).map((request) => request.route)).toEqual([
      "evidence",
      "read",
    ]);
  });

  it("uploads historical facts while denied reconnect remains pending without resubmitting it or granting authority", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    f.advance(225_000);
    await f.coordinator.refresh();
    f.beforeResponse(async (route) => {
      if (route === "reconnect") f.deny();
    });
    f.advance(15_000);
    await f.coordinator.refresh();
    expect(f.record().pending?.kind).toBe("reconnect");
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    const before = structuredClone(f.record());
    const count = f.requests.length;
    const observations: unknown[] = [];
    f.coordinator.subscribeAdmissionObservation((value) =>
      observations.push(value),
    );
    f.beforeResponse(null);
    f.allow();
    await f.coordinator.flushEvidence();
    expect(f.requests.slice(count).map((request) => request.route)).toEqual([
      "evidence",
    ]);
    expect(f.record().pending).toEqual(before.pending);
    expect(f.record().current).toEqual(before.current);
    expect(f.record().nativeProtection).toEqual(before.nativeProtection);
    expect(f.record().evidence.acknowledgments).toHaveLength(1);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
    expect(observations).toEqual([]);
  });

  it("does not admit an upload ahead of a queued native terminal after held maintenance", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    const entered = deferred();
    const hold = deferred();
    f.beforeResponse(async (route) => {
      if (route === "read") {
        entered.resolve();
        await hold.promise;
      }
    });
    f.advance(15_000);
    const read = f.coordinator.refresh();
    await entered.promise;
    const terminal = f.coordinator.commitProtectionTransition({
      kind: "native_terminal",
      attemptId,
      expectedProtectionRevision: 1,
      event: {
        type: "failed_to_begin",
        attemptId,
        sequence: 1,
        code: "native_failed_to_begin",
      },
    });
    const skipped = f.coordinator.flushEvidence();
    hold.resolve();
    await read;
    await skipped;
    expect(await terminal).toEqual({
      status: "committed",
      protectionRevision: 2,
    });
    expect(evidenceRequests(f)).toEqual([]);
    await f.coordinator.flushEvidence();
    expect(evidenceRequests(f)).toHaveLength(1);
    expect(evidenceRequests(f)[0]!.body.facts).toEqual(
      f.record().nativeProtection!.facts,
    );
  });

  it.each([false, true])(
    "emits zero evidence when its durable reservation is uncertain (published=%s)",
    async (published) => {
      const f = harness();
      await beginEvidenceAttempt(f);
      const before = structuredClone(f.record());
      f.failNextWrite(published);
      await f.coordinator.flushEvidence();
      expect(evidenceRequests(f)).toEqual([]);
      expect(f.record().nativeProtection).toEqual(before.nativeProtection);
      expect(f.record().evidence.acknowledgments).toEqual([]);
      expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
      const retainedCounter = f.record().lastReservedCounter;
      const bytes = f.storedBytes()!;
      expect(await f.coordinator.dispose()).toBe(true);
      const restored = harness(f.server);
      restored.setBytes(bytes);
      await restored.coordinator.initialize();
      await restored.coordinator.flushEvidence();
      expect(evidenceRequests(restored)[0]!.body.deviceProof).toMatchObject({
        counter: retainedCounter + 1,
      });
      expect(restored.record().evidence.acknowledgments).toHaveLength(1);
    },
  );

  it("retains legacy facts whose original signer is absent as blocked without using the replacement key", async () => {
    const f = harness();
    await completeEvidenceAttempt(f);
    const { evidence, ...prior } = f.record();
    expect(evidence.origins).toHaveLength(1);
    const { localBootRecovery, ...legacyProtection } = prior.nativeProtection!;
    expect(localBootRecovery.anchors).toHaveLength(1);
    const bytes = syntheticStoredRecord({
      ...prior,
      version: 2,
      nativeProtection: legacyProtection,
      device: f.options.crypto.createEnrollment(),
      current: null,
      pending: null,
      terminal: true,
      lastReservedCounter: 0,
    });
    const restored = harness();
    restored.setBytes(bytes);
    await restored.coordinator.initialize();
    expect(restored.coordinator.readProtectionContext().delivery).toBe(
      "blocked",
    );
    await restored.coordinator.flushEvidence();
    expect(evidenceRequests(restored)).toEqual([]);
    expect(restored.storedBytes()).toEqual(bytes);
    expect(restored.preserved).toEqual([]);
    expect(
      restored.coordinator.readProtectionContext().protection!.facts,
    ).toEqual(prior.nativeProtection!.facts);
  });

  it.each([false, true])(
    "restarts after acknowledgment publication uncertainty (published=%s) without losing or relabeling exact receipts",
    async (published) => {
      const f = harness();
      await beginEvidenceAttempt(f);
      const original = structuredClone(f.record().nativeProtection);
      f.beforeResponse(async (route) => {
        if (route === "evidence") f.failNextWrite(published);
      });
      await f.coordinator.flushEvidence();
      const first = evidenceRequests(f)[0]!;
      expect(f.server.receipts.size).toBe(1);
      expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
      const bytes = f.storedBytes()!;
      expect(await f.coordinator.dispose()).toBe(true);
      const restored = harness(f.server);
      restored.setBytes(bytes);
      await restored.coordinator.initialize();
      await restored.coordinator.flushEvidence();
      expect(restored.record().nativeProtection).toEqual(original);
      expect(restored.record().evidence.acknowledgments).toEqual([
        ...f.server.receipts.values(),
      ]);
      expect(restored.record().evidence.pendingBatches).toEqual([]);
      expect(
        restored.coordinator.readProtectionContext().freshAdmission,
      ).toBeNull();
      if (published) expect(evidenceRequests(restored)).toEqual([]);
      else {
        const retry = evidenceRequests(restored)[0]!;
        expect(retry.body.batchDigest).toBe(first.body.batchDigest);
        expect(retry.body.facts).toEqual(first.body.facts);
        expect(retry.body.originBuild).toEqual(first.body.originBuild);
        expect(retry.body.deviceProof).toMatchObject({
          counter: first.durable.lastReservedCounter + 1,
        });
      }
      const authority = await restored.coordinator.readFreshAdmission(
        restored.coordinator.readProtectionContext().admission!,
      );
      expect(authority).toEqual({ status: "unavailable" });
    },
  );

  it("recovers the first receipt after a committed but lost response using only a greater counter", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    f.evidenceResult(f.record().device.keyThumbprint, "lost");
    await f.coordinator.flushEvidence();
    const first = evidenceRequests(f)[0]!;
    const pending = structuredClone(f.record().evidence.pendingBatches);
    const receipt = [...f.server.receipts.values()];
    expect(f.record().evidence.acknowledgments).toEqual([]);
    f.evidenceResult(f.record().device.keyThumbprint, null);
    f.advance(15_000);
    await f.coordinator.refresh();
    const counterBeforeRetry = f.record().lastReservedCounter;
    await f.coordinator.flushEvidence();
    const retry = evidenceRequests(f).at(-1)!;
    expect(retry.durable.evidence.pendingBatches).toEqual(pending);
    expect(retry.body.batchDigest).toBe(first.body.batchDigest);
    expect(retry.body.facts).toEqual(first.body.facts);
    expect(retry.body.deviceProof).toMatchObject({
      counter: counterBeforeRetry + 1,
    });
    expect(f.record().evidence.acknowledgments).toEqual(receipt);
    expect(f.server.receipts.size).toBe(1);
  });

  it("treats a success-shaped but wrong acknowledgment as unconfirmed and preserves the exact pending batch", async () => {
    const f = harness();
    const fresh = await beginEvidenceAttempt(f);
    f.evidenceReply((reply) => Response.json({ ...reply, acknowledged: [] }));
    await f.coordinator.flushEvidence();
    expect(f.record().evidence.acknowledgments).toEqual([]);
    expect(f.record().evidence.pendingBatches).toHaveLength(1);
    expect(f.coordinator.readProtectionContext().freshAdmission).toBe(fresh);
    expect(f.coordinator.readProtectionContext().delivery).toBe("pending");
  });

  it("reserves no new signer, reopens no store and emits no late acknowledgment while timed-out upload I/O still owns transport", async () => {
    vi.useFakeTimers();
    const f = harness();
    await beginEvidenceAttempt(f);
    let release!: (response: Response) => void;
    f.blockFetch(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const upload = f.coordinator.flushEvidence();
    await vi.advanceTimersByTimeAsync(5_000);
    await upload;
    const before = f.storedBytes();
    const events = [...f.events];
    const requests = f.requests.length;
    f.advance(15_000);
    await f.coordinator.flushEvidence();
    await f.coordinator.refresh();
    await f.coordinator.retryPending();
    expect(f.events).toEqual(events);
    expect(f.requests).toHaveLength(requests);
    expect(f.storedBytes()).toEqual(before);
    const disposal = f.coordinator.dispose();
    await vi.advanceTimersByTimeAsync(20);
    expect(await disposal).toBe(false);
    expect(f.events).not.toContain("close");
    release(Response.json(unavailable, { status: 503 }));
    f.blockFetch(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.storedBytes()).toEqual(before);
    expect(f.events).not.toContain("close");
    expect(f.record().evidence.acknowledgments).toEqual([]);
  });

  it("waits for an abort-ignoring evidence exchange before disposal releases its native store", async () => {
    const f = harness();
    await beginEvidenceAttempt(f);
    let release!: (response: Response) => void;
    f.blockFetch(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const upload = f.coordinator.flushEvidence();
    await new Promise(setImmediate);
    const before = f.storedBytes();
    const request = evidenceRequests(f)[0]!;
    const pending = request.durable.evidence.pendingBatches[0]!;
    const disposal = f.coordinator.dispose();
    await upload;
    expect(f.events).not.toContain("close");
    release(
      Response.json({
        status: "accepted",
        code: "STUDENT_EVIDENCE_ACCEPTED",
        scope: request.body.scope,
        batchDigest: request.body.batchDigest,
        acceptedProofCounter: (request.body.deviceProof as { counter: number })
          .counter,
        acknowledged: pending.events.map((event) => ({
          ...event,
          receivedAt: "2026-09-08T14:00:00.000001Z",
        })),
      }),
    );
    expect(await disposal).toBe(true);
    expect(f.events.at(-1)).toBe("close");
    expect(f.storedBytes()).toEqual(before);
    expect(f.record().evidence.acknowledgments).toEqual([]);
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
    f.failAtWrite(4, true);
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

  it.each(["challenge", "join"])(
    "a first %s denial permits a corrected public code with the same enrollment and no protection authority",
    async (route) => {
      const f = harness();
      await f.coordinator.initialize();
      f.deny(route);
      await f.coordinator.joinInitial(code);
      const denied = f.record();
      expect(f.coordinator.readView()).toMatchObject({
        phase: "entry",
        session: null,
        pendingOperation: "join",
        calculatorEligible: false,
      });
      expect(denied.pending).toMatchObject({
        kind: "join",
        admissionMode: "initial",
        outcome: route === "join" ? "denied" : "not_dispatched",
      });
      expect(f.server.joins.size).toBe(0);
      expect(f.coordinator.readProtectionContext().admission).toBeNull();
      const before = f.requests.length;
      f.allow();
      await f.coordinator.joinInitial("0123456789AC");
      expect(f.requests.slice(before).map((request) => request.route)).toEqual([
        "challenge",
        "join",
      ]);
      const corrected = f.requests.at(-1)!.durable;
      expect(corrected.device).toEqual(denied.device);
      expect(corrected.lastReservedCounter).toBe(0);
      expect(corrected.nativeProtection).toBeNull();
      expect(corrected.evidence).toEqual(denied.evidence);
      expect(corrected.pending).toMatchObject({
        kind: "join",
        admissionMode: "initial",
        joinCode: "0123456789AC",
        outcome: "uncertain",
      });
      if (denied.pending?.kind !== "join" || corrected.pending?.kind !== "join")
        throw new Error("Expected initial join records");
      expect(corrected.pending.requestId).not.toBe(denied.pending.requestId);
      expect(corrected.pending.candidates).not.toEqual(
        denied.pending.candidates,
      );
      expect(f.preserved).toHaveLength(0);
      expect(f.server.joins.size).toBe(1);
      expect(f.coordinator.readView().phase).toBe("active");
      expect(f.coordinator.readProtectionContext().freshAdmission).toBeNull();
      expect(JSON.stringify(f.coordinator.readView())).not.toMatch(
        /removed|ended|expired/,
      );
    },
  );

  it("a durably denied initial attempt remains replaceable after restart without replacing its device", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.deny("join");
    await f.coordinator.joinInitial(code);
    const denied = f.record();
    expect(await f.coordinator.dispose()).toBe(true);
    const restarted = harness(f.server);
    restarted.setBytes(f.storedBytes()!);
    await restarted.coordinator.initialize();
    expect(restarted.coordinator.readView().phase).toBe("entry");
    expect(restarted.requests).toHaveLength(0);
    await restarted.coordinator.joinInitial("0123456789AC");
    expect(restarted.record().device).toEqual(denied.device);
    expect(restarted.record().current).not.toBeNull();
    expect(restarted.preserved).toHaveLength(0);
  });

  it.each([false, true])(
    "an uncertain pre-egress barrier emits no join and restart respects its possibly published marker: %s",
    async (published) => {
      const f = harness();
      await f.coordinator.initialize();
      f.failAtWrite(3, published);
      await f.coordinator.joinInitial(code);
      expect(f.requests.map((request) => request.route)).toEqual(["challenge"]);
      expect(f.coordinator.readView().phase).toBe("unconfirmed");
      const before = f.record();
      expect(before.pending).toMatchObject({
        outcome: published ? "uncertain" : "not_dispatched",
      });
      await f.coordinator.joinInitial("0123456789AC");
      expect(f.requests).toHaveLength(1);
      expect(await f.coordinator.dispose()).toBe(true);
      const restarted = harness();
      restarted.setBytes(f.storedBytes()!);
      await restarted.coordinator.initialize();
      expect(restarted.coordinator.readView().phase).toBe(
        published ? "unconfirmed" : "entry",
      );
      await restarted.coordinator.joinInitial("0123456789AC");
      if (published) {
        expect(restarted.requests).toHaveLength(0);
        restarted.deny("join");
        await restarted.coordinator.retryPending();
        expect(restarted.record().pending).toEqual(before.pending);
        expect(restarted.coordinator.readView().phase).toBe("unavailable");
      } else {
        expect(restarted.record().device).toEqual(before.device);
        expect(restarted.coordinator.readView().phase).toBe("active");
      }
    },
  );

  it.each([false, true])(
    "a failed denial publication never enables replacement until durable recovery: %s",
    async (published) => {
      const f = harness();
      await f.coordinator.initialize();
      f.deny("join");
      f.beforeResponse(async (route) => {
        if (route === "join") f.failNextWrite(published);
      });
      await f.coordinator.joinInitial(code);
      expect(f.coordinator.readView().phase).toBe("unconfirmed");
      expect(f.record().pending).toMatchObject({
        outcome: published ? "denied" : "uncertain",
      });
      await f.coordinator.joinInitial("0123456789AC");
      expect(f.requests.map((request) => request.route)).toEqual([
        "challenge",
        "join",
      ]);
      expect(await f.coordinator.dispose()).toBe(true);
      const restarted = harness();
      restarted.setBytes(f.storedBytes()!);
      await restarted.coordinator.initialize();
      expect(restarted.coordinator.readView().phase).toBe(
        published ? "entry" : "unconfirmed",
      );
      await restarted.coordinator.joinInitial("0123456789AC");
      expect(restarted.requests).toHaveLength(published ? 2 : 0);
    },
  );

  it.each(["challenge", "join"])(
    "a lost successful join followed by %s denial preserves the original uncertain intent across restart",
    async (route) => {
      const f = harness();
      await f.coordinator.initialize();
      f.dropJoinResponse();
      await f.coordinator.joinInitial(code);
      const pending = f.record();
      expect(f.server.joins.size).toBe(1);
      expect(pending.pending).toMatchObject({ outcome: "uncertain" });
      f.deny(route);
      await f.coordinator.retryPending();
      expect(f.coordinator.readView()).toMatchObject({
        phase: "unavailable",
        pendingOperation: "join",
      });
      const before = f.requests.length;
      await f.coordinator.joinInitial("0123456789AC");
      expect(f.requests).toHaveLength(before);
      expect(f.record().pending).toEqual(pending.pending);
      expect(f.record().device).toEqual(pending.device);
      expect(await f.coordinator.dispose()).toBe(true);
      const restarted = harness(f.server);
      restarted.setBytes(f.storedBytes()!);
      await restarted.coordinator.initialize();
      expect(restarted.coordinator.readView().phase).toBe("unconfirmed");
      await restarted.coordinator.joinInitial("0123456789AC");
      expect(restarted.requests).toHaveLength(0);
      await restarted.coordinator.retryPending();
      expect(restarted.requests.at(-1)?.durable.pending).toEqual(
        pending.pending,
      );
      expect(restarted.record().device).toEqual(pending.device);
      expect(restarted.coordinator.readView().phase).toBe("active");
      expect(f.server.joins.size).toBe(1);
    },
  );

  it("a malformed 403 remains uncertain and cannot authorize a corrected initial request", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.replyToJoin(() =>
      Response.json(
        { status: "denied", code: "STUDENT_SESSION_DENIED", extra: true },
        { status: 403 },
      ),
    );
    await f.coordinator.joinInitial(code);
    expect(f.coordinator.readView().phase).toBe("unconfirmed");
    expect(f.record().pending).toMatchObject({ outcome: "uncertain" });
    await f.coordinator.joinInitial("0123456789AC");
    expect(f.requests).toHaveLength(2);
  });

  it("concurrent corrected-code commands retain one enrollment and admit only the first owned intent", async () => {
    const f = harness();
    await f.coordinator.initialize();
    f.deny("join");
    await f.coordinator.joinInitial(code);
    const device = f.record().device;
    f.allow();
    await Promise.all([
      f.coordinator.joinInitial("0123456789AC"),
      f.coordinator.joinInitial("0123456789AD"),
    ]);
    expect(f.requests).toHaveLength(4);
    expect(f.requests.at(-1)?.durable.pending).toMatchObject({
      joinCode: "0123456789AC",
    });
    expect(f.record().device).toEqual(device);
    expect(f.server.joins.size).toBe(1);
  });

  it("generic denial of admitted authority retains only explicit targeted recovery and exact retry", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.deny();
    f.advance(15_000);
    await f.coordinator.refresh();
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

  it.each(["missing", "generation", "counter", "version"])(
    "a v5 integrity failure (%s) preserves the original ciphertext and blocks every admission path",
    async (mutation) => {
      const f = harness();
      await f.coordinator.initialize();
      await f.coordinator.joinInitial(code);
      const payload = JSON.parse(
        f.storedBytes()!.toString().slice(10),
      ) as Record<string, unknown>;
      if (mutation === "missing") delete payload.integritySha256;
      if (mutation === "generation")
        payload.generation = Number(payload.generation) + 1;
      if (mutation === "counter")
        payload.lastReservedCounter = Number(payload.lastReservedCounter) + 1;
      if (mutation === "version") payload.version = 3;
      const corrupted = Buffer.from(`synthetic:${JSON.stringify(payload)}`);
      expect(await f.coordinator.dispose()).toBe(true);
      const restarted = harness();
      restarted.setBytes(corrupted);
      await restarted.coordinator.initialize();
      expect(restarted.coordinator.readView().phase).toBe("recovery_required");
      await restarted.coordinator.joinInitial("0123456789AC");
      await restarted.coordinator.retryPending();
      await restarted.coordinator.beginTargetedReadmission(
        code,
        restarted.coordinator.readView().revision,
      );
      await restarted.coordinator.refresh();
      expect(restarted.requests).toHaveLength(0);
      expect(restarted.preserved).toHaveLength(0);
      expect(restarted.events.some((event) => event.startsWith("write:"))).toBe(
        false,
      );
      expect(
        restarted.coordinator.readProtectionContext().admission,
      ).toBeNull();
      expect(restarted.storedBytes()).toEqual(corrupted);
      expect(await restarted.coordinator.dispose()).toBe(true);
      expect(restarted.storedBytes()).toEqual(corrupted);
    },
  );

  it("a same-process checksum failure after an uncertain write blocks targeted recovery without quarantining bytes", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    f.advance(15_000);
    f.failNextWrite(true);
    await f.coordinator.refresh();
    const payload = JSON.parse(f.storedBytes()!.toString().slice(10)) as Record<
      string,
      unknown
    >;
    payload.generation = Number(payload.generation) + 1;
    const corrupted = Buffer.from(`synthetic:${JSON.stringify(payload)}`);
    f.setBytes(corrupted);
    await f.coordinator.retryPending();
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    const events = [...f.events];
    const requests = f.requests.length;
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    await f.coordinator.joinInitial("0123456789AC");
    await f.coordinator.retryPending();
    await f.coordinator.refresh();
    expect(f.preserved).toHaveLength(0);
    expect(f.events).toEqual(events);
    expect(f.requests).toHaveLength(requests);
    expect(f.storedBytes()).toEqual(corrupted);
    expect(f.coordinator.readProtectionContext().admission).toBeNull();
  });

  it("targeted recovery rechecks integrity uncertainty discovered by its own reload before quarantine", async () => {
    const f = harness();
    await f.coordinator.initialize();
    await f.coordinator.joinInitial(code);
    await f.coordinator.forfeit(f.coordinator.readView().revision);
    f.failQuarantineOnce();
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    const payload = JSON.parse(f.storedBytes()!.toString().slice(10)) as Record<
      string,
      unknown
    >;
    payload.generation = Number(payload.generation) + 1;
    const corrupted = Buffer.from(`synthetic:${JSON.stringify(payload)}`);
    f.setBytes(corrupted);
    const writes = f.events.filter((event) => event.startsWith("write:"));
    const requests = f.requests.length;
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    expect(f.preserved).toHaveLength(0);
    expect(f.events.filter((event) => event.startsWith("write:"))).toEqual(
      writes,
    );
    expect(f.requests).toHaveLength(requests);
    expect(f.storedBytes()).toEqual(corrupted);
    expect(f.coordinator.readProtectionContext().admission).toBeNull();
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
      syntheticStoredRecord({
        ...previous,
        generation: previous.generation + 4,
        lastReservedCounter: 7,
      }),
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
