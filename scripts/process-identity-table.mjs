import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const psExecutable = ["/bin/ps", "/usr/bin/ps"].find((candidate) =>
  fs.existsSync(candidate),
);
const processStartPattern =
  "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}";
const processIdentityLinePattern = new RegExp(
  `^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${processStartPattern})\\s*$`,
);
const retirementIdentityLinePattern = new RegExp(
  `^\\s*(\\d+)\\s+(${processStartPattern})\\s*$`,
);

function validatePid(pid, name) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`${name} must be a safe positive pid greater than one`);
  }
}

function parseSafeInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} is malformed`);
  }
  return parsed;
}

export function parseProcessIdentityTable(stdout) {
  const identities = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = line.match(processIdentityLinePattern);
    if (match === null) {
      throw new Error("Trusted ps returned a malformed process identity row");
    }
    identities.push(
      Object.freeze({
        parentPid: parseSafeInteger(match[2], "Process parent pid", 0),
        processGroupId: parseSafeInteger(match[3], "Process group identity", 1),
        processId: parseSafeInteger(match[1], "Process identity", 1),
        startedAt: match[4],
      }),
    );
  }
  return Object.freeze(identities);
}

export function parseRetirementIdentityTable(stdout) {
  const identities = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = line.match(retirementIdentityLinePattern);
    if (match === null) {
      throw new Error(
        "Trusted ps returned a malformed retirement identity row",
      );
    }
    identities.push(
      Object.freeze({
        processId: parseSafeInteger(match[1], "Retirement identity", 1),
        startedAt: match[2],
      }),
    );
  }
  return Object.freeze(identities);
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
  return parseProcessIdentityTable(stdout);
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
  return parseRetirementIdentityTable(stdout);
}

export function findProcessIdentity(identities, processId) {
  validatePid(processId, "Process identity lookup");
  return (
    identities.find((identity) => identity.processId === processId) ?? null
  );
}

export function selectDescendantProcessIdentities(identities, rootIdentity) {
  validatePid(rootIdentity?.processId, "Descendant root");
  if (
    typeof rootIdentity.startedAt !== "string" ||
    rootIdentity.startedAt.length === 0
  ) {
    throw new Error("Descendant root must include its process start identity");
  }
  const liveRoot = identities.some(
    (identity) =>
      identity.processId === rootIdentity.processId &&
      identity.startedAt === rootIdentity.startedAt,
  );
  if (!liveRoot) return Object.freeze([]);

  const selected = new Set([rootIdentity.processId]);
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
