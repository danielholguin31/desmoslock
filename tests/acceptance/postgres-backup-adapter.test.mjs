import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CURRENT_MIGRATION_SET_SHA256,
  CURRENT_MIGRATION_VERSIONS,
  SYNTHETIC_TABLES,
} from "../../scripts/synthetic-backup/operator.mjs";
import {
  createBoundedSubprocessRunner,
  createPostgresBackupAdapter,
  loadPostgresAdapterConfiguration,
} from "../../scripts/synthetic-backup/postgres-adapter.mjs";

const configuration = {
  executablePaths: {
    pgDump: "/operator-tools/pg_dump",
    pgRestore: "/operator-tools/pg_restore",
    psql: "/operator-tools/psql",
  },
  profiles: {
    "local-restore": {
      connection: {
        database: "postgres",
        host: "127.0.0.1",
        password: "synthetic-local-test-password",
        port: "54322",
        sslMode: "disable",
        user: "postgres",
      },
      environment: "local",
      localRestoreMarker: "local-restore-marker-0000000000000000000000000001",
    },
    staging: {
      connection: {
        database: "postgres",
        host: "db.synthetic.invalid",
        password: "synthetic-staging-test-password",
        port: "5432",
        sslMode: "verify-full",
        sslRootCert: "/operator-trust/staging-root-ca.pem",
        user: "postgres.synthetic",
      },
      environment: "staging",
    },
  },
};

const expectedFixture = {
  counts: {
    baselineFixtureState: 1,
    foundationSeed: 1,
    memberships: 6,
    profiles: 6,
    studentSessions: 2,
    tests: 2,
    workspaces: 2,
  },
  dataClass: "synthetic-only",
  digest: "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
  version: "internal-baseline-v2",
};
const RUNTIME_LIFECYCLE_TABLES = Object.freeze([
  "application_session_revocation_cutoffs",
  "application_session_revocations",
  "staff_audit_events",
  "staff_invitations",
  "staff_password_recovery_operations",
]);

function syntheticArchiveSql() {
  return Buffer.from(`
COPY desmoslock_v2.baseline_fixture_state (id, schema_generation, fixture_version, fixture_digest) FROM stdin;
1\t4\tinternal-baseline-v2\tf1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201
\\.
COPY desmoslock_v2.foundation_seed (id, schema_generation, fixture_namespace) FROM stdin;
1\t2\tdesmoslock-v2-foundation
\\.
COPY desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key, status, role_revision, accepted_at, revoked_at, revoked_by_profile_id, revocation_reason_code, updated_at) FROM stdin;
10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000001\towner\tmembership.alpha.owner\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000002\tadmin\tmembership.alpha.admin\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000003\tteacher\tmembership.alpha.teacher\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
10000000-0000-4000-8000-000000000002\t20000000-0000-4000-8000-000000000011\towner\tmembership.beta.owner\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
10000000-0000-4000-8000-000000000002\t20000000-0000-4000-8000-000000000012\tadmin\tmembership.beta.admin\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
10000000-0000-4000-8000-000000000002\t20000000-0000-4000-8000-000000000013\tteacher\tmembership.beta.teacher\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N
\\.
COPY desmoslock_v2.profiles (id, display_name, seed_key, auth_user_id) FROM stdin;
20000000-0000-4000-8000-000000000001\tSynthetic Alpha Owner\tprofile.alpha.owner\t\\N
20000000-0000-4000-8000-000000000002\tSynthetic Alpha Admin\tprofile.alpha.admin\t\\N
20000000-0000-4000-8000-000000000003\tSynthetic Alpha Teacher\tprofile.alpha.teacher\t\\N
20000000-0000-4000-8000-000000000011\tSynthetic Beta Owner\tprofile.beta.owner\t\\N
20000000-0000-4000-8000-000000000012\tSynthetic Beta Admin\tprofile.beta.admin\t\\N
20000000-0000-4000-8000-000000000013\tSynthetic Beta Teacher\tprofile.beta.teacher\t\\N
\\.
COPY desmoslock_v2.student_sessions (id, workspace_id, test_id, state, seed_key) FROM stdin;
40000000-0000-4000-8000-000000000001\t10000000-0000-4000-8000-000000000001\t30000000-0000-4000-8000-000000000001\tcreated\tsession.alpha.algebra
40000000-0000-4000-8000-000000000002\t10000000-0000-4000-8000-000000000002\t30000000-0000-4000-8000-000000000002\tcreated\tsession.beta.algebra
\\.
COPY desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) FROM stdin;
30000000-0000-4000-8000-000000000001\t10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000003\tSynthetic Alpha Algebra Test\ttest.alpha.algebra\tdraft\t1\t2000-01-01 00:00:00+00\t\\N\t\\N\t\\N
30000000-0000-4000-8000-000000000002\t10000000-0000-4000-8000-000000000002\t20000000-0000-4000-8000-000000000013\tSynthetic Beta Algebra Test\ttest.beta.algebra\tdraft\t1\t2000-01-01 00:00:00+00\t\\N\t\\N\t\\N
\\.
COPY desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key, settings_revision) FROM stdin;
10000000-0000-4000-8000-000000000001\tschool\tsynthetic-alpha\tSynthetic Alpha School\tschool.alpha\t1
10000000-0000-4000-8000-000000000002\tschool\tsynthetic-beta\tSynthetic Beta School\tschool.beta\t1
\\.
`);
}

