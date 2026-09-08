import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createStudentSessionCrypto } from "../../apps/desktop/src/main/student-session-crypto.ts";
import { createStudentSessionTransport } from "../../apps/desktop/src/main/student-session-transport.ts";
import {
  API_ORIGIN,
  auth,
  check,
  client,
  code,
  password,
  requireUuid,
  rpc,
  rpcRows,
  sessionClaims,
  sql,
  sqlUuid,
  stepUp,
} from "./staff-auth-loopback.mjs";
import {
  openConnection,
  parseJson,
  verifyDisposableDatabase,
} from "./revoke-membership-lock-db.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const operations = ["challenge", "join", "read", "reconnect", "forfeit"];
const denied = Object.freeze({
  status: "denied",
  code: "STUDENT_SESSION_DENIED",
});
const unavailable = Object.freeze({
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
});
const rowKeys = [
  "code",
  "test_id",
  "session_id",
  "session_revision",
  "test_revision",
  "epoch",
  "expires_at",
];
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

// All errors are static: no assertion, child diagnostic or rejection may print
// provider responses, codes, candidates, signatures, keys or SQL row snapshots.
export { check };
export function same(actual, expected, message) {
  check(isDeepStrictEqual(actual, expected), message);
}
export function accepted(result, expected = "STUDENT_SESSION_ACCEPTED") {
  check(
    result?.status === "accepted" && result.code === expected,
    "Expected real Student admission outcome was not accepted",
  );
  return result;
}
export function deniedResult(result) {
  same(
    result,
    denied,
    "Student denial was not the exact generic public response",
  );
}
export function unavailableResult(result) {
  same(
    result,
    unavailable,
    "A lost response must remain unavailable without invented authority",
  );
}
function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  );
}
function sqlInteger(value) {
  check(Number.isSafeInteger(value) && value >= 0, "Invalid synthetic integer");
  return String(value);
}

/** Starts a source-handler subprocess only when the runtime owner invokes a gate.
 * Config/key go through stdin memory, never argv, a file, host credential lookup,
 * Deno.env, or output. It calls real PostgREST through the production dependency.
 */
