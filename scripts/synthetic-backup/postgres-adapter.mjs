import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  CURRENT_MIGRATION_SET_SHA256,
  CURRENT_MIGRATION_VERSIONS,
  SYNTHETIC_TABLES,
} from "./operator.mjs";

const FIXTURE_DIGEST =
  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201";
const FIXTURE_VERSION = "internal-baseline-v2";
const SCHEMA_GENERATION = 4;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_RESTORE_SQL_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_OUTPUT_BYTES = 256 * 1024;

const PRISTINE_STUDENT_SESSION_PREDICATE = `state = 'created'
  and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
  and epoch = 1 and revision = 1 and last_accepted_proof_counter = 0
  and maintenance_accepted_at = '{}'::timestamptz[]
  and synthetic_display_name is null
  and device_session_id is null
  and device_public_key is null
  and capability_digest is null
  and capability_issued_at is null
  and capability_expires_at is null
  and reconnect_digest is null
  and reconnect_expires_at is null
  and join_request_id is null
  and join_operation_digest is null
  and join_admission_mode is null
  and join_material_digest is null
  and rotation_request_id is null
  and rotation_operation_digest is null
  and previous_reconnect_digest is null`;

const OBSERVATION_QUERY = `
with baseline as (
  select schema_generation, fixture_version, fixture_digest, fixture_valid
  from desmoslock_v2.internal_baseline_status()
  limit 1
), attestation as (
  select schema_generation, migration_set_sha256
  from desmoslock_v2.internal_release_attestation
  where id = 1
), counts as (
  select
    (select count(*) from desmoslock_v2.application_session_revocation_cutoffs)::integer as application_session_revocation_cutoffs,
    (select count(*) from desmoslock_v2.application_session_revocations)::integer as application_session_revocations,
    (select count(*) from desmoslock_v2.baseline_fixture_state)::integer as baseline_fixture_state,
    (select count(*) from desmoslock_v2.foundation_seed)::integer as foundation_seed,
    (select count(*) from desmoslock_v2.memberships)::integer as memberships,
    (select count(*) from desmoslock_v2.profiles)::integer as profiles,
    (select count(*) from desmoslock_v2.staff_audit_events)::integer as staff_audit_events,
    (select count(*) from desmoslock_v2.staff_invitations)::integer as staff_invitations,
    (select count(*) from desmoslock_v2.staff_password_recovery_operations)::integer as staff_password_recovery_operations,
    (select count(*) from desmoslock_v2.student_join_materials)::integer as student_join_materials,
    (select count(*) from desmoslock_v2.student_device_bindings)::integer as student_device_bindings,
    (select count(*) from desmoslock_v2.student_bootstrap_challenges)::integer as student_bootstrap_challenges,
    (select count(*) from desmoslock_v2.student_bootstrap_limits)::integer as student_bootstrap_limits,
    (select count(*) from desmoslock_v2.student_device_proof_state)::integer as student_device_proof_state,
    (select count(*) from desmoslock_v2.student_protection_events)::integer as student_protection_events,
    (select count(*) from desmoslock_v2.student_sessions)::integer as student_sessions,
    (select count(*) from desmoslock_v2.student_sessions where ${PRISTINE_STUDENT_SESSION_PREDICATE})::integer as pristine_student_sessions,
    (select count(*) from desmoslock_v2.tests)::integer as tests,
    (select count(*) from desmoslock_v2.workspaces)::integer as workspaces
)
select json_build_object(
  'applicationState', case
    when counts.application_session_revocation_cutoffs = 0
      and counts.application_session_revocations = 0
      and counts.baseline_fixture_state = 0
      and counts.foundation_seed = 0
      and counts.memberships = 0
      and counts.profiles = 0
      and counts.staff_audit_events = 0
      and counts.staff_invitations = 0
      and counts.staff_password_recovery_operations = 0
      and counts.student_join_materials = 0
      and counts.student_device_bindings = 0
      and counts.student_bootstrap_challenges = 0
      and counts.student_bootstrap_limits = 0
      and counts.student_device_proof_state = 0
      and counts.student_protection_events = 0
      and counts.student_sessions = 0
      and counts.pristine_student_sessions = 0
      and counts.tests = 0
      and counts.workspaces = 0
      and baseline.schema_generation is null
      then 'empty'
    when counts.application_session_revocation_cutoffs = 0
      and counts.application_session_revocations = 0
      and counts.baseline_fixture_state = 1
      and counts.foundation_seed = 1
      and counts.memberships = 6
      and counts.profiles = 6
      and counts.staff_audit_events = 0
      and counts.staff_invitations = 0
      and counts.staff_password_recovery_operations = 0
      and counts.student_join_materials = 0
      and counts.student_device_bindings = 0
      and counts.student_bootstrap_challenges = 0
      and counts.student_bootstrap_limits = 0
      and counts.student_device_proof_state = 0
      and counts.student_protection_events = 0
      and counts.student_sessions = 2
      and counts.pristine_student_sessions = 2
      and counts.tests = 2
      and counts.workspaces = 2
      and baseline.fixture_valid is true
      then 'synthetic-baseline'
    else 'other'
  end,
  'databaseName', current_database(),
  'fixture', case when baseline.schema_generation is null then null else json_build_object(
    'counts', json_build_object(
      'baselineFixtureState', counts.baseline_fixture_state,
      'foundationSeed', counts.foundation_seed,
      'memberships', counts.memberships,
      'profiles', counts.profiles,
      'studentSessions', counts.student_sessions,
      'tests', counts.tests,
      'workspaces', counts.workspaces
    ),
    'digest', baseline.fixture_digest,
    'valid', baseline.fixture_valid,
    'version', baseline.fixture_version
  ) end,
  'migrationVersions', (
    select coalesce(json_agg(version::text order by version::text), '[]'::json)
    from supabase_migrations.schema_migrations
  ),
  'migrationSetSha256', attestation.migration_set_sha256,
  'localRestoreMarker', (
    select marker
    from desmoslock_v2.local_restore_target_attestation
    where id = 1
      and database_name = current_database()
      and system_identifier = (
        select system_identifier::text from pg_control_system()
      )
  ),
  'schemaGeneration', attestation.schema_generation,
  'systemIdentifier', (
    select system_identifier::text from pg_control_system()
  )
)::text
from counts
left join baseline on true
left join attestation on true;
`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const observedKeys = Object.keys(value);
  const observedSet = new Set(observedKeys);
  return (
    observedKeys.length === keys.length &&
    observedSet.size === observedKeys.length &&
    keys.every((key) => observedSet.has(key))
  );
}

