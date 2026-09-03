import { isExactRecord, type JsonRecord } from "./http.ts";

export type ServiceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseRuntimeConfiguration {
  readonly expectedOrigin: string;
  readonly publishableKey: string;
  readonly serviceRoleKey?: string;
  readonly supabaseUrl: string;
}

export interface SupabaseHttpClient {
  request(path: string, init: RequestInit): Promise<Response>;
  readonly origin: string;
  readonly publishableKey: string;
  readonly serviceRoleKey?: string;
}

function isServerValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 16_384 &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function parseSupabaseOrigin(value: unknown): string | null {
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
    parsed.hostname === "host.docker.internal" ||
    parsed.hostname === "kong";
  const hostedProject =
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    /^[a-z0-9]{20}\.supabase\.co$/u.test(parsed.hostname);
  if (
    (!hostedProject && !(parsed.protocol === "http:" && localHost)) ||
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

export function parseAuthActionLinkOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const localLoopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const hostedProject =
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    /^[a-z0-9]{20}\.supabase\.co$/u.test(parsed.hostname);
  if (
    (!hostedProject && !(parsed.protocol === "http:" && localLoopback)) ||
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

export function createSupabaseHttpClient(
  configuration: SupabaseRuntimeConfiguration,
  serviceFetch: ServiceFetch,
): SupabaseHttpClient {
  const expectedOrigin = parseSupabaseOrigin(configuration.expectedOrigin);
  const suppliedOrigin = parseSupabaseOrigin(configuration.supabaseUrl);
  if (
    expectedOrigin === null ||
    suppliedOrigin === null ||
    expectedOrigin !== suppliedOrigin ||
    !isServerValue(configuration.publishableKey) ||
    (configuration.serviceRoleKey !== undefined &&
      !isServerValue(configuration.serviceRoleKey))
  ) {
    throw new Error("Backend configuration is invalid");
  }
  return {
    origin: suppliedOrigin,
    publishableKey: configuration.publishableKey,
    serviceRoleKey: configuration.serviceRoleKey,
    async request(path, init) {
      let target: URL;
      try {
        target = new URL(path, `${suppliedOrigin}/`);
      } catch {
        throw new Error("Backend target is invalid");
      }
      if (
        target.origin !== suppliedOrigin ||
        target.username !== "" ||
        target.password !== "" ||
        !target.pathname.startsWith("/") ||
        target.hash !== ""
      ) {
        throw new Error("Backend target is invalid");
      }
      return await serviceFetch(target, {
        ...init,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(5_000),
      });
    },
  };
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes = 65_536,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (
      !/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBytes
    ) {
      throw new Error("Backend response is invalid");
    }
  }
  if (response.body === null) {
    throw new Error("Backend response is invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Backend response is invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Backend response is invalid");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Backend response is invalid");
  }
}

export function readExactSingleRow(
  value: unknown,
  expectedKeys: readonly string[],
): JsonRecord | null {
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const [row] = value;
  return isExactRecord(row, expectedKeys) ? row : null;
}