function archiveWithRowValue(sql, row, columnIndex, value) {
  const columns = row.split("\t");
  assert.ok(columnIndex >= 0 && columnIndex < columns.length);
  assert.notEqual(columns[columnIndex], value);
  columns[columnIndex] = value;
  assert.equal(sql.includes(row), true);
  const mutated = sql.replace(row, columns.join("\t"));
  assert.notEqual(mutated, sql);
  return mutated;
}

function createFakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.directKills = [];
  child.kill = (signal) => {
    child.directKills.push(signal);
    return true;
  };
  child.unrefCount = 0;
  child.unref = () => {
    child.unrefCount += 1;
  };
  return child;
}

test("bounded subprocess timeout kills the detached process group and returns without close", async () => {
  const child = createFakeChild();
  const groupKills = [];
  let spawnOptions;
  const runner = createBoundedSubprocessRunner({
    killProcess(pid, signal) {
      groupKills.push([pid, signal]);
    },
    platform: "darwin",
    spawnProcess(_executable, _arguments, options) {
      spawnOptions = options;
      return child;
    },
  });
  const startedAt = Date.now();

  await assert.rejects(
    runner({
      arguments: ["--version"],
      environment: { LANG: "C" },
      executable: "/operator-tools/psql",
      input: null,
      maxOutputBytes: 1024,
      timeoutMs: 20,
    }),
    /POSTGRES_SUBPROCESS_FAILED/,
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(groupKills, [[-4321, "SIGKILL"]]);
  assert.deepEqual(child.directKills, []);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCount, 1);
});

test("bounded subprocess output overflow aborts without waiting for close", async () => {
  const child = createFakeChild(5432);
  const groupKills = [];
  const runner = createBoundedSubprocessRunner({
    killProcess(pid, signal) {
      groupKills.push([pid, signal]);
    },
    platform: "darwin",
    spawnProcess() {
      queueMicrotask(() => child.stdout.write(Buffer.alloc(5)));
      return child;
    },
  });

  await assert.rejects(
    runner({
      arguments: [],
      environment: { LANG: "C" },
      executable: "/operator-tools/pg_restore",
      input: Buffer.from("archive"),
      maxOutputBytes: 4,
      timeoutMs: 1_000,
    }),
    /POSTGRES_SUBPROCESS_FAILED/,
  );
  assert.deepEqual(groupKills, [[-5432, "SIGKILL"]]);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.unrefCount, 1);
});