function hasExactUniqueStrings(observed, expected) {
  if (
    !Array.isArray(observed) ||
    observed.length !== expected.length ||
    observed.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const observedSet = new Set(observed);
  return (
    observedSet.size === observed.length &&
    expected.every((value) => observedSet.has(value))
  );
}

function configurationError() {
  throw new Error("POSTGRES_ADAPTER_CONFIGURATION_INVALID");
}

function validateConnection(connection, environment) {
  const expectedKeys =
    environment === "staging"
      ? [
          "database",
          "host",
          "password",
          "port",
          "sslMode",
          "sslRootCert",
          "user",
        ]
      : ["database", "host", "password", "port", "sslMode", "user"];
  if (
    !hasExactKeys(connection, expectedKeys) ||
    typeof connection.database !== "string" ||
    !/^[A-Za-z0-9_.-]{1,63}$/u.test(connection.database) ||
    typeof connection.host !== "string" ||
    !/^[A-Za-z0-9.:[\]_-]{1,253}$/u.test(connection.host) ||
    typeof connection.password !== "string" ||
    connection.password.length === 0 ||
    connection.password.includes("\0") ||
    typeof connection.port !== "string" ||
    !/^\d{1,5}$/u.test(connection.port) ||
    Number(connection.port) < 1 ||
    Number(connection.port) > 65_535 ||
    typeof connection.user !== "string" ||
    !/^[A-Za-z0-9_.-]{1,127}$/u.test(connection.user)
  ) {
    configurationError();
  }
  if (
    (environment === "local" &&
      (connection.sslMode !== "disable" ||
        (connection.host !== "127.0.0.1" && connection.host !== "[::1]"))) ||
    (environment === "staging" &&
      (connection.sslMode !== "verify-full" ||
        typeof connection.sslRootCert !== "string" ||
        !path.isAbsolute(connection.sslRootCert) ||
        path.parse(connection.sslRootCert).root === connection.sslRootCert ||
        connection.sslRootCert.includes("\0")))
  ) {
    configurationError();
  }
  return { ...connection };
}

function validateLocalRestoreMarker(marker) {
  if (
    typeof marker !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{31,127}$/u.test(marker)
  ) {
    configurationError();
  }
  return marker;
}

function parseConfiguration(configuration) {
  const profileAliases = isRecord(configuration?.profiles)
    ? Object.keys(configuration.profiles)
    : [];
  const validAliases = ["local-restore", "staging"];
  const hasStaging = profileAliases.includes("staging");
  const executableNames = hasStaging
    ? ["pgDump", "pgRestore", "psql"]
    : ["pgRestore", "psql"];
  if (
    !hasExactKeys(configuration, ["executablePaths", "profiles"]) ||
    profileAliases.length === 0 ||
    profileAliases.some((alias) => !validAliases.includes(alias)) ||
    !hasExactKeys(configuration.executablePaths, executableNames)
  ) {
    configurationError();
  }
  for (const executablePath of Object.values(configuration.executablePaths)) {
    if (
      typeof executablePath !== "string" ||
      !path.isAbsolute(executablePath)
    ) {
      configurationError();
    }
  }

  const parsedProfiles = {};
  for (const alias of profileAliases) {
    const expectedEnvironment = alias === "staging" ? "staging" : "local";
    const profile = configuration.profiles[alias];
    const expectedProfileKeys =
      expectedEnvironment === "local"
        ? ["connection", "environment", "localRestoreMarker"]
        : ["connection", "environment"];
    if (
      !hasExactKeys(profile, expectedProfileKeys) ||
      profile.environment !== expectedEnvironment
    ) {
      configurationError();
    }
    parsedProfiles[alias] = {
      connection: validateConnection(profile.connection, expectedEnvironment),
      environment: expectedEnvironment,
      ...(expectedEnvironment === "local"
        ? {
            localRestoreMarker: validateLocalRestoreMarker(
              profile.localRestoreMarker,
            ),
          }
        : {}),
    };
  }
  return {
    executablePaths: { ...configuration.executablePaths },
    profiles: parsedProfiles,
  };
}

function requiredProcessValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    configurationError();
  }
  return value;
}

