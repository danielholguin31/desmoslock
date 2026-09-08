import {
  parseStudentChallengeRequest,
  parseStudentChallengeResult,
  parseStudentDigest,
  parseStudentForfeitRequest,
  parseStudentForfeitResult,
  parseStudentJoinRequest,
  parseStudentJoinResult,
  parseStudentProofOrigin,
  parseStudentReadRequest,
  parseStudentReadResult,
  parseStudentReconnectRequest,
  parseStudentReconnectResult,
  parseStudentSessionFailure,
  type PublicBackendConfiguration,
  type StudentChallengeRequest,
  type StudentChallengeResult,
  type StudentForfeitRequest,
  type StudentForfeitResult,
  type StudentJoinRequest,
  type StudentJoinResult,
  type StudentReadRequest,
  type StudentReadResult,
  type StudentReconnectRequest,
  type StudentReconnectResult,
  type StudentSessionUnavailable,
  type StudentSessionFailure,
} from "@desmoslock/contracts";

export type StudentSessionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StudentSessionTransport {
  isIdle(): boolean;
  /** Stop new requests and await underlying fetch/stream settlement, not UI deadlines. */
  drain(): Promise<void>;
  challenge(
    request: StudentChallengeRequest,
    signal?: AbortSignal,
  ): Promise<StudentChallengeResult>;
  join(
    request: StudentJoinRequest,
    logicalOperationDigest: string,
    signal?: AbortSignal,
  ): Promise<StudentJoinResult>;
  read(
    request: StudentReadRequest,
    originalCapabilityExpiresAtMs: number,
    signal?: AbortSignal,
  ): Promise<StudentReadResult>;
  reconnect(
    request: StudentReconnectRequest,
    logicalOperationDigest: string,
    signal?: AbortSignal,
  ): Promise<StudentReconnectResult>;
  forfeit(
    request: StudentForfeitRequest,
    signal?: AbortSignal,
  ): Promise<StudentForfeitResult>;
}

const bodyLimit = 8 * 1024;
const deadlineMs = 5_000;
const unavailable: StudentSessionUnavailable = Object.freeze({
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
});
type Operation = "challenge" | "join" | "read" | "reconnect" | "forfeit";
type Result =
  | StudentChallengeResult
  | StudentJoinResult
  | StudentReadResult
  | StudentReconnectResult
  | StudentForfeitResult;

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > bodyLimit)
  )
    throw new Error("Invalid student session response");
  if (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    response.body === null
  )
    throw new Error("Invalid student session response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancellation: Promise<void> | null = null;
  const cancel = () =>
    (cancellation ??= reader.cancel().catch(() => undefined));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > bodyLimit)
        throw new Error("Invalid student session response");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancel();
    reader.releaseLock();
  }
}