test("bounded subprocess falls back to direct kill and preserves successful output", async (context) => {
  await context.test("group kill fallback", async () => {
    const child = createFakeChild(6543);
    const runner = createBoundedSubprocessRunner({
      killProcess() {
        throw new Error("private native kill failure");
      },
      platform: "darwin",
      spawnProcess() {
        return child;
      },
    });
    await assert.rejects(
      runner({
        arguments: [],
        environment: { LANG: "C" },
        executable: "/operator-tools/psql",
        input: null,
        maxOutputBytes: 1024,
        timeoutMs: 20,
      }),
      /POSTGRES_SUBPROCESS_FAILED/,
    );
    assert.deepEqual(child.directKills, ["SIGKILL"]);
  });

  await context.test("success", async () => {
    const child = createFakeChild(7654);
    const groupKills = [];
    const runner = createBoundedSubprocessRunner({
      killProcess(pid, signal) {
        groupKills.push([pid, signal]);
      },
      platform: "darwin",
      spawnProcess() {
        queueMicrotask(() => {
          child.stdout.write(Buffer.from("bounded output"));
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    assert.deepEqual(
      await runner({
        arguments: [],
        environment: { LANG: "C" },
        executable: "/operator-tools/psql",
        input: null,
        maxOutputBytes: 1024,
        timeoutMs: 1_000,
      }),
      Buffer.from("bounded output"),
    );
    assert.deepEqual(groupKills, []);
    assert.equal(child.unrefCount, 0);
  });
});

test("operator process configuration reads only the selected command profile", () => {
  const stagingEnvironment = new Proxy(
    {
      DESMOSLOCK_PG_DUMP_PATH: "/operator-tools/pg_dump",
      DESMOSLOCK_PG_RESTORE_PATH: "/operator-tools/pg_restore",
      DESMOSLOCK_PSQL_PATH: "/operator-tools/psql",
      DESMOSLOCK_STAGING_PGDATABASE: "postgres",
      DESMOSLOCK_STAGING_PGHOST: "db.synthetic.invalid",
      DESMOSLOCK_STAGING_PGPASSWORD: "synthetic-staging-test-password",
      DESMOSLOCK_STAGING_PGPORT: "5432",
      DESMOSLOCK_STAGING_PGSSLROOTCERT: "/operator-trust/staging-root-ca.pem",
      DESMOSLOCK_STAGING_PGUSER: "postgres.synthetic",
      UNRELATED_CREDENTIAL: "must-not-be-read",
    },
    {
      get(target, property) {
        if (
          typeof property === "string" &&
          property.startsWith("DESMOSLOCK_LOCAL_RESTORE_")
        ) {
          throw new Error("local restore configuration must not be read");
        }
        return Reflect.get(target, property);
      },
    },
  );
  assert.deepEqual(
    loadPostgresAdapterConfiguration(stagingEnvironment, "staging"),
    {
      executablePaths: configuration.executablePaths,
      profiles: { staging: configuration.profiles.staging },
    },
  );

  const localEnvironment = new Proxy(
    {
      DESMOSLOCK_LOCAL_RESTORE_PGDATABASE: "postgres",
      DESMOSLOCK_LOCAL_RESTORE_PGHOST: "127.0.0.1",
      DESMOSLOCK_LOCAL_RESTORE_PGPASSWORD: "synthetic-local-test-password",
      DESMOSLOCK_LOCAL_RESTORE_PGPORT: "54322",
      DESMOSLOCK_LOCAL_RESTORE_PGUSER: "postgres",
      DESMOSLOCK_LOCAL_RESTORE_MARKER:
        "local-restore-marker-0000000000000000000000000001",
      DESMOSLOCK_PG_RESTORE_PATH: "/operator-tools/pg_restore",
      DESMOSLOCK_PSQL_PATH: "/operator-tools/psql",
      UNRELATED_CREDENTIAL: "must-not-be-read",
    },
    {
      get(target, property) {
        if (
          typeof property === "string" &&
          (property.startsWith("DESMOSLOCK_STAGING_") ||
            property === "DESMOSLOCK_PG_DUMP_PATH")
        ) {
          throw new Error("staging configuration must not be read");
        }
        return Reflect.get(target, property);
      },
    },
  );
  assert.deepEqual(
    loadPostgresAdapterConfiguration(localEnvironment, "local-restore"),
    {
      executablePaths: {
        pgRestore: "/operator-tools/pg_restore",
        psql: "/operator-tools/psql",
      },
      profiles: { "local-restore": configuration.profiles["local-restore"] },
    },
  );

  assert.throws(
    () => loadPostgresAdapterConfiguration({}, "staging"),
    /POSTGRES_ADAPTER_CONFIGURATION_INVALID/,
  );
  for (const sslRootCert of [undefined, "relative/root-ca.pem", "/"]) {
    assert.throws(
      () =>
        loadPostgresAdapterConfiguration(
          {
            DESMOSLOCK_PG_DUMP_PATH: "/operator-tools/pg_dump",
            DESMOSLOCK_PG_RESTORE_PATH: "/operator-tools/pg_restore",
            DESMOSLOCK_PSQL_PATH: "/operator-tools/psql",
            DESMOSLOCK_STAGING_PGDATABASE: "postgres",
            DESMOSLOCK_STAGING_PGHOST: "db.synthetic.invalid",
            DESMOSLOCK_STAGING_PGPASSWORD: "synthetic-staging-test-password",
            DESMOSLOCK_STAGING_PGPORT: "5432",
            ...(sslRootCert === undefined
              ? {}
              : { DESMOSLOCK_STAGING_PGSSLROOTCERT: sslRootCert }),
            DESMOSLOCK_STAGING_PGUSER: "postgres.synthetic",
          },
          "staging",
        ),
      /POSTGRES_ADAPTER_CONFIGURATION_INVALID/,
    );
  }
  assert.throws(
    () => loadPostgresAdapterConfiguration({}, "unknown"),
    /POSTGRES_ADAPTER_CONFIGURATION_INVALID/,
  );
});

test("operator CLI emits only stable refusal codes when process configuration is unavailable", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/synthetic-backup/run.mjs", import.meta.url),
      ),
      "export",
      "/tmp",
      "staging-baseline",
      "staging-instance-001",
    ],
    {
      encoding: "utf8",
      env: {
        DESMOSLOCK_STAGING_PGPASSWORD:
          "credential-shaped-value-that-must-not-be-logged",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "OPERATOR_FAILED",
    status: "refused",
  });
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /credential-shaped-value-that-must-not-be-logged/,
  );
});

test("Postgres adapter keeps credentials out of argv and exposes only symbolic database observations", async () => {
  const calls = [];
  const archive = Buffer.from("synthetic pg custom archive");
  let archiveRenderCount = 0;
  const runner = async (request) => {
    calls.push(request);
    if (request.executable.endsWith("/psql")) {
      return Buffer.from(
        JSON.stringify({
          applicationState: "synthetic-baseline",
          databaseName: "postgres",
          fixture: {
            counts: {
              baselineFixtureState: 1,
              foundationSeed: 1,
              memberships: 6,
              profiles: 6,
              studentSessions: 2,
              tests: 2,
              workspaces: 2,
            },
            digest:
              "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
            valid: true,
            version: "internal-baseline-v2",
          },
          migrationVersions: [...CURRENT_MIGRATION_VERSIONS],
          migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
          localRestoreMarker: null,
          schemaGeneration: 4,
          systemIdentifier: "7512345678901234567",
        }),
      );
    }
    if (
      request.executable.endsWith("/pg_restore") &&
      request.arguments.includes("--list")
    ) {
      return Buffer.from(
        SYNTHETIC_TABLES.map(
          (table, index) =>
            `${index + 1}; 0 ${index + 100} TABLE DATA desmoslock_v2 ${table} postgres`,
        ).join("\n"),
      );
    }
    if (request.executable.endsWith("/pg_restore")) {
      archiveRenderCount += 1;
      if (archiveRenderCount > 1) {
        return Buffer.from("COMMIT;\n");
      }
      return syntheticArchiveSql();
    }
    if (request.executable.endsWith("/pg_dump")) return archive;
    return Buffer.alloc(0);
  };
  const adapter = createPostgresBackupAdapter(configuration, runner);

  assert.deepEqual(await adapter.observeDatabase("staging"), {
    applicationState: "synthetic-baseline",
    environment: "staging",
    fixture: expectedFixture,
    identity: "7512345678901234567",
    migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
    schemaGeneration: 4,
  });
  assert.deepEqual(await adapter.dumpSyntheticData("staging"), archive);
  assert.deepEqual(await adapter.inspectDump(archive), {
    entries: SYNTHETIC_TABLES.map((table) => ({
      kind: "TABLE DATA",
      name: table,
      schema: "desmoslock_v2",
    })),
    fixture: expectedFixture,
    format: "postgres-custom-data-only",
  });
  assert.deepEqual(SYNTHETIC_TABLES, [
    "baseline_fixture_state",
    "foundation_seed",
    "memberships",
    "profiles",
    "student_sessions",
    "tests",
    "workspaces",
  ]);
  await adapter.restoreVerifiedEmptyDatabase(
    {
      databaseAlias: "local-restore",
      expectedDatabaseIdentity: "7512345678901234568",
      expectedMigrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
      expectedSchemaGeneration: 4,
      sourceDatabaseIdentity: "7512345678901234567",
    },
    archive,
  );

  assert.equal(archiveRenderCount, 1);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].executable, "/operator-tools/psql");
  assert.equal(calls[1].executable, "/operator-tools/pg_dump");
  assert.equal(calls[2].executable, "/operator-tools/pg_restore");
  assert.equal(calls[3].executable, "/operator-tools/pg_restore");
  assert.equal(calls[4].executable, "/operator-tools/psql");
  assert.equal(calls[1].arguments.includes("--data-only"), true);
  assert.equal(calls[1].arguments.includes("--serializable-deferrable"), true);
  assert.deepEqual(
    calls.map((call) => call.environment.PGTZ),
    [undefined, "UTC", undefined, undefined, undefined],
  );
  assert.deepEqual(
    calls[1].arguments.filter((argument) => argument.startsWith("--table=")),
    SYNTHETIC_TABLES.map((table) => `--table=desmoslock_v2.${table}`),
  );
  for (const call of calls) {
    const argumentsText = JSON.stringify(call.arguments);
    assert.doesNotMatch(
      argumentsText,
      /synthetic-(?:local|staging)-test-password/,
    );
    assert.equal(call.environment.LANG, "C");
    assert.equal(call.environment.LC_ALL, "C");
  }
  assert.equal(
    calls[0].environment.PGPASSWORD,
    "synthetic-staging-test-password",
  );
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.environment.PGSSLMODE, "verify-full");
    assert.equal(
      call.environment.PGSSLROOTCERT,
      "/operator-trust/staging-root-ca.pem",
    );
  }
  assert.equal(calls[2].environment.PGPASSWORD, undefined);
  assert.deepEqual(calls[3].input, archive);
  assert.equal(
    calls[4].environment.PGPASSWORD,
    "synthetic-local-test-password",
  );
  assert.equal(calls[4].environment.PGSSLMODE, "disable");
  assert.equal(calls[4].environment.PGSSLROOTCERT, undefined);
  const observationQuery = calls[0].arguments.at(-1);
  const transactionInput = calls[4].input.toString("utf8");
  const testCopyBlock = syntheticArchiveSql()
    .toString("utf8")
    .match(/COPY desmoslock_v2\.tests [\s\S]*?\n\\\.\n/u)?.[0];
  assert.ok(testCopyBlock);
  assert.equal(transactionInput.includes(testCopyBlock), true);
  for (const table of RUNTIME_LIFECYCLE_TABLES) {
    assert.match(
      observationQuery,
      new RegExp(
        `count\\(\\*\\) from desmoslock_v2\\.${table}\\)\\:\\:integer as ${table}`,
      ),
    );
    assert.equal(
      observationQuery.match(new RegExp(`counts\\.${table} = 0`, "g"))?.length,
      2,
    );
    assert.match(
      transactionInput,
      new RegExp(`exists \\(select 1 from desmoslock_v2\\.${table}\\)`),
    );
    assert.equal(
      calls[1].arguments.includes(`--table=desmoslock_v2.${table}`),
      false,
    );
    assert.doesNotMatch(
      transactionInput,
      new RegExp(`COPY desmoslock_v2\\.${table}`, "i"),
    );
  }
  assert.match(transactionInput, /begin isolation level serializable/i);
  assert.match(
    transactionInput,
    /current_database\(\)[\s\S]*postgres[\s\S]*local-restore-marker-0000000000000000000000000001[\s\S]*copy desmoslock_v2\.foundation_seed/i,
  );
  assert.match(
    transactionInput,
    new RegExp(
      `${CURRENT_MIGRATION_SET_SHA256}[\\s\\S]*copy desmoslock_v2\\.foundation_seed`,
      "i",
    ),
  );
  assert.equal(
    transactionInput.includes(
      `array[${CURRENT_MIGRATION_VERSIONS.map((version) => `'${version}'`).join(", ")}]::text[]`,
    ),
    true,
  );
  assert.match(transactionInput, /7512345678901234568/);
  assert.match(
    transactionInput,
    /restore target is not empty[\s\S]*copy desmoslock_v2\.workspaces[\s\S]*restored fixture verification failed/i,
  );
  assert.match(
    transactionInput,
    /restored fixture verification failed[\s\S]*restored foundation verification failed[\s\S]*commit/i,
  );
  assert.doesNotMatch(
    transactionInput,
    /synthetic-(?:local|staging)-test-password/,
  );
});