export function loadPostgresAdapterConfiguration(environment, profileAlias) {
  if (profileAlias !== "local-restore" && profileAlias !== "staging") {
    configurationError();
  }
  const isStaging = profileAlias === "staging";
  const prefix = isStaging
    ? "DESMOSLOCK_STAGING_"
    : "DESMOSLOCK_LOCAL_RESTORE_";
  const executablePaths = {
    pgRestore: requiredProcessValue(environment, "DESMOSLOCK_PG_RESTORE_PATH"),
    psql: requiredProcessValue(environment, "DESMOSLOCK_PSQL_PATH"),
  };
  if (isStaging) {
    executablePaths.pgDump = requiredProcessValue(
      environment,
      "DESMOSLOCK_PG_DUMP_PATH",
    );
  }
  return parseConfiguration({
    executablePaths,
    profiles: {
      [profileAlias]: {
        connection: {
          database: requiredProcessValue(environment, `${prefix}PGDATABASE`),
          host: requiredProcessValue(environment, `${prefix}PGHOST`),
          password: requiredProcessValue(environment, `${prefix}PGPASSWORD`),
          port: requiredProcessValue(environment, `${prefix}PGPORT`),
          sslMode: isStaging ? "verify-full" : "disable",
          ...(isStaging
            ? {
                sslRootCert: requiredProcessValue(
                  environment,
                  "DESMOSLOCK_STAGING_PGSSLROOTCERT",
                ),
              }
            : {}),
          user: requiredProcessValue(environment, `${prefix}PGUSER`),
        },
        environment: isStaging ? "staging" : "local",
        ...(!isStaging
          ? {
              localRestoreMarker: requiredProcessValue(
                environment,
                "DESMOSLOCK_LOCAL_RESTORE_MARKER",
              ),
            }
          : {}),
      },
    },
  });
}

function connectionEnvironment(connection) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PGDATABASE: connection.database,
    PGHOST: connection.host,
    PGPASSWORD: connection.password,
    PGPORT: connection.port,
    PGSSLMODE: connection.sslMode,
    ...(connection.sslRootCert === undefined
      ? {}
      : { PGSSLROOTCERT: connection.sslRootCert }),
    PGUSER: connection.user,
  };
}

function parseSubprocessRequest(request) {
  if (
    !hasExactKeys(request, [
      "arguments",
      "environment",
      "executable",
      "input",
      "maxOutputBytes",
      "timeoutMs",
    ]) ||
    !Array.isArray(request.arguments) ||
    request.arguments.some((argument) => typeof argument !== "string") ||
    !isRecord(request.environment) ||
    Object.values(request.environment).some(
      (value) => typeof value !== "string",
    ) ||
    typeof request.executable !== "string" ||
    !path.isAbsolute(request.executable) ||
    (request.input !== null && !Buffer.isBuffer(request.input)) ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 5 * 60_000
  ) {
    throw new Error("POSTGRES_SUBPROCESS_FAILED");
  }
  return request;
}

function destroyPipe(stream) {
  try {
    stream?.destroy();
  } catch {
    // Native stream errors are intentionally kept behind the stable boundary.
  }
}

