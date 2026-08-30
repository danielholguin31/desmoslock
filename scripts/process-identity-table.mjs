import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const psExecutable = ["/bin/ps", "/usr/bin/ps"].find((candidate) =>
  fs.existsSync(candidate),
);

function validatePid(pid, name) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`${name} must be a safe positive pid greater than one`);
  }
}

export async function readProcessIdentityTable() {
  if (psExecutable === undefined) {
    throw new Error(
      "A trusted ps executable is required for process identity checks",
    );
  }
  const { stdout } = await execFileAsync(
    psExecutable,
    ["-axo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2_000,
    },
  );
  const identities = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match === null) continue;
    identities.push(
      Object.freeze({
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        processId: Number(match[1]),
        startedAt: match[4],
      }),
    );
  }
  return Object.freeze(identities);
}

async function readRetirementIdentityTable() {
  if (psExecutable === undefined) {
    throw new Error(
      "A trusted ps executable is required for process identity checks",
    );
  }
  const { stdout } = await execFileAsync(
    psExecutable,
    ["-axo", "pid=,lstart="],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2_000,
    },
  );
  const identities = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (match === null) continue;
    identities.push(
      Object.freeze({
        processId: Number(match[1]),
        startedAt: match[2],
      }),
    );
  }
  return Object.freeze(identities);
}

export function findProcessIdentity(identities, processId) {
  validatePid(processId, "Process identity lookup");
  return (
    identities.find((identity) => identity.processId === processId) ?? null
  );
}

export function selectDescendantProcessIdentities(identities, rootProcessId) {
  validatePid(rootProcessId, "Descendant root");
  const selected = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of identities) {
      if (
        !selected.has(identity.processId) &&
        selected.has(identity.parentPid)
      ) {
        selected.add(identity.processId);
        changed = true;
      }
    }
  }
  return Object.freeze(
    identities.filter((identity) => selected.has(identity.processId)),
  );
}

export function selectProcessGroupIdentities(identities, processGroupId) {
  validatePid(processGroupId, "Process group identity lookup");
  return Object.freeze(
    identities.filter((identity) => identity.processGroupId === processGroupId),
  );
}

export async function waitForProcessIdentitiesToDisappear(
  recordedIdentities,
  timeoutMilliseconds,
) {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    throw new Error("Process identity timeout must be non-negative and finite");
  }
  const deadline = Date.now() + timeoutMilliseconds;
  let remaining;
  do {
    const current = await readRetirementIdentityTable();
    remaining = recordedIdentities.filter((recorded) =>
      current.some(
        (identity) =>
          identity.processId === recorded.processId &&
          identity.startedAt === recorded.startedAt,
      ),
    );
    if (remaining.length === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return Object.freeze(remaining);
}
