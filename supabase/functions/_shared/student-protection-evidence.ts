import {
  createSupabaseHttpClient,
  type ServiceFetch,
} from "./supabase-http.ts";
import {
  decodeEdgeStudentSecretBytes,
  edgeStudentKeyThumbprint,
  parseEdgeExactArray,
  parseEdgeExactRecord,
  parseEdgeStudentApiOrigin,
  parseEdgeStudentCounter,
  parseEdgeStudentDigest,
  parseEdgeStudentPublicKey,
  parseEdgeStudentScope,
  type EdgeStudentSessionScope,
} from "./student-session-proof.ts";
import {
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  encodeStudentEvidenceProof,
  parseNativeEvidenceOriginBuild,
  parseNativeProtectionFactPrefix,
  parseStudentEvidenceRequest,
  parseStudentEvidenceResult,
  type NativeEvidenceOriginBuild,
  type NativeProtectionFact,
  type StudentEvidenceRequest,
  type StudentEvidenceResult,
} from "./student-protection-evidence-proof.ts";

export const STUDENT_EVIDENCE_MAX_REQUEST_BYTES = 16_384;
export const STUDENT_EVIDENCE_MAX_RESPONSE_BYTES = 8_192;
export const STUDENT_EVIDENCE_REQUEST_TIMEOUT_MS = 5_000;

export interface StudentEvidenceScopeRpcInput {
  readonly school_id: string;
  readonly test_id: string;
  readonly student_session_id: string;
  readonly device_session_id: string;
  readonly epoch: number;
}
export interface StudentEvidenceCommitRpcInput extends StudentEvidenceScopeRpcInput {
  readonly api_origin: string;
  readonly origin_build: NativeEvidenceOriginBuild;
  readonly facts: readonly NativeProtectionFact[];
  readonly batch_digest: string;
  readonly verified_public_key: string;
  readonly proof_counter: number;
}
export interface StudentEvidenceDependencies {
  readonly apiOrigin: string;
  readEvidenceKey(
    input: StudentEvidenceScopeRpcInput,
    signal: AbortSignal,
  ): Promise<unknown>;
  commitEvidence(
    input: StudentEvidenceCommitRpcInput,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const denied = { status: "denied", code: "STUDENT_SESSION_DENIED" } as const;
const unavailable = {
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
} as const;
const scopeKeys = [
  "school_id",
  "test_id",
  "student_session_id",
  "device_session_id",
  "epoch",
] as const;
const commitKeys = [
  ...scopeKeys,
  "api_origin",
  "origin_build",
  "facts",
  "batch_digest",
  "verified_public_key",
  "proof_counter",
] as const;
class InvalidBody extends Error {}
class BodyTooLarge extends Error {}
class DependencyUnavailable extends Error {}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DependencyUnavailable();
}
function scopeInput(
  scope: EdgeStudentSessionScope,
): StudentEvidenceScopeRpcInput {
  return {
    school_id: scope.schoolId,
    test_id: scope.testId,
    student_session_id: scope.studentSessionId,
    device_session_id: scope.deviceSessionId,
    epoch: scope.epoch,
  };
}
function parseScopeInput(
  row: Record<string, unknown>,
): StudentEvidenceScopeRpcInput | null {
  const scope = parseEdgeStudentScope({
    schoolId: row.school_id,
    testId: row.test_id,
    studentSessionId: row.student_session_id,
    deviceSessionId: row.device_session_id,
    epoch: row.epoch,
  });
  return scope === null ? null : scopeInput(scope);
}
function parseCommitInput(
  value: unknown,
  apiOrigin: string,
): StudentEvidenceCommitRpcInput | null {
  const row = parseEdgeExactRecord(value, commitKeys);
  if (row === null || row.api_origin !== apiOrigin) return null;
  const scope = parseScopeInput(row);
  const build = parseNativeEvidenceOriginBuild(row.origin_build);
  const facts = parseNativeProtectionFactPrefix(row.facts);
  const digest = parseEdgeStudentDigest(row.batch_digest);
  const key = parseEdgeStudentPublicKey(row.verified_public_key);
  const counter = parseEdgeStudentCounter(row.proof_counter);
  if (
    scope === null ||
    build === null ||
    facts === null ||
    digest === null ||
    key === null ||
    counter === null ||
    facts.some(
      (fact) =>
        JSON.stringify(scopeInput(fact.scope)) !== JSON.stringify(scope),
    )
  )
    return null;
  return {
    ...scope,
    api_origin: apiOrigin,
    origin_build: build,
    facts,
    batch_digest: digest,
    verified_public_key: key,
    proof_counter: counter,
  };
}

/** Fixed original-binding evidence RPCs only; no caller-selected route or SQL name. */
export function createStudentEvidenceDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
): StudentEvidenceDependencies {
  const row = parseEdgeExactRecord(configuration, [
    "DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT",
    "DESMOSLOCK_PUBLIC_BACKEND_URL",
    "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
  ]);
  if (row === null) throw new DependencyUnavailable();
  const apiOrigin = parseEdgeStudentApiOrigin(
    row.DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT,
    row.DESMOSLOCK_PUBLIC_BACKEND_URL,
  );
  const serviceRoleKey = row.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = row.SUPABASE_URL;
  const expectedOrigin = row.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN;
  if (
    apiOrigin === null ||
    typeof serviceRoleKey !== "string" ||
    typeof supabaseUrl !== "string" ||
    (expectedOrigin !== undefined && typeof expectedOrigin !== "string")
  )
    throw new DependencyUnavailable();
  const client = createSupabaseHttpClient(
    {
      expectedOrigin,
      publishableKey: serviceRoleKey,
      serviceRoleKey,
      supabaseUrl,
    },
    serviceFetch,
  );
  const rpc = async (
    name: "read_student_evidence_key" | "commit_student_protection_evidence",
    input: StudentEvidenceScopeRpcInput | StudentEvidenceCommitRpcInput | null,
    signal: AbortSignal,
  ): Promise<unknown> => {
    throwIfAborted(signal);
    if (input === null) throw new DependencyUnavailable();
    const body = JSON.stringify(input);
    if (
      new TextEncoder().encode(body).byteLength >
      STUDENT_EVIDENCE_MAX_REQUEST_BYTES
    )
      throw new DependencyUnavailable();
    const path = `/rest/v1/rpc/${name}`;
    const result = await client.request(path, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-profile": "desmoslock_v2",
        "accept-profile": "desmoslock_v2",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
      body,
      signal,
    });
    throwIfAborted(signal);
    if (
      result.status !== 200 ||
      result.redirected ||
      (result.url !== "" && result.url !== client.origin + path)
    ) {
      void result.body?.cancel().catch(() => undefined);
      throw new DependencyUnavailable();
    }
    return await readBoundedJson(result, signal, false);
  };
  return {
    apiOrigin,
    readEvidenceKey: (input, signal) => {
      const row = parseEdgeExactRecord(input, scopeKeys);
      return rpc(
        "read_student_evidence_key",
        row === null ? null : parseScopeInput(row),
        signal,
      );
    },
    commitEvidence: (input, signal) =>
      rpc(
        "commit_student_protection_evidence",
        parseCommitInput(input, apiOrigin),
        signal,
      ),
  };
}

