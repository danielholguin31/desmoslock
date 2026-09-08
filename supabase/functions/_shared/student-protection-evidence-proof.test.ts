import fixture from "../../../packages/contracts/tests/fixtures/native-protection-evidence-vectors.json" with { type: "json" };
import {
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  encodeStudentEvidenceProof,
  type NativeEvidenceOriginBuild,
  type NativeProtectionFact,
  parseClientBuildIdentity,
  parseNativeEvidenceOriginBuild,
  parseNativeProtectionCategories,
  parseNativeProtectionFact,
  parseNativeProtectionFactPrefix,
  parseStudentEvidenceRequest,
  parseStudentEvidenceResult,
  parseStudentSessionFailure,
  parseStudentTimestamp,
  type StudentEvidenceRequest,
} from "./student-protection-evidence-proof.ts";
import {
  edgeStudentKeyThumbprint,
  type EdgeStudentSessionScope,
  encodeEdgeStudentProofBytes,
} from "./student-session-proof.ts";

interface Vector {
  name: string;
  apiOrigin: string;
  publicKey: string;
  originalKeyThumbprint: string;
  scope: EdgeStudentSessionScope;
  originBuild: NativeEvidenceOriginBuild;
  facts: NativeProtectionFact[];
  counter: number;
  contentBytesHex: string[];
  contentDigests: string[];
  batchBytesHex: string;
  batchDigest: string;
  proofBytesHex: string;
}
const vectors = fixture.vectors as Vector[];
const vector = vectors[0];
const first = vector.facts[0];
const receivedAt = "2026-09-08T10:20:30.123456Z";
const uuid = (id: number) =>
  `10000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
function assertEquals(actual: unknown, expected: unknown): void {
  if (
    Object.is(actual, expected) ||
    JSON.stringify(actual) === JSON.stringify(expected)
  )
    return;
  throw new Error(
    `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}
function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected valid synthetic fixture");
  return value;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
async function hash(bytes: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  );
}
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

for (const v of vectors) {
  Deno.test(
    `evidence Edge matches independent ${v.name} fact/batch/proof byte and SHA256 vectors`,
    async () => {
      required(parseStudentEvidenceRequest(request(v)));
      assertEquals(
        await edgeStudentKeyThumbprint(v.publicKey),
        v.originalKeyThumbprint,
      );
      for (const [index, fact] of v.facts.entries()) {
        const bytes = required(
          encodeNativeProtectionFactDigestInput({ ...context(v), fact }),
        );
        assertEquals(hex(bytes), v.contentBytesHex[index]);
        assertEquals(await hash(bytes), v.contentDigests[index]);
        assertEquals(
          new TextDecoder().decode(bytes).split("\0")[0],
          "desmoslock/native-protection-fact/v1",
        );
      }
      const batch = required(
        encodeStudentEvidenceBatchDigestInput({
          ...context(v),
          facts: v.facts,
          contentDigests: v.contentDigests,
        }),
      );
      assertEquals(hex(batch), v.batchBytesHex);
      assertEquals(await hash(batch), v.batchDigest);
      assertEquals(
        hex(
          required(
            encodeStudentEvidenceProof({
              apiOrigin: v.apiOrigin,
              originalKeyThumbprint: v.originalKeyThumbprint,
              scope: v.scope,
              batchDigest: v.batchDigest,
              counter: v.counter,
            }),
          ),
        ),
        v.proofBytesHex,
      );
    },
  );
}