/** Fixed main-only transport. Callers must durably retain intent/counter before invoking it. */
export function createStudentSessionTransport(
  configuration: PublicBackendConfiguration,
  fetchRequest: StudentSessionFetch = globalThis.fetch,
): StudentSessionTransport {
  const origin = parseStudentProofOrigin(configuration);
  if (origin === null)
    throw new Error("Student session backend configuration is invalid");
  const exchanges = new Set<Promise<unknown>>();
  let draining = false;

  async function post<T extends Result>(
    operation: Operation,
    request: object | null,
    parseResult: (value: unknown) => T | null,
    outerSignal?: AbortSignal,
  ): Promise<T | StudentSessionFailure> {
    if (
      draining ||
      exchanges.size !== 0 ||
      request === null ||
      outerSignal?.aborted === true
    )
      return unavailable;
    let body: string;
    try {
      body = JSON.stringify(request);
      if (Buffer.byteLength(body, "utf8") > bodyLimit) return unavailable;
    } catch {
      return unavailable;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    // Cover the race between the preflight check and listener installation.
    if (outerSignal?.aborted) controller.abort();
    const timeout = setTimeout(abort, deadlineMs);
    const endpoint = `${origin}/functions/v1/student-session-${operation}`;
    let response: Response | undefined;
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () =>
        reject(new Error("Student session request interrupted"));
      controller.signal.addEventListener("abort", rejectAborted, {
        once: true,
      });
    });
    async function exchange(): Promise<T | StudentSessionFailure> {
      controller.signal.throwIfAborted();
      response = await fetchRequest(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        keepalive: false,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        controller.signal.throwIfAborted();
      }
      if (
        response.redirected ||
        (response.url !== "" && response.url !== endpoint)
      )
        return unavailable;
      if (
        response.status !== 200 &&
        response.status !== 403 &&
        response.status !== 503
      )
        return unavailable;
      const value = await readBoundedJson(response, controller.signal);
      const failure = parseStudentSessionFailure(value);
      if (response.status === 403)
        return failure?.status === "denied" ? failure : unavailable;
      if (response.status === 503) return unavailable;
      if (failure !== null) return unavailable;
      return parseResult(value) ?? unavailable;
    }
    // Reserve before a fetch or async hook can reenter. The UI deadline may
    // settle first, but this owner remains until the real exchange and cleanup.
    const exchangeWork = Promise.resolve()
      .then(exchange)
      .finally(async () => {
        if (response?.body != null && !response.body.locked) {
          await response.body.cancel().catch(() => undefined);
        }
      });
    exchanges.add(exchangeWork);
    void exchangeWork.then(
      () => exchanges.delete(exchangeWork),
      () => exchanges.delete(exchangeWork),
    );
    try {
      return await Promise.race([exchangeWork, aborted]);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
      if (rejectAborted !== undefined)
        controller.signal.removeEventListener("abort", rejectAborted);
      controller.abort();
    }
  }

  return Object.freeze({
    isIdle: () => exchanges.size === 0,
    async drain() {
      draining = true;
      await Promise.allSettled([...exchanges]);
    },
    challenge(request: StudentChallengeRequest, signal?: AbortSignal) {
      return post(
        "challenge",
        parseStudentChallengeRequest(request),
        parseStudentChallengeResult,
        signal,
      );
    },
    join(
      request: StudentJoinRequest,
      logicalOperationDigest: string,
      signal?: AbortSignal,
    ) {
      const input = parseStudentJoinRequest(request);
      const valid = parseStudentDigest(logicalOperationDigest) !== null;
      return post(
        "join",
        valid ? input : null,
        (value) =>
          input === null
            ? null
            : parseStudentJoinResult(value, input, logicalOperationDigest),
        signal,
      );
    },
    read(
      request: StudentReadRequest,
      originalCapabilityExpiresAtMs: number,
      signal?: AbortSignal,
    ) {
      const input = parseStudentReadRequest(request);
      const valid =
        Number.isSafeInteger(originalCapabilityExpiresAtMs) &&
        originalCapabilityExpiresAtMs >= 0 &&
        !Object.is(originalCapabilityExpiresAtMs, -0);
      return post(
        "read",
        valid ? input : null,
        (value) =>
          input === null
            ? null
            : parseStudentReadResult(
                value,
                input,
                originalCapabilityExpiresAtMs,
              ),
        signal,
      );
    },
    reconnect(
      request: StudentReconnectRequest,
      logicalOperationDigest: string,
      signal?: AbortSignal,
    ) {
      const input = parseStudentReconnectRequest(request);
      const valid = parseStudentDigest(logicalOperationDigest) !== null;
      return post(
        "reconnect",
        valid ? input : null,
        (value) =>
          input === null
            ? null
            : parseStudentReconnectResult(value, input, logicalOperationDigest),
        signal,
      );
    },
    forfeit(request: StudentForfeitRequest, signal?: AbortSignal) {
      const input = parseStudentForfeitRequest(request);
      return post(
        "forfeit",
        input,
        (value) =>
          input === null ? null : parseStudentForfeitResult(value, input),
        signal,
      );
    },
  });
}