function configuredDependencies(): StudentEvidenceDependencies {
  return createStudentEvidenceDependencies({
    DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: Deno.env.get(
      "DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT",
    ),
    DESMOSLOCK_PUBLIC_BACKEND_URL: Deno.env.get(
      "DESMOSLOCK_PUBLIC_BACKEND_URL",
    ),
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get(
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
    ),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  });
}

async function readBoundedJson(
  message: Request | Response,
  signal: AbortSignal,
  publicRequest: boolean,
): Promise<unknown> {
  const maximum = publicRequest
    ? STUDENT_EVIDENCE_MAX_REQUEST_BYTES
    : STUDENT_EVIDENCE_MAX_RESPONSE_BYTES;
  const fail = () =>
    publicRequest ? new InvalidBody() : new DependencyUnavailable();
  const reject = (error: Error): never => {
    void message.body?.cancel().catch(() => undefined);
    throw error;
  };
  const contentType = message.headers.get("content-type");
  if (
    (contentType !== "application/json" &&
      contentType !== "application/json; charset=utf-8") ||
    message.headers.has("content-encoding")
  )
    return reject(fail());
  const announced = message.headers.get("content-length");
  if (announced !== null) {
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(announced) ||
      !Number.isSafeInteger(Number(announced))
    )
      return reject(fail());
    if (Number(announced) > maximum)
      return reject(
        publicRequest ? new BodyTooLarge() : new DependencyUnavailable(),
      );
  }
  throwIfAborted(signal);
  if (message.body === null) throw fail();
  const reader = message.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => undefined);
        throw publicRequest ? new BodyTooLarge() : new DependencyUnavailable();
      }
      chunks.push(result.value);
    }
    if (size === 0 || (announced !== null && Number(announced) !== size))
      throw fail();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw fail();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function oneSqlRow(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const rows = parseEdgeExactArray(value, 1);
  const row =
    rows !== null && rows.length === 1
      ? parseEdgeExactRecord(rows[0], keys)
      : null;
  if (
    row === null ||
    (row.code !== "ok" &&
      (row.code !== "student_session_denied" ||
        !keys.every((key) => key === "code" || row[key] === null)))
  )
    throw new DependencyUnavailable();
  return row;
}
async function sha256(bytes: Uint8Array | null): Promise<string> {
  if (bytes === null) throw new DependencyUnavailable();
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function verifyProof(
  input: StudentEvidenceRequest,
  bytes: Uint8Array | null,
): Promise<boolean> {
  const keyBytes = decodeEdgeStudentSecretBytes(input.publicKey);
  if (keyBytes === null || bytes === null) return false;
  const signature = Uint8Array.from(
    atob(
      input.deviceProof.signature.replaceAll("-", "+").replaceAll("_", "/") +
        "==",
    ),
    (character) => character.charCodeAt(0),
  );
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(keyBytes),
      "Ed25519",
      false,
      ["verify"],
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "DataError")
      return false;
    throw new DependencyUnavailable();
  }
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    signature,
    new Uint8Array(bytes),
  );
}
async function ingest(
  input: StudentEvidenceRequest,
  dependencies: StudentEvidenceDependencies,
  signal: AbortSignal,
): Promise<StudentEvidenceResult> {
  const originalKeyThumbprint = await edgeStudentKeyThumbprint(input.publicKey);
  throwIfAborted(signal);
  if (originalKeyThumbprint === null) return denied;
  const context = {
    apiOrigin: dependencies.apiOrigin,
    originalKeyThumbprint,
    scope: input.scope,
    originBuild: input.originBuild,
  };
  const contentDigests: string[] = [];
  for (const fact of input.facts) {
    contentDigests.push(
      await sha256(encodeNativeProtectionFactDigestInput({ ...context, fact })),
    );
    throwIfAborted(signal);
  }
  const batchDigest = await sha256(
    encodeStudentEvidenceBatchDigestInput({
      ...context,
      facts: input.facts,
      contentDigests,
    }),
  );
  throwIfAborted(signal);
  if (batchDigest !== input.batchDigest) return denied;
  const scope = scopeInput(input.scope);
  const binding = oneSqlRow(await dependencies.readEvidenceKey(scope, signal), [
    "code",
    "key_thumbprint",
  ]);
  throwIfAborted(signal);
  if (binding.code !== "ok") return denied;
  if (parseEdgeStudentPublicKey(binding.key_thumbprint) === null)
    throw new DependencyUnavailable();
  if (binding.key_thumbprint !== originalKeyThumbprint) return denied;
  const verified = await verifyProof(
    input,
    encodeStudentEvidenceProof({
      apiOrigin: dependencies.apiOrigin,
      originalKeyThumbprint,
      scope: input.scope,
      batchDigest,
      counter: input.deviceProof.counter,
    }),
  );
  throwIfAborted(signal);
  if (!verified) return denied;
  const row = oneSqlRow(
    await dependencies.commitEvidence(
      {
        ...scope,
        api_origin: dependencies.apiOrigin,
        origin_build: input.originBuild,
        facts: input.facts,
        batch_digest: batchDigest,
        verified_public_key: input.publicKey,
        proof_counter: input.deviceProof.counter,
      },
      signal,
    ),
    ["code", "scope", "batch_digest", "accepted_proof_counter", "acknowledged"],
  );
  throwIfAborted(signal);
  if (row.code !== "ok") return denied;
  const result = parseStudentEvidenceResult(
    {
      status: "accepted",
      code: "STUDENT_EVIDENCE_ACCEPTED",
      scope: row.scope,
      batchDigest: row.batch_digest,
      acceptedProofCounter: row.accepted_proof_counter,
      acknowledged: row.acknowledged,
    },
    input,
    contentDigests,
  );
  if (result === null || result.status !== "accepted")
    throw new DependencyUnavailable();
  return result;
}
function response(body: StudentEvidenceResult, status: number): Response {
  const json = JSON.stringify(body);
  if (
    new TextEncoder().encode(json).byteLength >
    STUDENT_EVIDENCE_MAX_RESPONSE_BYTES
  )
    return response(unavailable, 503);
  return new Response(json, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...(status === 405 ? { allow: "POST" } : {}),
    },
  });
}