test("Postgres adapter refuses export from the local restore profile", async () => {
  const localConfiguration = {
    executablePaths: {
      pgRestore: "/operator-tools/pg_restore",
      psql: "/operator-tools/psql",
    },
    profiles: { "local-restore": configuration.profiles["local-restore"] },
  };
  const adapter = createPostgresBackupAdapter(localConfiguration, async () => {
    throw new Error("the subprocess must not run");
  });

  await assert.rejects(
    adapter.dumpSyntheticData("local-restore"),
    /POSTGRES_EXPORT_SOURCE_INVALID/,
  );
});

test("Postgres adapter refuses a generation-3 restore target before execution", async () => {
  const localConfiguration = {
    executablePaths: {
      pgRestore: "/operator-tools/pg_restore",
      psql: "/operator-tools/psql",
    },
    profiles: { "local-restore": configuration.profiles["local-restore"] },
  };
  const adapter = createPostgresBackupAdapter(localConfiguration, async () => {
    throw new Error("the subprocess must not run");
  });

  await assert.rejects(
    adapter.restoreVerifiedEmptyDatabase(
      {
        databaseAlias: "local-restore",
        expectedDatabaseIdentity: "7512345678901234568",
        expectedMigrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
        expectedSchemaGeneration: 3,
        sourceDatabaseIdentity: "7512345678901234567",
      },
      Buffer.from("uninspected archive"),
    ),
    /POSTGRES_RESTORE_TARGET_INVALID/,
  );
});