Deno.test(
  "evidence proof bytes verify using actual ephemeral Ed25519 and reject counter/domain/scope/key/content tampering",
  async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = required(
      encodeEdgeStudentProofBytes(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      ),
    );
    const thumbprint = required(await edgeStudentKeyThumbprint(publicKey));
    const base = { ...context(), originalKeyThumbprint: thumbprint };
    const contentDigests = await Promise.all(
      vector.facts.map((fact) =>
        hash(
          required(encodeNativeProtectionFactDigestInput({ ...base, fact })),
        ),
      ),
    );
    const batchDigest = await hash(
      required(
        encodeStudentEvidenceBatchDigestInput({
          ...base,
          facts: vector.facts,
          contentDigests,
        }),
      ),
    );
    const proofInput = {
      apiOrigin: vector.apiOrigin,
      originalKeyThumbprint: thumbprint,
      scope: vector.scope,
      batchDigest,
      counter: 10,
    };
    const bytes = required(encodeStudentEvidenceProof(proofInput));
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new Uint8Array(bytes),
    );
    const verify = (input: Uint8Array) =>
      crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        signature,
        new Uint8Array(input),
      );
    assertEquals(await verify(bytes), true);
    for (const change of [
      { counter: 11 },
      { scope: { ...vector.scope, epoch: 1 } },
      { batchDigest: "e".repeat(64) },
      { originalKeyThumbprint: vector.originalKeyThumbprint },
      { apiOrigin: "http://127.0.0.1:54322" },
    ]) {
      assertEquals(
        await verify(
          required(encodeStudentEvidenceProof({ ...proofInput, ...change })),
        ),
        false,
      );
    }
    for (const [before, after] of [
      [
        "desmoslock/student-evidence-proof/v1",
        "desmoslock/student-maintenance-proof/v1",
      ],
      [
        "desmoslock/student-evidence-proof/v1",
        "desmoslock/student-bootstrap-proof/v1",
      ],
      ["evidence.ingest", "state.read"],
    ]) {
      assertEquals(
        await verify(
          new TextEncoder().encode(
            new TextDecoder().decode(bytes).replace(before, after),
          ),
        ),
        false,
      );
    }
    const changedFact = { ...first, cause: "backend_unavailable" };
    const changedContent = await hash(
      required(
        encodeNativeProtectionFactDigestInput({ ...base, fact: changedFact }),
      ),
    );
    const changedBatch = await hash(
      required(
        encodeStudentEvidenceBatchDigestInput({
          ...base,
          facts: [changedFact, ...vector.facts.slice(1)],
          contentDigests: [changedContent, ...contentDigests.slice(1)],
        }),
      ),
    );
    assertEquals(changedBatch === batchDigest, false);
    assertEquals(
      await verify(
        required(
          encodeStudentEvidenceProof({
            ...proofInput,
            batchDigest: changedBatch,
          }),
        ),
      ),
      false,
    );
    const corrupt = new Uint8Array(signature);
    corrupt[0] ^= 1;
    assertEquals(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        corrupt,
        new Uint8Array(bytes),
      ),
      false,
    );
    const retryBytes = required(
      encodeStudentEvidenceProof({ ...proofInput, counter: 11 }),
    );
    const retrySignature = await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new Uint8Array(retryBytes),
    );
    assertEquals(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        retrySignature,
        new Uint8Array(retryBytes),
      ),
      true,
    );
    assertEquals(
      await hash(
        required(
          encodeStudentEvidenceBatchDigestInput({
            ...base,
            facts: vector.facts,
            contentDigests,
          }),
        ),
      ),
      batchDigest,
    );
  },
);

Deno.test(
  "evidence Edge binds every semantic field by changed digest or strict rejection",
  async () => {
    const input = { ...context(), fact: first };
    const changes = [
      { policyVersion: 2 },
      { sequence: first.sequence - 1 },
      { eventId: uuid(100) },
      { attemptId: uuid(101) },
      { scope: { ...first.scope, epoch: 1 } },
      { slot: "cleanup" },
      { phase: "failed" },
      { nativeEvent: "did_end" },
      { nativeSequence: 1 },
      { cause: "backend_unavailable" },
      {
        categories: {
          ...first.categories,
          aac: { status: "pending", code: "none" },
        },
      },
    ];
    for (const change of changes) {
      const bytes = encodeNativeProtectionFactDigestInput({
        ...input,
        fact: { ...first, ...change },
      });
      assertEquals(
        bytes === null || (await hash(bytes)) !== vector.contentDigests[0],
        true,
      );
    }
    for (const key of [
      "schoolId",
      "testId",
      "studentSessionId",
      "deviceSessionId",
    ] as const) {
      const scope = { ...first.scope, [key]: uuid(90) };
      const bytes = required(
        encodeNativeProtectionFactDigestInput({
          ...input,
          scope,
          fact: { ...first, scope },
        }),
      );
      assertEquals((await hash(bytes)) === vector.contentDigests[0], false);
    }
    for (const key of [
      "aac",
      "shortcuts",
      "applications",
      "persistence",
      "windowNetwork",
    ] as const) {
      const categories = {
        ...first.categories,
        [key]: { status: "pending", code: "none" },
      };
      const bytes = required(
        encodeNativeProtectionFactDigestInput({
          ...input,
          fact: { ...first, categories },
        }),
      );
      assertEquals((await hash(bytes)) === vector.contentDigests[0], false);
    }
    if (vector.originBuild.kind !== "build")
      throw new Error("Known fixture required");
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
      assertEquals(
        (await hash(
          required(
            encodeNativeProtectionFactDigestInput({
              ...input,
              originBuild: { kind: "build", identity },
            }),
          ),
        )) === vector.contentDigests[0],
        false,
      );
    }
  },
);

