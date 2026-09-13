import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  parseStaffSuiteDiagnostics,
  staffSuiteNodeOptions,
} from "./staff-suite-diagnostics-reporter.mjs";

const TARGET_PROJECT = "desmoslock-v2";
const SOURCE_PORT = "55322";
const TARGET_PORT = "54322";
const SOURCE_EXCLUSIONS =
  "realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const PG_BINARY_ROOT = "/usr/lib/postgresql/bin";
const DOCKER_BINARY = "/usr/bin/docker";
const STAFF_SUITE_DIAGNOSTICS = Symbol("staff-suite-diagnostics");

export class FixtureFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }

  withCode(code) {
    return new FixtureFailure(code);
  }
}

export class StaffSuiteCommandFailure extends FixtureFailure {
  constructor(code, diagnostics) {
    super(code);
    this.diagnostics = diagnostics;
  }

  withCode(code) {
    return new StaffSuiteCommandFailure(code, this.diagnostics);
  }
}

export function requireFixture(condition, code) {
  if (!condition) throw new FixtureFailure(code);
}

export function requireRestoredWorkerReceipt(receipt) {
  requireFixture(
    receipt?.status === "restored" &&
      receipt.tlsVerified === true &&
      receipt.distinctSessionTimezones === true &&
      receipt.testMetadataPreserved === true &&
      receipt.studentMetadataPreserved === true &&
      receipt.studentRuntimeStoresEmpty === true &&
      receipt.secondRestoreRefused === true &&
      receipt.restoreMarkerRetired === true &&
      /^[a-f0-9]{64}$/u.test(receipt.artifactSha256 ?? "") &&
      /^[a-f0-9]{64}$/u.test(receipt.manifestSha256 ?? ""),
    "ROUNDTRIP_RECEIPT_INVALID",
  );
}

function decodeJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FixtureFailure("FIXTURE_JSON_INVALID");
  }
}

// Deliberately narrow: this fixture supplies an existing empty /dev/null file.
// PostgreSQL libpq reports this exact root-file load error before authentication.
// Unknown diagnostics fail closed and never become a successful TLS assertion.
export function isExpectedInvalidRootCertificate(exitCode, stdout, stderr) {
  return (
    exitCode === 2 &&
    stdout.length === 0 &&
    /^psql: error: connection to server at "127\.0\.0\.1"(?: \(127\.0\.0\.1\))?, port 55322 failed: could not read root certificate file "\/dev\/null": no certificate or crl found\n$/u.test(
      stderr.toString("utf8"),
    )
  );
}

// No raw subprocess output is relayed. Native/provider errors may carry secrets.
// Only runStaffSuite enables the closed reporter-record failure projection.
// On cancellation/timeout/overflow kill the entire client process group; the
// controller subsequently removes its exact named tool container as well.
export function boundedCommand(
  executable,
  args,
  {
    cwd,
    input,
    signal,
    timeoutMs = 30_000,
    maxBytes = MAX_COMMAND_BYTES,
    environment = process.env,
    expectInvalidRootCertificate = false,
    [STAFF_SUITE_DIAGNOSTICS]: staffSuiteDiagnostics = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let total = 0;
    const output = [];
    const diagnostics = [];
    let timer;
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child?.kill("SIGKILL");
        }
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        reject(
          staffSuiteDiagnostics && failure === "FIXTURE_COMMAND_FAILED"
            ? new StaffSuiteCommandFailure(
                failure,
                parseStaffSuiteDiagnostics(Buffer.concat(output)),
              )
            : new FixtureFailure(failure),
        );
      } else resolve(Buffer.concat(output));
    };
    const abort = () => finish("FIXTURE_COMMAND_ABORTED");
    if (signal?.aborted) {
      reject(new FixtureFailure("FIXTURE_COMMAND_ABORTED"));
      return;
    }
    try {
      child = spawn(executable, args, {
        cwd,
        env: environment,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new FixtureFailure("FIXTURE_COMMAND_UNAVAILABLE"));
      return;
    }
    timer = setTimeout(() => finish("FIXTURE_COMMAND_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, retain] of [
      [child.stdout, true],
      [child.stderr, false],
    ]) {
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) finish("FIXTURE_COMMAND_OUTPUT_LIMIT");
        else if (retain) output.push(chunk);
        else if (expectInvalidRootCertificate) diagnostics.push(chunk);
      });
      stream.on("error", () => finish("FIXTURE_COMMAND_IO_FAILED"));
    }
    child.on("error", () => finish("FIXTURE_COMMAND_UNAVAILABLE"));
    child.on("close", (code) => {
      if (settled) return;
      if (!expectInvalidRootCertificate) {
        finish(code === 0 ? undefined : "FIXTURE_COMMAND_FAILED");
        return;
      }
      const expected = isExpectedInvalidRootCertificate(
        code,
        Buffer.concat(output),
        Buffer.concat(diagnostics),
      );
      finish(
        expected
          ? undefined
          : code === 0
            ? "INVALID_CA_UNEXPECTED_SUCCESS"
            : "INVALID_CA_FAILURE_UNCLASSIFIED",
      );
    });
    child.stdin.on("error", () => finish("FIXTURE_COMMAND_IO_FAILED"));
    child.stdin.end(input);
  });
}