test("Postgres observation refuses migration drift and unattested local targets", async () => {
  const basePayload = {
    applicationState: "empty",
    databaseName: "postgres",
    fixture: null,
    localRestoreMarker: "local-restore-marker-0000000000000000000000000001",
    migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
    migrationVersions: [...CURRENT_MIGRATION_VERSIONS],
    schemaGeneration: 4,
    systemIdentifier: "7512345678901234568",
  };
  const localConfiguration = {
    executablePaths: {
      pgRestore: "/operator-tools/pg_restore",
      psql: "/operator-tools/psql",
    },
    profiles: { "local-restore": configuration.profiles["local-restore"] },
  };

  for (const mutation of [
    { migrationSetSha256: "0".repeat(64) },
    { migrationVersions: CURRENT_MIGRATION_VERSIONS.slice(0, -1) },
    {
      migrationVersions: [...CURRENT_MIGRATION_VERSIONS, "20990101000000"],
    },
    { schemaGeneration: 3 },
    { localRestoreMarker: null },
    { localRestoreMarker: "wrong-local-restore-marker-000000000000000000000" },
    { databaseName: "other_database" },
  ]) {
    const adapter = createPostgresBackupAdapter(localConfiguration, async () =>
      Buffer.from(JSON.stringify({ ...basePayload, ...mutation })),
    );
    await assert.rejects(
      adapter.observeDatabase("local-restore"),
      /POSTGRES_OBSERVATION_INVALID/,
    );
  }
});

