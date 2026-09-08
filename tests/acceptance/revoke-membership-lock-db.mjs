import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const container = "supabase_db_desmoslock-v2";
const maximumOutputBytes = 256 * 1024;
const dockerEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_CONTEXT: "default",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};
let verified = false;

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

function command(args, input) {
  const result = spawnSync("docker", ["--context", "default", ...args], {
    cwd: root,
    env: dockerEnvironment,
    encoding: "utf8",
    input,
    maxBuffer: maximumOutputBytes,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15_000,
    shell: false,
  });
  check(
    !result.error && result.status === 0,
    "Local concurrency command failed; raw output withheld",
  );
  return result.stdout.trim();
}

function psqlArguments() {
  check(verified, "The disposable database guard has not passed");
  return [
    "exec",
    "-i",
    container,
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
  ];
}

export function sql(statement) {
  return command(psqlArguments(), statement);
}

export function sqlUuid(value) {
  check(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        value,
      ),
    "Concurrency fixture identifier is invalid",
  );
  return `'${value}'::uuid`;
}

export function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      "Concurrency query returned malformed JSON; output withheld",
    );
  }
}

export function verifyDisposableDatabase() {
  check(
    command([
      "context",
      "inspect",
      "default",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]) === "unix:///var/run/docker.sock",
    "Concurrency acceptance requires the default local Unix Docker runtime",
  );
  const metadata = command([
    "inspect",
    "--format",
    "{{json .Name}}\n{{json .State.Running}}\n{{json .Config.Image}}",
    container,
  ])
    .split("\n")
    .map(parseJson);
  check(
    metadata.length === 3 &&
      metadata[0] === `/${container}` &&
      metadata[1] === true &&
      /^(?:public\.ecr\.aws\/supabase\/|ghcr\.io\/supabase\/|supabase\/)postgres:17\./u.test(
        metadata[2],
      ),
    "Concurrency acceptance requires the running disposable PostgreSQL 17 container",
  );
  verified = true;
}

// Framed stdin/stdout avoids shell interpolation and allows one outstanding SQL
// command per connection. Server output is bounded and never used in errors.
export async function openConnection(name) {
  check(
    /^[a-z0-9-]{1,63}$/u.test(name),
    "Invalid concurrency connection label",
  );
  const child = spawn("docker", ["--context", "default", ...psqlArguments()], {
    cwd: root,
    env: dockerEnvironment,
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
  });
  let pending;
  let closed = false;
  let failure;
  let buffer = "";
  let outputBytes = 0;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  function fail() {
    failure ??= new Error(
      "Concurrency SQL connection failed; raw output withheld",
    );
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  }
  child.on("error", () => {
    fail();
    resolveExit();
  });
  child.stdin.on("error", fail);
  child.on("close", () => {
    closed = true;
    fail();
    resolveExit();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maximumOutputBytes) {
      fail();
      child.kill("SIGTERM");
      return;
    }
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      if (!pending) {
        fail();
        continue;
      }
      if (line === pending.marker) {
        const completed = pending;
        pending = undefined;
        clearTimeout(completed.timer);
        completed.resolve(completed.lines);
      } else {
        pending.lines.push(line);
      }
    }
  });
  const watchdog = setTimeout(() => {
    fail();
    child.stdin.end("\nrollback;\n\\q\n");
    child.kill("SIGTERM");
  }, 35_000);
  async function query(statement) {
    check(
      !closed && !failure && !pending,
      "Concurrency connection is unavailable or busy",
    );
    const marker = `lock_test_${randomUUID().replaceAll("-", "")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail();
        child.stdin.end("\nrollback;\n\\q\n");
      }, 10_000);
      pending = { marker, lines: [], resolve, reject, timer };
      child.stdin.write(`${statement}\n\\echo ${marker}\n`);
    });
  }
  async function close() {
    clearTimeout(watchdog);
    if (!closed && !child.stdin.destroyed)
      child.stdin.end("\nrollback;\n\\q\n");
    let timer;
    const finished = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      child.kill("SIGTERM");
      throw new Error(
        "Concurrency connection did not close; CI must stop the disposable stack",
      );
    }
  }
  try {
    await query(`set application_name = '${name}';
set statement_timeout = '8s';
set lock_timeout = '6s';
set idle_in_transaction_session_timeout = '12s';`);
    const rows = await query("select pg_backend_pid();");
    check(
      rows.length === 1 && /^[1-9][0-9]*$/u.test(rows[0]),
      "Concurrency backend PID is invalid",
    );
    return { name, pid: Number(rows[0]), query, close };
  } catch {
    await close();
    throw new Error(
      "Concurrency connection startup failed; raw output withheld",
    );
  }
}