export function runStaffSuite(npm, options) {
  const environment = options.environment ?? process.env;
  let nodeOptions;
  try {
    nodeOptions = staffSuiteNodeOptions(
      environment.NODE_OPTIONS,
      fileURLToPath(
        new URL("./staff-suite-diagnostics-reporter.mjs", import.meta.url),
      ),
    );
  } catch {
    throw new FixtureFailure("STAFF_SUITE_REPORTER_CONFIGURATION_INVALID");
  }
  return boundedCommand(npm, ["run", "test:staff-auth"], {
    ...options,
    environment: { ...environment, NODE_OPTIONS: nodeOptions },
    [STAFF_SUITE_DIAGNOSTICS]: true,
  });
}

export function sourceConfiguration(text, project) {
  requireFixture(
    /^desmoslock-restore-[a-f0-9]{16}$/u.test(project),
    "SOURCE_PROJECT_INVALID",
  );
  requireFixture(
    text.includes('project_id = "desmoslock-v2"'),
    "SOURCE_CONFIG_DRIFT",
  );
  let output = text.replace(
    'project_id = "desmoslock-v2"',
    `project_id = "${project}"`,
  );
  // Exact versioned inputs only; preserve all Auth policies and template paths.
  for (const [from, to] of [
    [54320, 55320],
    [54321, 55321],
    [54322, 55322],
    [54323, 55323],
    [54324, 55324],
  ]) {
    requireFixture(
      output.split(`= ${from}\n`).length === 2,
      "SOURCE_PORT_CONFIG_DRIFT",
    );
    output = output.replace(`= ${from}\n`, `= ${to}\n`);
  }
  return output;
}

// This finite fixture inventory must stay closed over the versioned config's
// template references; never copy arbitrary config-selected paths or directories.
export async function materializeSourceFixture(
  repositoryRoot,
  sourceRoot,
  sourceProject,
  migrationFiles,
) {
  await fs.mkdir(path.join(sourceRoot, "supabase/migrations"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(sourceRoot, "supabase/templates"), {
    recursive: true,
    mode: 0o700,
  });
  const allowedInputs = [
    "supabase/seed.sql",
    "supabase/templates/recovery-v1.html",
    "supabase/templates/confirmation-v1.html",
    ...migrationFiles.map((file) => `supabase/migrations/${file}`),
  ];
  for (const relative of allowedInputs) {
    requireFixture(
      !relative.includes("..") && !relative.includes(".env"),
      "VERSIONED_INPUT_INVALID",
    );
    await fs.copyFile(
      path.join(repositoryRoot, relative),
      path.join(sourceRoot, relative),
    );
  }
  const config = await fs.readFile(
    path.join(repositoryRoot, "supabase/config.toml"),
    "utf8",
  );
  await fs.writeFile(
    path.join(sourceRoot, "supabase/config.toml"),
    sourceConfiguration(config, sourceProject),
    { mode: 0o600 },
  );
}

export function connectionFromStatus(status, expectedPort) {
  let url;
  try {
    url = new URL(status.DB_URL);
  } catch {
    throw new FixtureFailure("DISPOSABLE_DATABASE_URL_INVALID");
  }
  let password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    throw new FixtureFailure("DISPOSABLE_DATABASE_URL_INVALID");
  }
  requireFixture(
    url.protocol === "postgresql:" &&
      url.hostname === "127.0.0.1" &&
      url.port === expectedPort &&
      url.pathname === "/postgres" &&
      url.username === "postgres" &&
      !url.search &&
      !url.hash &&
      password.length > 0 &&
      !password.includes("\0"),
    "DISPOSABLE_DATABASE_URL_INVALID",
  );
  return {
    host: "127.0.0.1",
    port: expectedPort,
    database: "postgres",
    user: "postgres",
    password,
  };
}