export function createBoundedSubprocessRunner({
  killProcess = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  return function runBoundedSubprocess(request) {
    return new Promise((resolve, reject) => {
      let parsedRequest;
      try {
        parsedRequest = parseSubprocessRequest(request);
      } catch {
        reject(new Error("POSTGRES_SUBPROCESS_FAILED"));
        return;
      }

      let child;
      try {
        child = spawnProcess(
          parsedRequest.executable,
          parsedRequest.arguments,
          {
            detached: platform !== "win32",
            env: parsedRequest.environment,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch {
        reject(new Error("POSTGRES_SUBPROCESS_FAILED"));
        return;
      }

      let settled = false;
      let outputBytes = 0;
      const output = [];
      let timer;
      const terminateProcessTree = () => {
        let groupTerminated = false;
        if (
          platform !== "win32" &&
          Number.isSafeInteger(child.pid) &&
          child.pid > 0
        ) {
          try {
            killProcess(-child.pid, "SIGKILL");
            groupTerminated = true;
          } catch {
            // Fall through to the direct child handle.
          }
        }
        if (!groupTerminated) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Termination remains best effort; the pipes are still destroyed.
          }
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminateProcessTree();
        destroyPipe(child.stdin);
        destroyPipe(child.stdout);
        destroyPipe(child.stderr);
        try {
          child.unref?.();
        } catch {
          // Native handle details are intentionally not surfaced.
        }
        reject(new Error("POSTGRES_SUBPROCESS_FAILED"));
      };

      child.on("error", abort);
      child.stdout.on("error", abort);
      child.stderr.on("error", abort);
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        if (outputBytes > parsedRequest.maxOutputBytes) {
          abort();
          return;
        }
        output.push(bytes);
      });
      child.stderr.resume();
      child.on("close", (code, signal) => {
        if (settled) return;
        if (code !== 0 || signal !== null) {
          abort();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(output));
      });
      child.stdin.on("error", abort);
      timer = setTimeout(abort, parsedRequest.timeoutMs);
      try {
        child.stdin.end(parsedRequest.input ?? undefined);
      } catch {
        abort();
      }
    });
  };
}

export const runBoundedSubprocess = createBoundedSubprocessRunner();

function parseObservation(output, profile) {
  let payload;
  try {
    payload = JSON.parse(output.toString("utf8").trim());
  } catch {
    throw new Error("POSTGRES_OBSERVATION_INVALID");
  }
  if (
    !hasExactKeys(payload, [
      "applicationState",
      "databaseName",
      "fixture",
      "localRestoreMarker",
      "migrationSetSha256",
      "migrationVersions",
      "schemaGeneration",
      "systemIdentifier",
    ]) ||
    !["empty", "other", "synthetic-baseline"].includes(
      payload.applicationState,
    ) ||
    !Array.isArray(payload.migrationVersions) ||
    payload.databaseName !== profile.connection.database ||
    typeof payload.migrationSetSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(payload.migrationSetSha256) ||
    (profile.environment === "local" &&
      payload.localRestoreMarker !== profile.localRestoreMarker) ||
    (profile.environment === "staging" &&
      payload.localRestoreMarker !== null) ||
    typeof payload.systemIdentifier !== "string" ||
    !/^\d{10,32}$/u.test(payload.systemIdentifier) ||
    payload.schemaGeneration !== SCHEMA_GENERATION
  ) {
    throw new Error("POSTGRES_OBSERVATION_INVALID");
  }
  const migrationSetSha256 =
    hasExactUniqueStrings(
      payload.migrationVersions,
      CURRENT_MIGRATION_VERSIONS,
    ) && payload.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256
      ? CURRENT_MIGRATION_SET_SHA256
      : "unrecognized-migration-set";
  if (migrationSetSha256 !== CURRENT_MIGRATION_SET_SHA256) {
    throw new Error("POSTGRES_OBSERVATION_INVALID");
  }
  let fixture = null;
  if (payload.fixture !== null) {
    if (
      !hasExactKeys(payload.fixture, [
        "counts",
        "digest",
        "valid",
        "version",
      ]) ||
      !hasExactKeys(payload.fixture.counts, [
        "baselineFixtureState",
        "foundationSeed",
        "memberships",
        "profiles",
        "studentSessions",
        "tests",
        "workspaces",
      ]) ||
      typeof payload.fixture.digest !== "string" ||
      typeof payload.fixture.version !== "string" ||
      typeof payload.fixture.valid !== "boolean"
    ) {
      throw new Error("POSTGRES_OBSERVATION_INVALID");
    }
    fixture = {
      counts: payload.fixture.counts,
      dataClass: payload.fixture.valid ? "synthetic-only" : "unverified",
      digest: payload.fixture.digest,
      version: payload.fixture.version,
    };
  }
  return {
    applicationState: payload.applicationState,
    environment: profile.environment,
    fixture,
    identity: payload.systemIdentifier,
    migrationSetSha256,
    schemaGeneration: payload.schemaGeneration,
  };
}

function parseArchiveInventory(output) {
  const entries = [];
  for (const line of output.toString("utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";")) continue;
    const match =
      /^\d+;\s+\d+\s+\d+\s+(TABLE DATA)\s+(\S+)\s+(\S+)\s+\S+$/u.exec(trimmed);
    if (match === null) {
      entries.push({
        kind: "UNRECOGNIZED",
        name: "unrecognized",
        schema: "unrecognized",
      });
      continue;
    }
    entries.push({ kind: match[1], name: match[3], schema: match[2] });
  }
  return { entries, format: "postgres-custom-data-only" };
}

const COPY_COLUMNS = Object.freeze({
  baseline_fixture_state: [
    "id",
    "schema_generation",
    "fixture_version",
    "fixture_digest",
  ],
  foundation_seed: ["id", "schema_generation", "fixture_namespace"],
  memberships: [
    "workspace_id",
    "profile_id",
    "role",
    "seed_key",
    "status",
    "role_revision",
    "accepted_at",
    "revoked_at",
    "revoked_by_profile_id",
    "revocation_reason_code",
    "updated_at",
  ],
  profiles: ["id", "display_name", "seed_key", "auth_user_id"],
  student_sessions: [
    "id",
    "workspace_id",
    "test_id",
    "state",
    "seed_key",
    "synthetic_display_name",
    "created_at",
    "epoch",
    "revision",
    "device_session_id",
    "device_public_key",
    "last_accepted_proof_counter",
    "maintenance_accepted_at",
    "capability_digest",
    "capability_issued_at",
    "capability_expires_at",
    "reconnect_digest",
    "reconnect_expires_at",
    "join_request_id",
    "join_operation_digest",
    "join_admission_mode",
    "join_material_digest",
    "rotation_request_id",
    "rotation_operation_digest",
    "previous_reconnect_digest",
  ],
  tests: [
    "id",
    "workspace_id",
    "created_by_profile_id",
    "title",
    "seed_key",
    "lifecycle",
    "revision",
    "created_at",
    "opened_at",
    "ended_at",
    "creation_request_id",
  ],
  workspaces: [
    "id",
    "kind",
    "slug",
    "display_name",
    "seed_key",
    "settings_revision",
  ],
});
const RESTORE_TABLE_ORDER = Object.freeze([
  "foundation_seed",
  "workspaces",
  "profiles",
  "memberships",
  "tests",
  "student_sessions",
  "baseline_fixture_state",
]);
const POSTGRES_NULL = "\\N";
const NULLABLE_COPY_COLUMNS = Object.freeze({
  memberships: Object.freeze([
    "accepted_at",
    "revoked_at",
    "revoked_by_profile_id",
    "revocation_reason_code",
    "updated_at",
  ]),
  profiles: Object.freeze(["auth_user_id"]),
  student_sessions: Object.freeze([
    "synthetic_display_name",
    "device_session_id",
    "device_public_key",
    "capability_digest",
    "capability_issued_at",
    "capability_expires_at",
    "reconnect_digest",
    "reconnect_expires_at",
    "join_request_id",
    "join_operation_digest",
    "join_admission_mode",
    "join_material_digest",
    "rotation_request_id",
    "rotation_operation_digest",
    "previous_reconnect_digest",
  ]),
  tests: Object.freeze(["opened_at", "ended_at", "creation_request_id"]),
});

function archiveContentError() {
  throw new Error("POSTGRES_ARCHIVE_CONTENT_INVALID");
}

function hasExactRow(row, expected) {
  return (
    Array.isArray(row) &&
    row.length === expected.length &&
    row.every((value, index) => value === expected[index])
  );
}

function isAllowedArchiveScaffolding(line, restrictionState) {
  if (line === "" || line.startsWith("--")) return true;
  if (
    /^(?:SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0|SET client_encoding = 'UTF8'|SET standard_conforming_strings = on|SET check_function_bodies = false|SET xmloption = content|SET client_min_messages = warning|SET row_security = off|SET default_tablespace = ''|SET default_table_access_method = heap|SELECT pg_catalog\.set_config\('search_path', '', false\));$/u.test(
      line,
    )
  ) {
    return true;
  }
  const restrict = /^\\restrict ([A-Za-z0-9_]{1,128})$/u.exec(line);
  if (restrict !== null && restrictionState.token === null) {
    restrictionState.token = restrict[1];
    return true;
  }
  const unrestrict = /^\\unrestrict ([A-Za-z0-9_]{1,128})$/u.exec(line);
  if (
    unrestrict !== null &&
    restrictionState.token !== null &&
    unrestrict[1] === restrictionState.token
  ) {
    restrictionState.token = null;
    return true;
  }
  return false;
}

function parseCopyBlocks(output) {
  const tables = new Map();
  const lines = output.toString("utf8").split(/\r?\n/u);
  const restrictionState = { token: null };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("COPY ")) {
      if (!isAllowedArchiveScaffolding(line, restrictionState)) {
        archiveContentError();
      }
      continue;
    }
    const match =
      /^COPY desmoslock_v2\.([a-z_]+) \(([a-z_, ]+)\) FROM stdin;$/u.exec(line);
    if (match === null) archiveContentError();
    const table = match[1];
    const columns = match[2].split(", ");
    if (
      !Object.hasOwn(COPY_COLUMNS, table) ||
      tables.has(table) ||
      columns.length !== COPY_COLUMNS[table].length ||
      columns.some(
        (column, columnIndex) => column !== COPY_COLUMNS[table][columnIndex],
      )
    ) {
      archiveContentError();
    }
    const rows = [];
    let terminated = false;
    for (index += 1; index < lines.length; index += 1) {
      const row = lines[index];
      if (row === "\\.") {
        terminated = true;
        break;
      }
      const values = row.split("\t");
      if (
        values.length !== columns.length ||
        values.some((value, columnIndex) => {
          if (value === POSTGRES_NULL) {
            return !NULLABLE_COPY_COLUMNS[table]?.includes(
              columns[columnIndex],
            );
          }
          return value.includes("\\") || value === "";
        })
      ) {
        archiveContentError();
      }
      rows.push(values);
    }
    if (!terminated) archiveContentError();
    tables.set(table, rows);
  }
  if (!hasExactUniqueStrings([...tables.keys()], SYNTHETIC_TABLES)) {
    archiveContentError();
  }
  if (restrictionState.token !== null) archiveContentError();
  return tables;
}

