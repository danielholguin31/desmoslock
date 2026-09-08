import path from "node:path";

const PREFIX = "[desmoslock-staff-suite:v1] ";
const MAX_FRAME_BYTES = 256;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 32;
const MAX_LINE = 1_000_000;
const FILE_STAGES = new Map([
  ["tests/acceptance/staff-auth-stack.test.mjs", "stack"],
  ["tests/acceptance/revoke-membership-lock.test.mjs", "locks"],
  ["tests/acceptance/staff-auth-composed.test.mjs", "composed"],
  ["tests/acceptance/student-session-interop.test.mjs", "composed"],
  ["tests/acceptance/student-session-locks.test.mjs", "composed"],
]);
const SCRIPT_STAGES = new Map([
  ["> desmoslock@2.0.0 test:db\n> supabase test db", "db"],
  [
    "> desmoslock@2.0.0 test:staff-auth:stack\n> node --test tests/acceptance/staff-auth-stack.test.mjs",
    "stack",
  ],
  [
    "> desmoslock@2.0.0 test:staff-auth:locks\n> node --test tests/acceptance/revoke-membership-lock.test.mjs",
    "locks",
  ],
  [
    "> desmoslock@2.0.0 test:edge\n> deno lint supabase/functions && deno test supabase/functions && deno check supabase/functions/health/index.ts supabase/functions/account-recovery/index.ts supabase/functions/staff-invitations/index.ts supabase/functions/student-session-challenge/index.ts supabase/functions/student-session-join/index.ts supabase/functions/student-session-read/index.ts supabase/functions/student-session-reconnect/index.ts supabase/functions/student-session-forfeit/index.ts",
    "edge",
  ],
  [
    "> desmoslock@2.0.0 test:unit\n> npm run build:packages && vitest run",
    "unit",
  ],
  [
    "> desmoslock@2.0.0 test:staff-auth:composed\n> node --test tests/acceptance/staff-auth-composed.test.mjs",
    "composed",
  ],
]);

function validRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, "file") &&
    Object.hasOwn(value, "line") &&
    Object.hasOwn(value, "outcome") &&
    FILE_STAGES.has(value.file) &&
    Number.isSafeInteger(value.line) &&
    value.line > 0 &&
    value.line <= MAX_LINE &&
    (value.outcome === "passed" || value.outcome === "failed")
  );
}

// No event name, error, stack, provider payload, stdout or stderr is forwarded.
export default async function* staffSuiteDiagnosticsReporter(source) {
  try {
    const files = new Map(
      [...FILE_STAGES.keys()].map((file) => [
        path.resolve(process.cwd(), file),
        file,
      ]),
    );
    for await (const event of source) {
      try {
        if (event?.type !== "test:pass" && event?.type !== "test:fail")
          continue;
        const input = event.data;
        if (typeof input?.file !== "string" || input.file.length > 4_096)
          continue;
        const file = files.get(path.resolve(process.cwd(), input.file));
        const record = {
          file,
          line: input.line,
          outcome: event.type === "test:pass" ? "passed" : "failed",
        };
        if (validRecord(record)) yield `${PREFIX}${JSON.stringify(record)}\n`;
      } catch {
        /* Malformed events carry no admissible diagnostic data. */
      }
    }
  } catch {
    /* Even a failed event stream must not disclose its error. */
  }
}

export function parseStaffSuiteDiagnostics(stdout) {
  let stage = "unknown";
  const records = [];
  const eventCounters = { passed: 0, failed: 0, omitted: 0 };
  const result = () =>
    Object.freeze({
      stage,
      records: Object.freeze(records),
      eventCounters: Object.freeze(eventCounters),
    });
  if (
    (!Buffer.isBuffer(stdout) && typeof stdout !== "string") ||
    Buffer.byteLength(stdout) > MAX_INPUT_BYTES
  )
    return result();
  let previous = "";
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    const bannerStage = SCRIPT_STAGES.get(`${previous}\n${line}`);
    if (bannerStage !== undefined) stage = bannerStage;
    previous = line;
    if (!line.startsWith(PREFIX) || Buffer.byteLength(line) > MAX_FRAME_BYTES)
      continue;
    try {
      const payload = line.slice(PREFIX.length);
      const parsed = JSON.parse(payload);
      if (!validRecord(parsed)) continue;
      const record = {
        file: parsed.file,
        line: parsed.line,
        outcome: parsed.outcome,
      };
      // The owned reporter emits exactly this canonical shape. Reject duplicate
      // fields, escapes and extra syntax instead of normalizing foreign frames.
      if (JSON.stringify(record) !== payload) continue;
      eventCounters[record.outcome] += 1;
      if (records.length === MAX_RECORDS) {
        records.shift();
        eventCounters.omitted += 1;
      }
      records.push(Object.freeze(record));
      stage = FILE_STAGES.get(record.file);
    } catch {
      /* Raw or malformed subprocess text never becomes a record. */
    }
  }
  return result();
}

function optionTokens(options) {
  const tokens = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const character of options) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (character === " " && !quoted) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
    } else token += character;
  }
  if (quoted || escaped) throw new Error();
  if (token.length > 0) tokens.push(token);
  return tokens;
}

export function staffSuiteNodeOptions(existingOptions, reporterAbsolutePath) {
  try {
    const existing = existingOptions ?? "";
    const hasControl = (value) =>
      [...value].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      });
    if (
      typeof existing !== "string" ||
      existing.length > 16_384 ||
      hasControl(existing) ||
      typeof reporterAbsolutePath !== "string" ||
      reporterAbsolutePath.length > 4_096 ||
      hasControl(reporterAbsolutePath) ||
      !path.isAbsolute(reporterAbsolutePath)
    )
      throw new Error();
    const tokens = optionTokens(existing);
    for (const [index, token] of tokens.entries()) {
      const name = token.split("=", 1)[0].replaceAll("_", "-");
      if (name === "--test-reporter" || name === "--test-reporter-destination")
        throw new Error();
      if (token.startsWith("-")) {
        if (!process.allowedNodeEnvironmentFlags.has(token)) throw new Error();
      } else if (index === 0 || !tokens[index - 1].startsWith("-"))
        throw new Error();
    }
    const argument = `--test-reporter=${reporterAbsolutePath}`
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    return `${existing}${existing.length > 0 ? " " : ""}"${argument}"`;
  } catch {
    throw new Error("STAFF_SUITE_NODE_OPTIONS_INVALID");
  }
}