test("Postgres adapter rejects hostile archive contents before any database connection", async (context) => {
  const validSql = syntheticArchiveSql().toString("utf8");
  const foundationBlock = [
    "COPY desmoslock_v2.foundation_seed (id, schema_generation, fixture_namespace) FROM stdin;",
    "1\t2\tdesmoslock-v2-foundation",
    "\\.",
    "",
  ].join("\n");
  const baselineRow =
    "1\t4\tinternal-baseline-v2\tf1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201";
  const membershipHeader =
    "COPY desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key, status, role_revision, accepted_at, revoked_at, revoked_by_profile_id, revocation_reason_code, updated_at) FROM stdin;";
  const membershipRow =
    "10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000001\towner\tmembership.alpha.owner\tactive\t1\t\\N\t\\N\t\\N\t\\N\t\\N";
  const profileHeader =
    "COPY desmoslock_v2.profiles (id, display_name, seed_key, auth_user_id) FROM stdin;";
  const profileRow =
    "20000000-0000-4000-8000-000000000001\tSynthetic Alpha Owner\tprofile.alpha.owner\t\\N";
  const workspaceHeader =
    "COPY desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key, settings_revision) FROM stdin;";
  const workspaceRow =
    "10000000-0000-4000-8000-000000000001\tschool\tsynthetic-alpha\tSynthetic Alpha School\tschool.alpha\t1";
  const testHeader =
    "COPY desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) FROM stdin;";
  const testRow =
    "30000000-0000-4000-8000-000000000001\t10000000-0000-4000-8000-000000000001\t20000000-0000-4000-8000-000000000003\tSynthetic Alpha Algebra Test\ttest.alpha.algebra\tdraft\t1\t2000-01-01 00:00:00+00\t\\N\t\\N\t\\N";
  const hostileArchives = {
    "altered foundation marker": validSql.replace(
      "desmoslock-v2-foundation",
      "altered-foundation",
    ),
    "altered pinned digest": validSql.replace(
      "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
      "0".repeat(64),
    ),
    "stale fixture generation": archiveWithRowValue(
      validSql,
      baselineRow,
      1,
      "3",
    ),
    "stale fixture version": archiveWithRowValue(
      validSql,
      baselineRow,
      2,
      "internal-baseline-v1",
    ),
    "duplicate COPY block": `${validSql}${foundationBlock}`,
    "extra fixture row": validSql.replace(
      `${baselineRow}\n\\.`,
      `${baselineRow}\n${baselineRow}\n\\.`,
    ),
    "malformed COPY block": validSql.replace(
      "COPY desmoslock_v2.workspaces",
      "COPY public.workspaces",
    ),
    "stale workspace COPY layout": validSql
      .replace(
        workspaceHeader,
        workspaceHeader.replace(", settings_revision", ""),
      )
      .replace("school.alpha\t1\n", "school.alpha\n")
      .replace("school.beta\t1\n", "school.beta\n"),
    "extra workspace COPY column": validSql.replace(
      workspaceHeader,
      workspaceHeader.replace(
        "settings_revision)",
        "settings_revision, unexpected)",
      ),
    ),
    "reordered workspace COPY columns": validSql.replace(
      workspaceHeader,
      workspaceHeader.replace(
        "seed_key, settings_revision",
        "settings_revision, seed_key",
      ),
    ),
    "missing workspace revision value": validSql.replace(
      workspaceRow,
      workspaceRow.slice(0, -2),
    ),
    "extra workspace row value": validSql.replace(
      workspaceRow,
      `${workspaceRow}\t1`,
    ),
    ...Object.fromEntries(
      ["\\N", "NULL", "", "0", "2", "01", "1.0", "+1", "1e0", " "].map(
        (value, index) => [
          `noncanonical workspace revision ${index + 1}`,
          archiveWithRowValue(validSql, workspaceRow, 5, value),
        ],
      ),
    ),
    "stale five-column Test COPY layout": validSql
      .replace(
        testHeader,
        "COPY desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key) FROM stdin;",
      )
      .replaceAll("\tdraft\t1\t2000-01-01 00:00:00+00\t\\N\t\\N\t\\N\n", "\n"),
    "extra Test COPY column": validSql.replace(
      testHeader,
      testHeader.replace(
        "creation_request_id)",
        "creation_request_id, unexpected)",
      ),
    ),
    "reordered Test COPY columns": validSql.replace(
      testHeader,
      testHeader.replace("lifecycle, revision", "revision, lifecycle"),
    ),
    "missing Test row value": validSql.replace(testRow, testRow.slice(0, -3)),
    "extra Test row value": validSql.replace(testRow, `${testRow}\t\\N`),
    ...Object.fromEntries(
      ["\\N", "NULL", "", "open", "ended", "unknown", "Draft"].map(
        (value, index) => [
          `nonpristine Test lifecycle ${index + 1}`,
          archiveWithRowValue(validSql, testRow, 5, value),
        ],
      ),
    ),
    ...Object.fromEntries(
      ["\\N", "NULL", "", "0", "2", "01", "1.0", "+1", "1e0", " "].map(
        (value, index) => [
          `noncanonical Test revision ${index + 1}`,
          archiveWithRowValue(validSql, testRow, 6, value),
        ],
      ),
    ),
    ...Object.fromEntries(
      [
        "\\N",
        "NULL",
        "",
        "2000-01-01 00:00:01+00",
        "2000-01-01T00:00:00.000000Z",
        "2000-01-01 00:00:00.000000+00",
        "1999-12-31 19:00:00-05",
        "2000-01-01 09:00:00+09",
        "2000-01-01 00:00:00+00:00",
        "2000-01-01 00:00:00",
        "2000-01-01 00:00:00.000001+00",
      ].map((value, index) => [
        `noncanonical Test created_at ${index + 1}`,
        archiveWithRowValue(validSql, testRow, 7, value),
      ]),
    ),
    ...Object.fromEntries(
      [8, 9, 10].flatMap((column) =>
        [
          "NULL",
          "",
          "2000-01-01 00:00:00+00",
          "a1000000-0000-4000-8000-000000000001",
        ].map((value, index) => [
          `nonnull Test metadata column ${column} value ${index + 1}`,
          archiveWithRowValue(validSql, testRow, column, value),
        ]),
      ),
    ),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((column) => [
        `null marker in required Test field ${column}`,
        archiveWithRowValue(validSql, testRow, column, "\\N"),
      ]),
    ),
    "stale membership COPY layout": validSql.replace(
      membershipHeader,
      "COPY desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key) FROM stdin;",
    ),
    "extra membership COPY column": validSql.replace(
      membershipHeader,
      membershipHeader.replace("updated_at)", "updated_at, unexpected)"),
    ),
    "reordered membership COPY columns": validSql.replace(
      membershipHeader,
      membershipHeader.replace(
        "status, role_revision",
        "role_revision, status",
      ),
    ),
    "stale profile COPY layout": validSql.replace(
      profileHeader,
      "COPY desmoslock_v2.profiles (id, display_name, seed_key) FROM stdin;",
    ),
    "extra profile COPY column": validSql.replace(
      profileHeader,
      profileHeader.replace("auth_user_id)", "auth_user_id, unexpected)"),
    ),
    "reordered profile COPY columns": validSql.replace(
      profileHeader,
      profileHeader.replace("display_name, seed_key", "seed_key, display_name"),
    ),
    "bound seeded profile": archiveWithRowValue(
      validSql,
      profileRow,
      3,
      "a1000000-0000-4000-8000-000000000001",
    ),
    "literal NULL profile binding": archiveWithRowValue(
      validSql,
      profileRow,
      3,
      "NULL",
    ),
    "empty profile binding": archiveWithRowValue(validSql, profileRow, 3, ""),
    "null marker in required profile field": archiveWithRowValue(
      validSql,
      profileRow,
      1,
      "\\N",
    ),
    "null marker in seeded profile key": archiveWithRowValue(
      validSql,
      profileRow,
      2,
      "\\N",
    ),
    "inactive seeded membership": archiveWithRowValue(
      validSql,
      membershipRow,
      4,
      "revoked",
    ),
    "advanced seeded membership revision": archiveWithRowValue(
      validSql,
      membershipRow,
      5,
      "2",
    ),
    "accepted seeded membership": archiveWithRowValue(
      validSql,
      membershipRow,
      6,
      "2026-09-03 12:00:00+00",
    ),
    "revoked seeded membership": archiveWithRowValue(
      validSql,
      membershipRow,
      7,
      "2026-09-03 12:00:00+00",
    ),
    "seeded membership with revoker": archiveWithRowValue(
      validSql,
      membershipRow,
      8,
      "20000000-0000-4000-8000-000000000001",
    ),
    "seeded membership with revocation reason": archiveWithRowValue(
      validSql,
      membershipRow,
      9,
      "owner_action",
    ),
    "updated seeded membership": archiveWithRowValue(
      validSql,
      membershipRow,
      10,
      "2026-09-03 12:00:00+00",
    ),
    "literal NULL membership lifecycle value": archiveWithRowValue(
      validSql,
      membershipRow,
      6,
      "NULL",
    ),
    "empty membership lifecycle value": archiveWithRowValue(
      validSql,
      membershipRow,
      6,
      "",
    ),
    "null marker in required membership state": archiveWithRowValue(
      validSql,
      membershipRow,
      4,
      "\\N",
    ),
    "null marker in membership revision": archiveWithRowValue(
      validSql,
      membershipRow,
      5,
      "\\N",
    ),
    "null marker in seeded membership key": archiveWithRowValue(
      validSql,
      membershipRow,
      3,
      "\\N",
    ),
    "missing foundation marker": validSql.replace(foundationBlock, ""),
    "transaction escape": `COMMIT;\n${validSql}`,
    "privileged DDL": `${validSql}\nCREATE TABLE public.escape (id integer);\n`,
    "procedural SQL": `${validSql}\nDO $$ begin null; end $$;\n`,
    "psql connection switch": `\\connect postgres\n${validSql}`,
    "unexpected session command": `SET ROLE postgres;\n${validSql}`,
    ...Object.fromEntries(
      RUNTIME_LIFECYCLE_TABLES.map((table) => [
        `${table} COPY block`,
        `${validSql}COPY desmoslock_v2.${table} (id) FROM stdin;\nruntime-row\n\\.\n`,
      ]),
    ),
  };

  for (const [label, archiveSql] of Object.entries(hostileArchives)) {
    assert.notEqual(archiveSql, validSql, label);
    await context.test(label, async () => {
      const calls = [];
      const adapter = createPostgresBackupAdapter(
        configuration,
        async (request) => {
          calls.push(request);
          assert.equal(request.executable, "/operator-tools/pg_restore");
          assert.equal(request.environment.PGPASSWORD, undefined);
          if (request.arguments.includes("--list")) {
            return Buffer.from(
              SYNTHETIC_TABLES.map(
                (table, index) =>
                  `${index + 1}; 0 ${index + 100} TABLE DATA desmoslock_v2 ${table} postgres`,
              ).join("\n"),
            );
          }
          return Buffer.from(archiveSql);
        },
      );

      await assert.rejects(
        adapter.inspectDump(Buffer.from("hostile archive")),
        /POSTGRES_ARCHIVE_CONTENT_INVALID/,
      );
      assert.equal(calls.length, 2);
    });
  }
});