function canonicalRestoreSql(tables) {
  return Buffer.from(
    RESTORE_TABLE_ORDER.map((table) => {
      const header = `COPY desmoslock_v2.${table} (${COPY_COLUMNS[table].join(", ")}) FROM stdin;\n`;
      const rows = tables
        .get(table)
        .map((values) => values.join("\t"))
        .join("\n");
      return `${header}${rows}\n\\.\n`;
    }).join(""),
    "utf8",
  );
}

function frameText(parts) {
  return `${parts.length}#${parts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("")}`;
}

function archiveFixtureCounts(tables) {
  return {
    baselineFixtureState: tables.get("baseline_fixture_state").length,
    foundationSeed: tables.get("foundation_seed").length,
    memberships: tables.get("memberships").length,
    profiles: tables.get("profiles").length,
    studentSessions: tables.get("student_sessions").length,
    tests: tables.get("tests").length,
    workspaces: tables.get("workspaces").length,
  };
}

function canonicalEntityPayload(tables, counts) {
  const compareSeedKeys = (left, right) =>
    left.seedKey < right.seedKey ? -1 : left.seedKey > right.seedKey ? 1 : 0;
  const groups = [
    tables
      .get("workspaces")
      .map(([id, kind, slug, displayName, seedKey, settingsRevision]) => {
        if (kind !== "school" || settingsRevision !== "1")
          archiveContentError();
        return {
          parts: ["school", seedKey, id, slug, displayName],
          seedKey,
        };
      }),
    tables.get("profiles").map(([id, displayName, seedKey, authUserId]) => {
      if (authUserId !== POSTGRES_NULL) archiveContentError();
      return {
        parts: ["profile", seedKey, id, displayName, ""],
        seedKey,
      };
    }),
    tables
      .get("memberships")
      .map(
        ([
          workspaceId,
          profileId,
          role,
          seedKey,
          status,
          roleRevision,
          acceptedAt,
          revokedAt,
          revokedByProfileId,
          revocationReasonCode,
          updatedAt,
        ]) => {
          if (
            status !== "active" ||
            roleRevision !== "1" ||
            [
              acceptedAt,
              revokedAt,
              revokedByProfileId,
              revocationReasonCode,
              updatedAt,
            ].some((value) => value !== POSTGRES_NULL)
          ) {
            archiveContentError();
          }
          return {
            parts: [
              "membership",
              seedKey,
              workspaceId,
              profileId,
              role,
              status,
              roleRevision,
              "",
              "",
              "",
              "",
              "",
            ],
            seedKey,
          };
        },
      ),
    tables
      .get("tests")
      .map(
        ([
          id,
          workspaceId,
          creatorId,
          title,
          seedKey,
          lifecycle,
          revision,
          createdAt,
          openedAt,
          endedAt,
          creationRequestId,
        ]) => {
          // Native pg_dump COPY text is fixed by the export's process-local UTC.
          // Validate the new metadata independently of the published framing.
          if (
            lifecycle !== "draft" ||
            revision !== "1" ||
            createdAt !== "2000-01-01 00:00:00+00" ||
            [openedAt, endedAt, creationRequestId].some(
              (value) => value !== POSTGRES_NULL,
            )
          ) {
            archiveContentError();
          }
          return {
            parts: ["test", seedKey, id, workspaceId, creatorId, title],
            seedKey,
          };
        },
      ),
    tables
      .get("student_sessions")
      .map(([id, workspaceId, testId, state, seedKey, ...metadata]) => {
        // Added authority fields are checked independently; the published
        // five-column entity framing and fixed fixture digest remain unchanged.
        const expectedMetadata = [
          POSTGRES_NULL,
          "2000-01-01 00:00:00+00",
          "1",
          "1",
          POSTGRES_NULL,
          POSTGRES_NULL,
          "0",
          "{}",
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
          POSTGRES_NULL,
        ];
        if (state !== "created" || !hasExactRow(metadata, expectedMetadata))
          archiveContentError();
        return {
          parts: ["session", seedKey, id, workspaceId, testId, state],
          seedKey,
        };
      }),
  ];
  return [
    frameText([
      "fixture",
      FIXTURE_VERSION,
      String(SCHEMA_GENERATION),
      "baseline_fixture_state",
      String(counts.baselineFixtureState),
      "foundation_seed",
      String(counts.foundationSeed),
      "memberships",
      String(counts.memberships),
      "profiles",
      String(counts.profiles),
      "student_sessions",
      String(counts.studentSessions),
      "tests",
      String(counts.tests),
      "workspaces",
      String(counts.workspaces),
    ]),
    ...groups.flatMap((group) =>
      group.toSorted(compareSeedKeys).map(({ parts }) => frameText(parts)),
    ),
  ].join("");
}

