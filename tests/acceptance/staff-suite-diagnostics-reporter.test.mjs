import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import reporter, {
  parseStaffSuiteDiagnostics,
  staffSuiteNodeOptions,
} from "./staff-suite-diagnostics-reporter.mjs";

const prefix = "[desmoslock-staff-suite:v1] ";
const stackFile = "tests/acceptance/staff-auth-stack.test.mjs";
const locksFile = "tests/acceptance/revoke-membership-lock.test.mjs";
const composedFile = "tests/acceptance/staff-auth-composed.test.mjs";
const studentInteropFile = "tests/acceptance/student-session-interop.test.mjs";
const studentLocksFile = "tests/acceptance/student-session-locks.test.mjs";
const edgeCommand =
  "deno lint supabase/functions && deno test supabase/functions && deno check supabase/functions/health/index.ts supabase/functions/account-recovery/index.ts supabase/functions/staff-invitations/index.ts supabase/functions/student-session-challenge/index.ts supabase/functions/student-session-join/index.ts supabase/functions/student-session-read/index.ts supabase/functions/student-session-reconnect/index.ts supabase/functions/student-session-forfeit/index.ts";
const reporterPath = fileURLToPath(
  new URL("./staff-suite-diagnostics-reporter.mjs", import.meta.url),
);
const fixtureRoot = fileURLToPath(
  new URL("../../artifacts/local-tool-tmp/", import.meta.url),
);
const sentinel = "synthetic-private-diagnostic-sentinel";
const frame = (file = stackFile, line = 2, outcome = "passed") =>
  `${prefix}${JSON.stringify({ file, line, outcome })}\n`;
const empty = {
  stage: "unknown",
  records: [],
  eventCounters: { passed: 0, failed: 0, omitted: 0 },
};

async function rendered(events) {
  let output = "";
  for await (const chunk of reporter(events)) output += chunk;
  return output;
}

test("reporter exposes only the exact allowed file, positive line and closed outcome", async () => {
  const output = await rendered([
    {
      type: "test:pass",
      data: {
        file: path.resolve(stackFile),
        line: 2,
        name: sentinel,
        details: { error: new Error(sentinel) },
      },
    },
    {
      type: "test:fail",
      data: {
        file: locksFile,
        line: 1_000_000,
        name: sentinel,
        details: { stack: sentinel },
      },
    },
    { type: "test:pass", data: { file: composedFile, line: 19 } },
    ...[
      "test:stdout",
      "test:stderr",
      "test:diagnostic",
      "test:summary",
      "test:start",
      "error",
    ].map((type) => ({
      type,
      data: { file: stackFile, line: 2, message: sentinel },
    })),
  ]);
  assert.equal(
    output,
    frame(stackFile) +
      frame(locksFile, 1_000_000, "failed") +
      frame(composedFile, 19),
  );
  assert.ok(
    !output.includes(sentinel),
    "reporter disclosed an unapproved field",
  );
});

test("reporter rejects unknown paths and invalid location data", async () => {
  const output = await rendered([
    null,
    {},
    ...[
      0,
      -1,
      1.1,
      "2",
      null,
      undefined,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      1_000_001,
    ].map((line) => ({ type: "test:fail", data: { file: stackFile, line } })),
    ...[
      `${stackFile}.other`,
      `outside/${stackFile}`,
      sentinel,
      `/outside/${stackFile}`,
      "x".repeat(4_097),
      null,
    ].map((file) => ({ type: "test:fail", data: { file, line: 1 } })),
    {
      type: "test:fail",
      get data() {
        throw new Error(sentinel);
      },
    },
  ]);
  assert.equal(output, "");
  async function* brokenSource() {
    yield { type: "test:diagnostic", data: { message: sentinel } };
    throw new Error(sentinel);
  }
  assert.equal(await rendered(brokenSource()), "");
});

test("decoder retains only exact canonical frames and freezes its entire result", () => {
  const result = parseStaffSuiteDiagnostics(
    Buffer.from(
      `${sentinel}\n${frame(stackFile)}${frame(locksFile, 8, "failed")}`,
    ),
  );
  assert.deepEqual(result, {
    stage: "locks",
    records: [
      { file: stackFile, line: 2, outcome: "passed" },
      { file: locksFile, line: 8, outcome: "failed" },
    ],
    eventCounters: { passed: 1, failed: 1, omitted: 0 },
  });
  for (const value of [
    result,
    result.records,
    ...result.records,
    result.eventCounters,
  ])
    assert.ok(Object.isFrozen(value));
});

