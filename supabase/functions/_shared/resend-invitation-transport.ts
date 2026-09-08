import { parseCanonicalEmail, parseCanonicalUuid } from "./http.ts";

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_RESPONSE_MAXIMUM_BYTES = 16_384;
const RESEND_TIMEOUT_MILLISECONDS = 8_000;
const RESEND_DEADLINE_EXPIRED = Symbol("resend deadline expired");
/** Resend retains idempotency results for 24 hours; keep a full hour of margin. */
export const RESEND_AUTOMATIC_RETRY_MAXIMUM_AGE_MILLISECONDS =
  23 * 60 * 60 * 1_000;

export const STAFF_INVITATION_COPY_VERSION = "staff-invitation-v1" as const;
const STAFF_INVITATION_SUBJECT = "You're invited to DesmosLock";

export interface ResendInvitationMaterial {
  readonly attemptId: string;
  readonly attemptStartedAt: string;
  readonly callbackUrl: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly recipientEmail: string;
}

/**
 * Confidential delivery material, frozen in memory for one handler invocation.
 * Never persist the callback/body, expose it, or log it. Retries reuse its bytes.
 */
export interface PreparedResendInvitationDelivery extends ResendInvitationMaterial {
  readonly copyVersion: typeof STAFF_INVITATION_COPY_VERSION;
  readonly from: string;
  readonly idempotencyKey: string;
  readonly providerRequestBody: string;
  readonly replyTo: string;
}

export type ResendInvitationDeliveryResult =
  | { readonly kind: "provider_accepted"; readonly providerMessageId: string }
  | { readonly kind: "provider_ambiguous" }
  | { readonly kind: "provider_rejected" };

export interface ResendInvitationTransport {
  prepare(
    material: ResendInvitationMaterial,
  ): PreparedResendInvitationDelivery | null;
  deliver(
    attempt: PreparedResendInvitationDelivery,
  ): Promise<ResendInvitationDeliveryResult>;
}

export interface ResendInvitationRuntime {
  readonly clearTimeout: (handle: unknown) => void;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
}

interface ResendInvitationConfiguration {
  readonly apiKey: string;
  readonly callbackOrigin: string;
  readonly from: string;
  readonly replyTo: string;
}

function readExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const observedKeys = Reflect.ownKeys(value);
    if (
      observedKeys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => observedKeys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function parseCallbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }
  return origin.protocol === "https:" &&
    origin.username === "" &&
    origin.password === "" &&
    origin.pathname === "/" &&
    origin.search === "" &&
    origin.hash === "" &&
    origin.origin === value
    ? value
    : null;
}

function parseConfiguredFrom(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 320) return null;
  if (parseCanonicalEmail(value) !== null) return value;
  const match = /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,62}) <([^<>]+)>$/u.exec(value);
  return match !== null &&
    match[1] === match[1].trim() &&
    parseCanonicalEmail(match[2]) !== null
    ? value
    : null;
}

function parseConfiguration(
  value: unknown,
): ResendInvitationConfiguration | null {
  const configuration = readExactDataRecord(value, [
    "apiKey",
    "callbackOrigin",
    "from",
    "replyTo",
  ]);
  if (configuration === null) return null;
  const apiKey =
    typeof configuration.apiKey === "string" &&
    /^[!-~]{1,512}$/u.test(configuration.apiKey)
      ? configuration.apiKey
      : null;
  const callbackOrigin = parseCallbackOrigin(configuration.callbackOrigin);
  const from = parseConfiguredFrom(configuration.from);
  const replyTo = parseCanonicalEmail(configuration.replyTo);
  return apiKey !== null &&
    callbackOrigin !== null &&
    from !== null &&
    replyTo !== null
    ? { apiKey, callbackOrigin, from, replyTo }
    : null;
}

function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function parseDirectInvitationCallback(
  value: unknown,
  expectedOrigin: string,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    return null;
  }
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    return null;
  }
  return callback.protocol === "https:" &&
    callback.origin === expectedOrigin &&
    callback.username === "" &&
    callback.password === "" &&
    callback.pathname === "/" &&
    callback.href === value &&
    callback.search === "?auth=invite" &&
    /^#token_hash=[0-9a-f]{56}$/u.test(callback.hash) &&
    value === `${expectedOrigin}/?auth=invite${callback.hash}`
    ? callback.href
    : null;
}