function verifySyntheticArchiveContents(output) {
  const tables = parseCopyBlocks(output);
  const foundationRows = tables.get("foundation_seed");
  const fixtureStateRows = tables.get("baseline_fixture_state");
  if (
    foundationRows.length !== 1 ||
    !hasExactRow(foundationRows[0], ["1", "2", "desmoslock-v2-foundation"]) ||
    fixtureStateRows.length !== 1 ||
    !hasExactRow(fixtureStateRows[0], [
      "1",
      String(SCHEMA_GENERATION),
      FIXTURE_VERSION,
      FIXTURE_DIGEST,
    ])
  ) {
    archiveContentError();
  }
  const counts = archiveFixtureCounts(tables);
  const observedDigest = crypto
    .createHash("sha256")
    .update(canonicalEntityPayload(tables, counts), "utf8")
    .digest("hex");
  if (
    observedDigest !== FIXTURE_DIGEST ||
    JSON.stringify(counts) !==
      JSON.stringify({
        baselineFixtureState: 1,
        foundationSeed: 1,
        memberships: 6,
        profiles: 6,
        studentSessions: 2,
        tests: 2,
        workspaces: 2,
      })
  ) {
    archiveContentError();
  }
  return {
    fixture: {
      counts,
      dataClass: "synthetic-only",
      digest: observedDigest,
      version: FIXTURE_VERSION,
    },
    restoreSql: canonicalRestoreSql(tables),
  };
}