Deno.test(
  "evidence Edge exact object/array parsers reject accessors, extras, sparse/proxy and prototype objects without execution",
  () => {
    let calls = 0;
    const value = Object.defineProperty({ ...first }, "scope", {
      enumerable: true,
      get() {
        calls += 1;
        return first.scope;
      },
    });
    assertEquals(parseNativeProtectionFact(value), null);
    const list = Object.defineProperty([first], "0", {
      enumerable: true,
      get() {
        calls += 1;
        return first;
      },
    });
    assertEquals(parseNativeProtectionFactPrefix(list), null);
    assertEquals(calls, 0);
    assertEquals(
      parseNativeProtectionFact(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("synthetic");
            },
          },
        ),
      ),
      null,
    );
    assertEquals(parseNativeProtectionFact(Object.create(first)), null);
    assertEquals(
      parseNativeProtectionFact({ ...first, [Symbol("extra")]: true }),
      null,
    );
    assertEquals(
      parseNativeProtectionFact(
        Object.defineProperty({ ...first }, "cause", {
          value: "none",
          enumerable: false,
        }),
      ),
      null,
    );
    assertEquals(parseNativeProtectionFactPrefix(new Array(1)), null);
    assertEquals(
      parseNativeProtectionFactPrefix(Object.assign([first], { extra: true })),
      null,
    );
    const parsed = required(parseStudentEvidenceRequest(request()));
    assertEquals(Object.isFrozen(parsed.facts[0].categories.aac), true);
    assertEquals(Object.isFrozen(parsed.scope), true);
  },
);

