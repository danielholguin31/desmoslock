// deno-lint-ignore-file require-await
import vectors from "../../../packages/contracts/tests/fixtures/native-protection-evidence-vectors.json" with { type: "json" };
import { handleRequest } from "../student-session-evidence/index.ts";
import {
  createStudentEvidenceDependencies,
  type StudentEvidenceDependencies,
  type StudentEvidenceCommitRpcInput,
} from "./student-protection-evidence.ts";
import {
  edgeStudentKeyThumbprint,
  encodeEdgeStudentProofBytes,
} from "./student-session-proof.ts";
import {
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  encodeStudentEvidenceProof,
  parseStudentEvidenceRequest,
  type StudentEvidenceRequest,
} from "./student-protection-evidence-proof.ts";

const apiOrigin = "http://127.0.0.1:54321";
const endpoint = `${apiOrigin}/functions/v1/student-session-evidence`;
const receivedAt = "2026-09-08T04:05:06.123456Z";
const denied = { status: "denied", code: "STUDENT_SESSION_DENIED" };
const unavailable = {
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
};
function assert(
  condition: unknown,
  message = "Unexpected synthetic evidence value",
): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected));
}
async function digest(bytes: Uint8Array | null): Promise<string> {
  assert(bytes !== null);
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function fixture(counter = 1) {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = encodeEdgeStudentProofBytes(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  assert(publicKey !== null);
  const thumbprint = await edgeStudentKeyThumbprint(publicKey);
  assert(thumbprint !== null);
  const vector = vectors.vectors[2];
  assert(vector !== undefined);
  const context = {
    apiOrigin,
    originalKeyThumbprint: thumbprint,
    scope: vector.scope,
    originBuild: vector.originBuild,
  };
  const contentDigests = await Promise.all(
    vector.facts.map((fact) =>
      digest(encodeNativeProtectionFactDigestInput({ ...context, fact })),
    ),
  );
  const batchDigest = await digest(
    encodeStudentEvidenceBatchDigestInput({
      ...context,
      facts: vector.facts,
      contentDigests,
    }),
  );
  const sign = async (counter: number): Promise<StudentEvidenceRequest> => {
    const bytes = encodeStudentEvidenceProof({
      apiOrigin,
      originalKeyThumbprint: thumbprint,
      scope: vector.scope,
      batchDigest,
      counter,
    });
    assert(bytes !== null);
    const signature = encodeEdgeStudentProofBytes(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keys.privateKey,
          new Uint8Array(bytes),
        ),
      ),
    );
    assert(signature !== null);
    const input = parseStudentEvidenceRequest({
      version: 1,
      scope: vector.scope,
      originBuild: vector.originBuild,
      facts: vector.facts,
      batchDigest,
      publicKey,
      deviceProof: { counter, signature },
    });
    assert(input !== null);
    return input;
  };
  const input = await sign(counter);
  const calls: { kind: string; value: unknown }[] = [];
  const ack = input.facts.map((fact, index) => ({
    eventId: fact.eventId,
    contentDigest: contentDigests[index],
    receivedAt,
  }));
  const commitRow = (value: StudentEvidenceCommitRpcInput) => ({
    code: "ok",
    scope: input.scope,
    batch_digest: input.batchDigest,
    accepted_proof_counter: value.proof_counter,
    acknowledged: ack,
  });
  const dependencies: StudentEvidenceDependencies = {
    apiOrigin,
    readEvidenceKey: async (value) => {
      calls.push({ kind: "key", value });
      return [{ code: "ok", key_thumbprint: thumbprint }];
    },
    commitEvidence: async (value) => {
      calls.push({ kind: "commit", value });
      return [commitRow(value)];
    },
  };
  return { input, sign, calls, ack, thumbprint, dependencies, commitRow };
}
function post(body: unknown, init: RequestInit = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}
async function check(result: Response, status: number, body?: unknown) {
  equal(result.status, status);
  equal(result.headers.get("cache-control"), "no-store");
  equal(result.headers.get("access-control-allow-origin"), null);
  equal(result.headers.get("x-content-type-options"), "nosniff");
  const actual = await result.json();
  if (body !== undefined) equal(actual, body);
  return actual;
}