export async function startStudentEdge(serviceKey) {
  check(
    typeof serviceKey === "string" &&
      serviceKey.length >= 20 &&
      serviceKey.length <= 16_384,
    "Existing disposable runtime injection is missing",
  );
  const functionsRoot = path.join(root, "supabase/functions");
  const imports = operations
    .map(
      (operation) =>
        `import { handleRequest as ${operation} } from ${JSON.stringify(pathToFileURL(path.join(functionsRoot, `student-session-${operation}/index.ts`)).href)};`,
    )
    .join("\n");
  const dependencyModule = pathToFileURL(
    path.join(functionsRoot, "_shared/student-session-service.ts"),
  ).href;
  const script = `${imports}
import { createStudentSessionDependencies } from ${JSON.stringify(dependencyModule)};
const reader = Deno.stdin.readable.getReader();
let runtimeText = "";
let runtimeBytes = 0;
const decoder = new TextDecoder("utf-8", { fatal: true });
try {
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    runtimeBytes += next.value.byteLength;
    if (runtimeBytes > 16_512) throw new Error("Runtime injection exceeds its fixed bound");
    runtimeText += decoder.decode(next.value, { stream: true });
  }
  runtimeText += decoder.decode();
} finally { reader.releaseLock(); }
let injection;
try { injection = JSON.parse(runtimeText); } catch { throw new Error("Invalid runtime injection"); }
if (injection === null || typeof injection !== "object" || Array.isArray(injection) ||
  Object.keys(injection).length !== 1 || typeof injection.serviceKey !== "string" ||
  injection.serviceKey.length < 20 || injection.serviceKey.length > 16_384) throw new Error("Invalid runtime injection");
runtimeText = "";
const handlers = { challenge, join, read, reconnect, forfeit };
let dependencies;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen({ port }) {
  const origin = "http://127.0.0.1:" + port;
  dependencies = createStudentSessionDependencies({
    DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
    DESMOSLOCK_PUBLIC_BACKEND_URL: origin,
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: ${JSON.stringify(API_ORIGIN)},
    SUPABASE_URL: ${JSON.stringify(API_ORIGIN)},
    SUPABASE_SERVICE_ROLE_KEY: injection.serviceKey
  });
  console.log(JSON.stringify({ ready: true, origin }));
}, onError() { return new Response("unavailable", { status: 503 }); } }, request => {
  const route = new URL(request.url).pathname;
  const match = /^\\/functions\\/v1\\/student-session-(challenge|join|read|reconnect|forfeit)$/.exec(route);
  return match ? handlers[match[1]](request, dependencies) : new Response("missing", { status: 404 });
});
await server.finished;
`;
  // Deno may cache emitted runner modules: argv contains only nonsecret source.
  // The ephemeral service key is parsed from stdin after module compilation.
  const runner = `data:application/typescript,${encodeURIComponent(script)}`;
  const child = spawn(
    path.join(root, "node_modules/deno/deno"),
    [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--no-npm",
      "--cached-only",
      "--no-lock",
      "--allow-net=127.0.0.1",
      `--allow-read=${functionsRoot}`,
      runner,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        DENO_NO_UPDATE_CHECK: "1",
        DENO_DIR: path.join(
          root,
          "artifacts/local-tool-tmp/student-session-deno",
        ),
        TMPDIR: path.join(root, "artifacts/local-tool-tmp"),
      },
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    },
  );
  const watchdog = setTimeout(() => child.kill("SIGTERM"), 180_000);
  let closed = false;
  let invalidOutput = false;
  let buffer = "";
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.on("close", () => {
    closed = true;
    resolveExit();
  });
  child.stdin.on("error", () => {});
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const startupTimer = setTimeout(
    () =>
      rejectReady(
        new Error(
          "Student Deno handler startup timed out; diagnostics withheld",
        ),
      ),
    10_000,
  );
  child.on("error", () =>
    rejectReady(
      new Error("Student Deno handler could not start; diagnostics withheld"),
    ),
  );
  child.on("close", () =>
    rejectReady(
      new Error(
        "Student Deno handler exited before readiness; diagnostics withheld",
      ),
    ),
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 512) {
      invalidOutput = true;
      child.kill("SIGTERM");
      return;
    }
    if (!buffer.includes("\n")) return;
    try {
      const lines = buffer.trim().split("\n");
      const row = JSON.parse(lines[0]);
      const endpoint = new URL(row.origin);
      check(
        lines.length === 1 &&
          exactKeys(row, ["ready", "origin"]) &&
          row.ready === true &&
          endpoint.protocol === "http:" &&
          endpoint.hostname === "127.0.0.1" &&
          endpoint.port !== "" &&
          endpoint.origin === row.origin &&
          endpoint.pathname === "/" &&
          !endpoint.username &&
          !endpoint.password &&
          !endpoint.search &&
          !endpoint.hash,
        "Deno emitted an invalid readiness frame",
      );
      resolveReady(row.origin);
    } catch {
      invalidOutput = true;
      rejectReady(
        new Error("Deno output failed its nonsecret readiness contract"),
      );
    }
  });
  child.stdin.end(JSON.stringify({ serviceKey }));
  async function close() {
    clearTimeout(startupTimer);
    clearTimeout(watchdog);
    if (!closed) child.kill("SIGTERM");
    let stopped = await Promise.race([
      exited.then(() => true),
      delay(3_000).then(() => false),
    ]);
    if (!stopped) {
      child.kill("SIGKILL");
      stopped = await Promise.race([
        exited.then(() => true),
        delay(3_000).then(() => false),
      ]);
    }
    check(
      stopped && !invalidOutput,
      "Deno handler teardown or output sanitization failed",
    );
  }
  try {
    const origin = await ready;
    clearTimeout(startupTimer);
    return { origin, close };
  } catch {
    try {
      await close();
    } catch {
      /* Report only the fixed startup error. */
    }
    throw new Error(
      "Real Deno source handler did not become ready; diagnostics withheld",
    );
  }
}