function safeMount(source, target, readonly = true) {
  requireFixture(
    path.isAbsolute(source) && !/[\n\r,]/u.test(source),
    "MOUNT_PATH_INVALID",
  );
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

export function nativeClientWrapper(container, binary) {
  requireFixture(
    /^desmoslock-restore-tools-[a-f0-9]{32}$/u.test(container) &&
      ["psql", "pg_dump", "pg_restore"].includes(binary),
    "NATIVE_WRAPPER_INVALID",
  );
  // Names only in argv: Docker obtains each value from this process's minimal
  // environment. stdin/stdout remain binary-transparent to the real client.
  const names = [
    "LANG",
    "LC_ALL",
    "PGDATABASE",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGTZ",
  ];
  return `#!/bin/sh\nexec ${DOCKER_BINARY} --host unix:///var/run/docker.sock exec --interactive ${names.map((name) => `--env ${name}`).join(" ")} ${container} ${PG_BINARY_ROOT}/${binary} "$@"\n`;
}

function tlsSetupScript(runId) {
  requireFixture(/^[a-f0-9]{32}$/u.test(runId), "TLS_RUN_ID_INVALID");
  // This script contains only paths and public certificate configuration.
  // No private-key bytes ever leave source-container tmpfs.
  return `set -eu
umask 077
awk '$2 == "/dev/shm" && $3 == "tmpfs" { found = 1 } END { exit !found }' /proc/mounts
task_tls=/dev/shm/desmoslock-restore-${runId}
mkdir "$task_tls"
task_openssl=
for task_candidate in /usr/bin/openssl /nix/store/*-openssl-*/bin/openssl; do
  if [ -x "$task_candidate" ]; then task_openssl="$task_candidate"; break; fi
done
[ -n "$task_openssl" ]
"$task_openssl" req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=DesmosLock disposable CI root' -addext 'basicConstraints=critical,CA:TRUE' -keyout "$task_tls/ca.key" -out "$task_tls/ca.crt" >/dev/null 2>&1
"$task_openssl" req -new -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' -keyout "$task_tls/server.key" -out "$task_tls/server.csr" >/dev/null 2>&1
cat > "$task_tls/extensions" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
EXT
"$task_openssl" x509 -req -days 1 -in "$task_tls/server.csr" -CA "$task_tls/ca.crt" -CAkey "$task_tls/ca.key" -set_serial 1 -extfile "$task_tls/extensions" -out "$task_tls/server.crt" >/dev/null 2>&1
chown postgres:postgres "$task_tls" "$task_tls/server.key" "$task_tls/server.crt"
chmod 700 "$task_tls"
chmod 600 "$task_tls/server.key"

`;
}

function tlsReloadSql(runId) {
  requireFixture(/^[a-f0-9]{32}$/u.test(runId), "TLS_RUN_ID_INVALID");
  return `alter system set ssl = 'on';
alter system set ssl_cert_file = '/dev/shm/desmoslock-restore-${runId}/server.crt';
alter system set ssl_key_file = '/dev/shm/desmoslock-restore-${runId}/server.key';
select pg_reload_conf();`;
}

async function privateDirectory(parent, prefix) {
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  await fs.chmod(directory, 0o700);
  const stat = await fs.lstat(directory);
  return { directory, dev: stat.dev, ino: stat.ino };
}

async function removeOwnedDirectory(owned) {
  if (!owned) return;
  const stat = await fs.lstat(owned.directory);
  requireFixture(
    stat.isDirectory() && stat.dev === owned.dev && stat.ino === owned.ino,
    "CLEANUP_DIRECTORY_IDENTITY_CHANGED",
  );
  await fs.rm(owned.directory, { recursive: true });
}

/** Owns the complete target lifecycle; invoke only on a fresh dedicated CI job. */
export async function runBackupRoundtrip(repositoryRoot, testSignal) {
  requireFixture(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.CI === "true" &&
      process.version === "v24.20.0",
    "DISPOSABLE_CI_REQUIRED",
  );
  requireFixture(
    Number.isInteger(process.getuid?.()) && process.getuid() !== 0,
    "UNPRIVILEGED_CI_RUNNER_REQUIRED",
  );
  repositoryRoot = await fs.realpath(repositoryRoot);
  const cli = path.join(repositoryRoot, "node_modules/.bin/supabase");
  const node = await fs.realpath(process.execPath);
  const npm = path.join(path.dirname(node), "npm");
  const cliPackage = decodeJson(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules/supabase/package.json"),
    ),
  );
  requireFixture(cliPackage.version === "2.115.0", "PINNED_CLI_REQUIRED");
  const { CURRENT_MIGRATION_FILES } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "scripts/synthetic-backup/operator.mjs"),
    )
  );
  const runId = randomUUID().replaceAll("-", "");
  const sourceProject = `desmoslock-restore-${runId.slice(0, 16)}`;
  const sourceContainer = `supabase_db_${sourceProject}`;
  const targetContainer = `supabase_db_${TARGET_PROJECT}`;
  const toolContainer = `desmoslock-restore-tools-${runId}`;
  const environment = {
    ...process.env,
    DOCKER_CONTEXT: "default",
    DOCKER_HOST: "unix:///var/run/docker.sock",
  };
  const cancellation = new AbortController();
  const signal = AbortSignal.any(
    [testSignal, cancellation.signal].filter(Boolean),
  );
  const interrupt = () => cancellation.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const run = (executable, args, options = {}) =>
    boundedCommand(executable, args, {
      cwd: repositoryRoot,
      environment,
      signal,
      ...options,
    });
  const docker = (args, options) =>
    run(DOCKER_BINARY, ["--context", "default", ...args], options);
  let workspace, tlsRoot;
  let ownsTarget = false,
    ownsSource = false,
    ownsTool = false;
  let primaryFailure, receipt;
  let stage = "PREFLIGHT";
  const cleanupFailures = [];
  try {
    const endpoint = (
      await docker([
        "context",
        "inspect",
        "default",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ])
    )
      .toString()
      .trim();
    requireFixture(
      endpoint === "unix:///var/run/docker.sock",
      "LOCAL_DOCKER_REQUIRED",
    );
    const containers = (
      await docker(["ps", "--all", "--format", "{{.Names}}"])
    ).toString();
    const volumes = (
      await docker(["volume", "ls", "--format", "{{.Name}}"])
    ).toString();
    requireFixture(
      !containers.split(/\s+/u).some((name) => name.startsWith("supabase_")) &&
        !volumes.split(/\s+/u).some((name) => name.startsWith("supabase_")),
      "FRESH_CI_DOCKER_REQUIRED",
    );
    // /dev/shm is checked before any TLS public file is written there.
    const shm = await fs.statfs("/dev/shm");
    requireFixture(shm.type === 0x01021994, "HOST_TLS_TMPFS_REQUIRED");
    workspace = await privateDirectory(
      os.tmpdir(),
      `desmoslock-restore-${runId}-`,
    );
    tlsRoot = await privateDirectory(
      "/dev/shm",
      `desmoslock-restore-${runId}-`,
    );
    const sourceRoot = path.join(workspace.directory, "source");
    const backupRoot = path.join(workspace.directory, "backup");
    await fs.mkdir(backupRoot, { mode: 0o700 });
    await materializeSourceFixture(
      repositoryRoot,
      sourceRoot,
      sourceProject,
      CURRENT_MIGRATION_FILES,
    );
    stage = "TARGET_SETUP";
    ownsTarget = true;
    await run(cli, ["start"], {
      timeoutMs: 600_000,
      maxBytes: 16 * 1024 * 1024,
    });
    await run(cli, ["db", "reset", "--no-seed"], { timeoutMs: 300_000 });
    stage = "SOURCE_SETUP";
    ownsSource = true;
    await run(cli, ["start", "--exclude", SOURCE_EXCLUSIONS], {
      cwd: sourceRoot,
      timeoutMs: 600_000,
      maxBytes: 16 * 1024 * 1024,
    });
    await run(cli, ["db", "reset"], { cwd: sourceRoot, timeoutMs: 300_000 });
    const metadata = async (name) => {
      const value = decodeJson(
        await docker([
          "inspect",
          "--format",
          '{"name":{{json .Name}},"running":{{json .State.Running}},"image":{{json .Config.Image}},"imageId":{{json .Image}}}',
          name,
        ]),
      );
      requireFixture(
        value.name === `/${name}` && value.running === true,
        "RUN_OWNED_CONTAINER_REQUIRED",
      );
      return value;
    };
    const source = await metadata(sourceContainer),
      target = await metadata(targetContainer);
    requireFixture(
      source.image === target.image &&
        source.imageId === target.imageId &&
        /^sha256:[a-f0-9]{64}$/u.test(source.imageId) &&
        /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|supabase\/)postgres:17\.6\.1\.159(?:@sha256:[a-f0-9]{64})?$/u.test(
          source.image,
        ),
      "MATCHING_PINNED_POSTGRES_IMAGES_REQUIRED",
    );
    for (const project of [sourceProject, TARGET_PROJECT]) {
      const auth = await metadata(`supabase_auth_${project}`);
      requireFixture(
        /\/gotrue:v2\.195\.0(?:@sha256:[a-f0-9]{64})?$/u.test(auth.image),
        "PINNED_REAL_AUTH_REQUIRED",
      );
    }
    stage = "TLS_GENERATION";
    await docker(
      ["exec", "--user", "root", "--interactive", sourceContainer, "sh", "-s"],
      { input: tlsSetupScript(runId), timeoutMs: 60_000 },
    );
    stage = "TLS_RELOAD";
    const reload = await docker(
      [
        "exec",
        "--user",
        "postgres",
        "--interactive",
        sourceContainer,
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
      { input: tlsReloadSql(runId), timeoutMs: 30_000, maxBytes: 4096 },
    );
    requireFixture(
      reload.toString().trim() === "t",
      "POSTGRES_RELOAD_REQUIRED",
    );
    const ca = await docker(
      [
        "exec",
        "--user",
        "root",
        sourceContainer,
        "cat",
        `/dev/shm/desmoslock-restore-${runId}/ca.crt`,
      ],
      { maxBytes: 16_384 },
    );
    requireFixture(
      /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/u.test(
        ca.toString("ascii"),
      ),
      "PUBLIC_CA_INVALID",
    );
    const caPath = path.join(tlsRoot.directory, "ca.crt");
    await fs.writeFile(caPath, ca, { mode: 0o600 });
    const sourceConnection = connectionFromStatus(
      decodeJson(
        await run(cli, ["status", "--output", "json"], { cwd: sourceRoot }),
      ),
      SOURCE_PORT,
    );
    const targetConnection = connectionFromStatus(
      decodeJson(await run(cli, ["status", "--output", "json"])),
      TARGET_PORT,
    );
    stage = "NATIVE_CLIENT_SETUP";
    // Only the public CA enters this native-client container. The real operator,
    // Python publication launcher, and Node stay on their supported CI host.
    requireFixture(
      !containers.split(/\s+/u).includes(toolContainer),
      "TOOL_NAME_ALREADY_EXISTS",
    );
    ownsTool = true;
    await docker(
      [
        "create",
        "--name",
        toolContainer,
        "--label",
        `desmoslock.restore.run=${runId}`,
        "--read-only",
        "--network",
        "host",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--mount",
        safeMount(caPath, "/trust/ca.crt"),
        "--entrypoint",
        "/bin/sleep",
        source.imageId,
        "2147483647",
      ],
      { maxBytes: 4096 },
    );
    await docker(["start", toolContainer], { maxBytes: 4096 });
    requireFixture(
      (await metadata(toolContainer)).imageId === source.imageId,
      "TOOL_IMAGE_ID_MISMATCH",
    );
    const binaryRoot = path.join(workspace.directory, "native-clients");
    await fs.mkdir(binaryRoot, { mode: 0o700 });
    const executablePaths = {};
    for (const [key, binary] of [
      ["psql", "psql"],
      ["pgDump", "pg_dump"],
      ["pgRestore", "pg_restore"],
    ]) {
      const executable = path.join(binaryRoot, binary);
      await fs.writeFile(
        executable,
        nativeClientWrapper(toolContainer, binary),
        { mode: 0o700 },
      );
      executablePaths[key] = executable;
    }
    stage = "OPERATOR_WORKER";
    receipt = decodeJson(
      await run(
        node,
        [
          path.join(
            repositoryRoot,
            "tests/acceptance/synthetic-backup-runtime.mjs",
          ),
          "--operator-worker",
        ],
        {
          // Only stdin receives the synthetic database credentials and target marker.
          input: JSON.stringify({
            source: sourceConnection,
            target: targetConnection,
            marker: randomBytes(32).toString("hex"),
            backupRoot,
            executablePaths,
          }),
          environment: { LANG: "C", LC_ALL: "C" },
          timeoutMs: 360_000,
          maxBytes: 32_768,
        },
      ),
    );
    if (receipt.status === "failed") {
      const stages = [
        "CAPABILITIES",
        "TLS_VERIFY",
        "TLS_INVALID_CA_PROBE",
        "CLUSTER_IDENTITIES",
        "SESSION_TIMEZONES",
        "TARGET_ATTESTATION",
        "EXPORT",
        "RESTORE",
        "RESTORE_VERIFICATION",
        "SECOND_RESTORE",
        "MARKER_RETIREMENT",
        "POST_RETIREMENT_VERIFICATION",
      ];
      requireFixture(stages.includes(receipt.stage), "WORKER_FAILURE_INVALID");
      throw new FixtureFailure(receipt.stage);
    }
    requireRestoredWorkerReceipt(receipt);
    // The existing suite observes public health and then performs all three real
    // provider journeys on the restored fixture. Never reset/seed between these.
    stage = "STAFF_SUITE";
    await runStaffSuite(npm, {
      cwd: repositoryRoot,
      environment,
      signal,
      timeoutMs: 600_000,
    });
    receipt = { ...receipt, staffAuthSuiteOnRestoredTarget: true };
  } catch (error) {
    primaryFailure =
      error instanceof FixtureFailure
        ? error.withCode(`${stage}_${error.code}`)
        : new FixtureFailure(`${stage}_FAILED`);
  } finally {
    const cleanup = async (action) => {
      try {
        await action();
      } catch {
        cleanupFailures.push("CLEANUP_FAILED");
      }
    };
    if (ownsTool)
      await cleanup(async () => {
        const found = (
          await docker(
            [
              "ps",
              "--all",
              "--filter",
              `name=^/${toolContainer}$`,
              "--format",
              "{{.Names}}",
            ],
            { signal: undefined },
          )
        )
          .toString()
          .trim();
        if (found === "") return;
        requireFixture(
          found === toolContainer,
          "TOOL_CLEANUP_IDENTITY_CHANGED",
        );
        await docker(["rm", "--force", toolContainer], { signal: undefined });
      });
    if (ownsSource)
      await cleanup(() =>
        run(cli, ["stop", "--no-backup"], {
          cwd: path.join(workspace.directory, "source"),
          signal: undefined,
          timeoutMs: 120_000,
        }),
      );
    if (ownsTarget)
      await cleanup(() =>
        run(cli, ["stop", "--no-backup"], {
          signal: undefined,
          timeoutMs: 120_000,
        }),
      );
    await cleanup(() => removeOwnedDirectory(tlsRoot));
    // Preserve the nonsecret source configuration if stack cleanup failed.
    // The ephemeral CI runner owns final destruction; never erase recovery paths.
    if (cleanupFailures.length === 0)
      await cleanup(() => removeOwnedDirectory(workspace));
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
  if (primaryFailure)
    throw primaryFailure.withCode(
      cleanupFailures.length
        ? `${primaryFailure.code}_AND_CLEANUP_FAILED`
        : primaryFailure.code,
    );
  requireFixture(cleanupFailures.length === 0, "CLEANUP_FAILED");
  return receipt;
}