Deno.test(
  "evidence uses a real original-key signature and exact content-bound acknowledgments",
  async () => {
    const f = await fixture();
    const result = await check(
      await handleRequest(post(f.input), f.dependencies),
      200,
    );
    equal(result, {
      status: "accepted",
      code: "STUDENT_EVIDENCE_ACCEPTED",
      scope: f.input.scope,
      batchDigest: f.input.batchDigest,
      acceptedProofCounter: 1,
      acknowledged: f.ack,
    });
    equal(
      f.calls.map((call) => call.kind),
      ["key", "commit"],
    );
    const committed = f.calls[1]?.value as StudentEvidenceCommitRpcInput;
    equal(committed.verified_public_key, f.input.publicKey);
    equal(committed.facts, f.input.facts);
    equal(committed.api_origin, apiOrigin);
    assert(!("signature" in committed) && !("capability_token" in committed));
  },
);
Deno.test(
  "higher-counter retry retains original receipts and exact batch content",
  async () => {
    const f = await fixture();
    const first = (await check(
      await handleRequest(post(f.input), f.dependencies),
      200,
    )) as Record<string, unknown>;
    const retry = await f.sign(2);
    const second = (await check(
      await handleRequest(post(retry), f.dependencies),
      200,
    )) as Record<string, unknown>;
    equal(first.acknowledged, second.acknowledged);
    equal(first.batchDigest, second.batchDigest);
    equal(second.acceptedProofCounter, 2);
  },
);
for (const modification of [
  "digest",
  "signature",
  "scope",
  "origin",
  "unknown-key",
] as const) {
  Deno.test(
    `evidence rejects ${modification} without committing or charging a mutation`,
    async () => {
      const f = await fixture();
      const input = structuredClone(f.input);
      let value: unknown = input;
      if (modification === "digest")
        value = { ...input, batchDigest: "0".repeat(64) };
      if (modification === "signature")
        value = {
          ...input,
          deviceProof: { counter: 1, signature: "A".repeat(86) },
        };
      if (modification === "scope")
        value = {
          ...input,
          scope: { ...input.scope, epoch: input.scope.epoch + 1 },
        };
      if (modification === "origin")
        value = { ...input, originBuild: { kind: "unverified_build" } };
      if (modification === "unknown-key")
        f.dependencies.readEvidenceKey = async () => [
          { code: "ok", key_thumbprint: "A".repeat(43) },
        ];
      await check(
        await handleRequest(post(value), f.dependencies),
        403,
        denied,
      );
      assert(f.calls.every((call) => call.kind !== "commit"));
    },
  );
}
for (const mutation of [
  "partial",
  "extra",
  "digest",
  "scope",
  "counter",
  "timestamp",
  "payload-denial",
  "leaked-error",
] as const) {
  Deno.test(
    `evidence does not acknowledge ${mutation} SQL response`,
    async () => {
      const f = await fixture();
      f.dependencies.commitEvidence = async (input) => {
        const row = f.commitRow(input);
        if (mutation === "partial")
          return [{ ...row, acknowledged: f.ack.slice(1) }];
        if (mutation === "extra")
          return [{ ...row, acknowledged: [...f.ack, f.ack[0]] }];
        if (mutation === "digest")
          return [
            {
              ...row,
              acknowledged: f.ack.map((ack) => ({
                ...ack,
                contentDigest: "0".repeat(64),
              })),
            },
          ];
        if (mutation === "scope")
          return [
            {
              ...row,
              scope: { ...f.input.scope, epoch: f.input.scope.epoch + 1 },
            },
          ];
        if (mutation === "counter")
          return [{ ...row, accepted_proof_counter: input.proof_counter + 1 }];
        if (mutation === "timestamp")
          return [
            {
              ...row,
              acknowledged: f.ack.map((ack) => ({
                ...ack,
                receivedAt: "2026-09-08T04:05:06.123Z",
              })),
            },
          ];
        if (mutation === "payload-denial")
          return [{ ...row, code: "student_session_denied" }];
        throw new Error("private synthetic backend text must never cross HTTP");
      };
      await check(
        await handleRequest(post(f.input), f.dependencies),
        503,
        unavailable,
      );
    },
  );
}
Deno.test(
  "finite SQL denial remains generic for ended or replaced original bindings",
  async () => {
    const f = await fixture();
    f.dependencies.commitEvidence = async () => [
      {
        code: "student_session_denied",
        scope: null,
        batch_digest: null,
        accepted_proof_counter: null,
        acknowledged: null,
      },
    ];
    await check(
      await handleRequest(post(f.input), f.dependencies),
      403,
      denied,
    );
  },
);
Deno.test("aborted held key lookup cannot later begin a commit", async () => {
  const f = await fixture();
  let release: ((value: unknown) => void) | undefined;
  let started: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.dependencies.readEvidenceKey = () => {
    started?.();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const controller = new AbortController();
  const pending = handleRequest(
    post(f.input, { signal: controller.signal }),
    f.dependencies,
  );
  await began;
  controller.abort();
  await check(await pending, 503, unavailable);
  release?.([{ code: "ok", key_thumbprint: f.thumbprint }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(f.calls.length, 0);
});
Deno.test(
  "lost already-started commit response is unavailable without retry or compensation",
  async () => {
    const f = await fixture();
    let release: ((value: unknown) => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let commits = 0;
    f.dependencies.commitEvidence = () => {
      commits += 1;
      started?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const controller = new AbortController();
    const pending = handleRequest(
      post(f.input, { signal: controller.signal }),
      f.dependencies,
    );
    await began;
    controller.abort();
    await check(await pending, 503, unavailable);
    release?.([
      f.commitRow({ proof_counter: 1 } as StudentEvidenceCommitRpcInput),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(commits, 1);
  },
);
Deno.test(
  "hung dependency stops at the public five-second deadline",
  async () => {
    const f = await fixture();
    f.dependencies.readEvidenceKey = () => new Promise(() => undefined);
    const start = performance.now();
    await check(
      await handleRequest(post(f.input), f.dependencies),
      503,
      unavailable,
    );
    assert(
      performance.now() - start >= 4_900 && performance.now() - start < 7_000,
    );
    equal(f.calls.length, 0);
  },
);
Deno.test(
  "public evidence body enforces 16KiB, finite JSON and POST-only without lookups",
  async () => {
    const f = await fixture();
    for (const method of ["GET", "OPTIONS", "DELETE"])
      await check(
        await handleRequest(new Request(endpoint, { method }), f.dependencies),
        405,
        denied,
      );
    for (const body of [
      {},
      { ...f.input, proof: "extra" },
      { ...f.input, facts: [] },
    ])
      await check(await handleRequest(post(body), f.dependencies), 403, denied);
    await check(
      await handleRequest(post("X".repeat(16_384)), f.dependencies),
      413,
      denied,
    );
    for (const headers of [
      new Headers({ "content-type": "text/plain" }),
      new Headers({
        "content-type": "application/json",
        "content-encoding": "gzip",
      }),
      new Headers({
        "content-type": "application/json",
        "content-length": "0",
      }),
    ])
      await check(
        await handleRequest(post(f.input, { headers }), f.dependencies),
        403,
        denied,
      );
    await check(
      await handleRequest(
        new Request(endpoint + "?scope=other", {
          method: "POST",
          body: JSON.stringify(f.input),
        }),
        f.dependencies,
      ),
      403,
      denied,
    );
    equal(f.calls.length, 0);
  },
);
Deno.test(
  "factory confines actual two HTTP calls to fixed RPCs with strict headers and bound input",
  async () => {
    const f = await fixture();
    const urls: string[] = [];
    const dependencies = createStudentEvidenceDependencies(
      {
        DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
        DESMOSLOCK_PUBLIC_BACKEND_URL: apiOrigin,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: apiOrigin,
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key-only",
        SUPABASE_URL: apiOrigin,
      },
      async (input, init) => {
        const url = String(input);
        urls.push(url);
        equal(init?.method, "POST");
        equal(init?.redirect, "error");
        equal(init?.cache, "no-store");
        equal(init?.credentials, "omit");
        const headers = new Headers(init?.headers);
        equal(headers.get("content-profile"), "desmoslock_v2");
        equal(
          headers.get("authorization"),
          "Bearer synthetic-service-role-key-only",
        );
        assert(
          init?.signal instanceof AbortSignal && typeof init.body === "string",
        );
        const body = JSON.parse(init.body) as StudentEvidenceCommitRpcInput;
        return Response.json(
          url.endsWith("read_student_evidence_key")
            ? [{ code: "ok", key_thumbprint: f.thumbprint }]
            : [f.commitRow(body)],
        );
      },
    );
    await check(await handleRequest(post(f.input), dependencies), 200);
    equal(urls, [
      apiOrigin + "/rest/v1/rpc/read_student_evidence_key",
      apiOrigin + "/rest/v1/rpc/commit_student_protection_evidence",
    ]);
  },
);
for (const kind of [
  "oversize",
  "encoding",
  "redirect",
  "status",
  "partial-length",
  "extra-row",
] as const) {
  Deno.test(
    `factory rejects ${kind} upstream response without exposing body`,
    async () => {
      const f = await fixture();
      const dependencies = createStudentEvidenceDependencies(
        {
          DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
          DESMOSLOCK_PUBLIC_BACKEND_URL: apiOrigin,
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: apiOrigin,
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key-only",
          SUPABASE_URL: apiOrigin,
        },
        async () => {
          if (kind === "oversize") return Response.json("X".repeat(8_192));
          if (kind === "encoding")
            return Response.json([], {
              headers: { "content-encoding": "gzip" },
            });
          if (kind === "redirect")
            return new Response("private", {
              status: 302,
              headers: { location: "https://invalid.example" },
            });
          if (kind === "status")
            return Response.json({ error: "private" }, { status: 500 });
          if (kind === "partial-length")
            return Response.json([], { headers: { "content-length": "900" } });
          return Response.json([
            { code: "ok", key_thumbprint: f.thumbprint },
            { code: "ok", key_thumbprint: f.thumbprint },
          ]);
        },
      );
      await check(
        await handleRequest(post(f.input), dependencies),
        503,
        unavailable,
      );
    },
  );
}
