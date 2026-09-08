import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "./staff-suite-diagnostics-reporter.test.mjs";
import {
  boundedCommand,
  connectionFromStatus,
  FixtureFailure,
  isExpectedInvalidRootCertificate,
  nativeClientWrapper,
  requireRestoredWorkerReceipt,
  runStaffSuite,
  sourceConfiguration,
  StaffSuiteCommandFailure,
  withSessionTimezone,
} from "./synthetic-backup-runtime.mjs";

const node = process.execPath;
const failure = (code) => (error) =>
  error instanceof FixtureFailure &&
  error.code === code &&
  error.message === code;

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
