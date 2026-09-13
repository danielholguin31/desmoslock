import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_MIGRATION_FILES } from "../../scripts/synthetic-backup/operator.mjs";
import "./staff-suite-diagnostics-reporter.test.mjs";
import {
  boundedCommand,
  captureBackendCatalogPrefix,
  connectionFromStatus,
  FixtureFailure,
  isExpectedInvalidRootCertificate,
  materializeSourceFixture,
  nativeClientWrapper,
  requireDisposableCi,
  requireRestoredWorkerReceipt,
  runStaffSuite,
  sourceConfiguration,
  StaffSuiteCommandFailure,
  withRoundtripCleanup,
  withSessionTimezone,
} from "./synthetic-backup-runtime.mjs";

const node = process.execPath;
const failure = (code) => (error) =>
  error instanceof FixtureFailure &&
  error.code === code &&
  error.message === code;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const catalogRoot = path.join(repositoryRoot, "scripts/backend-catalog");
const catalogCli = path.join(repositoryRoot, "node_modules/.bin/supabase");
const catalogCommit = "7e351815" + "0".repeat(32);
const catalogRoles = [
  "anon",
  "authenticated",
  "service_role",
  "supabase_admin",
];

// Artificial shape controls only: these rows are not a PostgreSQL observation.
// The real pure validator checks the capture boundary using the pinned source
// inventory, without starting a database or invoking an application routine.
async function artificialCatalogProjection() {
  const expectations = JSON.parse(
    await fs.readFile(
      path.join(catalogRoot, "catalog-source-expectations.json"),
    ),
  );
  const records = [];
  const add = (kind, id, data) => records.push({ kind, id, data });
  const object = (kind, id, data) => {
    add(kind, id, data);
    add("acl", [kind, ...id], { is_null: false, entries: [] });
    for (const role of [...catalogRoles, "public"])
      add("effective_acl", [kind, ...id, role], {
        privileges: [],
        grant_options: [],
      });
  };
  add("context", ["desmoslock_v2"], {
    server_version_num: 170006,
    database: "postgres",
    query_role: "supabase_admin",
    session_role: "supabase_admin",
    search_path: "pg_catalog",
    read_only: true,
    required_roles_present: true,
    default_acl_roles: ["supabase_admin"],
  });
  for (const role of catalogRoles)
    add("role", [role], {
      effective_probe: true,
      superuser: role === "supabase_admin",
      inherit: true,
      bypass_rls: role === "service_role",
      inherits_roles: [],
      can_set_roles: [],
    });
  object("schema", ["desmoslock_v2"], { owner: "supabase_admin" });
  for (const table of expectations.tables)
    object("relation", ["desmoslock_v2", table.name], {
      kind: "r",
      owner: "supabase_admin",
      persistence: "p",
      is_partition: false,
      rls: true,
      force_rls: false,
      replica_identity: "d",
      has_rules: false,
      has_triggers: false,
      parents: [],
      partition_hash: null,
      options_hash: "0".repeat(64),
    });
  for (const routine of expectations.functions)
    object(
      "routine",
      [
        "desmoslock_v2",
        routine.name,
        routine.name === "internal_frame_text" ? "pg_catalog._text" : "",
      ],
      {
        kind: "f",
        owner: "supabase_admin",
        language: "sql",
        return_type: "pg_catalog.text",
        returns_set: false,
        all_argument_types: [],
        argument_names: [],
        argument_modes: [],
        default_count: 0,
        security_definer: false,
        volatility: "s",
        strict: false,
        leakproof: false,
        parallel: "u",
        body_hash: routine.sourceDollarQuotedBodySha256,
        binary_hash: null,
        has_sql_body: false,
        definition_hash: "1".repeat(64),
        config_names: [],
        config_hash: "0".repeat(64),
        sole_empty_search_path: false,
      },
    );
  return {
    format_version: 1,
    schema: "desmoslock_v2",
    overflow: false,
    records,
  };
}

async function catalogHarness(t, rawProjection) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "catalog-control-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projection = await artificialCatalogProjection();
  const raw = rawProjection ?? Buffer.from(`${JSON.stringify(projection)}\n`);
  const calls = [];
  const capture = {
    repositoryRoot,
    workspaceDirectory: directory,
    cli: catalogCli,
    run: async (executable, args, options) => {
      calls.push({ operation: "run", executable, args, options });
      if (executable === "/usr/bin/git")
        return Buffer.from(`${catalogCommit}\n`);
      if (executable === catalogCli) return Buffer.alloc(0);
      assert.equal(executable, "/usr/bin/python3");
      return boundedCommand(executable, args, options);
    },
    docker: async (args, options) => {
      calls.push({ operation: "docker", args, options });
      return raw;
    },
    readFile: async (file, ...options) => {
      calls.push({ operation: "read", file });
      return fs.readFile(file, ...options);
    },
    writeFile: async (file, bytes, options) => {
      calls.push({ operation: "write", file, bytes, options });
      return fs.writeFile(file, bytes, options);
    },
  };
  return { capture, calls, directory, projection, raw };
}