export async function createStudentHarness(runtime) {
  check(
    runtime?.admin &&
      typeof runtime.publishableKey === "string" &&
      typeof runtime.serviceKey === "string",
    "Student gate requires opaque keys/client from the existing disposable runtime",
  );
  verifyDisposableDatabase();
  await runtime.checkRuntimeHealth("before Student acceptance fixtures");
  const edge = await startStudentEdge(runtime.serviceKey);
  const configuration = Object.freeze({
    environment: "local",
    url: edge.origin,
  });
  const crypto = createStudentSessionCrypto(configuration);
  const namespace = randomUUID();
  const schoolId = randomUUID();
  const foreignSchoolId = randomUUID();
  const transports = new Set();
  try {
    sql(`insert into desmoslock_v2.workspaces(id,kind,slug,display_name,seed_key) values
(${sqlUuid(schoolId)},'school','student-a-${namespace}','Disposable Student School A',null),
(${sqlUuid(foreignSchoolId)},'school','student-b-${namespace}','Disposable Student School B',null);`);

    async function actor(label, actorSchool, role, privileged = false) {
      check(
        ["teacher", "owner", "admin", "foreign"].includes(label) &&
          ["teacher", "owner", "admin"].includes(role),
        "Invalid fixed synthetic actor",
      );
      const secret = password();
      const email = `student-${label}-${namespace}@example.invalid`;
      const created = await auth(() =>
        runtime.admin.auth.admin.createUser({
          email,
          password: secret,
          email_confirm: true,
        }),
      );
      const userId = requireUuid(created.user?.id);
      const profileId = randomUUID();
      sql(`begin;
insert into desmoslock_v2.profiles(id,display_name,seed_key,auth_user_id)
values(${sqlUuid(profileId)},'Disposable Student ${label}',null,${sqlUuid(userId)});
insert into desmoslock_v2.memberships(workspace_id,profile_id,role,seed_key)
values(${sqlUuid(actorSchool)},${sqlUuid(profileId)},'${role}',null);
commit;`);
      const staff = client(runtime.publishableKey);
      await auth(() =>
        staff.auth.signInWithPassword({ email, password: secret }),
      );
      let aal1Client;
      if (privileged) {
        aal1Client = client(runtime.publishableKey);
        await auth(() =>
          aal1Client.auth.signInWithPassword({ email, password: secret }),
        );
        await stepUp(staff);
      }
      const { session } = await auth(() => staff.auth.getSession());
      const claims = sessionClaims(session);
      code(await rpc(staff, "current_staff_context"), "ok");
      return {
        client: staff,
        aal1Client,
        profileId,
        userId,
        schoolId: actorSchool,
        claims,
      };
    }
    const teacher = await actor("teacher", schoolId, "teacher");
    const foreignTeacher = await actor("foreign", foreignSchoolId, "teacher");
    function transport(fetcher) {
      const value = createStudentSessionTransport(configuration, fetcher);
      transports.add(value);
      return value;
    }
    function device() {
      return crypto.createEnrollment();
    }
    function candidates() {
      return crypto.createCandidates();
    }
    async function raw(operation, body) {
      check(operations.includes(operation), "Unknown fixed Student operation");
      let response;
      try {
        response = await fetch(
          `${edge.origin}/functions/v1/student-session-${operation}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch {
        throw new Error("Real Student HTTP exchange failed; details withheld");
      }
      check(
        response.headers.get("cache-control") === "no-store" &&
          response.headers
            .get("content-type")
            ?.startsWith("application/json") &&
          !response.redirected,
        "Real Edge HTTP response headers violated the fixed boundary",
      );
      let text;
      try {
        text = await response.text();
      } catch {
        throw new Error("Student response body unavailable");
      }
      check(
        Buffer.byteLength(text) <= 8_192,
        "Student result exceeded its size bound",
      );
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("Student result was not bounded JSON");
      }
      if (response.status === 403) deniedResult(result);
      else
        check(
          response.status === 200 || response.status === 503,
          "Unexpected Student endpoint status",
        );
      return { status: response.status, result };
    }
    async function test(staff = teacher) {
      const created = await rpc(staff.client, "create_school_test", {
        workspace_id: staff.schoolId,
        creation_request_id: randomUUID(),
        title: "Disposable admission Test",
      });
      code(created, "test_created");
      const testId = requireUuid(created.test_id);
      code(
        await rpc(staff.client, "open_test", {
          workspace_id: staff.schoolId,
          test_id: testId,
          expected_test_revision: 1,
        }),
        "test_opened",
      );
      return { schoolId: staff.schoolId, testId };
    }
    async function staffMutation(name, args, expected, staff = teacher) {
      const rows = await rpcRows(staff.client, name, args);
      check(
        rows.length === 1 && exactKeys(rows[0], rowKeys),
        "Student staff mutation omitted its exact result schema",
      );
      const result = rows[0];
      check(
        result.code === expected,
        "Student staff mutation returned an unexpected result",
      );
      const nonnull =
        name === "issue_test_join_code"
          ? ["test_id", "test_revision", "expires_at"]
          : name === "remove_student_session"
            ? ["test_id", "session_id", "session_revision", "epoch"]
            : [
                "test_id",
                "session_id",
                "session_revision",
                "epoch",
                "expires_at",
              ];
      for (const key of rowKeys.slice(1))
        check(
          nonnull.includes(key) ? result[key] !== null : result[key] === null,
          "Student staff mutation widened its result nullability",
        );
      if (result.expires_at !== null)
        check(
          timestampPattern.test(result.expires_at),
          "Staff expiry lost six-digit precision",
        );
      return result;
    }
    async function issue(target) {
      const joinCode = crypto.createJoinCode();
      const detail = await rpc(teacher.client, "current_school_test", {
        workspace_id: target.schoolId,
        test_id: target.testId,
      });
      code(detail, "ok");
      const request = {
        workspace_id: target.schoolId,
        test_id: target.testId,
        expected_test_revision: detail.test_revision,
        issuance_request_id: randomUUID(),
        join_material_digest: crypto.digestJoinCode(joinCode),
      };
      const result = await staffMutation(
        "issue_test_join_code",
        request,
        "join_code_issued",
      );
      return { joinCode, request, result };
    }
    async function prepareJoin(material, options = {}) {
      const enrollment = options.device ?? device();
      const submitted = options.candidates ?? candidates();
      const requestId = options.requestId ?? randomUUID();
      const admissionMode = options.mode ?? "initial";
      const logicalOperationDigest = crypto.digestLogicalOperation({
        kind: "join",
        admissionMode,
        requestId,
        deviceSessionId: enrollment.deviceSessionId,
        joinMaterialDigest: crypto.digestJoinCode(material.joinCode),
        capabilityDigest: submitted.capabilityDigest,
        reconnectDigest: submitted.reconnectDigest,
      });
      const requestTransport = options.transport ?? transport();
      const challenge = await requestTransport.challenge({
        requestId,
        deviceSessionId: enrollment.deviceSessionId,
        publicKey: enrollment.publicKey,
        logicalOperationDigest,
      });
      check(
        typeof challenge.challengeId === "string",
        "Real Edge did not allocate a bootstrap challenge",
      );
      const proof = crypto.signBootstrap(enrollment, {
        kind: "bootstrap",
        requestId,
        deviceSessionId: enrollment.deviceSessionId,
        logicalOperationDigest,
        challengeId: challenge.challengeId,
        expiresAtMs: challenge.expiresAtMs,
      });
      return {
        device: enrollment,
        candidates: submitted,
        logicalOperationDigest,
        transport: requestTransport,
        request: {
          admissionMode,
          requestId,
          deviceSessionId: enrollment.deviceSessionId,
          joinCode: material.joinCode,
          capabilityDigest: submitted.capabilityDigest,
          reconnectDigest: submitted.reconnectDigest,
          deviceProof: proof,
        },
      };
    }
    async function join(material, options = {}) {
      const intent = await prepareJoin(material, options);
      const result = await intent.transport.join(
        intent.request,
        intent.logicalOperationDigest,
      );
      return { ...intent, result };
    }
    function maintenance(joined, operation, counter, options = {}) {
      check(
        ["read", "reconnect", "forfeit"].includes(operation),
        "Invalid maintenance operation",
      );
      const scope = options.scope ?? joined.result.scope;
      const requestId = options.requestId ?? randomUUID();
      const logical =
        operation === "reconnect"
          ? {
              kind: operation,
              requestId,
              scope,
              expectedSessionRevision:
                options.expectedRevision ?? joined.result.sessionRevision,
              reconnectDigest: crypto.digestReconnectGrant(
                joined.candidates.reconnectGrant,
              ),
              nextCapabilityDigest: options.next.capabilityDigest,
              nextReconnectDigest: options.next.reconnectDigest,
            }
          : {
              kind: operation,
              requestId,
              scope,
              capabilityDigest: crypto.digestCapability(
                joined.candidates.capabilityToken,
              ),
              ...(operation === "forfeit"
                ? {
                    expectedSessionRevision:
                      options.expectedRevision ?? joined.result.sessionRevision,
                  }
                : {}),
            };
      const logicalOperationDigest = crypto.digestLogicalOperation(logical);
      const deviceProof = crypto.signMaintenance(
        options.device ?? joined.device,
        {
          kind: "maintenance",
          operation,
          requestId,
          scope,
          logicalOperationDigest,
          counter,
        },
      );
      const request =
        operation === "reconnect"
          ? {
              requestId,
              scope,
              expectedSessionRevision: logical.expectedSessionRevision,
              reconnectGrant: joined.candidates.reconnectGrant,
              nextCapabilityDigest: options.next.capabilityDigest,
              nextReconnectDigest: options.next.reconnectDigest,
              deviceProof,
            }
          : {
              requestId,
              scope,
              capabilityToken: joined.candidates.capabilityToken,
              deviceProof,
              ...(operation === "forfeit"
                ? { expectedSessionRevision: logical.expectedSessionRevision }
                : {}),
            };
      return { request, logicalOperationDigest, operation };
    }
    async function send(joined, intent, requestTransport = transport()) {
      if (intent.operation === "read")
        return requestTransport.read(
          intent.request,
          joined.result.capabilityExpiresAtMs,
        );
      if (intent.operation === "reconnect")
        return requestTransport.reconnect(
          intent.request,
          intent.logicalOperationDigest,
        );
      return requestTransport.forfeit(intent.request);
    }
    async function remove(
      target,
      joined,
      revision = joined.result.sessionRevision,
    ) {
      return staffMutation(
        "remove_student_session",
        {
          workspace_id: target.schoolId,
          test_id: target.testId,
          student_session_id: joined.result.scope.studentSessionId,
          expected_session_revision: revision,
        },
        "student_session_removed",
      );
    }
    async function prepare(target, joined, revision) {
      const joinCode = crypto.createJoinCode();
      const request = {
        workspace_id: target.schoolId,
        test_id: target.testId,
        student_session_id: joined.result.scope.studentSessionId,
        expected_session_revision: revision,
        issuance_request_id: randomUUID(),
        join_material_digest: crypto.digestJoinCode(joinCode),
      };
      return {
        joinCode,
        request,
        result: await staffMutation(
          "prepare_student_readmission",
          request,
          "student_readmission_prepared",
        ),
      };
    }
    async function end(target) {
      const detail = await rpc(teacher.client, "current_school_test", {
        workspace_id: target.schoolId,
        test_id: target.testId,
      });
      code(
        await rpc(teacher.client, "end_test", {
          workspace_id: target.schoolId,
          test_id: target.testId,
          expected_test_revision: detail.test_revision,
        }),
        "test_ended",
      );
    }
    function snapshot(target) {
      return parseJson(
        sql(`select jsonb_build_object(
      'test',(select to_jsonb(t)||jsonb_build_object('tuple',t.ctid::text) from desmoslock_v2.tests t where t.id=${sqlUuid(target.testId)}),
      'sessions',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('tuple',s.ctid::text) order by s.id) from desmoslock_v2.student_sessions s where s.test_id=${sqlUuid(target.testId)}),'[]'::jsonb),
      'materials',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('tuple',m.ctid::text) order by m.issuance_request_id) from desmoslock_v2.student_join_materials m where m.test_id=${sqlUuid(target.testId)}),'[]'::jsonb),
      'bindings',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('tuple',b.ctid::text) order by b.device_session_id) from desmoslock_v2.student_device_bindings b where b.test_id=${sqlUuid(target.testId)}),'[]'::jsonb),
      'audit',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('tuple',e.ctid::text) order by e.id) from desmoslock_v2.staff_audit_events e where e.test_id=${sqlUuid(target.testId)}),'[]'::jsonb));`),
      );
    }
    async function close() {
      await Promise.all([...transports].map((value) => value.drain()));
      await edge.close();
      await runtime.checkRuntimeHealth(
        "after retained Student acceptance fixtures",
      );
      // Committed fixture rows, immutable device bindings and audit remain intact.
      // The existing owned stack's final teardown is their only cleanup boundary.
    }
    return {
      configuration,
      crypto,
      teacher,
      foreignTeacher,
      schoolId,
      actor,
      foreignSchoolId,
      transport,
      device,
      candidates,
      raw,
      test,
      issue,
      staffMutation,
      prepareJoin,
      join,
      maintenance,
      send,
      remove,
      prepare,
      end,
      snapshot,
      close,
    };
  } catch {
    await Promise.allSettled([...transports].map((value) => value.drain()));
    try {
      await edge.close();
    } catch {
      /* Preserve the fixed setup failure. */
    }
    throw new Error(
      "Student fixture setup failed; handler stopped and committed synthetic fixtures retained",
    );
  }
}

export function withoutAttemptMetadata(result) {
  const issuance = { ...result };
  delete issuance.serverNowMs;
  delete issuance.acceptedProofCounter;
  return issuance;
}
export function currentSession(snapshot, id) {
  const row = snapshot.sessions.find((session) => session.id === id);
  check(row !== undefined, "Expected scoped Student row is absent");
  return row;
}
export function transitionCount(snapshot, event) {
  return snapshot.audit.filter((entry) => entry.event_type === event).length;
}

/** Real SQL connection holds exact rows; actual HTTP handler RPCs are waiters. */
export async function holdStudentLock(target, sessionId = null) {
  const connection = await openConnection(
    `student-block-${randomUUID().slice(0, 8)}`,
  );
  try {
    const locked = await connection.query(`begin;