test("decoder rejects extra, duplicate, malformed, unknown and oversized fields without retaining raw input", () => {
  const invalid = [
    "null",
    "[]",
    "{}",
    "{",
    JSON.stringify({ file: stackFile, line: 2 }),
    JSON.stringify({
      file: stackFile,
      line: 2,
      outcome: "passed",
      error: sentinel,
    }),
    JSON.stringify({
      file: stackFile,
      line: 2,
      outcome: "passed",
      name: sentinel,
    }),
    JSON.stringify({
      file: stackFile,
      line: 2,
      outcome: "passed",
      stack: sentinel,
    }),
    JSON.stringify({
      file: `${stackFile}/${sentinel}`,
      line: 2,
      outcome: "failed",
    }),
    JSON.stringify({
      file: path.resolve(stackFile),
      line: 2,
      outcome: "failed",
    }),
    `{"file":"${stackFile}","line":2,"outcome":"${sentinel}","outcome":"passed"}`,
    JSON.stringify({ file: stackFile, line: 0, outcome: "passed" }),
    JSON.stringify({ file: stackFile, line: -1, outcome: "passed" }),
    JSON.stringify({ file: stackFile, line: 1_000_001, outcome: "passed" }),
    JSON.stringify({ file: stackFile, line: "2", outcome: "passed" }),
    JSON.stringify({ file: stackFile, line: 2, outcome: sentinel }),
    `${JSON.stringify({ file: stackFile, line: 2, outcome: "passed" })} ${sentinel}`,
    `${" ".repeat(257)}${JSON.stringify({ file: stackFile, line: 2, outcome: "passed" })}`,
    JSON.stringify({ file: stackFile, line: 2, outcome: "passed" }).replaceAll(
      "/",
      "\\/",
    ),
  ]
    .map((payload) => `${prefix}${payload}\n`)
    .join("");
  assert.deepEqual(parseStaffSuiteDiagnostics(invalid), empty);
  assert.deepEqual(parseStaffSuiteDiagnostics(`${sentinel}${frame()}`), empty);
  for (const value of [
    null,
    undefined,
    {},
    42,
    Buffer.alloc(2 * 1024 * 1024 + 1),
    "a".repeat(2 * 1024 * 1024 + 1),
  ]) {
    assert.deepEqual(parseStaffSuiteDiagnostics(value), empty);
  }
});

test("decoder retains the latest 32 records and counts only validated bounded frames", () => {
  const input = Array.from({ length: 80 }, (_, index) =>
    frame(locksFile, index + 1, index % 2 === 0 ? "passed" : "failed"),
  ).join("");
  const result = parseStaffSuiteDiagnostics(`${input}${prefix}${sentinel}\n`);
  assert.equal(result.records.length, 32);
  assert.equal(result.records[0].line, 49);
  assert.equal(result.records.at(-1).line, 80);
  assert.deepEqual(result.eventCounters, {
    passed: 40,
    failed: 40,
    omitted: 48,
  });
  assert.ok(Object.values(result.eventCounters).every(Number.isSafeInteger));
});

test("Student file locations retain the closed composed projection and reject lookalike or noncanonical frames", async () => {
  for (const file of [studentInteropFile, studentLocksFile]) {
    const output = await rendered([
      {
        type: "test:fail",
        data: {
          file: path.resolve(file),
          line: 7,
          name: sentinel,
          details: { error: new Error(sentinel) },
        },
      },
      { type: "test:stdout", data: { file, line: 7, message: sentinel } },
      { type: "test:stderr", data: { file, line: 7, message: sentinel } },
    ]);
    assert.equal(output, frame(file, 7, "failed"));
    assert.deepEqual(parseStaffSuiteDiagnostics(output), {
      stage: "composed",
      records: [{ file, line: 7, outcome: "failed" }],
      eventCounters: { passed: 0, failed: 1, omitted: 0 },
    });
    for (const invalidFile of [
      path.basename(file),
      `${file}.other`,
      `outside/${file}`,
      file.replace("student-session-", "student_session_"),
    ]) {
      assert.equal(
        await rendered([
          { type: "test:fail", data: { file: invalidFile, line: 7 } },
        ]),
        "",
      );
      assert.deepEqual(
        parseStaffSuiteDiagnostics(frame(invalidFile, 7, "failed")),
        empty,
      );
    }
    for (const payload of [
      JSON.stringify({ file, line: 7, outcome: "failed", error: sentinel }),
      `{"file":"${file}","line":7,"outcome":"${sentinel}","outcome":"failed"}`,
      JSON.stringify({ file, line: 7, outcome: "failed" }).replaceAll(
        "/",
        "\\/",
      ),
    ])
      assert.deepEqual(
        parseStaffSuiteDiagnostics(`${prefix}${payload}\n`),
        empty,
      );
  }
});