function cleanupHarness(capture, calls, overrides = {}) {
  const workspace = { directory: capture.workspaceDirectory, dev: 1, ino: 2 };
  const tlsRoot = {
    directory: "/synthetic-tmpfs/catalog-control",
    dev: 3,
    ino: 4,
  };
  const state = {
    stage: "CATALOG_PREFIX",
    ownsTool: false,
    ownsSource: false,
    ownsTarget: true,
    workspace,
    tlsRoot,
  };
  return {
    state,
    options: {
      state: () => state,
      run: async (executable, args, options) => {
        calls.push({ operation: "cleanup-run", executable, args, options });
        return Buffer.alloc(0);
      },
      docker: async () => assert.fail("an unowned tool must not be touched"),
      cli: catalogCli,
      toolContainer:
        "desmoslock-restore-tools-0123456789abcdef0123456789abcdef",
      removeDirectory: async (owned) => {
        calls.push({ operation: "remove", owned });
      },
      detach: () => calls.push({ operation: "detach" }),
      ...overrides,
    },
  };
}

test("disposable CI guard accepts only the pinned unprivileged Linux runner", () => {
  const valid = Object.freeze({
    platform: "linux",
    nodeVersion: "v24.20.0",
    githubActions: "true",
    ci: "true",
    uid: 1001,
  });
  assert.doesNotThrow(() => requireDisposableCi(valid));
  for (const [field, values] of [
    ["platform", ["darwin", "win32", undefined]],
    ["nodeVersion", ["v24.19.0", "v24.20.1", "24.20.0", undefined]],
    ["githubActions", [true, "false", "TRUE", undefined]],
    ["ci", [true, "false", "TRUE", undefined]],
  ])
    for (const value of values)
      assert.throws(
        () => requireDisposableCi({ ...valid, [field]: value }),
        failure("DISPOSABLE_CI_REQUIRED"),
      );
  for (const uid of [0, undefined, null, "1001", 1.5, NaN])
    assert.throws(
      () => requireDisposableCi({ ...valid, uid }),
      failure("UNPRIVILEGED_CI_RUNNER_REQUIRED"),
    );
});

test("catalog prefix capture fixes source pins, command arguments, SQL input, and bounded diagnostic", async (t) => {
  const { capture, calls, projection, raw, directory } =
    await catalogHarness(t);
  const diagnostic = await captureBackendCatalogPrefix(capture);
  assert.ok(Buffer.isBuffer(diagnostic));
  assert.ok(diagnostic.length <= 1_104_096);
  const text = diagnostic.toString("utf8");
  assert.match(text, /^DESMOSLOCK_CATALOG_PREFIX_V1 \{[^\n]+\}\n$/u);
  const observation = JSON.parse(
    text.slice("DESMOSLOCK_CATALOG_PREFIX_V1 ".length),
  );
  const expectations = JSON.parse(
    await fs.readFile(
      path.join(catalogRoot, "catalog-source-expectations.json"),
    ),
  );
  assert.deepEqual(observation, {
    observation_version: 1,
    query_sha256:
      "d4c00e6330577e42aa0268f113f3d8a2b37e7e9b8f2c50b7c726bf2c0340c1d9",
    source_commit: catalogCommit,
    source_files: expectations.sourceFiles,
    prefix_versions: ["20260824000100", "20260828000100"],
    projection,
  });
  assert.equal(
    text,
    `DESMOSLOCK_CATALOG_PREFIX_V1 ${JSON.stringify(observation)}\n`,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.operation === "read")
      .map((call) => call.file)
      .toSorted(),
    [
      path.join(catalogRoot, "catalog.sql"),
      path.join(catalogRoot, "validate.py"),
      path.join(catalogRoot, "catalog-source-expectations.json"),
      ...expectations.sourceFiles.map((source) =>
        path.join(repositoryRoot, source.path),
      ),
    ].toSorted(),
  );
  const observationPath = path.join(directory, "catalog-prefix.json");
  assert.deepEqual(
    calls.filter((call) => call.operation !== "read"),
    [
      {
        operation: "run",
        executable: "/usr/bin/git",
        args: ["rev-parse", "HEAD"],
        options: { timeoutMs: 10_000, maxBytes: 128 },
      },
      {
        operation: "run",
        executable: catalogCli,
        args: [
          "db",
          "reset",
          "--local",
          "--version",
          "20260828000100",
          "--no-seed",
        ],
        options: { timeoutMs: 300_000 },
      },
      {
        operation: "docker",
        args: [
          "exec",
          "--user",
          "postgres",
          "--interactive",
          "supabase_db_desmoslock-v2",
          "/usr/lib/postgresql/bin/psql",
          "--no-psqlrc",
          "--quiet",
          "--tuples-only",
          "--no-align",
          "--set",
          "ON_ERROR_STOP=1",
          "--host",
          "/var/run/postgresql",
          "--port",
          "5432",
          "--username",
          "supabase_admin",
          "--dbname",
          "postgres",
        ],
        options: {
          input:
            "BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog;\n" +
            "SET LOCAL statement_timeout = '10s';\nSET LOCAL lock_timeout = '1s';\n" +
            (await fs.readFile(path.join(catalogRoot, "catalog.sql"), "utf8")) +
            "\nROLLBACK;\n",
          timeoutMs: 30_000,
          maxBytes: 1_100_000,
        },
      },
      {
        operation: "write",
        file: observationPath,
        bytes: raw,
        options: { mode: 0o600, flag: "wx" },
      },
      {
        operation: "run",
        executable: "/usr/bin/python3",
        args: [
          "-I",
          "-B",
          path.join(catalogRoot, "validate.py"),
          "validate",
          observationPath,
          "--expectations",
          path.join(catalogRoot, "catalog-source-expectations.json"),
        ],
        options: { timeoutMs: 10_000, maxBytes: 8192 },
      },
    ],
  );
  assert.deepEqual(await fs.readFile(observationPath), raw);
  assert.equal((await fs.stat(observationPath)).mode & 0o777, 0o600);
});