select id::text from desmoslock_v2.tests where id=${sqlUuid(target.testId)} ${sessionId === null ? "for update" : "for share"};
${sessionId === null ? "" : `select id::text from desmoslock_v2.student_sessions where id=${sqlUuid(sessionId)} for update;`}`);
    check(
      locked.length === (sessionId === null ? 1 : 2) &&
        locked[0] === target.testId &&
        (sessionId === null || locked[1] === sessionId),
      "Blocker did not acquire the exact intended Test/session row",
    );
    return connection;
  } catch {
    await connection.close();
    throw new Error(
      "Student blocker could not acquire its exact synthetic row",
    );
  }
}
export async function observeStudentWait(
  blocker,
  rpcName,
  relation,
  minimum = 1,
) {
  check(
    [
      "commit_student_session_join",
      "read_student_maintenance_key",
      "commit_student_session_read",
      "commit_student_session_reconnect",
    ].includes(rpcName) && ["tests", "student_sessions"].includes(relation),
    "Invalid named lock observation",
  );
  const deadline = performance.now() + 1_800;
  while (performance.now() < deadline) {
    const rows =
      await blocker.query(`do $$ begin perform pg_stat_clear_snapshot(); end $$;
with recursive blocked(pid) as (
select a.pid from pg_stat_activity a where ${sqlInteger(blocker.pid)}=any(pg_blocking_pids(a.pid))
union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid)))
select coalesce(jsonb_agg(a.pid order by a.pid),'[]'::jsonb)
from pg_stat_activity a where a.wait_event_type='Lock' and a.pid<>pg_backend_pid()
and a.pid in (select pid from blocked)
and strpos(a.query,'${rpcName}')>0
and exists(select 1 from pg_locks l where l.pid=a.pid and l.relation='desmoslock_v2.${relation}'::regclass and l.granted and l.mode='RowShareLock');`);
    check(rows.length === 1, "Lock observation returned an unexpected frame");
    const pids = parseJson(rows[0]);
    if (Array.isArray(pids) && pids.length >= minimum)
      return { count: pids.length, relation, rpcName };
    await delay(15);
  }
  throw new Error(
    "Required actual PostgREST Test/session lock wait was not observed before deadline",
  );
}
export async function commitStaffWhileHolding(
  blocker,
  harness,
  target,
  operation,
  joined,
) {
  check(
    ["end", "remove"].includes(operation),
    "Invalid locked staff transition",
  );
  const claims = harness.teacher.claims;
  const current = harness.snapshot(target);
  const statement =
    operation === "end"
      ? `select code from desmoslock_v2.end_test(${sqlUuid(target.schoolId)},${sqlUuid(target.testId)},${sqlInteger(current.test.revision)});`
      : `select code from desmoslock_v2.remove_student_session(${sqlUuid(target.schoolId)},${sqlUuid(target.testId)},${sqlUuid(joined.result.scope.studentSessionId)},${sqlInteger(joined.result.sessionRevision)});`;
  const rows =
    await blocker.query(`do $$ begin perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',${sqlUuid(harness.teacher.userId)},'session_id',${sqlUuid(claims.session_id)},'role','authenticated','aal','aal1','exp',${sqlInteger(claims.exp)})::text,true); end $$;