test("Postgres adapter rejects every lifecycle table in the archive inventory", async (context) => {
  for (const lifecycleTable of RUNTIME_LIFECYCLE_TABLES) {
    await context.test(lifecycleTable, async () => {
      const adapter = createPostgresBackupAdapter(
        configuration,
        async (request) => {
          if (request.arguments.includes("--list")) {
            return Buffer.from(
              [
                ...SYNTHETIC_TABLES.map(
                  (table, index) =>
                    `${index + 1}; 0 ${index + 100} TABLE DATA desmoslock_v2 ${table} postgres`,
                ),
                `8; 0 108 TABLE DATA desmoslock_v2 ${lifecycleTable} postgres`,
              ].join("\n"),
            );
          }
          return syntheticArchiveSql();
        },
      );

      await assert.rejects(
        adapter.inspectDump(Buffer.from(`inventory-${lifecycleTable}`)),
        /POSTGRES_ARCHIVE_CONTENT_INVALID/,
      );
    });
  }
});

test("archive readiness distinguishes rows that collide under delimiter joining", async (context) => {
  const originalRow =
    "10000000-0000-4000-8000-000000000001\tschool\tsynthetic-alpha\tSynthetic Alpha School\tschool.alpha";
  const collidingRows = [
    ["school", "school.alpha", "id", "synthetic|alpha", "School"],
    ["school", "school.alpha", "id", "synthetic", "alpha|School"],
  ];
  assert.equal(collidingRows[0].join("|"), collidingRows[1].join("|"));

  for (const [index, parts] of collidingRows.entries()) {
    await context.test(`collision variant ${index + 1}`, async () => {
      const replacementRow = [
        "10000000-0000-4000-8000-000000000001",
        "school",
        parts[3],
        parts[4],
        "school.alpha",
      ].join("\t");
      const adapter = createPostgresBackupAdapter(
        configuration,
        async (request) => {
          if (request.arguments.includes("--list")) {
            return Buffer.from(
              SYNTHETIC_TABLES.map(
                (table, tableIndex) =>
                  `${tableIndex + 1}; 0 ${tableIndex + 100} TABLE DATA desmoslock_v2 ${table} postgres`,
              ).join("\n"),
            );
          }
          return Buffer.from(
            syntheticArchiveSql()
              .toString("utf8")
              .replace(originalRow, replacementRow),
          );
        },
      );
      await assert.rejects(
        adapter.inspectDump(Buffer.from(`collision-${index + 1}`)),
        /POSTGRES_ARCHIVE_CONTENT_INVALID/,
      );
    });
  }
});