test("catalog pin drift and invalid capture scope stop before command execution", async (t) => {
  for (const relative of [
    "scripts/backend-catalog/catalog.sql",
    "scripts/backend-catalog/validate.py",
    "scripts/backend-catalog/catalog-source-expectations.json",
    "supabase/migrations/20260824000100_v2_foundation.sql",
    "supabase/migrations/20260828000100_internal_release_backend.sql",
  ]) {
    const { capture, calls } = await catalogHarness(t);
    const read = capture.readFile;
    capture.readFile = async (file) => {
      const bytes = await read(file);
      return file === path.join(repositoryRoot, relative)
        ? Buffer.concat([bytes, Buffer.from("\n")])
        : bytes;
    };
    await assert.rejects(
      captureBackendCatalogPrefix(capture),
      failure("CATALOG_INPUT_INVALID"),
    );
    assert.equal(
      calls.some((call) => call.operation !== "read"),
      false,
    );
  }
  for (const invalid of [
    { repositoryRoot: "relative" },
    { workspaceDirectory: "relative" },
    { cli: "/unowned/supabase" },
    { run: null },
    { docker: null },
  ]) {
    const { capture, calls } = await catalogHarness(t);
    await assert.rejects(
      captureBackendCatalogPrefix({ ...capture, ...invalid }),
      failure("CATALOG_SCOPE_INVALID"),
    );
    assert.deepEqual(calls, []);
  }
});

test("catalog capture rejects malformed commit identity before resetting the target", async (t) => {
  for (const commit of [
    `${catalogCommit}`,
    `${catalogCommit}\nextra\n`,
    `${"A".repeat(40)}\n`,
    "7e351815\n",
    "synthetic-private-value\n",
  ]) {
    const { capture, calls } = await catalogHarness(t);
    capture.run = async (executable, args) => {
      calls.push({ operation: "run", executable, args });
      assert.equal(executable, "/usr/bin/git");
      return Buffer.from(commit);
    };
    await assert.rejects(
      captureBackendCatalogPrefix(capture),
      failure("CATALOG_COMMIT_INVALID"),
    );
    assert.equal(calls.filter((call) => call.operation === "run").length, 1);
    assert.equal(
      calls.some((call) => call.operation === "docker"),
      false,
    );
  }
});

test("real catalog validator rejects malformed, missing, duplicate, and oversized projections with target cleanup", async (t) => {
  const value = await artificialCatalogProjection();
  const missing = structuredClone(value);
  missing.records = missing.records.filter(
    (record) => record.kind !== "context",
  );
  const duplicate = structuredClone(value);
  duplicate.records.push(structuredClone(duplicate.records[0]));
  const drift = structuredClone(value);
  drift.records.find((record) => record.kind === "routine").data.body_hash =
    "2".repeat(64);
  const cases = [
    ["invalid JSON", Buffer.from("{"), "FIXTURE_COMMAND_FAILED"],
    [
      "missing context",
      Buffer.from(JSON.stringify(missing)),
      "FIXTURE_COMMAND_FAILED",
    ],
    [
      "duplicate record",
      Buffer.from(JSON.stringify(duplicate)),
      "FIXTURE_COMMAND_FAILED",
    ],
    [
      "duplicate JSON field",
      Buffer.from(
        JSON.stringify(value).replace(
          '"format_version":1',
          '"format_version":1,"format_version":1',
        ),
      ),
      "FIXTURE_COMMAND_FAILED",
    ],
    [
      "source body drift",
      Buffer.from(JSON.stringify(drift)),
      "FIXTURE_COMMAND_FAILED",
    ],
    [
      "server overflow",
      Buffer.from(JSON.stringify({ ...value, overflow: true })),
      "FIXTURE_COMMAND_FAILED",
    ],
    ["missing output", Buffer.alloc(0), "CATALOG_OUTPUT_INVALID"],
    ["byte cap", Buffer.alloc(1_100_001, " "), "CATALOG_OUTPUT_INVALID"],
  ];
  for (const [name, raw, code] of cases)
    await t.test(name, async (t) => {
      const { capture, calls } = await catalogHarness(t, raw);
      const cleanup = cleanupHarness(capture, calls);
      await assert.rejects(
        withRoundtripCleanup(async () => {
          await captureBackendCatalogPrefix(capture);
          assert.fail(
            "a rejected catalog must not return a diagnostic or continue setup",
          );
        }, cleanup.options),
        failure(`CATALOG_PREFIX_${code}`),
      );
      assert.deepEqual(
        calls.filter((call) => call.operation === "cleanup-run"),
        [
          {
            operation: "cleanup-run",
            executable: catalogCli,
            args: ["stop", "--no-backup"],
            options: { signal: undefined, timeoutMs: 120_000 },
          },
        ],
      );
      assert.deepEqual(
        calls
          .filter((call) => call.operation === "remove")
          .map((call) => call.owned),
        [cleanup.state.tlsRoot, cleanup.state.workspace],
      );
      assert.equal(
        calls.filter((call) => call.operation === "detach").length,
        1,
      );
      if (code === "CATALOG_OUTPUT_INVALID")
        assert.equal(
          calls.some((call) => call.operation === "write"),
          false,
        );
      else
        assert.equal(
          calls.filter((call) => call.executable === "/usr/bin/python3").length,
          1,
        );
    });
});

