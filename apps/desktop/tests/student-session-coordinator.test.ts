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
  };
}

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

  it("coalesces 15-second maintenance and replaces a due renewal read with one rotation", async () => {
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
    ]);
    expect(f.record().lastReservedCounter).toBe(2);
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
    expect(f.requests.at(-1)?.route).toBe("reconnect");
    expect(f.record().lastReservedCounter).toBe(2);
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

  it("corrupt storage has no automatic initial fallback and stale recovery review cannot quarantine", async () => {
    const f = harness();
    f.setBytes(Buffer.from("opaque corrupt artifact"));
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
    expect(f.requests.at(-1)?.body.admissionMode).toBe("readmission");
    expect(f.preserved).toEqual([Buffer.from("opaque corrupt artifact")]);
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

  it("reopens after a once-failing quarantine and a new reviewed recovery preserves exact old bytes", async () => {
    const f = harness();
    const original = Buffer.from("exact unreadable artifact");
    f.setBytes(original);
    await f.coordinator.initialize();
    f.failQuarantineOnce();
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.requests).toHaveLength(0);
    await f.coordinator.retryPending();
    expect(f.coordinator.readView().phase).toBe("recovery_required");
    await f.coordinator.beginTargetedReadmission(
      code,
      f.coordinator.readView().revision,
    );
    expect(f.preserved).toEqual([original]);
    expect(f.requests.at(-1)?.body.admissionMode).toBe("readmission");
  });
});
