export const MAX_REQUEST_BODY_BYTES = 4_096;

export interface CorsPolicy {
  readonly allowedHeaders: readonly string[];
  readonly allowedOrigin: string;
}

export type JsonRecord = Record<string, unknown>;

const jsonContentType = "application/json; charset=utf-8";
const canonicalEmailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

function baseHeaders(allowedOrigin?: string): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": jsonContentType,
  });
  if (allowedOrigin !== undefined) {
    headers.set("access-control-allow-origin", allowedOrigin);
    headers.set("vary", "Origin");
  }
  return headers;
}

export function codeResponse(
  code: string,
  status: number,
  allowedOrigin?: string,
): Response {
  return Response.json(
    { code, ok: status >= 200 && status < 300 },
    {
      headers: baseHeaders(allowedOrigin),
      status,
    },
  );
}

export function methodNotAllowedResponse(allowedOrigin: string): Response {
  const headers = baseHeaders(allowedOrigin);
  headers.set("allow", "POST, OPTIONS");
  return new Response(JSON.stringify({ code: "invalid_request", ok: false }), {
    headers,
    status: 405,
  });
}

export function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const observedKeys = Object.keys(value);
  return (
    observedKeys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}

export function parseExactOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const localHost =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "localhost";
  const allowedProtocol =
    parsed.protocol === "https:" || (parsed.protocol === "http:" && localHost);
  if (
    !allowedProtocol ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    return null;
  }
  return parsed.origin;
}

export function parseExactCallback(
  value: unknown,
  expectedOrigin: string,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.origin !== expectedOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname === "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== value
  ) {
    return null;
  }
  return parsed.href;
}

export function parseExactRootCallback(
  value: unknown,
  expectedOrigin: string,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.origin === expectedOrigin &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.href === value
    ? parsed.href
    : null;
}

function parseRequestedHeaders(value: string | null): string[] | null {
  if (value === null || value.length === 0 || value.length > 1_024) {
    return null;
  }
  const headers = value.split(",").map((header) => header.trim().toLowerCase());
  if (headers.some((header) => !/^[a-z0-9-]+$/u.test(header))) {
    return null;
  }
  if (new Set(headers).size !== headers.length) {
    return null;
  }
  return headers.sort();
}

export function validateRequestOrigin(
  request: Request,
  allowedOrigin: string,
): boolean {
  return request.headers.get("origin") === allowedOrigin;
}

export function handlePreflight(
  request: Request,
  policy: CorsPolicy,
): Response {
  if (!validateRequestOrigin(request, policy.allowedOrigin)) {
    return codeResponse("invalid_request", 403);
  }
  if (request.headers.get("access-control-request-method") !== "POST") {
    return codeResponse("invalid_request", 400, policy.allowedOrigin);
  }
  const requestedHeaders = parseRequestedHeaders(
    request.headers.get("access-control-request-headers"),
  );
  const allowedHeaders = [...policy.allowedHeaders]
    .map((header) => header.toLowerCase())
    .sort();
  if (
    requestedHeaders === null ||
    requestedHeaders.length !== allowedHeaders.length ||
    requestedHeaders.some((header, index) => header !== allowedHeaders[index])
  ) {
    return codeResponse("invalid_request", 400, policy.allowedOrigin);
  }
  return new Response(null, {
    headers: {
      "access-control-allow-headers": allowedHeaders.join(", "),
      "access-control-allow-methods": "POST",
      "access-control-allow-origin": policy.allowedOrigin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    },
    status: 204,
  });
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  return /^application\/json(?:;[\t ]*charset=utf-8)?$/iu.test(value);
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
      return null;
    }
    const announcedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(announcedLength) ||
      announcedLength > maximumBytes
    ) {
      return null;
    }
  }
  if (request.body === null) {
    return null;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (totalBytes === 0) {
    return null;
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readStrictJson(
  request: Request,
  maximumBytes = MAX_REQUEST_BODY_BYTES,
): Promise<JsonRecord | null> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return null;
  }
  const body = await readBoundedBody(request, maximumBytes);
  if (body === null) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : null;
}

export function parseEmail(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value.trim() !== value
  ) {
    return null;
  }
  if (!/^[\x21-\x7e]+$/u.test(value)) {
    return null;
  }
  const atIndex = value.lastIndexOf("@");
  if (atIndex <= 0 || atIndex !== value.indexOf("@")) {
    return null;
  }
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/u.test(local) ||
    domain.length > 253
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[A-Za-z0-9-]+$/u.test(label),
    ) ||
    !/[A-Za-z]/u.test(labels.at(-1) ?? "")
  ) {
    return null;
  }
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

export function parseCanonicalEmail(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 254 &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    canonicalEmailPattern.test(value)
    ? value
    : null;
}

export function parseUuid(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    return null;
  }
  return value.toLowerCase();
}

export function parseCanonicalUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
    ? value
    : null;
}

export function parseBearerJwt(value: string | null): string | null {
  if (value === null || value.length > 4_103) {
    return null;
  }
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(value);
  return match?.[1] ?? null;
}