test("prefix reset, query, and validator command failures use the real cleanup wrapper exactly once", async (t) => {
  for (const command of ["prefix reset", "query", "validator"])
    await t.test(command, async (t) => {
      const { capture, calls } = await catalogHarness(t);
      const run = capture.run;
      const docker = capture.docker;
      capture.docker = async (...args) => {
        const output = await docker(...args);
        if (command === "query")
          throw new FixtureFailure("FIXTURE_COMMAND_FAILED");
        return output;
      };
      capture.run = async (executable, args, options) => {
        if (
          (command === "prefix reset" && executable === catalogCli) ||
          (command === "validator" && executable === "/usr/bin/python3")
        ) {
          calls.push({ operation: "run", executable, args, options });
          throw new FixtureFailure("FIXTURE_COMMAND_FAILED");
        }
        return run(executable, args, options);
      };
      const cleanup = cleanupHarness(capture, calls);
      await assert.rejects(
        withRoundtripCleanup(async () => {
          const diagnostic = await captureBackendCatalogPrefix(capture);
          calls.push({ operation: "diagnostic", bytes: diagnostic });
          await capture.run(catalogCli, ["db", "reset", "--no-seed"], {
            timeoutMs: 300_000,
          });
          calls.push({ operation: "source-setup" });
        }, cleanup.options),
        failure("CATALOG_PREFIX_FIXTURE_COMMAND_FAILED"),
      );
      const stops = calls.filter((call) => call.operation === "cleanup-run");
      assert.equal(stops.length, 1);
      assert.deepEqual(stops[0].args, ["stop", "--no-backup"]);
      assert.equal(Object.hasOwn(stops[0].options, "signal"), true);
      assert.equal(stops[0].options.signal, undefined);
      assert.equal(
        calls.some((call) =>
          ["diagnostic", "source-setup"].includes(call.operation),
        ),
        false,
      );
      assert.equal(
        calls.some(
          (call) =>
            call.operation === "run" &&
            call.executable === catalogCli &&
            call.args.join(" ") === "db reset --no-seed",
        ),
        false,
      );
      if (command === "prefix reset") {
        assert.equal(
          calls.some(
            (call) =>
              ["docker", "write"].includes(call.operation) ||
              call.executable === "/usr/bin/python3",
          ),
          false,
        );
        assert.deepEqual(
          calls.filter((call) => call.operation === "run"),
          [
            {
              operation: "run",
              executable: "/usr/bin/git",
              args: ["rev-parse", "HEAD"],
              options: { timeoutMs: 10_000, maxBytes: 128 },
            },
            {
              operation: "run",
              executable: catalogCli,
              args: [
                "db",
                "reset",
                "--local",
                "--version",
                "20260828000100",
                "--no-seed",
              ],
              options: { timeoutMs: 300_000 },
            },
          ],
        );
      }
      assert.equal(
        calls.filter((call) => call.operation === "detach").length,
        1,
      );
    });
});

test("catalog capture requires an exact validator summary tied to the captured projection", async (t) => {
  for (const [name, mutate, code = "CATALOG_VALIDATION_INVALID"] of [
    [
      "missing status",
      (value) => {
        delete value.status;
      },
    ],
    [
      "missing record count",
      (value) => {
        delete value.records;
      },
    ],
    [
      "missing digest",
      (value) => {
        delete value.sha256;
      },
    ],
    [
      "missing limit",
      (value) => {
        delete value.catalog_equivalence;
      },
    ],
    [
      "extra field",
      (value) => {
        value.extra = "synthetic-private-value";
      },
    ],
    [
      "rejected status",
      (value) => {
        value.status = "rejected";
      },
    ],
    [
      "equivalence claim",
      (value) => {
        value.catalog_equivalence = "established";
      },
    ],
    [
      "invalid record type",
      (value) => {
        value.records = String(value.records);
      },
    ],
    [
      "zero records",
      (value) => {
        value.records = 0;
      },
    ],
    [
      "record cap",
      (value) => {
        value.records = 2049;
      },
    ],
    [
      "invalid digest",
      (value) => {
        value.sha256 = "synthetic-private-value";
      },
    ],
    [
      "different record count",
      (value) => {
        value.records += 1;
      },
      "CATALOG_VALIDATION_MISMATCH",
    ],
    [
      "different digest",
      (value) => {
        value.sha256 = "0".repeat(64);
      },
      "CATALOG_VALIDATION_MISMATCH",
    ],
  ])
    await t.test(name, async (t) => {
      const { capture } = await catalogHarness(t);
      const run = capture.run;
      capture.run = async (executable, ...args) => {
        const bytes = await run(executable, ...args);
        if (executable !== "/usr/bin/python3") return bytes;
        const validation = JSON.parse(bytes);
        mutate(validation);
        return Buffer.from(JSON.stringify(validation));
      };
      await assert.rejects(captureBackendCatalogPrefix(capture), failure(code));
    });
});