test("stage fallback accepts only the six exact current npm banner and command pairs", () => {
  const stages = [
    ["test:db", "supabase test db", "db"],
    ["test:staff-auth:stack", `node --test ${stackFile}`, "stack"],
    ["test:staff-auth:locks", `node --test ${locksFile}`, "locks"],
    ["test:edge", edgeCommand, "edge"],
    ["test:unit", "npm run build:packages && vitest run", "unit"],
    ["test:staff-auth:composed", `node --test ${composedFile}`, "composed"],
  ];
  for (const [script, command, stage] of stages) {
    const banner = `> desmoslock@2.0.0 ${script}\n> ${command}\n`;
    assert.equal(
      parseStaffSuiteDiagnostics(`${sentinel}\n${banner}`).stage,
      stage,
    );
    assert.equal(
      parseStaffSuiteDiagnostics(banner.replaceAll("\n", "\r\n")).stage,
      stage,
    );
    for (const invalid of [
      banner.replace("2.0.0", "2.0.1"),
      banner.replace(command, `${command} ${sentinel}`),
      `> ${command}\n`,
      banner.replace("\n>", `\n${sentinel}\n>`),
      `prefix ${banner}`,
    ]) {
      assert.equal(parseStaffSuiteDiagnostics(invalid).stage, "unknown");
    }
  }
  const edge = stages.find((entry) => entry[2] === "edge");
  assert.equal(
    parseStaffSuiteDiagnostics(
      `${frame()}\n> desmoslock@2.0.0 ${edge[0]}\n> ${edge[1]}\n`,
    ).stage,
    "edge",
  );
});

test("Edge fallback matches the Student package command and requires all five ordered Student entrypoints", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["test:edge"], edgeCommand);
  const banner = (command) => `> desmoslock@2.0.0 test:edge\n> ${command}\n`;
  assert.deepEqual(parseStaffSuiteDiagnostics(banner(edgeCommand)), {
    ...empty,
    stage: "edge",
  });
  const entrypoints = ["challenge", "join", "read", "reconnect", "forfeit"].map(
    (operation) => `supabase/functions/student-session-${operation}/index.ts`,
  );
  for (const command of [
    edgeCommand.slice(0, edgeCommand.indexOf(` ${entrypoints[0]}`)),
    ...entrypoints.map((entrypoint) =>
      edgeCommand.replace(` ${entrypoint}`, ""),
    ),
    edgeCommand.replace(
      `${entrypoints[3]} ${entrypoints[4]}`,
      `${entrypoints[4]} ${entrypoints[3]}`,
    ),
    edgeCommand.replace("student-session-join", "student-session-join-other"),
    `${edgeCommand} ${sentinel}`,
  ])
    assert.deepEqual(parseStaffSuiteDiagnostics(banner(command)), empty);
});

test("NODE_OPTIONS preserves owned bytes and rejects competing reporters, unsafe syntax and unknown options", () => {
  const existing = '  --no-warnings --max-old-space-size="128"  ';
  assert.ok(
    staffSuiteNodeOptions(existing, reporterPath).startsWith(`${existing} `),
  );
  assert.equal(
    staffSuiteNodeOptions(undefined, reporterPath),
    `"--test-reporter=${reporterPath}"`,
  );
  assert.equal(
    staffSuiteNodeOptions("", '/owned/a "quote" \\name.mjs'),
    '"--test-reporter=/owned/a \\"quote\\" \\\\name.mjs"',
  );
  const staticFailure = (error) =>
    error instanceof Error &&
    error.message === "STAFF_SUITE_NODE_OPTIONS_INVALID";
  for (const options of [
    "--test-reporter=spec",
    '"--test-reporter=spec"',
    "--test-reporter spec",
    "--test-reporter-destination=stdout",
    "--test_reporter=spec",
    "--test_reporter_destination stdout",
    `--not-a-node-option=${sentinel}`,
    sentinel,
    '"--no-warnings',
    "--no-warnings\n",
    "--no-warnings\0",
    {},
    "a".repeat(16_385),
  ])
    assert.throws(
      () => staffSuiteNodeOptions(options, reporterPath),
      staticFailure,
    );
  for (const file of [
    "relative.mjs",
    null,
    `/owned/${sentinel}\nreporter.mjs`,
    "/".repeat(4_097),
  ]) {
    assert.throws(() => staffSuiteNodeOptions("", file), staticFailure);
  }
});