Deno.test(
  "evidence Edge finite fields, canonical IDs, safe integers and native slot/category constraints match the shared parser",
  () => {
    for (const change of [
      { extra: true },
      { sequence: 0 },
      { sequence: -0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { sequence: 1.5 },
      { sequence: Infinity },
      { sequence: NaN },
      { policyVersion: 2 },
      { eventId: uuid(1).replace("-4000-", "-1000-") },
      { eventId: uuid(1) + "\n" },
      { nativeEvent: undefined },
      { nativeEvent: "arbitrary" },
      { nativeSequence: 0 },
      { cause: "raw error" },
      { slot: "other" },
      { phase: "idle" },
      { phase: "locked" },
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
      assertEquals(parseNativeProtectionFact({ ...first, ...change }), null);
    for (const [status, code] of [
      ["confirmed", "native_inactive"],
      ["pending", "native_inactive"],
      ["failed", "none"],
      ["failed", "prohibited_application"],
      ["unknown", "none"],
    ]) {
      assertEquals(
        parseNativeProtectionCategories({
          ...first.categories,
          aac: { status, code },
        }),
        null,
      );
    }
    assertEquals(
      parseNativeProtectionCategories({
        ...first.categories,
        shortcuts: { status: "pending", code: "awaiting_native_begin" },
      }),
      null,
    );
    assertEquals(
      parseNativeProtectionCategories({ ...first.categories, rawApps: [] }),
      null,
    );
  },
);

Deno.test(
  "evidence Edge rejects suffixes, order/slot/id/native regressions and scope/attempt mixing",
  () => {
    const facts = vector.facts;
    for (const value of [
      [],
      facts.slice(1),
      [...facts].reverse(),
      [...facts, first],
      [first, first],
      [first, { ...facts[1], eventId: first.eventId }],
      [first, { ...facts[1], sequence: first.sequence }],
      [first, { ...facts[1], attemptId: uuid(70) }],
      [first, { ...facts[1], scope: { ...first.scope, epoch: 1 } }],
      [first, facts[2]],
      [first, facts[1], { ...facts[2], nativeSequence: 1 }],
      [
        first,
        facts[1],
        { ...facts[4], nativeSequence: facts[1].nativeSequence },
      ],
    ])
      assertEquals(parseNativeProtectionFactPrefix(value), null);
  },
);

Deno.test(
  "evidence Edge encoders reject wrong origins, extra self/proof fields and noncanonical proof values",
  () => {
    for (const key of [
      "counter",
      "signature",
      "batchDigest",
      "receivedAt",
      "headers",
    ]) {
      assertEquals(
        encodeNativeProtectionFactDigestInput({
          ...context(),
          fact: first,
          [key]: "extra",
        }),
        null,
      );
      assertEquals(
        encodeStudentEvidenceBatchDigestInput({
          ...context(),
          facts: vector.facts,
          contentDigests: vector.contentDigests,
          [key]: "extra",
        }),
        null,
      );
    }
    for (const apiOrigin of [
      vector.apiOrigin + "/",
      vector.apiOrigin + "\n",
      "http://localhost:54321",
      "https://user@example.com",
      "https://example.com?query=1",
    ]) {
      assertEquals(
        encodeNativeProtectionFactDigestInput({
          ...context(),
          fact: first,
          apiOrigin,
        }),
        null,
      );
    }
    const input = {
      apiOrigin: vector.apiOrigin,
      originalKeyThumbprint: vector.originalKeyThumbprint,
      scope: vector.scope,
      batchDigest: vector.batchDigest,
      counter: 1,
    };
    for (const change of [
      { counter: 0 },
      { counter: -0 },
      { counter: Number.MAX_SAFE_INTEGER + 1 },
      { counter: 1.1 },
      { intent: "state.read" },
      { domain: "other" },
      { originalKeyThumbprint: "B".repeat(43) },
      { batchDigest: "A".repeat(64) },
    ]) {
      assertEquals(encodeStudentEvidenceProof({ ...input, ...change }), null);
    }
    assertEquals(
      encodeStudentEvidenceBatchDigestInput({
        ...context(),
        facts: vector.facts,
        contentDigests: vector.contentDigests.slice(1),
      }),
      null,
    );
  },
);

Deno.test(
  "evidence Edge rejects origin variant and collector identity drift",
  () => {
    for (const value of [
      null,
      {},
      { kind: "unknown" },
      { kind: "legacy_unknown", identity: {} },
      {
        kind: "build",
        identity: null,
      },
      { kind: "unverified_build", extra: true },
    ]) {
      assertEquals(parseNativeEvidenceOriginBuild(value), null);
    }
    if (vector.originBuild.kind !== "build")
      throw new Error("Known fixture required");
    const identity = vector.originBuild.identity;
    for (const change of [
      { sourceRepository: "other/repo" },
      { sourceCommit: "0".repeat(40) },
      { sourceTree: "a".repeat(41) },
      { buildId: "e".repeat(64) + "\n" },
      { packageLockSha256: "E".repeat(64) },
      { schemaVersion: 2 },
      { extra: true },
    ]) {
      assertEquals(parseClientBuildIdentity({ ...identity, ...change }), null);
    }
  },
);

Deno.test(
  "evidence Edge exact acknowledgments reject omitted/foreign/conflicting receipts and preserve failures",
  () => {
    const valid = accepted();
    required(
      parseStudentEvidenceResult(valid, request(), vector.contentDigests),
    );
    required(
      parseStudentEvidenceResult(
        { ...valid, acknowledged: [...valid.acknowledged].reverse() },
        request(),
        vector.contentDigests,
      ),
    );
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
          receivedAt: receivedAt + "\n",
        })),
      },
      { acceptedProofCounter: 1 },
      { scope: { ...first.scope, epoch: 1 } },
      { batchDigest: "e".repeat(64) },
      { status: "success" },
      { code: "STUDENT_SESSION_CURRENT" },
      { extra: true },
    ]) {
      assertEquals(
        parseStudentEvidenceResult(
          { ...valid, ...change },
          request(),
          vector.contentDigests,
        ),
        null,
      );
    }
    for (const [status, code] of [
      ["denied", "STUDENT_SESSION_DENIED"],
      ["unavailable", "STUDENT_SESSION_UNAVAILABLE"],
    ]) {
      assertEquals(parseStudentSessionFailure({ status, code }), {
        status,
        code,
      });
      assertEquals(
        parseStudentEvidenceResult(
          { status, code },
          request(),
          vector.contentDigests,
        ),
        {
          status,
          code,
        },
      );
      assertEquals(
        parseStudentEvidenceResult(
          { status, code, acknowledged: [] },
          request(),
          vector.contentDigests,
        ),
        null,
      );
    }
  },
);

Deno.test(
  "evidence Edge timestamps preserve exact six-digit UTC and reject newline/date rollover parity gaps",
  () => {
    assertEquals(parseStudentTimestamp(receivedAt), receivedAt);
    assertEquals(
      parseStudentTimestamp("2024-02-29T23:59:59.999999Z"),
      "2024-02-29T23:59:59.999999Z",
    );
    for (const value of [
      receivedAt + "\n",
      receivedAt + "\r\n",
      receivedAt.replace("123456", "123"),
      "2025-02-29T23:59:59.123456Z",
      "2026-04-31T10:20:30.123456Z",
      "0000-01-01T10:20:30.123456Z",
      "2026-09-08T24:20:30.123456Z",
      "2026-09-08T10:60:30.123456Z",
      "2026-09-08T10:20:60.123456Z",
    ]) {
      assertEquals(parseStudentTimestamp(value), null);
    }
  },
);