test("cleanup failure preserves recovery workspace and suffixes the original catalog failure", async (t) => {
  const { capture, calls } = await catalogHarness(t);
  capture.docker = async () => {
    throw new FixtureFailure("FIXTURE_COMMAND_TIMEOUT");
  };
  const cleanup = cleanupHarness(capture, calls, {
    run: async (executable, args, options) => {
      calls.push({ operation: "cleanup-run", executable, args, options });
      throw new FixtureFailure("FIXTURE_COMMAND_FAILED");
    },
  });
  await assert.rejects(
    withRoundtripCleanup(
      () => captureBackendCatalogPrefix(capture),
      cleanup.options,
    ),
    failure("CATALOG_PREFIX_FIXTURE_COMMAND_TIMEOUT_AND_CLEANUP_FAILED"),
  );
  assert.equal(
    calls.filter((call) => call.operation === "cleanup-run").length,
    1,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.operation === "remove")
      .map((call) => call.owned),
    [cleanup.state.tlsRoot],
  );
  assert.equal(calls.filter((call) => call.operation === "detach").length, 1);
});

test("cancelled catalog work still stops the owned target with cancellation detached", async (t) => {
  const { capture, calls } = await catalogHarness(t);
  const cancellation = new AbortController();
  cancellation.abort();
  capture.docker = () =>
    boundedCommand("/not-an-executable", [], { signal: cancellation.signal });
  const cleanup = cleanupHarness(capture, calls);
  await assert.rejects(
    withRoundtripCleanup(
      () => captureBackendCatalogPrefix(capture),
      cleanup.options,
    ),
    failure("CATALOG_PREFIX_FIXTURE_COMMAND_ABORTED"),
  );
  const stops = calls.filter((call) => call.operation === "cleanup-run");
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].args, ["stop", "--no-backup"]);
  assert.equal(Object.hasOwn(stops[0].options, "signal"), true);
  assert.equal(stops[0].options.signal, undefined);
  assert.equal(calls.filter((call) => call.operation === "detach").length, 1);
});

test("inert roundtrip callback returns the validated diagnostic before full reset and source setup", async (t) => {
  const { capture, calls } = await catalogHarness(t);
  const cleanup = cleanupHarness(capture, calls);
  const result = await withRoundtripCleanup(async () => {
    const diagnostic = await captureBackendCatalogPrefix(capture);
    calls.push({ operation: "diagnostic", bytes: diagnostic });
    await capture.run(catalogCli, ["db", "reset", "--no-seed"], {
      timeoutMs: 300_000,
    });
    cleanup.state.stage = "SOURCE_SETUP";
    cleanup.state.ownsSource = true;
    calls.push({ operation: "source-setup" });
    return "synthetic-roundtrip-result";
  }, cleanup.options);
  assert.equal(result, "synthetic-roundtrip-result");
  assert.deepEqual(
    calls
      .filter((call) =>
        ["run", "docker", "diagnostic", "source-setup"].includes(
          call.operation,
        ),
      )
      .map((call) =>
        call.operation === "run"
          ? call.executable === catalogCli
            ? call.args.join(" ")
            : call.executable
          : call.operation,
      ),
    [
      "/usr/bin/git",
      "db reset --local --version 20260828000100 --no-seed",
      "docker",
      "/usr/bin/python3",
      "diagnostic",
      "db reset --no-seed",
      "source-setup",
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call.operation === "cleanup-run"),
    [
      {
        operation: "cleanup-run",
        executable: catalogCli,
        args: ["stop", "--no-backup"],
        options: {
          cwd: path.join(capture.workspaceDirectory, "source"),
          signal: undefined,
          timeoutMs: 120_000,
        },
      },
      {
        operation: "cleanup-run",
        executable: catalogCli,
        args: ["stop", "--no-backup"],
        options: { signal: undefined, timeoutMs: 120_000 },
      },
    ],
  );
  assert.equal(calls.filter((call) => call.operation === "detach").length, 1);
});

test("worker receipt requires explicit metadata and empty authority-store evidence", () => {
  const receipt = Object.freeze({
    status: "restored",
    tlsVerified: true,
    distinctSessionTimezones: true,
    testMetadataPreserved: true,
    studentMetadataPreserved: true,
    studentRuntimeStoresEmpty: true,
    secondRestoreRefused: true,
    restoreMarkerRetired: true,
    artifactSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  });
  assert.doesNotThrow(() => requireRestoredWorkerReceipt(receipt));
  for (const field of [
    "tlsVerified",
    "distinctSessionTimezones",
    "testMetadataPreserved",
    "studentMetadataPreserved",
    "studentRuntimeStoresEmpty",
    "secondRestoreRefused",
    "restoreMarkerRetired",
  ]) {
    const missing = { ...receipt };
    delete missing[field];
    assert.throws(
      () => requireRestoredWorkerReceipt(missing),
      failure("ROUNDTRIP_RECEIPT_INVALID"),
    );
    for (const value of [false, null, "true", 1]) {
      assert.throws(
        () => requireRestoredWorkerReceipt({ ...receipt, [field]: value }),
        failure("ROUNDTRIP_RECEIPT_INVALID"),
      );
    }
  }
  for (const invalid of [
    null,
    undefined,
    { ...receipt, status: "failed" },
    { ...receipt, artifactSha256: "synthetic-private-value" },
    { ...receipt, manifestSha256: "synthetic-private-value" },
  ]) {
    assert.throws(
      () => requireRestoredWorkerReceipt(invalid),
      failure("ROUNDTRIP_RECEIPT_INVALID"),
    );
  }
});