function pgEnvironment(connection, sslMode, sslRootCert) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PGDATABASE: "postgres",
    PGHOST: "127.0.0.1",
    PGPORT: connection.port,
    PGUSER: "postgres",
    PGPASSWORD: connection.password,
    PGSSLMODE: sslMode,
    ...(sslRootCert ? { PGSSLROOTCERT: sslRootCert } : {}),
  };
}

export function withSessionTimezone(runProcess, timezone) {
  return (request) =>
    runProcess({
      ...request,
      // Exercise an ambient session timezone while preserving the adapter's
      // explicit UTC export override. Never modify the process or database.
      environment: { PGTZ: timezone, ...request.environment },
    });
}

const PRISTINE_TEST_METADATA_QUERY = `select count(*) = 2 and bool_and(
  lifecycle = 'draft' and revision = 1
  and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
  and opened_at is null and ended_at is null and creation_request_id is null
) from desmoslock_v2.tests;`;

// Pin each complete fixture identity separately from its unchanged digest.
// Every added column is checked; an admitted authority can never be pristine.
const PRISTINE_STUDENT_METADATA_QUERY = `select count(*) = 2 and bool_and(coalesce(
  (id, workspace_id, test_id, state, seed_key) in (
    ('40000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '30000000-0000-4000-8000-000000000001'::uuid,
      'created', 'session.alpha.algebra'),
    ('40000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      'created', 'session.beta.algebra')
  )
  and synthetic_display_name is null
  and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
  and epoch = 1 and revision = 1
  and device_session_id is null and device_public_key is null
  and last_accepted_proof_counter = 0
  and maintenance_accepted_at = '{}'::timestamptz[]
  and capability_digest is null and capability_issued_at is null
  and capability_expires_at is null
  and reconnect_digest is null and reconnect_expires_at is null
  and join_request_id is null and join_operation_digest is null
  and join_admission_mode is null and join_material_digest is null
  and rotation_request_id is null and rotation_operation_digest is null
  and previous_reconnect_digest is null,
  false
)) from desmoslock_v2.student_sessions;`;