function invitationCopy(callbackUrl: string, expiresAt: string): string {
  return [
    "You have been invited to join a school in DesmosLock.",
    "",
    "Open this direct link, then confirm the invitation in your browser:",
    callbackUrl,
    "",
    `This invitation expires at ${expiresAt}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
}

function prepareAttempt(
  configuration: ResendInvitationConfiguration,
  materialValue: unknown,
): PreparedResendInvitationDelivery | null {
  const material = readExactDataRecord(materialValue, [
    "attemptId",
    "attemptStartedAt",
    "callbackUrl",
    "expiresAt",
    "invitationId",
    "recipientEmail",
  ]);
  if (material === null) return null;
  const invitationId = parseCanonicalUuid(material.invitationId);
  const attemptId = parseCanonicalUuid(material.attemptId);
  const attemptStartedAt = parseCanonicalTimestamp(material.attemptStartedAt);
  const expiresAt = parseCanonicalTimestamp(material.expiresAt);
  const recipientEmail = parseCanonicalEmail(material.recipientEmail);
  const callbackUrl = parseDirectInvitationCallback(
    material.callbackUrl,
    configuration.callbackOrigin,
  );
  if (
    invitationId === null ||
    attemptId === null ||
    attemptStartedAt === null ||
    typeof material.attemptStartedAt !== "string" ||
    expiresAt === null ||
    typeof material.expiresAt !== "string" ||
    expiresAt <= attemptStartedAt ||
    recipientEmail === null ||
    callbackUrl === null
  ) {
    return null;
  }
  const idempotencyKey = `desmoslock.staff-invitation.${invitationId}.${attemptId}`;
  const providerRequestBody = JSON.stringify({
    from: configuration.from,
    to: [recipientEmail],
    reply_to: configuration.replyTo,
    subject: STAFF_INVITATION_SUBJECT,
    text: invitationCopy(callbackUrl, material.expiresAt),
  });
  return Object.freeze({
    attemptId,
    attemptStartedAt: material.attemptStartedAt,
    callbackUrl,
    copyVersion: STAFF_INVITATION_COPY_VERSION,
    expiresAt: material.expiresAt,
    from: configuration.from,
    idempotencyKey,
    invitationId,
    providerRequestBody,
    recipientEmail,
    replyTo: configuration.replyTo,
  });
}

function exactPreparedAttempt(
  configuration: ResendInvitationConfiguration,
  value: unknown,
): PreparedResendInvitationDelivery | null {
  const frozen = readExactDataRecord(value, [
    "attemptId",
    "attemptStartedAt",
    "callbackUrl",
    "copyVersion",
    "expiresAt",
    "from",
    "idempotencyKey",
    "invitationId",
    "providerRequestBody",
    "recipientEmail",
    "replyTo",
  ]);
  if (frozen === null) return null;
  const expected = prepareAttempt(configuration, {
    attemptId: frozen.attemptId,
    attemptStartedAt: frozen.attemptStartedAt,
    callbackUrl: frozen.callbackUrl,
    expiresAt: frozen.expiresAt,
    invitationId: frozen.invitationId,
    recipientEmail: frozen.recipientEmail,
  });
  return expected !== null &&
    frozen.copyVersion === expected.copyVersion &&
    frozen.from === expected.from &&
    frozen.idempotencyKey === expected.idempotencyKey &&
    frozen.providerRequestBody === expected.providerRequestBody &&
    frozen.replyTo === expected.replyTo
    ? expected
    : null;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response detail is intentionally discarded.
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)
  ) {
    void cancelBody(response);
    return null;
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > RESEND_RESPONSE_MAXIMUM_BYTES)
  ) {
    void cancelBody(response);
    return null;
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) {
    cancelReader();
    return null;
  }
  signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > RESEND_RESPONSE_MAXIMUM_BYTES) {
        cancelReader();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out stream may still be completing cancellation.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export function parseResendProviderMessageId(value: unknown): string | null {
  const response = readExactDataRecord(value, ["id"]);
  if (response === null) return null;
  return typeof response.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      response.id,
    )
    ? response.id
    : null;
}

type ResendIdempotencyConflict =
  "concurrent_idempotent_requests" | "invalid_idempotent_request";

function parseResendIdempotencyConflict(
  value: unknown,
): ResendIdempotencyConflict | null {
  const response = readExactDataRecord(value, [
    "message",
    "name",
    "statusCode",
  ]);
  if (response === null) return null;
  if (
    response.statusCode !== 409 ||
    typeof response.message !== "string" ||
    response.message.length === 0 ||
    response.message.length > 2_048
  ) {
    return null;
  }
  return response.name === "concurrent_idempotent_requests" ||
    response.name === "invalid_idempotent_request"
    ? response.name
    : null;
}

const defaultRuntime: ResendInvitationRuntime = {
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  fetch: (input, init) => globalThis.fetch(input, init),
  now: Date.now,
  setTimeout: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds),
};

export function createResendInvitationTransport(
  configurationValue: unknown,
  runtime: ResendInvitationRuntime = defaultRuntime,
): ResendInvitationTransport {
  let configuration: ResendInvitationConfiguration | null = null;
  try {
    configuration = parseConfiguration(configurationValue);
  } catch {
    // Configuration objects may be supplied by an injectable runtime. Never
    // propagate accessor or proxy detail across this service-only boundary.
  }
  if (configuration === null) {
    throw new Error("Resend invitation transport configuration is invalid");
  }

  return {
    prepare(material) {
      try {
        return prepareAttempt(configuration, material);
      } catch {
        return null;
      }
    },
    async deliver(attempt) {
      let exactAttempt: PreparedResendInvitationDelivery | null;
      try {
        exactAttempt = exactPreparedAttempt(configuration, attempt);
      } catch {
        return { kind: "provider_rejected" };
      }
      if (exactAttempt === null) return { kind: "provider_rejected" };
      let now: number;
      try {
        now = runtime.now();
      } catch {
        return { kind: "provider_rejected" };
      }
      const startedAt = Date.parse(exactAttempt.attemptStartedAt);
      const expiresAt = Date.parse(exactAttempt.expiresAt);
      if (
        !Number.isSafeInteger(now) ||
        now < startedAt ||
        now - startedAt >= RESEND_AUTOMATIC_RETRY_MAXIMUM_AGE_MILLISECONDS ||
        now >= expiresAt
      ) {
        return { kind: "provider_rejected" };
      }

      const controller = new AbortController();
      let timeout: unknown;
      let deadlineExpired = false;
      let expireDeadline: (() => void) | undefined;
      const deadline = new Promise<typeof RESEND_DEADLINE_EXPIRED>(
        (resolve) => {
          expireDeadline = () => {
            deadlineExpired = true;
            controller.abort();
            resolve(RESEND_DEADLINE_EXPIRED);
          };
        },
      );
      try {
        timeout = runtime.setTimeout(
          () => expireDeadline?.(),
          RESEND_TIMEOUT_MILLISECONDS,
        );
      } catch {
        return { kind: "provider_rejected" };
      }
      try {
        if (deadlineExpired) return { kind: "provider_rejected" };
        const responsePromise = runtime.fetch(RESEND_EMAILS_ENDPOINT, {
          body: exactAttempt.providerRequestBody,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${configuration.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": exactAttempt.idempotencyKey,
            "user-agent": "desmoslock-edge/2.0",
          },
          method: "POST",
          redirect: "error",
          signal: controller.signal,
        });
        const responseOrDeadline = await Promise.race([
          responsePromise,
          deadline,
        ]);
        if (responseOrDeadline === RESEND_DEADLINE_EXPIRED) {
          void responsePromise.then(cancelBody, () => undefined);
          return { kind: "provider_ambiguous" };
        }
        const response = responseOrDeadline;
        if (deadlineExpired) return { kind: "provider_ambiguous" };
        if (response.status === 409) {
          const conflictBodyPromise = readBoundedJson(
            response,
            controller.signal,
          );
          const conflictBodyOrDeadline = await Promise.race([
            conflictBodyPromise,
            deadline,
          ]);
          if (conflictBodyOrDeadline === RESEND_DEADLINE_EXPIRED) {
            void cancelBody(response);
            return { kind: "provider_ambiguous" };
          }
          const conflict = parseResendIdempotencyConflict(
            conflictBodyOrDeadline,
          );
          return conflict === "invalid_idempotent_request"
            ? { kind: "provider_rejected" }
            : { kind: "provider_ambiguous" };
        }
        if (response.status < 200 || response.status > 299 || !response.ok) {
          void cancelBody(response);
          return response.status >= 500 || response.status === 408
            ? { kind: "provider_ambiguous" }
            : { kind: "provider_rejected" };
        }
        const responseBodyPromise = readBoundedJson(
          response,
          controller.signal,
        );
        const responseBodyOrDeadline = await Promise.race([
          responseBodyPromise,
          deadline,
        ]);
        if (responseBodyOrDeadline === RESEND_DEADLINE_EXPIRED) {
          void cancelBody(response);
          return { kind: "provider_ambiguous" };
        }
        const providerMessageId = parseResendProviderMessageId(
          responseBodyOrDeadline,
        );
        return providerMessageId === null || controller.signal.aborted
          ? { kind: "provider_ambiguous" }
          : { kind: "provider_accepted", providerMessageId };
      } catch {
        return { kind: "provider_ambiguous" };
      } finally {
        try {
          runtime.clearTimeout(timeout);
        } catch {
          // Cleanup failures cannot change or expose the provider outcome.
        }
      }
    },
  };
}