test("bounded command returns stdout without relaying stderr", async () => {
  const result = await boundedCommand(
    node,
    [
      "-e",
      "process.stdout.write('ok'); process.stderr.write('synthetic-private-value')",
    ],
    { timeoutMs: 5_000 },
  );
  assert.equal(result.toString(), "ok");
});

test("nonzero subprocess output remains behind a static error", async () => {
  await assert.rejects(
    boundedCommand(
      node,
      [
        "-e",
        "process.stderr.write('synthetic-private-value'); process.exit(1)",
      ],
      { timeoutMs: 5_000 },
    ),
    failure("FIXTURE_COMMAND_FAILED"),
  );
});

test("only the real staff npm invocation returns closed failure locations after context wrapping", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "staff-failure-"));
  try {
    await fs.mkdir(path.join(directory, "tests/acceptance"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          "test:staff-auth": "npm run test:staff-auth:composed",
          "test:staff-auth:composed":
            "node --test tests/acceptance/staff-auth-composed.test.mjs",
        },
      }),
    );
    await fs.writeFile(
      path.join(directory, "tests/acceptance/staff-auth-composed.test.mjs"),
      "import test from 'node:test';\n" +
        "test('synthetic-private-name', () => { console.log('synthetic-private-output'); console.error('synthetic-private-stderr'); throw new Error('synthetic-private-error'); });\n",
    );
    await fs.writeFile(path.join(directory, "user.npmrc"), "");
    await fs.writeFile(path.join(directory, "global.npmrc"), "");
    const npm =
      process.env.npm_execpath ?? path.join(path.dirname(node), "npm");
    let executablePath = `${path.dirname(node)}:/usr/bin:/bin`;
    if (process.env.npm_execpath) {
      const bin = path.join(directory, "bin");
      await fs.mkdir(bin);
      const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(
        path.join(bin, "npm"),
        `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(npm)} "$@"\n`,
        { mode: 0o700 },
      );
      executablePath = `${bin}:${executablePath}`;
    }
    const environment = {
      PATH: executablePath,
      NODE_OPTIONS: "--max-old-space-size=128",
      NPM_CONFIG_USERCONFIG: path.join(directory, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(directory, "global.npmrc"),
      NPM_CONFIG_CACHE: path.join(directory, "npm-cache"),
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_LOGS_MAX: "0",
      COREPACK_ENABLE_NETWORK: "0",
    };
    await assert.rejects(
      runStaffSuite(npm, {
        cwd: directory,
        environment,
        timeoutMs: 10_000,
      }),
      (error) => {
        assert.ok(error instanceof StaffSuiteCommandFailure);
        assert.equal(error.code, "FIXTURE_COMMAND_FAILED");
        assert.equal(error.diagnostics.stage, "composed");
        assert.deepEqual(error.diagnostics.records, [
          {
            file: "tests/acceptance/staff-auth-composed.test.mjs",
            line: 2,
            outcome: "failed",
          },
        ]);
        assert.equal(error.diagnostics.eventCounters.failed, 1);
        const afterCleanup = error
          .withCode(`STAFF_SUITE_${error.code}`)
          .withCode("STAFF_SUITE_FIXTURE_COMMAND_FAILED_AND_CLEANUP_FAILED");
        assert.ok(afterCleanup instanceof StaffSuiteCommandFailure);
        assert.equal(
          afterCleanup.code,
          "STAFF_SUITE_FIXTURE_COMMAND_FAILED_AND_CLEANUP_FAILED",
        );
        assert.deepEqual(afterCleanup.diagnostics, error.diagnostics);
        assert.equal(
          JSON.stringify(afterCleanup).includes("synthetic-private"),
          false,
        );
        return true;
      },
    );
    assert.equal(environment.NODE_OPTIONS, "--max-old-space-size=128");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("public command options cannot enable staff failure projection", async () => {
  await assert.rejects(
    boundedCommand(
      node,
      [
        "-e",
        "process.stdout.write('[desmoslock-staff-suite:v1] '+JSON.stringify({file:'tests/acceptance/staff-auth-composed.test.mjs',line:2,outcome:'failed'})+'\\n');process.exit(1)",
      ],
      { timeoutMs: 5_000, staffSuiteDiagnostics: true },
    ),
    (error) => {
      assert.ok(error instanceof FixtureFailure);
      assert.equal(error instanceof StaffSuiteCommandFailure, false);
      assert.equal(error.code, "FIXTURE_COMMAND_FAILED");
      assert.equal("diagnostics" in error, false);
      return true;
    },
  );
});

test("a conflicting reporter configuration fails before staff-suite egress", () => {
  assert.throws(
    () =>
      runStaffSuite("/not-an-executable", {
        environment: { NODE_OPTIONS: "--test-reporter=spec" },
      }),
    failure("STAFF_SUITE_REPORTER_CONFIGURATION_INVALID"),
  );
});

test("output overflow and timeout terminate owned commands", async () => {
  await assert.rejects(
    boundedCommand(
      node,
      [
        "-e",
        "process.stdout.write('a'.repeat(4096)); setInterval(()=>{},1000)",
      ],
      { maxBytes: 256, timeoutMs: 5_000 },
    ),
    failure("FIXTURE_COMMAND_OUTPUT_LIMIT"),
  );
  await assert.rejects(
    boundedCommand(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 80 }),
    failure("FIXTURE_COMMAND_TIMEOUT"),
  );
});