function child(executable, args, options) {
  try {
    const result = spawnSync(executable, args, {
      ...options,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ok(
      !result.error && result.signal === null,
      "synthetic diagnostic child unavailable",
    );
    return result;
  } catch {
    throw new Error("SYNTHETIC_DIAGNOSTIC_CHILD_UNAVAILABLE");
  }
}

async function fixture(run) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(
    path.join(fixtureRoot, "staff-diagnostics-"),
  );
  try {
    await fs.mkdir(path.join(directory, "tests/acceptance"), {
      recursive: true,
    });
    await fs.mkdir(path.join(directory, "bin"));
    const userConfig = path.join(directory, "empty-user-npmrc");
    const globalConfig = path.join(directory, "empty-global-npmrc");
    await fs.writeFile(userConfig, "");
    await fs.writeFile(globalConfig, "");
    const ownReporter = path.join(directory, 'reporter "quoted" spaces.mjs');
    await fs.copyFile(reporterPath, ownReporter);
    // npm supplies this public executable path in normal repository scripts.
    // Direct node invocations can use the npm bundled beside that Node runtime.
    const npmCli =
      process.env.npm_execpath ??
      path.resolve(
        path.dirname(process.execPath),
        "../lib/node_modules/npm/bin/npm-cli.js",
      );
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(
      path.join(directory, "bin/npm"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(npmCli)} "$@"\n`,
      { mode: 0o700 },
    );
    const environment = {
      PATH: `${path.join(directory, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NODE_OPTIONS: staffSuiteNodeOptions("--no-warnings", ownReporter),
      npm_config_cache: path.join(directory, "npm-cache"),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_logs_max: "0",
      COREPACK_ENABLE_NETWORK: "0",
    };
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "desmoslock",
        version: "2.0.0",
        private: true,
        type: "module",
        scripts: {
          "test:staff-auth":
            "npm run test:staff-auth:stack && npm run test:staff-auth:locks && npm run test:staff-auth:composed",
          "test:staff-auth:stack": `node --test ${stackFile}`,
          "test:staff-auth:locks": `node --test ${locksFile}`,
          "test:staff-auth:composed": `node --test ${composedFile}`,
        },
      }),
    );
    await run({ directory, environment, npmCli });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("actual Node 24 custom reporter suppresses synthetic names, stdout, stderr and errors", async () => {
  assert.equal(process.version, "v24.20.0", "use the pinned Node runtime");
  await fixture(async ({ directory, environment }) => {
    await fs.writeFile(
      path.join(directory, stackFile),
      `import test from 'node:test';\ntest('${sentinel}-name', () => { console.log('${sentinel}-stdout'); console.error('${sentinel}-stderr'); });\ntest('${sentinel}-failure', () => { throw new Error('${sentinel}-error'); });\n`,
    );
    const result = child(process.execPath, ["--test", stackFile], {
      cwd: directory,
      env: environment,
    });
    assert.equal(result.status, 1);
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(sentinel),
      "reporter leaked private synthetic data",
    );
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      frame(stackFile, 2) + frame(stackFile, 3, "failed"),
    );
  });
});

for (const file of [studentInteropFile, studentLocksFile]) {
  test(`actual Node reporter keeps ${path.basename(file)} in the closed composed projection`, async () => {
    await fixture(async ({ directory, environment }) => {
      await fs.writeFile(
        path.join(directory, file),
        `import test from 'node:test';\ntest('${sentinel}-pass', () => { console.log('${sentinel}-stdout'); console.error('${sentinel}-stderr'); });\ntest('${sentinel}-failure', () => { throw new Error('${sentinel}-error'); });\n`,
      );
      const result = child(process.execPath, ["--test", file], {
        cwd: directory,
        env: environment,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, frame(file, 2) + frame(file, 3, "failed"));
      assert.deepEqual(parseStaffSuiteDiagnostics(result.stdout), {
        stage: "composed",
        records: [
          { file, line: 2, outcome: "passed" },
          { file, line: 3, outcome: "failed" },
        ],
        eventCounters: { passed: 1, failed: 1, omitted: 0 },
      });
    });
  });
}

test("actual npm run inherits the single reporter through the synthetic staff-stage chain", async () => {
  await fixture(async ({ directory, environment, npmCli }) => {
    await fs.writeFile(
      path.join(directory, stackFile),
      `import test from 'node:test';\ntest('${sentinel}-pass', () => { console.log('${sentinel}-stdout'); console.error('${sentinel}-stderr'); });\n`,
    );
    await fs.writeFile(
      path.join(directory, locksFile),
      `import test from 'node:test';\ntest('${sentinel}-failure', () => { throw new Error('${sentinel}-error'); });\n`,
    );
    await fs.writeFile(
      path.join(directory, composedFile),
      `throw new Error('${sentinel}-must-not-run');\n`,
    );
    const version = child(process.execPath, [npmCli, "--version"], {
      cwd: directory,
      env: environment,
    });
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^11\.[0-9]+\.[0-9]+$/u);
    const result = child(process.execPath, [npmCli, "run", "test:staff-auth"], {
      cwd: directory,
      env: environment,
    });
    assert.equal(result.status, 1);
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(sentinel),
      "npm chain leaked private synthetic data",
    );
    assert.deepEqual(parseStaffSuiteDiagnostics(result.stdout), {
      stage: "locks",
      records: [
        { file: stackFile, line: 2, outcome: "passed" },
        { file: locksFile, line: 2, outcome: "failed" },
      ],
      eventCounters: { passed: 1, failed: 1, omitted: 0 },
    });
  });
});