set local role authenticated;
${statement}
reset role;
commit;`);
  check(
    rows.length === 1 &&
      rows[0] ===
        (operation === "end" ? "test_ended" : "student_session_removed"),
    "Competing production staff RPC did not commit under the real provider session",
  );
}

/** A scoped failure fixture adds no authority and never disables an existing
 * trigger. Drop only this uniquely owned fixture after observing rollback. */
export function installStudentAuditFailure(target) {
  const identifier = `student_failure_${randomUUID().replaceAll("-", "")}`;
  check(
    /^student_failure_[0-9a-f]{32}$/u.test(identifier),
    "Invalid failure fixture identity",
  );
  sql(`begin;
create function desmoslock_v2.${identifier}() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001',message='synthetic Student audit unavailable'; end $$;
revoke all on function desmoslock_v2.${identifier}() from public,anon,authenticated,service_role;
create trigger ${identifier} before insert on desmoslock_v2.staff_audit_events for each row
when (new.test_id=${sqlUuid(target.testId)} and new.event_type='student_session_reconnected')
execute function desmoslock_v2.${identifier}();
commit;`);
  return () =>
    sql(`begin;
drop trigger ${identifier} on desmoslock_v2.staff_audit_events;
drop function desmoslock_v2.${identifier}();
commit;`);
}
