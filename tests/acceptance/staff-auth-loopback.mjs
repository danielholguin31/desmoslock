import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createClient } from "@supabase/supabase-js";
import {
  parseCreateSchoolTestRpcResult,
  parseEndTestRpcResult,
  parseOpenTestRpcResult,
  parseReadSchoolTestRpcResult,
  parseReadSchoolTestsRpcResult,
  parseSchoolDisplayName,
  parseUpdateTestTitleRpcResult,
  parseUpdateSchoolDisplayNameRpcResult,
} from "@desmoslock/contracts";

import { prepareStaffRecoveryCallback } from "../../apps/web/src/auth/staff-auth-callback.ts";
import { createBackendProbe } from "../../supabase/functions/health/index.ts";

export const API_ORIGIN = "http://127.0.0.1:54321";
// Match the checked-in inert SiteURL so real GoTrue accepts the callback
// without adding redirect permissions. This origin is never fetched.
export const WEB_ORIGIN = "https://desmoslock.invalid";
const MAILPIT_ORIGIN = "http://127.0.0.1:54324";
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
  // CLI 2.115.0 retains the legacy inbucket container name for Mailpit.
  for (const component of ["auth", "db", "inbucket"]) {
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
    else if (component === "db")
      check(
        /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|supabase\/)postgres:17\./u.test(
          metadata[2],
        ),
        "Acceptance requires disposable Supabase PostgreSQL 17",
      );
    else
      check(
        /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|axllent\/)mailpit:v1\.30\.2(?:@sha256:[0-9a-f]{64})?$/u.test(
          metadata[2],
        ),
        "Acceptance requires the pinned disposable Mailpit v1.30.2 sink",
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

export function client(key, fetcher = loopbackFetch, flowType = "implicit") {
  return createClient(API_ORIGIN, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
      debug: false,
      flowType,
    },
    global: { fetch: fetcher },
  });
}