test("already cancelled command is never started", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    boundedCommand("/not-an-executable", [], { signal: controller.signal }),
    failure("FIXTURE_COMMAND_ABORTED"),
  );
});

test("source fixture config only changes project and declared ports", () => {
  const fixture =
    'project_id = "desmoslock-v2"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[local_smtp]\nport = 54324\n[auth]\nenable_signup = false\n';
  const changed = sourceConfiguration(
    fixture,
    "desmoslock-restore-0123456789abcdef",
  );
  assert.equal(
    changed
      .replaceAll("5532", "5432")
      .replace("desmoslock-restore-0123456789abcdef", "desmoslock-v2"),
    fixture,
  );
  assert.throws(
    () => sourceConfiguration(fixture, "unowned-project"),
    failure("SOURCE_PROJECT_INVALID"),
  );
  assert.throws(
    () =>
      sourceConfiguration(
        fixture.replace("54324", "60000"),
        "desmoslock-restore-0123456789abcdef",
      ),
    failure("SOURCE_PORT_CONFIG_DRIFT"),
  );
});

test("materialized source includes every configured Auth template and only canonical fixture inputs", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "restore-source-"));
  const sourceRoot = path.join(temporary, "source");
  const project = "desmoslock-restore-0123456789abcdef";
  try {
    await materializeSourceFixture(
      repositoryRoot,
      sourceRoot,
      project,
      CURRENT_MIGRATION_FILES,
    );
    const config = await fs.readFile(
      path.join(repositoryRoot, "supabase/config.toml"),
      "utf8",
    );
    const generated = await fs.readFile(
      path.join(sourceRoot, "supabase/config.toml"),
      "utf8",
    );
    assert.equal(generated, sourceConfiguration(config, project));
    const templatePaths = Array.from(
      generated.matchAll(/^content_path = "(.+)"$/gmu),
      ([, relative]) => {
        assert.match(relative, /^\.\/supabase\/templates\/[a-z0-9-]+\.html$/u);
        return relative.slice(2);
      },
    );
    assert.deepEqual(templatePaths.toSorted(), [
      "supabase/templates/confirmation-v1.html",
      "supabase/templates/recovery-v1.html",
    ]);
    const copiedPaths = [
      "supabase/seed.sql",
      ...templatePaths,
      ...CURRENT_MIGRATION_FILES.map((file) => `supabase/migrations/${file}`),
    ];
    for (const relative of copiedPaths) {
      assert.deepEqual(
        await fs.readFile(path.join(sourceRoot, relative)),
        await fs.readFile(path.join(repositoryRoot, relative)),
        `source fixture must preserve ${relative}`,
      );
    }
    const materializedFiles = [];
    for (const relative of await fs.readdir(sourceRoot, { recursive: true })) {
      const stat = await fs.lstat(path.join(sourceRoot, relative));
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isFile()) materializedFiles.push(relative);
      else assert.equal(stat.isDirectory(), true);
    }
    // An exact file inventory also excludes environment files, unrelated assets,
    // provider caches and the rest of the repository from this isolated source.
    assert.deepEqual(
      materializedFiles.toSorted(),
      ["supabase/config.toml", ...copiedPaths].toSorted(),
    );
  } finally {
    await fs.rm(temporary, { recursive: true });
  }
});

test("database status accepts only the exact disposable database endpoint", () => {
  const syntheticEndpoint = new URL("postgresql://127.0.0.1:55322/postgres");
  syntheticEndpoint.username = "postgres";
  syntheticEndpoint.password = "synthetic-password";
  const valid = syntheticEndpoint.href;
  assert.equal(
    connectionFromStatus({ DB_URL: valid }, "55322").host,
    "127.0.0.1",
  );
  for (const invalid of [
    valid.replace("127.0.0.1", "localhost"),
    valid.replace("127.0.0.1", "127.1"),
    valid.replace("127.0.0.1", "db.example.invalid"),
    valid.replace("55322", "54322"),
    `${valid}?sslmode=disable`,
    valid.replace("/postgres", "/other"),
  ]) {
    assert.throws(
      () => connectionFromStatus({ DB_URL: invalid }, "55322"),
      failure("DISPOSABLE_DATABASE_URL_INVALID"),
    );
  }
});

