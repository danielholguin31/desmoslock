import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

export const API_ORIGIN = "http://127.0.0.1:54321";
// Match the checked-in inert SiteURL so real GoTrue accepts the callback
// without adding redirect permissions. This origin is never fetched.
export const WEB_ORIGIN = "https://desmoslock.invalid";
const project = "desmoslock-v2";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// Assertions take booleans and static messages only: test-runner diagnostics must
// never serialize an Auth response, credential, callback, or secret-bearing error.
export function check(condition, message) {
  if (!condition) throw new Error(message);
}

function command(executable, args, input) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    input,
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 30_000,
  });
  check(
    !result.error && result.status === 0,
    "Disposable runtime command failed; details redacted",
  );
  return result.stdout.trim();
}

function json(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Disposable response was not JSON; details redacted");
  }
}

export function sql(statement) {
  return command(
    "docker",
    [
      "--context",
      "default",
      "exec",
      "-i",
      `supabase_db_${project}`,
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
    ],
    statement,
  );
}

export function sqlUuid(value) {
  check(
    typeof value === "string" && uuidPattern.test(value),
    "Synthetic fixture identifier is invalid",
  );
  return `'${value}'::uuid`;
}

export function requireUuid(value) {
  sqlUuid(value);
  return value;
}

export function openDisposableStack() {
  const endpoint = command("docker", [
    "context",
    "inspect",
    "default",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  check(
    endpoint === "unix:///var/run/docker.sock",
    "Acceptance requires the default local Unix Docker runtime",
  );
  for (const component of ["auth", "db"]) {
    const metadata = command("docker", [
      "--context",
      "default",
      "inspect",
      "--format",
      "{{json .Name}}\n{{json .State.Running}}\n{{json .Config.Image}}",
      `supabase_${component}_${project}`,
    ])
      .split("\n")
      .map(json);
    check(metadata.length === 3, "Disposable container metadata is incomplete");
    check(
      metadata[0] === `/supabase_${component}_${project}` &&
        metadata[1] === true,
      "Expected disposable project container is not running",
    );
    if (component === "auth")
      check(
        /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|supabase\/)gotrue:v2\.195\.0(?:@sha256:[0-9a-f]{64})?$/u.test(
          metadata[2],
        ),
        "Acceptance requires pinned GoTrue v2.195.0",
      );
    else
      check(
        /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|supabase\/)postgres:17\./u.test(
          metadata[2],
        ),
        "Acceptance requires disposable Supabase PostgreSQL 17",
      );
  }
  const status = json(
    command(path.join(root, "node_modules/.bin/supabase"), [
      "status",
      "--output",
      "json",
    ]),
  );
  check(
    status.API_URL === API_ORIGIN,
    "Acceptance refuses any noncanonical API origin",
  );
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  check(
    typeof publishableKey === "string" &&
      publishableKey.length >= 20 &&
      typeof serviceKey === "string" &&
      serviceKey.length >= 20,
    "Disposable stack omitted ephemeral keys",
  );
  check(
    sql(
      "select (not exists (select 1 from auth.users)) and coalesce((select fixture_valid from desmoslock_v2.internal_baseline_status()), false);",
    ) === "t",
    "Acceptance requires freshly reset synthetic fixtures and an empty Auth user table",
  );
  return { publishableKey, serviceKey };
}

export async function loopbackFetch(input, init = {}) {
  let endpoint;
  try {
    endpoint = new URL(input instanceof Request ? input.url : input);
  } catch {
    throw new Error("Invalid loopback request");
  }
  check(
    endpoint.origin === API_ORIGIN &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash,
    "Acceptance refuses non-loopback credential egress",
  );
  let response;
  try {
    response = await fetch(input instanceof Request ? input : endpoint, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  } catch {
    throw new Error("Disposable request failed; details redacted");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Unexpected provider redirect; details redacted");
  }
  return response;
}

export function client(key, fetcher = loopbackFetch) {
  return createClient(API_ORIGIN, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
      debug: false,
    },
    global: { fetch: fetcher },
  });
}

