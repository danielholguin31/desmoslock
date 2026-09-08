import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedCommand,
  connectionFromStatus,
  FixtureFailure,
  isExpectedInvalidRootCertificate,
  nativeClientWrapper,
  sourceConfiguration,
} from "./synthetic-backup-runtime.mjs";

const node = process.execPath;
const failure = (code) => (error) =>
  error instanceof FixtureFailure &&
  error.code === code &&
  error.message === code;

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