// These stores are observed only. They are never part of the seven-table export.
const EMPTY_STUDENT_RUNTIME_STORES_QUERY = `select
  not exists(select 1 from desmoslock_v2.student_join_materials)
  and not exists(select 1 from desmoslock_v2.student_device_bindings)
  and not exists(select 1 from desmoslock_v2.student_bootstrap_challenges)
  and not exists(select 1 from desmoslock_v2.student_bootstrap_limits)
  and not exists(select 1 from desmoslock_v2.student_device_proof_state)
  and not exists(select 1 from desmoslock_v2.student_protection_events);`;

export async function operatorWorker(
  configuration,
  repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
) {
  let stage = "CAPABILITIES";
  try {
    requireFixture(
      process.platform === "linux" && process.version === "v24.20.0",
      "PINNED_WORKER_RUNTIME_REQUIRED",
    );
    for (const [connection, port] of [
      [configuration?.source, SOURCE_PORT],
      [configuration?.target, TARGET_PORT],
    ]) {
      requireFixture(
        connection?.host === "127.0.0.1" &&
          connection.port === port &&
          connection.database === "postgres" &&
          connection.user === "postgres" &&
          typeof connection.password === "string" &&
          connection.password.length > 0 &&
          !connection.password.includes("\0"),
        "WORKER_CONNECTION_INVALID",
      );
    }
    requireFixture(
      /^[a-f0-9]{64}$/u.test(configuration.marker ?? ""),
      "WORKER_MARKER_INVALID",
    );
    const { createPostgresBackupAdapter, runBoundedSubprocess } = await import(
      pathToFileURL(
        path.join(
          repositoryRoot,
          "scripts/synthetic-backup/postgres-adapter.mjs",
        ),
      )
    );
    const {
      exportSyntheticBackup,
      restoreSyntheticBackup,
      SyntheticBackupRefusal,
      CURRENT_MIGRATION_SET_SHA256,
    } = await import(
      pathToFileURL(
        path.join(repositoryRoot, "scripts/synthetic-backup/operator.mjs"),
      )
    );
    const paths = configuration.executablePaths;
    requireFixture(
      paths &&
        Object.keys(paths).sort().join(",") === "pgDump,pgRestore,psql" &&
        Object.entries(paths).every(
          ([key, executable]) =>
            typeof executable === "string" &&
            path.isAbsolute(executable) &&
            path.basename(executable) ===
              { psql: "psql", pgDump: "pg_dump", pgRestore: "pg_restore" }[key],
        ) &&
        typeof configuration.backupRoot === "string" &&
        path.isAbsolute(configuration.backupRoot),
      "WORKER_PATHS_INVALID",
    );
    for (const executable of Object.values(paths)) {
      const version = await runBoundedSubprocess({
        executable,
        arguments: ["--version"],
        environment: { LANG: "C", LC_ALL: "C" },
        input: null,
        maxOutputBytes: 1024,
        timeoutMs: 5_000,
      });
      requireFixture(
        /\(PostgreSQL\) 17\./u.test(version.toString()),
        "POSTGRES_17_CLIENT_REQUIRED",
      );
    }
    // The real publication implementation requires this exact system launcher.
    await runBoundedSubprocess({
      executable: "/usr/bin/python3",
      arguments: ["-I", "-c", "import os,sys; assert hasattr(os, 'fchdir')"],
      environment: { LANG: "C", LC_ALL: "C" },
      input: null,
      maxOutputBytes: 1024,
      timeoutMs: 5_000,
    });
    const sourceTimezone = "Asia/Tokyo";
    const targetTimezone = "America/Los_Angeles";
    const sourceEnv = {
      ...pgEnvironment(configuration.source, "verify-full", "/trust/ca.crt"),
      PGTZ: sourceTimezone,
    };
    const targetEnv = {
      ...pgEnvironment(configuration.target, "disable"),
      PGTZ: targetTimezone,
    };
    const query = async (environment, statement) =>
      (
        await runBoundedSubprocess({
          executable: paths.psql,
          arguments: [
            "--no-psqlrc",
            "--quiet",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
          ],
          environment,
          input: Buffer.from(statement),
          maxOutputBytes: 65_536,
          timeoutMs: 30_000,
        })
      )
        .toString()
        .trim();
    stage = "TLS_VERIFY";
    requireFixture(
      (await query(
        sourceEnv,
        "select ssl from pg_stat_ssl where pid = pg_backend_pid();",
      )) === "t",
      "ACTUAL_TLS_REQUIRED",
    );
    stage = "TLS_INVALID_CA_PROBE";
    await boundedCommand(
      paths.psql,
      [
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      {
        environment: { ...sourceEnv, PGSSLROOTCERT: "/dev/null" },
        input: Buffer.from("select 1;"),
        maxBytes: 8192,
        timeoutMs: 30_000,
        expectInvalidRootCertificate: true,
      },
    );
    stage = "TLS_VERIFY";
    requireFixture(
      (await query(
        sourceEnv,
        "select ssl from pg_stat_ssl where pid = pg_backend_pid();",
      )) === "t",
      "TLS_RECHECK_REQUIRED",
    );
    stage = "CLUSTER_IDENTITIES";
    const sourceId = await query(
      sourceEnv,
      "select system_identifier::text from pg_control_system();",
    );
    const targetId = await query(
      targetEnv,
      "select system_identifier::text from pg_control_system();",
    );
    requireFixture(
      /^\d{10,32}$/u.test(sourceId) &&
        /^\d{10,32}$/u.test(targetId) &&
        sourceId !== targetId,
      "DISTINCT_CLUSTERS_REQUIRED",
    );
    for (const environment of [sourceEnv, targetEnv]) {
      requireFixture(
        (await query(
          environment,
          "select not exists(select 1 from auth.users);",
        )) === "t",
        "EMPTY_AUTH_REQUIRED",
      );
    }
    stage = "SESSION_TIMEZONES";
    for (const [environment, timezone, localTimestamp] of [
      [sourceEnv, sourceTimezone, "2000-01-01 09:00:00+09"],
      [targetEnv, targetTimezone, "1999-12-31 16:00:00-08"],
    ]) {
      requireFixture(
        (await query(environment, "show timezone;")) === timezone &&
          (await query(
            environment,
            "select '2000-01-01T00:00:00.000000Z'::timestamptz::text;",
          )) === localTimestamp,
        "DISTINCT_SESSION_TIMEZONES_REQUIRED",
      );
    }
    requireFixture(
      (await query(sourceEnv, PRISTINE_TEST_METADATA_QUERY)) === "t",
      "PRISTINE_SOURCE_TEST_METADATA_REQUIRED",
    );
    requireFixture(
      (await query(sourceEnv, PRISTINE_STUDENT_METADATA_QUERY)) === "t",
      "PRISTINE_SOURCE_STUDENT_METADATA_REQUIRED",
    );
    for (const environment of [sourceEnv, targetEnv]) {
      requireFixture(
        (await query(environment, EMPTY_STUDENT_RUNTIME_STORES_QUERY)) === "t",
        "EMPTY_STUDENT_RUNTIME_STORES_REQUIRED",
      );
    }
    stage = "TARGET_ATTESTATION";
    requireFixture(
      (await query(
        targetEnv,
        "select not exists(select 1 from desmoslock_v2.local_restore_target_attestation);",
      )) === "t",
      "FRESH_TARGET_MARKER_REQUIRED",
    );
    await query(
      targetEnv,
      `insert into desmoslock_v2.local_restore_target_attestation (id,marker,database_name,system_identifier) select 1,'${configuration.marker}',current_database(),system_identifier::text from pg_control_system();`,
    );
    const source = createPostgresBackupAdapter(
      {
        executablePaths: paths,
        profiles: {
          staging: {
            environment: "staging",
            connection: {
              ...configuration.source,
              sslMode: "verify-full",
              sslRootCert: "/trust/ca.crt",
            },
          },
        },
      },
      withSessionTimezone(runBoundedSubprocess, sourceTimezone),
    );
    const target = createPostgresBackupAdapter(
      {
        executablePaths: { psql: paths.psql, pgRestore: paths.pgRestore },
        profiles: {
          "local-restore": {
            environment: "local",
            localRestoreMarker: configuration.marker,
            connection: { ...configuration.target, sslMode: "disable" },
          },
        },
      },
      withSessionTimezone(runBoundedSubprocess, targetTimezone),
    );
    const before = await target.observeDatabase("local-restore");
    requireFixture(
      before.applicationState === "empty" &&
        (await query(
          targetEnv,
          "select not exists(select 1 from desmoslock_v2.student_sessions);",
        )) === "t",
      "UNSEEDED_TARGET_REQUIRED",
    );
    stage = "EXPORT";
    const exported = await exportSyntheticBackup(
      {
        backupRoot: configuration.backupRoot,
        backupName: "pristine-baseline",
        databaseAlias: "staging",
        expectedDatabaseIdentity: sourceId,
      },
      source,
    );
    const restoreSpec = {
      backupRoot: configuration.backupRoot,
      backupName: "pristine-baseline",
      databaseAlias: "local-restore",
      expectedDatabaseIdentity: targetId,
      expectedManifestSha256: exported.manifestSha256,
    };
    stage = "RESTORE";
    const restored = await restoreSyntheticBackup(restoreSpec, target);
    requireFixture(
      restored.postRestoreSyntheticFixtureVerified === true,
      "RESTORED_FIXTURE_REQUIRED",
    );
    stage = "RESTORE_VERIFICATION";
    const after = await target.observeDatabase("local-restore");
    requireFixture(
      after.applicationState === "synthetic-baseline" &&
        after.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256 &&
        isDeepStrictEqual(after.fixture?.counts, {
          baselineFixtureState: 1,
          foundationSeed: 1,
          memberships: 6,
          profiles: 6,
          studentSessions: 2,
          tests: 2,
          workspaces: 2,
        }),
      "RESTORED_COUNTS_REQUIRED",
    );
    requireFixture(
      (await query(targetEnv, "show timezone;")) === targetTimezone &&
        (await query(targetEnv, PRISTINE_TEST_METADATA_QUERY)) === "t" &&
        (await query(
          targetEnv,
          "select bool_and(created_at::text = '1999-12-31 16:00:00-08') from desmoslock_v2.tests;",
        )) === "t",
      "RESTORED_TEST_METADATA_REQUIRED",
    );
    requireFixture(
      (await query(targetEnv, PRISTINE_STUDENT_METADATA_QUERY)) === "t" &&
        (await query(
          targetEnv,
          "select bool_and(created_at::text = '1999-12-31 16:00:00-08') from desmoslock_v2.student_sessions;",
        )) === "t" &&
        (await query(targetEnv, EMPTY_STUDENT_RUNTIME_STORES_QUERY)) === "t",
      "RESTORED_STUDENT_METADATA_REQUIRED",
    );
    stage = "SECOND_RESTORE";
    let refused = false;
    try {
      await restoreSyntheticBackup(restoreSpec, target);
    } catch (error) {
      refused =
        error instanceof SyntheticBackupRefusal &&
        error.code === "TARGET_REFUSED";
    }
    requireFixture(
      refused &&
        isDeepStrictEqual(after, await target.observeDatabase("local-restore")),
      "SECOND_RESTORE_MUST_NOT_MUTATE",
    );
    // End only this fixture's temporary restore authorization before running
    // ordinary staff checks, which retain their empty-by-default marker test.
    // All interpolated identities have already passed exact hex/digit guards.
    stage = "MARKER_RETIREMENT";
    requireFixture(
      (await query(
        targetEnv,
        `do $fixture$
declare retired integer;
begin
  delete from desmoslock_v2.local_restore_target_attestation
  where id = 1
    and marker = '${configuration.marker}'
    and database_name = current_database()
    and database_name = 'postgres'
    and system_identifier = '${targetId}'
    and system_identifier = (
      select system_identifier::text from pg_control_system()
    );
  get diagnostics retired = row_count;
  if retired <> 1 or exists (
    select 1 from desmoslock_v2.local_restore_target_attestation
  ) then
    raise exception 'fixture marker retirement refused';
  end if;
end;
$fixture$;
select not exists(select 1 from desmoslock_v2.local_restore_target_attestation);`,
      )) === "t",
      "OWNED_MARKER_RETIREMENT_REQUIRED",
    );
    stage = "POST_RETIREMENT_VERIFICATION";
    requireFixture(
      (await query(
        targetEnv,
        `select
  current_database() = 'postgres'
  and (select system_identifier::text from pg_control_system()) = '${targetId}'
  and not exists(select 1 from desmoslock_v2.local_restore_target_attestation)
  and coalesce((
    select count(*) = 1 and bool_and(
      fixture_valid and schema_generation = 4
      and fixture_version = 'internal-baseline-v2'
      and fixture_digest = 'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
      and migration_set_sha256 = '${CURRENT_MIGRATION_SET_SHA256}'
    ) from desmoslock_v2.internal_baseline_status()
  ), false)
  and (select count(*) from desmoslock_v2.baseline_fixture_state) = 1
  and (select count(*) from desmoslock_v2.foundation_seed) = 1
  and (select count(*) from desmoslock_v2.memberships) = 6
  and (select count(*) from desmoslock_v2.profiles) = 6
  and (select count(*) from desmoslock_v2.student_sessions) = 2
  and (select count(*) from desmoslock_v2.tests) = 2
  and (select count(*) from desmoslock_v2.workspaces) = 2
  and coalesce((
    select count(*) = 1 and bool_and(
      id = 1 and schema_generation = 4
      and migration_set_sha256 = '${CURRENT_MIGRATION_SET_SHA256}'
    ) from desmoslock_v2.internal_release_attestation
  ), false);`,
      )) === "t",
      "POST_RETIREMENT_BASELINE_REQUIRED",
    );
    requireFixture(
      (await query(targetEnv, PRISTINE_TEST_METADATA_QUERY)) === "t" &&
        (await query(targetEnv, PRISTINE_STUDENT_METADATA_QUERY)) === "t" &&
        (await query(targetEnv, EMPTY_STUDENT_RUNTIME_STORES_QUERY)) === "t",
      "POST_RETIREMENT_METADATA_REQUIRED",
    );
    return {
      status: "restored",
      artifactSha256: exported.artifactSha256,
      manifestSha256: exported.manifestSha256,
      migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
      fixtureDigest: restored.fixtureDigest,
      tlsVerified: true,
      invalidCaRejected: true,
      distinctClusters: true,
      distinctSessionTimezones: true,
      testMetadataPreserved: true,
      studentMetadataPreserved: true,
      studentRuntimeStoresEmpty: true,
      secondRestoreRefused: true,
      restoreMarkerRetired: true,
    };
  } catch {
    return { status: "failed", stage };
  }
}

async function readWorkerInput() {
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(
    () => process.stdin.destroy(new FixtureFailure("WORKER_INPUT_TIMEOUT")),
    10_000,
  );
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      requireFixture(bytes <= 32_768, "WORKER_INPUT_LIMIT");
      chunks.push(chunk);
    }
    return decodeJson(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === "--operator-worker"
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await operatorWorker(await readWorkerInput()))}\n`,
    );
  } catch {
    process.stderr.write("DISPOSABLE_OPERATOR_WORKER_FAILED\n");
    process.exitCode = 1;
  }
}
