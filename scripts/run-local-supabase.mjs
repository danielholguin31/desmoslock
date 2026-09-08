import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const minimalExclusions =
  "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
const commands = Object.freeze({
  "start-full": ["start"],
  "start-minimal": ["start", "--exclude", minimalExclusions],
  reset: ["db", "reset"],
  "reset-empty": ["db", "reset", "--no-seed"],
  stop: ["stop"],
});

function failureCategory(output) {
  if (/no space left|not enough space|disk full/iu.test(output))
    return "insufficient disk space";
  if (
    /cannot connect to.*docker|docker daemon|docker.sock|docker is not running/iu.test(
      output,
    )
  )
    return "Docker unavailable";
  if (/timed? ?out|deadline exceeded/iu.test(output))
    return "dependency timeout";
  if (
    /connection refused|network is unreachable|could not resolve/iu.test(output)
  )
    return "dependency network unavailable";
  if (/migration|sqlstate|syntax error/iu.test(output))
    return "migration or database command failed";
  return "local stack command failed";
}

/** Supabase start/status output can contain disposable credentials. Never relay it. */
export function runLocalSupabase(action, run = spawnSync) {
  if (!Object.hasOwn(commands, action))
    throw new Error("Unsupported local Supabase action");
  const args = commands[action];
  const result = run("supabase", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
    timeout: 600_000,
  });
  if (result.status !== 0 || result.error !== undefined) {
    const category =
      result.error?.code === "ETIMEDOUT"
        ? "command timeout"
        : result.error?.code === "ENOENT"
          ? "Supabase CLI unavailable"
          : failureCategory(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const status = Number.isInteger(result.status)
      ? result.status
      : "unavailable";
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const sqlState = /\bSQLSTATE\s*[:=]?\s*([a-z0-9]{5})\b/iu
      .exec(output)?.[1]
      ?.toUpperCase();
    const statement = /\bstatement\s+([0-9]{1,6})\b/iu.exec(output)?.[1];
    const detail = `${sqlState === undefined ? "" : `; SQLSTATE ${sqlState}`}${statement === undefined ? "" : `; statement ${statement}`}`;
    throw new Error(
      `Supabase ${action}: ${category} (exit ${status}${detail}). Raw output withheld because it can contain credentials.`,
    );
  }
  return `Supabase ${action} completed.`;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[2];
  process.stdout.write(
    `Running disposable Supabase ${Object.hasOwn(commands, action ?? "") ? action : "command"}.\n`,
  );
  try {
    process.stdout.write(`${runLocalSupabase(action)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Local Supabase command unavailable"}\n`,
    );
    process.exitCode = 1;
  }
}
