import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  encodeStudentEvidenceProof,
  parseNativeEvidenceOriginBuild,
  parseNativeProtectionCategories,
  parseNativeProtectionFact,
  parseNativeProtectionFactPrefix,
  parseReadStudentProtectionEventsRequest,
  parseReadStudentProtectionEventsRpcResult,
  parseStaffStudentProtectionEvent,
  parseStaffStudentProtectionEventPage,
  parseStudentEvidenceRequest,
  parseStudentEvidenceResult,
  parseStudentProtectionEventPageCursor,
  type NativeEvidenceOriginBuild,
  type NativeProtectionFact,
  type StudentEvidenceRequest,
  type ReadStudentProtectionEventsRequest,
} from "../src/native-protection-evidence.js";
import type { StudentSessionScope } from "../src/student-session.js";

interface Vector {
  name: string;
  apiOrigin: string;
  publicKey: string;
  originalKeyThumbprint: string;
  scope: StudentSessionScope;
  originBuild: NativeEvidenceOriginBuild;
  facts: NativeProtectionFact[];
  counter: number;
  contentBytesHex: string[];
  contentDigests: string[];
  batchBytesHex: string;
  batchDigest: string;
  proofBytesHex: string;
}
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/native-protection-evidence-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { version: number; vectors: Vector[] };
const vector = fixture.vectors[0] as Vector;
const uuid = (id: number) =>
  `10000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
const clone = <T>(value: T): T => structuredClone(value);
const hex = (bytes: Uint8Array | null) =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");
const hash = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
function context(v = vector) {
  return {
    apiOrigin: v.apiOrigin,
    originalKeyThumbprint: v.originalKeyThumbprint,
    scope: v.scope,
    originBuild: v.originBuild,
  };
}
function request(v = vector): StudentEvidenceRequest {
  return {
    version: 1,
    scope: v.scope,
    originBuild: v.originBuild,
    facts: v.facts,
    batchDigest: v.batchDigest,
    publicKey: v.publicKey,
    deviceProof: { counter: v.counter, signature: "A".repeat(86) },
  };
}
const receivedAt = "2026-09-08T10:20:30.123456Z";
function accepted(v = vector) {
  return {
    status: "accepted",
    code: "STUDENT_EVIDENCE_ACCEPTED",
    scope: v.scope,
    batchDigest: v.batchDigest,
    acceptedProofCounter: v.counter,
    acknowledged: v.facts.map((fact, index) => ({
      eventId: fact.eventId,
      contentDigest: v.contentDigests[index],
      receivedAt,
    })),
  };
}
const fact = vector.facts[0] as NativeProtectionFact;

describe("native evidence exact bytes", () => {
  it.each(fixture.vectors)(
    "matches independently authored $name golden bytes and digests",
    (v) => {
      expect(parseStudentEvidenceRequest(request(v))).not.toBeNull();
      v.facts.forEach((fact, index) => {
        const bytes = encodeNativeProtectionFactDigestInput({
          ...context(v),
          fact,
        });
        expect(hex(bytes)).toBe(v.contentBytesHex[index]);
        expect(hash(bytes)).toBe(v.contentDigests[index]);
      });
      const batch = encodeStudentEvidenceBatchDigestInput({
        ...context(v),
        facts: v.facts,
        contentDigests: v.contentDigests,
      });
      expect(hex(batch)).toBe(v.batchBytesHex);
      expect(hash(batch)).toBe(v.batchDigest);
      expect(
        hex(
          encodeStudentEvidenceProof({
            apiOrigin: v.apiOrigin,
            originalKeyThumbprint: v.originalKeyThumbprint,
            scope: v.scope,
            batchDigest: v.batchDigest,
            counter: v.counter,
          }),
        ),
      ).toBe(v.proofBytesHex);
    },
  );
  it("keeps content and batch identity across counter-only retries while changing proof bytes", () => {
    const retried = {
      ...request(),
      deviceProof: { counter: 1, signature: "B".repeat(85) + "A" },
    };
    expect(parseStudentEvidenceRequest(retried)).not.toBeNull();
    expect(
      hash(
        encodeStudentEvidenceBatchDigestInput({
          ...context(),
          facts: retried.facts,
          contentDigests: vector.contentDigests,
        }),
      ),
    ).toBe(vector.batchDigest);
    const input = {
      apiOrigin: vector.apiOrigin,
      originalKeyThumbprint: vector.originalKeyThumbprint,
      scope: vector.scope,
      batchDigest: vector.batchDigest,
      counter: 1,
    };
    expect(hex(encodeStudentEvidenceProof(input))).not.toBe(
      vector.proofBytesHex,
    );
    expect(
      encodeStudentEvidenceProof({ ...input, intent: "state.read" }),
    ).toBeNull();
    expect(
      encodeStudentEvidenceProof({
        ...input,
        domain: "desmoslock/student-maintenance-proof/v1",
      }),
    ).toBeNull();
  });
  it("binds every semantic fact field by a digest change or strict rejection", () => {
    const base = { ...context(), fact };
    const changes: Record<string, unknown>[] = [
      { policyVersion: 2 },
      { sequence: fact.sequence - 1 },
      { eventId: uuid(100) },
      { attemptId: uuid(101) },
      { scope: { ...fact.scope, epoch: 1 } },
      { slot: "cleanup" },
      { phase: "failed" },
      { nativeEvent: "did_end" },
      { nativeSequence: 1 },
      { cause: "backend_unavailable" },
      {
        categories: {
          ...fact.categories,
          aac: { status: "pending", code: "none" },
        },
      },
    ];
    for (const change of changes)
      expect(
        hash(
          encodeNativeProtectionFactDigestInput({
            ...base,
            fact: { ...fact, ...change },
          }),
        ),
      ).not.toBe(vector.contentDigests[0]);
    for (const key of [
      "schoolId",
      "testId",
      "studentSessionId",
      "deviceSessionId",
    ] as const) {
      const scope = { ...fact.scope, [key]: uuid(102) };
      expect(
        hash(
          encodeNativeProtectionFactDigestInput({
            ...base,
            scope,
            fact: { ...fact, scope },
          }),
        ),
      ).not.toBe(vector.contentDigests[0]);
    }
    for (const key of [
      "aac",
      "shortcuts",
      "applications",
      "persistence",
      "windowNetwork",
    ] as const) {
      const categories = {
        ...fact.categories,
        [key]: { status: "pending", code: "none" },
      };
      expect(
        hash(
          encodeNativeProtectionFactDigestInput({
            ...base,
            fact: { ...fact, categories },
          }),
        ),
      ).not.toBe(vector.contentDigests[0]);
    }
  });
  it("binds original build, API origin and key thumbprint; excludes all supplied transport/self fields", () => {
    const base = { ...context(), fact };
    for (const changed of [
      { apiOrigin: "http://127.0.0.1:54322" },
      { originalKeyThumbprint: "A".repeat(43) },
      {
        scope: { ...vector.scope, epoch: 1 },
        fact: { ...fact, scope: { ...vector.scope, epoch: 1 } },
      },
      { originBuild: { kind: "legacy_unknown" } },
    ])
      expect(
        hash(encodeNativeProtectionFactDigestInput({ ...base, ...changed })),
      ).not.toBe(vector.contentDigests[0]);
    if (vector.originBuild.kind !== "build")
      throw new Error("known fixture required");
    for (const key of [
      "sourceCommit",
      "sourceTree",
      "packageLockSha256",
      "buildId",
    ] as const) {
      const identity = {
        ...vector.originBuild.identity,
        [key]: "e".repeat(key.startsWith("source") ? 40 : 64),
      };
      expect(
        hash(
          encodeNativeProtectionFactDigestInput({
            ...base,
            originBuild: { kind: "build", identity },
          }),
        ),
      ).not.toBe(vector.contentDigests[0]);
    }
    for (const key of [
      "counter",
      "signature",
      "batchDigest",
      "receivedAt",
      "headers",
    ]) {
      expect(
        encodeNativeProtectionFactDigestInput({ ...base, [key]: "extra" }),
      ).toBeNull();
      expect(
        encodeStudentEvidenceBatchDigestInput({
          ...context(),
          facts: vector.facts,
          contentDigests: vector.contentDigests,
          [key]: "extra",
        }),
      ).toBeNull();
    }
    expect(
      encodeNativeProtectionFactDigestInput({
        ...base,
        apiOrigin: vector.apiOrigin + "/",
      }),
    ).toBeNull();
    expect(
      encodeStudentEvidenceBatchDigestInput({
        ...context(),
        facts: vector.facts,
        contentDigests: vector.contentDigests.slice(1),
      }),
    ).toBeNull();
  });
});

describe("finite facts and prefixes", () => {
  it("snapshots and deeply freezes exact data without invoking accessors", () => {
    const input = clone(request());
    const result = parseStudentEvidenceRequest(input);
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result?.facts[0]?.categories.aac)).toBe(true);
    expect(Object.isFrozen(result?.scope)).toBe(true);
    Object.defineProperty(input, "facts", { value: [] });
    expect(result?.facts).toHaveLength(8);
    const getter = vi.fn(() => fact.scope);
    expect(
      parseNativeProtectionFact(
        Object.defineProperty({ ...fact }, "scope", {
          get: getter,
          enumerable: true,
        }),
      ),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const arrayGetter = vi.fn(() => fact);
    expect(
      parseNativeProtectionFactPrefix(
        Object.defineProperty([fact], "0", {
          get: arrayGetter,
          enumerable: true,
        }),
      ),
    ).toBeNull();
    expect(arrayGetter).not.toHaveBeenCalled();
    expect(
      parseNativeProtectionFact(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("hostile");
            },
          },
        ),
      ),
    ).toBeNull();
  });
  it("rejects unknown, noncanonical and impossible finite fields", () => {
    for (const change of [
      { extra: true },
      { sequence: 0 },
      { sequence: -0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { sequence: 1.5 },
      { eventId: uuid(1).replace("-4000-", "-1000-") },
      { eventId: uuid(1).toUpperCase() + "\n" },
      { nativeEvent: undefined },
      { nativeEvent: "arbitrary" },
      { nativeSequence: 0 },
      { cause: "raw error" },
      { slot: "other" },
      { phase: "idle" },
      { phase: "locked" },
      { policyVersion: 2 },
      {
        categories: {
          ...fact.categories,
          aac: { status: "confirmed", code: "none" },
        },
      },
    ])
      expect(parseNativeProtectionFact({ ...fact, ...change })).toBeNull();
    expect(parseNativeProtectionFact(Object.create(fact))).toBeNull();
    expect(
      parseNativeProtectionFact({ ...fact, [Symbol("extra")]: true }),
    ).toBeNull();
    expect(
      parseNativeProtectionFact(
        Object.defineProperty({ ...fact }, "cause", {
          value: "none",
          enumerable: false,
        }),
      ),
    ).toBeNull();
  });
  it("enforces category-specific failure codes and confirmed/pending semantics", () => {
    for (const [status, code] of [
      ["confirmed", "native_inactive"],
      ["pending", "native_inactive"],
      ["failed", "none"],
      ["failed", "prohibited_application"],
      ["unknown", "none"],
    ])
      expect(
        parseNativeProtectionCategories({
          ...fact.categories,
          aac: { status, code },
        }),
      ).toBeNull();
    expect(
      parseNativeProtectionCategories({
        ...fact.categories,
        shortcuts: { status: "pending", code: "awaiting_native_begin" },
      }),
    ).toBeNull();
    expect(
      parseNativeProtectionCategories({ ...fact.categories, rawApps: [] }),
    ).toBeNull();
  });
  it("rejects suffixes, reordered or duplicate slots/IDs/sequences, mixed attempts and foreign scopes", () => {
    const known = vector.facts;
    for (const facts of [
      [],
      known.slice(1),
      [...known].reverse(),
      [...known, fact],
      [fact, fact],
      [fact, { ...known[1], eventId: fact.eventId }],
      [fact, { ...known[1], sequence: fact.sequence }],
      [fact, { ...known[1], attemptId: uuid(70) }],
      [fact, { ...known[1], scope: { ...fact.scope, epoch: 1 } }],
      [fact, known[2]],
      [fact, known[1], { ...known[2], nativeSequence: 1 }],
      [
        fact,
        known[1],
        { ...known[4], nativeSequence: known[1]?.nativeSequence },
      ],
    ])
      expect(parseNativeProtectionFactPrefix(facts)).toBeNull();
    expect(parseNativeProtectionFactPrefix(new Array(1))).toBeNull();
    expect(
      parseNativeProtectionFactPrefix(Object.assign([fact], { extra: true })),
    ).toBeNull();
  });
  it("rejects invalid slot/native/cause combinations while preserving journal-compatible nullable sequences", () => {
    for (const change of [
      { slot: "began", nativeEvent: null },
      { slot: "native_terminal", nativeEvent: "did_begin", nativeSequence: 1 },
      {
        slot: "failure",
        nativeEvent: "did_end",
        nativeSequence: 1,
        cause: "native_failure",
      },
      { slot: "cleanup", nativeEvent: "did_end", nativeSequence: 1 },
      { slot: "abandoned", cause: "none" },
      { slot: "end_requested", cause: "none" },
      { slot: "locked", phase: "locked", nativeSequence: 1 },
    ])
      expect(parseNativeProtectionFact({ ...fact, ...change })).toBeNull();
    expect(
      parseNativeProtectionFact({ ...fact, slot: "cleanup", phase: "failed" }),
    ).not.toBeNull();
  });
  it("requires exact origin variants and a valid collector identity", () => {
    for (const value of [
      null,
      {},
      { kind: "unknown" },
      { kind: "legacy_unknown", identity: {} },
      { kind: "build", identity: null },
      { kind: "unverified_build", extra: true },
    ])
      expect(parseNativeEvidenceOriginBuild(value)).toBeNull();
    if (vector.originBuild.kind !== "build")
      throw new Error("known fixture required");
    expect(
      parseNativeEvidenceOriginBuild({
        kind: "build",
        identity: {
          ...vector.originBuild.identity,
          sourceRepository: "other/repo",
        },
      }),
    ).toBeNull();
  });
  it("rejects malformed transport/proof fields and stays inside the selected16KiB request limit", () => {
    for (const change of [
      { version: 2 },
      { scope: { ...fact.scope, epoch: 1 } },
      { batchDigest: "a".repeat(63) },
      { publicKey: "B".repeat(43) },
      { deviceProof: { counter: 0, signature: "A".repeat(86) } },
      { facts: undefined },
      { capabilityToken: "extra" },
    ])
      expect(
        parseStudentEvidenceRequest({ ...request(), ...change }),
      ).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(request()))).toBeLessThan(
      16 * 1024,
    );
  });
});

describe("exact acknowledgment", () => {
  it("accepts only the full exact event/digest set, including reordered receipts", () => {
    expect(
      parseStudentEvidenceResult(accepted(), request(), vector.contentDigests),
    ).not.toBeNull();
    expect(
      parseStudentEvidenceResult(
        { ...accepted(), acknowledged: [...accepted().acknowledged].reverse() },
        request(),
        vector.contentDigests,
      ),
    ).not.toBeNull();
    const valid = accepted();
    for (const change of [
      { acknowledged: valid.acknowledged.slice(1) },
      { acknowledged: [...valid.acknowledged, valid.acknowledged[0]] },
      {
        acknowledged: valid.acknowledged.map((row) => ({
          ...row,
          eventId: uuid(80),
        })),
      },
      {
        acknowledged: valid.acknowledged.map((row) => ({
          ...row,
          contentDigest: "a".repeat(64),
        })),
      },
      {
        acknowledged: valid.acknowledged.map((row) => ({
          ...row,
          receivedAt: "2026-09-08T10:20:30.123Z",
        })),
      },
      { acceptedProofCounter: 1 },
      { scope: { ...fact.scope, epoch: 1 } },
      { batchDigest: "e".repeat(64) },
      { status: "success" },
      { code: "STUDENT_SESSION_CURRENT" },
      { extra: true },
    ])
      expect(
        parseStudentEvidenceResult(
          { ...valid, ...change },
          request(),
          vector.contentDigests,
        ),
      ).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(valid))).toBeLessThan(8 * 1024);
  });
  it("preserves fixed denial/unavailability without treating them as receipts", () => {
    for (const [status, code] of [
      ["denied", "STUDENT_SESSION_DENIED"],
      ["unavailable", "STUDENT_SESSION_UNAVAILABLE"],
    ]) {
      expect(
        parseStudentEvidenceResult(
          { status, code },
          request(),
          vector.contentDigests,
        ),
      ).toEqual({ status, code });
      expect(
        parseStudentEvidenceResult(
          { status, code, acknowledged: [] },
          request(),
          vector.contentDigests,
        ),
      ).toBeNull();
    }
    expect(
      parseStudentEvidenceResult(
        accepted(),
        request(),
        vector.contentDigests.slice(1),
      ),
    ).toBeNull();
  });
});

describe("staff historical evidence projection", () => {
  const read: ReadStudentProtectionEventsRequest = {
    schoolId: fact.scope.schoolId,
    testId: fact.scope.testId,
    studentSessionId: fact.scope.studentSessionId,
    before: null,
  };
  const event = {
    fact,
    originBuild: vector.originBuild,
    contentDigest: vector.contentDigests[0],
    receivedAt,
  };
  const rpc = (value = event) => ({
    code: "ok",
    fact: value.fact,
    origin_build: value.originBuild,
    content_digest: value.contentDigest,
    received_at: value.receivedAt,
  });
  it("keeps original epoch/build and exact receipt microseconds, excluding all proof data", () => {
    expect(parseStaffStudentProtectionEvent(event)).toEqual(event);
    expect(parseReadStudentProtectionEventsRpcResult([rpc()], read)).toEqual({
      ok: true,
      page: { items: [event], nextCursor: null },
    });
    expect(
      parseStaffStudentProtectionEvent({
        ...event,
        publicKey: vector.publicKey,
      }),
    ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRequest({ ...read, epoch: 1 }),
    ).toBeNull();
    expect(
      parseStudentProtectionEventPageCursor({
        receivedAt,
        eventId: fact.eventId,
      }),
    ).not.toBeNull();
    expect(
      parseStudentProtectionEventPageCursor({
        receivedAt: receivedAt.replace("123456", "123"),
        eventId: fact.eventId,
      }),
    ).toBeNull();
  });
  it("validates all51rows including hidden row then emits exact50row cursor", () => {
    const events = Array.from({ length: 51 }, (_, index) => ({
      ...event,
      fact: { ...fact, eventId: uuid(200 - index) },
      receivedAt: `2026-09-08T10:20:30.${String(900 - Math.floor(index / 3)).padStart(6, "0")}Z`,
    }));
    const result = parseReadStudentProtectionEventsRpcResult(
      events.map(rpc),
      read,
    );
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("page required");
    expect(result.page.items).toHaveLength(50);
    expect(result.page.nextCursor).toEqual({
      receivedAt: events[49]?.receivedAt,
      eventId: events[49]?.fact.eventId,
    });
    expect(parseStaffStudentProtectionEventPage(result.page, read)).toEqual(
      result.page,
    );
    expect(
      parseStaffStudentProtectionEventPage(
        { ...result.page, nextCursor: { receivedAt, eventId: uuid(1) } },
        read,
      ),
    ).toBeNull();
    const hidden = events[50];
    if (hidden === undefined) throw new Error("hidden row required");
    events[50] = {
      ...hidden,
      fact: {
        ...hidden.fact,
        scope: { ...hidden.fact.scope, schoolId: uuid(99) },
      },
    };
    expect(
      parseReadStudentProtectionEventsRpcResult(events.map(rpc), read),
    ).toBeNull();
  });
  it("rejects foreign targets, duplicate/order/cursor drift, extra fields and dirty failure rows", () => {
    for (const key of ["schoolId", "testId", "studentSessionId"] as const)
      expect(
        parseReadStudentProtectionEventsRpcResult([rpc()], {
          ...read,
          [key]: uuid(99),
        }),
      ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRpcResult([rpc(), rpc()], read),
    ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRpcResult([rpc()], {
        ...read,
        before: { receivedAt, eventId: fact.eventId },
      }),
    ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRpcResult(
        [{ ...rpc(), signature: "extra" }],
        read,
      ),
    ).toBeNull();
    const failure = {
      code: "forbidden",
      fact: null,
      origin_build: null,
      content_digest: null,
      received_at: null,
    };
    expect(parseReadStudentProtectionEventsRpcResult([failure], read)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(
      parseReadStudentProtectionEventsRpcResult([{ ...failure, fact }], read),
    ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRpcResult(
        [{ ...failure, code: "success" }],
        read,
      ),
    ).toBeNull();
    expect(
      parseReadStudentProtectionEventsRpcResult([failure, failure], read),
    ).toBeNull();
  });
});