test("native wrapper uses an explicit socket, safe arguments, and named PG environment", async () => {
  const wrapper = nativeClientWrapper(
    "desmoslock-restore-tools-0123456789abcdef0123456789abcdef",
    "pg_dump",
  );
  assert.match(
    wrapper,
    /^#!\/bin\/sh\nexec \/usr\/bin\/docker --host unix:\/\/\/var\/run\/docker.sock exec --interactive /u,
  );
  assert.match(wrapper, /--env PGPASSWORD /u);
  assert.match(wrapper, /--env PGTZ /u);
  assert.doesNotMatch(wrapper, /PGPASSWORD=|--env-file|--tty|\$\(/u);
  assert.match(wrapper, /\/usr\/lib\/postgresql\/bin\/pg_dump "\$@"\n$/u);
  await boundedCommand("/bin/sh", ["-n"], { input: wrapper, timeoutMs: 5_000 });
  assert.throws(
    () => nativeClientWrapper("unowned-container", "psql"),
    failure("NATIVE_WRAPPER_INVALID"),
  );
  assert.throws(
    () =>
      nativeClientWrapper(
        "desmoslock-restore-tools-0123456789abcdef0123456789abcdef",
        "psql; other",
      ),
    failure("NATIVE_WRAPPER_INVALID"),
  );
});

test("fixture session timezones preserve explicit UTC export without mutating requests", async () => {
  const calls = [];
  const runner = withSessionTimezone(async (request) => {
    calls.push(request);
    return Buffer.from("synthetic result");
  }, "Asia/Tokyo");
  const observation = Object.freeze({
    executable: "/operator-tools/psql",
    environment: Object.freeze({ LANG: "C", PGHOST: "127.0.0.1" }),
  });
  const dump = Object.freeze({
    executable: "/operator-tools/pg_dump",
    environment: Object.freeze({ LANG: "C", PGHOST: "127.0.0.1", PGTZ: "UTC" }),
  });
  const originalTimezone = process.env.PGTZ;
  assert.equal((await runner(observation)).toString(), "synthetic result");
  await runner(dump);
  assert.deepEqual(
    calls.map((call) => call.environment.PGTZ),
    ["Asia/Tokyo", "UTC"],
  );
  assert.equal(observation.environment.PGTZ, undefined);
  assert.equal(dump.environment.PGTZ, "UTC");
  assert.equal(process.env.PGTZ, originalTimezone);
  assert.notEqual(calls[0].environment, observation.environment);
});

const emptyRootDiagnostic =
  'psql: error: connection to server at "127.0.0.1", port 55322 failed: could not read root certificate file "/dev/null": no certificate or crl found\n';

test("invalid-root classifier requires the exact native certificate failure", () => {
  const empty = Buffer.alloc(0);
  const diagnostic = Buffer.from(emptyRootDiagnostic);
  assert.equal(isExpectedInvalidRootCertificate(2, empty, diagnostic), true);
  for (const [code, stdout, stderr] of [
    [0, empty, diagnostic],
    [1, empty, diagnostic],
    [null, empty, diagnostic],
    [2, Buffer.from("1\n"), diagnostic],
    [2, empty, Buffer.from("Cannot connect to the Docker daemon\n")],
    [
      2,
      empty,
      Buffer.from(
        emptyRootDiagnostic.replace(
          "no certificate or crl found",
          "Permission denied",
        ),
      ),
    ],
    [2, empty, Buffer.from(emptyRootDiagnostic.replace("55322", "54322"))],
    [
      2,
      empty,
      Buffer.from(emptyRootDiagnostic.replace("/dev/null", "/other/root.crt")),
    ],
    [2, empty, Buffer.from(emptyRootDiagnostic + "connection reset by peer\n")],
    [2, empty, Buffer.from("psql: error: connection refused\n")],
  ])
    assert.equal(isExpectedInvalidRootCertificate(code, stdout, stderr), false);
});

test("bounded negative probe accepts expected certificate failure and rejects unrelated errors", async () => {
  // Synthetic subprocess fixtures test classification only, not actual TLS.
  const args = (message, exitCode) => [
    "-e",
    `process.stderr.write(${JSON.stringify(message)}); process.exit(${exitCode})`,
  ];
  const options = {
    timeoutMs: 5_000,
    maxBytes: 8192,
    expectInvalidRootCertificate: true,
  };
  assert.equal(
    (await boundedCommand(node, args(emptyRootDiagnostic, 2), options)).length,
    0,
  );
  await assert.rejects(
    boundedCommand(
      node,
      args("Docker unavailable: synthetic-private-value\n", 2),
      options,
    ),
    failure("INVALID_CA_FAILURE_UNCLASSIFIED"),
  );
  await assert.rejects(
    boundedCommand(node, args("psql: error: connection refused\n", 2), options),
    failure("INVALID_CA_FAILURE_UNCLASSIFIED"),
  );
  await assert.rejects(
    boundedCommand(node, args(emptyRootDiagnostic, 0), options),
    failure("INVALID_CA_UNEXPECTED_SUCCESS"),
  );
});

test("expected certificate text cannot turn a timeout or overflow into success", async () => {
  await assert.rejects(
    boundedCommand(
      node,
      [
        "-e",
        `process.stderr.write(${JSON.stringify(emptyRootDiagnostic)}); setInterval(()=>{},1000)`,
      ],
      { expectInvalidRootCertificate: true, timeoutMs: 200, maxBytes: 8192 },
    ),
    failure("FIXTURE_COMMAND_TIMEOUT"),
  );
  await assert.rejects(
    boundedCommand(
      node,
      [
        "-e",
        `process.stderr.write(${JSON.stringify(emptyRootDiagnostic.repeat(20))}); process.exit(2)`,
      ],
      { expectInvalidRootCertificate: true, timeoutMs: 5_000, maxBytes: 1024 },
    ),
    failure("FIXTURE_COMMAND_OUTPUT_LIMIT"),
  );
});