function verifiedArchiveInventory(inventory) {
  if (
    inventory.format !== "postgres-custom-data-only" ||
    inventory.entries.length !== SYNTHETIC_TABLES.length
  ) {
    archiveContentError();
  }
  const expected = new Set(SYNTHETIC_TABLES);
  const observed = new Set();
  for (const entry of inventory.entries) {
    if (
      !hasExactKeys(entry, ["kind", "name", "schema"]) ||
      entry.kind !== "TABLE DATA" ||
      entry.schema !== "desmoslock_v2" ||
      !expected.has(entry.name) ||
      observed.has(entry.name)
    ) {
      archiveContentError();
    }
    observed.add(entry.name);
  }
  return inventory;
}

function archiveSha256(archive) {
  return crypto.createHash("sha256").update(archive).digest("hex");
}

function parseAtomicRestoreTarget(target) {
  if (
    !hasExactKeys(target, [
      "databaseAlias",
      "expectedDatabaseIdentity",
      "expectedMigrationSetSha256",
      "expectedSchemaGeneration",
      "sourceDatabaseIdentity",
    ]) ||
    target.databaseAlias !== "local-restore" ||
    typeof target.expectedDatabaseIdentity !== "string" ||
    !/^\d{10,32}$/u.test(target.expectedDatabaseIdentity) ||
    target.expectedMigrationSetSha256 !== CURRENT_MIGRATION_SET_SHA256 ||
    target.expectedSchemaGeneration !== SCHEMA_GENERATION ||
    typeof target.sourceDatabaseIdentity !== "string" ||
    !/^\d{10,32}$/u.test(target.sourceDatabaseIdentity) ||
    target.sourceDatabaseIdentity === target.expectedDatabaseIdentity
  ) {
    throw new Error("POSTGRES_RESTORE_TARGET_INVALID");
  }
  return target;
}

function buildAtomicRestoreInput(target, restoreSql, profile) {
  const expectedMigrationVersions = CURRENT_MIGRATION_VERSIONS.map(
    (version) => `'${version}'`,
  ).join(", ");
  const preflight = `
begin isolation level serializable;
select pg_advisory_xact_lock(hashtextextended('desmoslock-v2/synthetic-restore', 0));
do $desmoslock_restore_preflight$
begin
  if (select system_identifier::text from pg_control_system()) <>
    '${target.expectedDatabaseIdentity}' then
    raise exception using errcode = '55000', message = 'restore target identity mismatch';
  end if;
  if current_database() <> '${profile.connection.database}' then
    raise exception using errcode = '55000', message = 'restore database identity mismatch';
  end if;
  if not exists (
    select 1
    from desmoslock_v2.local_restore_target_attestation
    where id = 1
      and marker = '${profile.localRestoreMarker}'
      and database_name = current_database()
      and system_identifier = (
        select system_identifier::text from pg_control_system()
      )
  ) then
    raise exception using errcode = '55000', message = 'restore local attestation mismatch';
  end if;
  if not exists (
    select 1
    from desmoslock_v2.internal_release_attestation
    where id = 1
      and schema_generation = ${SCHEMA_GENERATION}
      and migration_set_sha256 = '${CURRENT_MIGRATION_SET_SHA256}'
  ) then
    raise exception using errcode = '55000', message = 'restore migration attestation mismatch';
  end if;
  if (
    select coalesce(array_agg(version::text order by version::text), array[]::text[])
    from supabase_migrations.schema_migrations
  ) is distinct from array[${expectedMigrationVersions}]::text[] then
    raise exception using errcode = '55000', message = 'restore migration set mismatch';
  end if;
  if exists (select 1 from desmoslock_v2.application_session_revocation_cutoffs)
    or exists (select 1 from desmoslock_v2.application_session_revocations)
    or exists (select 1 from desmoslock_v2.baseline_fixture_state)
    or exists (select 1 from desmoslock_v2.foundation_seed)
    or exists (select 1 from desmoslock_v2.memberships)
    or exists (select 1 from desmoslock_v2.profiles)
    or exists (select 1 from desmoslock_v2.staff_audit_events)
    or exists (select 1 from desmoslock_v2.staff_invitations)
    or exists (select 1 from desmoslock_v2.staff_password_recovery_operations)
    or exists (select 1 from desmoslock_v2.student_join_materials)
    or exists (select 1 from desmoslock_v2.student_device_bindings)
    or exists (select 1 from desmoslock_v2.student_bootstrap_challenges)
    or exists (select 1 from desmoslock_v2.student_bootstrap_limits)
    or exists (select 1 from desmoslock_v2.student_device_proof_state)
    or exists (select 1 from desmoslock_v2.student_protection_events)
    or exists (select 1 from desmoslock_v2.student_sessions)
    or exists (select 1 from desmoslock_v2.tests)
    or exists (select 1 from desmoslock_v2.workspaces)
  then
    raise exception using errcode = '55000', message = 'restore target is not empty';
  end if;
end
$desmoslock_restore_preflight$;
`;
  const verification = `
do $desmoslock_restore_verification$
begin
  if not exists (
    select 1
    from desmoslock_v2.internal_baseline_status() as baseline
    where baseline.fixture_valid
      and baseline.schema_generation = ${SCHEMA_GENERATION}
      and baseline.fixture_version = '${FIXTURE_VERSION}'
      and baseline.fixture_digest =
        '${FIXTURE_DIGEST}'
  ) then
    raise exception using errcode = '55000', message = 'restored fixture verification failed';
  end if;
  if not exists (
    select 1
    from desmoslock_v2.foundation_seed
    where id = 1
      and schema_generation = 2
      and fixture_namespace = 'desmoslock-v2-foundation'
  ) or (select count(*) from desmoslock_v2.foundation_seed) <> 1 then
    raise exception using errcode = '55000', message = 'restored foundation verification failed';
  end if;
  if (select count(*) from desmoslock_v2.student_sessions where ${PRISTINE_STUDENT_SESSION_PREDICATE}) <> 2
    or exists (select 1 from desmoslock_v2.student_join_materials)
    or exists (select 1 from desmoslock_v2.student_device_bindings)
    or exists (select 1 from desmoslock_v2.student_bootstrap_challenges)
    or exists (select 1 from desmoslock_v2.student_bootstrap_limits)
    or exists (select 1 from desmoslock_v2.student_device_proof_state)
    or exists (select 1 from desmoslock_v2.student_protection_events)
  then
    raise exception using errcode = '55000', message = 'restored StudentSession authority verification failed';
  end if;
end
$desmoslock_restore_verification$;
commit;
`;
  return Buffer.concat([
    Buffer.from(preflight, "utf8"),
    restoreSql,
    Buffer.from(verification, "utf8"),
  ]);
}