// These checks reach the actual database, Auth server, and local Edge endpoint.
// The source probe independently enforces its exact migration-set attestation;
// runtime provisioning must leave the fixed synthetic fixture identity intact.
export function createRuntimeHealthCheck(admin, serviceKey) {
  const expectedBaseline = {
    capabilities: ["auth", "database", "rest"],
    fixtureDigest:
      "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
    fixtureValid: true,
    fixtureVersion: "internal-baseline-v2",
    schemaGeneration: 4,
  };
  const probe = createBackendProbe(
    {
      DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: API_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      SUPABASE_URL: API_ORIGIN,
    },
    loopbackFetch,
  );
  let migrationSet;

  return async (checkpoint) => {
    const status = await rpc(admin, "internal_baseline_status");
    check(
      typeof status.migration_set_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(status.migration_set_sha256),
      `Database migration attestation is missing ${checkpoint}`,
    );
    migrationSet ??= status.migration_set_sha256;
    check(
      isDeepStrictEqual(status, {
        fixture_digest: expectedBaseline.fixtureDigest,
        fixture_valid: true,
        fixture_version: expectedBaseline.fixtureVersion,
        migration_set_sha256: migrationSet,
        schema_generation: 4,
      }),
      `Database baseline changed ${checkpoint}`,
    );

    let probed;
    try {
      probed = await probe();
    } catch {
      throw new Error(
        `Real source health probe failed ${checkpoint}; details redacted`,
      );
    }
    check(
      isDeepStrictEqual(probed, expectedBaseline),
      `Real source health probe is not exact-ready ${checkpoint}`,
    );

    const response = await loopbackFetch(`${API_ORIGIN}/functions/v1/health`, {
      method: "GET",
    });
    check(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store" &&
        response.headers.get("access-control-allow-origin") === "*",
      `Live public health is unavailable ${checkpoint}`,
    );
    let publicStatus;
    try {
      publicStatus = await response.json();
    } catch {
      throw new Error(
        `Live health response is malformed ${checkpoint}; details redacted`,
      );
    }
    check(
      isDeepStrictEqual(publicStatus, {
        ...expectedBaseline,
        service: "desmoslock-v2",
        status: "ready",
      }),
      `Live public health is not exact-ready ${checkpoint}`,
    );
  };
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

export async function rpcRows(supabase, name, args = {}) {
  let result;
  try {
    result = await supabase.schema("desmoslock_v2").rpc(name, args);
  } catch {
    throw new Error("Product RPC did not complete; details redacted");
  }
  check(
    result?.error === null && Array.isArray(result.data),
    "Product RPC response failed; details redacted",
  );
  return result.data;
}

export async function rpc(supabase, name, args = {}) {
  const rows = await rpcRows(supabase, name, args);
  check(rows.length === 1, "Product RPC did not return exactly one outcome");
  if (name === "current_staff_context") checkStaffContext(rows[0]);
  if (name === "update_school_display_name")
    check(
      parseUpdateSchoolDisplayNameRpcResult(rows) !== null,
      "School update did not return an exact code-only outcome",
    );
  if (name === "create_school_test")
    check(
      parseCreateSchoolTestRpcResult(rows) !== null,
      "Test creation returned a malformed outcome",
    );
  if (name === "update_test_title")
    check(
      parseUpdateTestTitleRpcResult(rows) !== null,
      "Test title update returned a malformed outcome",
    );
  if (name === "open_test")
    check(
      parseOpenTestRpcResult(rows) !== null,
      "Test opening returned a malformed outcome",
    );
  if (name === "end_test")
    check(
      parseEndTestRpcResult(rows) !== null,
      "Test ending returned a malformed outcome",
    );
  return rows[0];
}

export async function readSchoolTests(supabase, request) {
  const rows = await rpcRows(supabase, "current_school_tests", {
    workspace_id: request.schoolId,
    before_created_at: request.before?.createdAt ?? null,
    before_test_id: request.before?.testId ?? null,
  });
  const result = parseReadSchoolTestsRpcResult(rows, request);
  check(
    result !== null,
    "Actual Test page failed the production contract decoder",
  );
  return result;
}

export async function readSchoolTest(supabase, request) {
  const rows = await rpcRows(supabase, "current_school_test", {
    workspace_id: request.schoolId,
    test_id: request.testId,
  });
  const result = parseReadSchoolTestRpcResult(rows, request);
  check(
    result !== null,
    "Actual Test detail failed the production contract decoder",
  );
  return result;
}

export async function directTestTableDenied(supabase, schoolId) {
  requireUuid(schoolId);
  for (const write of [false, true]) {
    let result;
    try {
      const table = supabase.schema("desmoslock_v2").from("tests");
      result = await (
        write
          ? table.update({ title: "Forbidden direct Test title" })
          : table.select("id,title,lifecycle,revision")
      ).eq("workspace_id", schoolId);
    } catch {
      throw new Error(
        "Direct Test table denial was not observed; details redacted",
      );
    }
    check(
      result?.data === null && result.error?.code === "42501",
      "Direct Test table access did not fail at the privilege boundary",
    );
  }
}

function checkStaffContext(row) {
  const keys = [
    "code",
    "profile_id",
    "display_name",
    "school_id",
    "school_slug",
    "school_name",
    "school_settings_revision",
    "membership_role",
    "role_revision",
  ];
  check(
    row !== null &&
      typeof row === "object" &&
      Object.keys(row).length === keys.length &&
      keys.every((key) => Object.hasOwn(row, key)),
    "Staff context did not return the exact nine-column projection",
  );
  if (row.code === "ok") {
    requireUuid(row.profile_id);
    requireUuid(row.school_id);
    check(
      typeof row.display_name === "string" &&
        row.display_name.length > 0 &&
        typeof row.school_slug === "string" &&
        row.school_slug.length > 0 &&
        parseSchoolDisplayName(row.school_name) !== null &&
        Number.isSafeInteger(row.school_settings_revision) &&
        row.school_settings_revision >= 1 &&
        ["owner", "admin", "teacher"].includes(row.membership_role) &&
        Number.isSafeInteger(row.role_revision) &&
        row.role_revision >= 1,
      "Staff context returned malformed School presentation or Membership facts",
    );
    return;
  }
  check(
    typeof row.code === "string" &&
      row.code.length > 0 &&
      keys
        .filter((key) => key !== "code" && key !== "profile_id")
        .every((key) => row[key] === null) &&
      (row.profile_id === null || row.code === "membership_inactive"),
    "Denied staff context retained protected School presentation or Membership facts",
  );
  if (row.profile_id !== null) requireUuid(row.profile_id);
}

export async function directSchoolTableDenied(supabase, schoolId) {
  requireUuid(schoolId);
  for (const write of [false, true]) {
    let result;
    try {
      const table = supabase.schema("desmoslock_v2").from("workspaces");
      result = await (
        write
          ? table.update({ display_name: "Forbidden direct School rename" })
          : table.select("id,display_name,settings_revision")
      ).eq("id", schoolId);
    } catch {
      throw new Error(
        "Direct School table denial was not observed; details redacted",
      );
    }
    check(
      result?.data === null && result.error?.code === "42501",
      "Direct School table access did not fail at the privilege boundary",
    );
  }
}

export async function rpcDenied(supabase, name, args, expectedCodes) {
  let result;
  try {
    result = await supabase.schema("desmoslock_v2").rpc(name, args);
  } catch {
    throw new Error("Product RPC denial was not observed; details redacted");
  }
  check(
    result?.data === null && expectedCodes.includes(result.error?.code),
    "Product RPC did not reject the inaccessible signature or role",
  );
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
  const otpAt = (time) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
    const digest = createHmac("sha1", key).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    return String(
      (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
    ).padStart(6, "0");
  };
  const verifiedAt = Date.now();
  let lastPeriod = Math.floor(verifiedAt / 30_000);
  await auth(() =>
    supabase.auth.mfa.verify({
      factorId: enrollment.id,
      challengeId: challenge.id,
      code: otpAt(verifiedAt),
    }),
  );
  const { session } = await auth(() => supabase.auth.getSession());
  check(
    sessionClaims(session).aal === "aal2",
    "Real TOTP verification did not produce AAL2",
  );
  // Reuse the real factor through the browser's normal challenge UI, without
  // injecting an SDK session or reusing a provider-rejected TOTP time step.
  return {
    async nextCode() {
      const period = Math.floor(Date.now() / 30_000);
      if (period <= lastPeriod)
        await delay((lastPeriod + 1) * 30_000 - Date.now() + 200);
      const nextAt = Date.now();
      lastPeriod = Math.floor(nextAt / 30_000);
      return otpAt(nextAt);
    },
  };
}

// Mailpit is the CLI's disposable SMTP sink, with no relay configured. These
// numeric loopback URLs constrain this harness; they do not attest Docker's
// listener bindings. No mail is released, downloaded to a file, or logged.
async function mailpitJson(endpoint) {
  check(
    endpoint.origin === MAILPIT_ORIGIN &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash,
    "Mail capture refuses any noncanonical sink origin",
  );
  let response;
  try {
    response = await fetch(endpoint, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Disposable mail capture unavailable; details redacted");
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new Error("Disposable mail capture did not succeed");
  }
  // The fetch signal's ten-second deadline also covers reads. Bound bytes before
  // decoding/parsing so even an unexpected response cannot collect a large mail.
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      check(
        bytes <= 262_144,
        "Disposable mail response exceeds its byte limit",
      );
      chunks.push(value);
    }
    return json(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error(
      "Invalid or incomplete disposable mail response; details redacted",
    );
  } finally {
    reader.releaseLock();
  }
}

function exactRecipient(message, recipient) {
  return (
    Array.isArray(message?.To) &&
    message.To.length === 1 &&
    message.To[0]?.Address === recipient &&
    (message.Cc?.length ?? 0) === 0 &&
    (message.Bcc?.length ?? 0) === 0
  );
}

async function mailedRecoveryCallback(recipient, supabase, redirectTo) {
  check(
    /^composed-teacher-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.invalid$/u.test(
      recipient,
    ),
    "Recovery capture requires the run-owned synthetic recipient",
  );
  const search = new URL("/api/v1/search", MAILPIT_ORIGIN);
  search.searchParams.set("query", `to:${recipient}`);
  search.searchParams.set("start", "0");
  search.searchParams.set("limit", "2");
  const initial = await mailpitJson(search);
  check(
    initial.messages_count === 0 &&
      Array.isArray(initial.messages) &&
      initial.messages.length === 0,
    "Recovery capture requires an unused synthetic recipient mailbox",
  );
  // The PKCE-configured SDK generates S256 and holds its verifier in memory.
  // The provider creates the flow and sends the untouched pkce_ credential.
  await auth(() =>
    supabase.auth.resetPasswordForEmail(recipient, { redirectTo }),
  );
  const deadline = Date.now() + 15_000;
  let summary;
  while (Date.now() < deadline) {
    const result = await mailpitJson(search);
    check(
      Array.isArray(result.messages) &&
        Number.isInteger(result.messages_count) &&
        result.messages_count >= 0 &&
        result.messages_count <= 1 &&
        result.messages.length === result.messages_count,
      "Recovery capture returned an ambiguous mailbox result",
    );
    if (result.messages_count === 1) {
      summary = result.messages[0];
      break;
    }
    await delay(200);
  }
  check(
    exactRecipient(summary, recipient) &&
      typeof summary.ID === "string" &&
      /^[A-Za-z0-9_-]{1,80}$/u.test(summary.ID),
    "Recovery mail was not captured for the exact synthetic recipient",
  );
  const message = await mailpitJson(
    new URL(`/api/v1/message/${summary.ID}`, MAILPIT_ORIGIN),
  );
  check(
    message.ID === summary.ID &&
      exactRecipient(message, recipient) &&
      typeof message.HTML === "string" &&
      message.HTML.length < 100_000,
    "Recovery mail detail did not match its synthetic recipient",
  );
  const links = [
    ...message.HTML.matchAll(
      /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/giu,
    ),
  ];
  check(links.length === 1, "Recovery mail omitted its unique provider action");
  // recovery-v1.html intentionally mails an inert frontend callback. Decode
  // HTML escaping only and never fetch that callback or alter its credential.
  const callbackText = (links[0][1] ?? links[0][2]).replaceAll("&amp;", "&");
  let callback;
  try {
    callback = new URL(callbackText);
  } catch {
    throw new Error("Invalid mailed recovery callback; details redacted");
  }
  const fragment = new URLSearchParams(callback.hash.slice(1));
  const tokenHash = fragment.get("token_hash");
  check(
    /^pkce_[0-9a-f]{56}$/u.test(tokenHash ?? "") &&
      callbackText === `${redirectTo}#token_hash=${tokenHash}&type=recovery` &&
      callback.href === callbackText &&
      callback.origin === WEB_ORIGIN &&
      !callback.username &&
      !callback.password,
    "Mailed recovery callback differs from the exact inert application route",
  );
  return callbackText;
}

// Genuine local SMTP PKCE recovery. External email delivery and browser callback
// handling remain separate evidence; the provider owns all flow/session state.
export async function recoverySession(recipient, supabase) {
  // Same route shape as the application. These run-owned callback identifiers
  // are independent of the SDK's secret PKCE verifier, which stays in memory.
  const flow = randomBytes(16).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const redirectTo = `${WEB_ORIGIN}/?auth=recovery&flow=${flow}&state=${state}`;
  const mailedCallback = await mailedRecoveryCallback(
    recipient,
    supabase,
    redirectTo,
  );
  let action;
  let installed;
  let scrubs = 0;
  const callbackOptions = {
    backendOrigin: API_ORIGIN,
    route: { origin: WEB_ORIGIN, pathname: "/" },
    history: {
      replaceState(data, unused, url) {
        check(
          data === null && unused === "" && url === "/",
          "Recovery callback did not scrub its sensitive route",
        );
        scrubs += 1;
      },
    },
    navigate(url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Invalid provider navigation; details redacted");
      }
      check(
        action === undefined &&
          url.startsWith(`${API_ORIGIN}/auth/v1/verify?`) &&
          parsed.href === url &&
          parsed.origin === API_ORIGIN &&
          parsed.pathname === "/auth/v1/verify" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.hash,
        "Recovery navigation is outside the canonical loopback provider route",
      );
      action = parsed;
    },
    async exchange(input) {
      check(
        installed === undefined &&
          input.flowId === flow &&
          input.state === state,
        "Recovery code callback did not preserve the requested flow and state",
      );
      installed = await auth(() =>
        supabase.auth.exchangeCodeForSession(input.authorizationCode),
      );
    },
  };
  const prepared = prepareStaffRecoveryCallback(
    mailedCallback,
    callbackOptions,
  );
  check(
    prepared.status === "confirmation_required" && action === undefined,
    "Mailed recovery callback did not require explicit confirmation",
  );
  const confirmed = await prepared.confirm();
  check(
    confirmed.status === "redirecting" && action !== undefined,
    "Recovery confirmation did not prepare provider verification",
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
    response.status === 303,
    "Provider PKCE recovery GET did not return its code redirect",
  );
  const redirect = response.headers.get("location");
  await response.body?.cancel();
  // Inspect only; never follow the inert SiteURL or persist the callback/code.
  const completed = prepareStaffRecoveryCallback(redirect, callbackOptions);
  check(
    completed.status === "exchange_required" && installed === undefined,
    "Provider PKCE code callback was not accepted by the application parser",
  );
  const exchanged = await completed.exchange();
  check(
    exchanged.status === "accepted" && installed !== undefined && scrubs === 2,
    "Application recovery callback did not exchange its real provider code",
  );
  check(
    sessionClaims(installed.session).amr?.some(
      (claim) => claim.method === "recovery",
    ) === true,
    "Actual provider PKCE session lacks recovery AMR",
  );
  return installed.session;
}