/** Original admitted client reports only. No result grants admission or native authority. */
export async function handleStudentEvidenceRequest(
  request: Request,
  supplied?: StudentEvidenceDependencies,
): Promise<Response> {
  if (request.method !== "POST") return response(denied, 405);
  const url = new URL(request.url);
  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return response(denied, 403);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, STUDENT_EVIDENCE_REQUEST_TIMEOUT_MS);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let rejectDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(new DependencyUnavailable());
    controller.signal.addEventListener("abort", rejectDeadline, { once: true });
    if (controller.signal.aborted) rejectDeadline();
  });
  const work = async (): Promise<Response> => {
    throwIfAborted(controller.signal);
    const body = await readBoundedJson(request, controller.signal, true);
    const input = parseStudentEvidenceRequest(body);
    if (input === null) return response(denied, 403);
    const dependencies = supplied ?? configuredDependencies();
    if (
      parseEdgeStudentApiOrigin(
        dependencies.apiOrigin.startsWith("http:") ? "local" : "staging",
        dependencies.apiOrigin,
      ) === null
    )
      throw new DependencyUnavailable();
    const result = await ingest(input, dependencies, controller.signal);
    throwIfAborted(controller.signal);
    return response(result, result.status === "denied" ? 403 : 200);
  };
  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    return error instanceof BodyTooLarge
      ? response(denied, 413)
      : error instanceof InvalidBody
        ? response(denied, 403)
        : response(unavailable, 503);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (rejectDeadline !== undefined)
      controller.signal.removeEventListener("abort", rejectDeadline);
    controller.abort();
  }
}