export function createPostgresBackupAdapter(
  configuration,
  runProcess = runBoundedSubprocess,
) {
  const parsed = parseConfiguration(configuration);
  const verifiedRestorePlans = new Map();
  const profileFor = (alias) => {
    const profile = parsed.profiles[alias];
    if (profile === undefined) throw new Error("POSTGRES_ALIAS_INVALID");
    return profile;
  };

  return {
    async dumpSyntheticData(alias) {
      const profile = profileFor(alias);
      if (profile.environment !== "staging") {
        throw new Error("POSTGRES_EXPORT_SOURCE_INVALID");
      }
      return await runProcess({
        arguments: [
          "--format=custom",
          "--data-only",
          "--no-owner",
          "--no-privileges",
          "--serializable-deferrable",
          ...SYNTHETIC_TABLES.map((table) => `--table=desmoslock_v2.${table}`),
        ],
        environment: {
          ...connectionEnvironment(profile.connection),
          PGTZ: "UTC",
        },
        executable: parsed.executablePaths.pgDump,
        input: null,
        maxOutputBytes: MAX_ARCHIVE_BYTES,
        timeoutMs: 120_000,
      });
    },

    async inspectDump(archive) {
      const verifiedArchive = Buffer.from(archive);
      const inventoryOutput = await runProcess({
        arguments: ["--list"],
        environment: { LANG: "C", LC_ALL: "C" },
        executable: parsed.executablePaths.pgRestore,
        input: Buffer.from(verifiedArchive),
        maxOutputBytes: MAX_TEXT_OUTPUT_BYTES,
        timeoutMs: 30_000,
      });
      const contentOutput = await runProcess({
        arguments: ["--file=-", "--data-only", "--no-owner", "--no-privileges"],
        environment: { LANG: "C", LC_ALL: "C" },
        executable: parsed.executablePaths.pgRestore,
        input: Buffer.from(verifiedArchive),
        maxOutputBytes: MAX_RESTORE_SQL_BYTES,
        timeoutMs: 120_000,
      });
      const inventory = verifiedArchiveInventory(
        parseArchiveInventory(inventoryOutput),
      );
      const verifiedContents = verifySyntheticArchiveContents(contentOutput);
      verifiedRestorePlans.set(
        archiveSha256(verifiedArchive),
        verifiedContents.restoreSql,
      );
      return { ...inventory, fixture: verifiedContents.fixture };
    },

    async observeDatabase(alias) {
      const profile = profileFor(alias);
      const output = await runProcess({
        arguments: [
          "--no-psqlrc",
          "--quiet",
          "--no-align",
          "--tuples-only",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          OBSERVATION_QUERY,
        ],
        environment: connectionEnvironment(profile.connection),
        executable: parsed.executablePaths.psql,
        input: null,
        maxOutputBytes: MAX_TEXT_OUTPUT_BYTES,
        timeoutMs: 30_000,
      });
      return parseObservation(output, profile);
    },

    async restoreVerifiedEmptyDatabase(targetSpecification, archive) {
      const target = parseAtomicRestoreTarget(targetSpecification);
      const profile = profileFor(target.databaseAlias);
      if (profile.environment !== "local") {
        throw new Error("POSTGRES_RESTORE_TARGET_INVALID");
      }
      const archiveKey = archiveSha256(Buffer.from(archive));
      const restoreSql = verifiedRestorePlans.get(archiveKey);
      if (restoreSql === undefined) {
        throw new Error("POSTGRES_RESTORE_INPUT_INVALID");
      }
      verifiedRestorePlans.delete(archiveKey);
      const transactionInput = buildAtomicRestoreInput(
        target,
        restoreSql,
        profile,
      );
      if (transactionInput.byteLength > MAX_RESTORE_SQL_BYTES) {
        throw new Error("POSTGRES_RESTORE_INPUT_INVALID");
      }
      await runProcess({
        arguments: ["--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1"],
        environment: connectionEnvironment(profile.connection),
        executable: parsed.executablePaths.psql,
        input: transactionInput,
        maxOutputBytes: MAX_TEXT_OUTPUT_BYTES,
        timeoutMs: 120_000,
      });
    },
  };
}