export async function auth(operation) {
  let result;
  try {
    result = await operation();
  } catch {
    throw new Error("Auth operation did not complete; details redacted");
  }
  check(
    result?.error === null && result.data != null,
    "Auth operation failed; details redacted",
  );
  return result.data;
}

export async function authDenied(operation, expectedCode) {
  let result;
  try {
    result = await operation();
  } catch {
    throw new Error("Auth denial could not be observed; details redacted");
  }
  check(
    result?.error?.code === expectedCode &&
      result.error.status >= 400 &&
      result.error.status < 500 &&
      result.error.status !== 429,
    `Expected provider rejection: ${expectedCode}`,
  );
}

export async function rpc(supabase, name, args = {}) {
  let result;
  try {
    result = await supabase.schema("desmoslock_v2").rpc(name, args);
  } catch {
    throw new Error("Product RPC did not complete; details redacted");
  }
  check(
    result?.error === null &&
      Array.isArray(result.data) &&
      result.data.length === 1,
    "Product RPC response failed; details redacted",
  );
  return result.data[0];
}

export function code(row, expected) {
  check(row?.code === expected, `Expected product outcome: ${expected}`);
}

export function password() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

export function sessionClaims(session) {
  let claims;
  try {
    claims = json(
      Buffer.from(session.access_token.split(".")[1], "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("Provider session is malformed; details redacted");
  }
  requireUuid(claims.session_id);
  return claims;
}

export async function stepUp(supabase) {
  const enrollment = await auth(() =>
    supabase.auth.mfa.enroll({ factorType: "totp" }),
  );
  requireUuid(enrollment.id);
  const secret = enrollment.totp?.secret;
  check(
    typeof secret === "string" && /^[A-Z2-7]+=*$/u.test(secret),
    "Provider did not return a usable TOTP enrollment",
  );
  let bits = "";
  for (const character of secret.replace(/=+$/u, ""))
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(character)
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(
    (bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)),
  );
  const challenge = await auth(() =>
    supabase.auth.mfa.challenge({ factorId: enrollment.id }),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const otp = String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
  await auth(() =>
    supabase.auth.mfa.verify({
      factorId: enrollment.id,
      challengeId: challenge.id,
      code: otp,
    }),
  );
  const { session } = await auth(() => supabase.auth.getSession());
  check(
    sessionClaims(session).aal === "aal2",
    "Real TOTP verification did not produce AAL2",
  );
}

// Admin-generated recovery followed through the real GET verification route.
// This produces provider-owned recovery AMR. It is not emailed-PKCE evidence.
export async function recoverySession(admin, recipient, supabase) {
  const generated = await auth(() =>
    admin.auth.admin.generateLink({ type: "recovery", email: recipient }),
  );
  let action;
  try {
    action = new URL(generated.properties?.action_link);
  } catch {
    throw new Error("Invalid provider recovery action; details redacted");
  }
  check(
    action.origin === API_ORIGIN &&
      action.pathname === "/auth/v1/verify" &&
      action.searchParams.get("type") === "recovery" &&
      !action.username &&
      !action.password &&
      !action.hash,
    "Recovery action is outside the pinned provider verification route",
  );
  let response;
  try {
    response = await fetch(action, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Recovery verification did not complete; details redacted");
  }
  check(
    response.status >= 300 && response.status < 400,
    "Provider recovery GET did not return a session redirect",
  );
  let redirect;
  try {
    redirect = new URL(response.headers.get("location"));
  } catch {
    throw new Error("Malformed recovery redirect; details redacted");
  }
  await response.body?.cancel();
  // Inspect only; never follow the redirect or persist its fragment.
  const fragment = new URLSearchParams(redirect.hash.slice(1));
  check(
    fragment.get("type") === "recovery" &&
      fragment.has("access_token") &&
      fragment.has("refresh_token"),
    "Provider recovery GET omitted its session",
  );
  const installed = await auth(() =>
    supabase.auth.setSession({
      access_token: fragment.get("access_token"),
      refresh_token: fragment.get("refresh_token"),
    }),
  );
  check(
    sessionClaims(installed.session).amr?.some(
      (claim) => claim.method === "recovery",
    ) === true,
    "Actual provider session lacks recovery AMR",
  );
  return installed.session;
}
