import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildDesktopAACProtection } from "../../scripts/build-desktop-aac-protection.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.platform === "darwin";

async function fixture(t) {
  const base = path.join(repository, "artifacts/local-tool-tmp");
  assert.equal(await fs.realpath(base), base);
  const root = await fs.mkdtemp(path.join(base, "aac-source-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test(
  "real AAC adapter strictly compiles and links without loading or invoking it",
  { skip: !enabled },
  async () => {
    const result = await buildDesktopAACProtection();
    assert.equal(result.supported, true);
    assert.equal(result.napi, 8);
    assert.equal(result.architecture, process.arch);
    const binary = await fs.readFile(result.outputFile);
    assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
    assert.equal(
      binary.readUInt32LE(4),
      process.arch === "arm64" ? 0x0100000c : 0x01000007,
    );
    const { stdout } = await execute(
      "/usr/bin/otool",
      ["-L", result.outputFile],
      {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        timeout: 10_000,
        maxBuffer: 65_536,
      },
    );
    for (const framework of [
      "AutomaticAssessmentConfiguration",
      "AppKit",
      "Foundation",
    ]) {
      assert.ok(
        stdout.includes(`/${framework}.framework/`),
        `linked ${framework}`,
      );
    }
    // Deliberately no require(), import() or Electron launch for the native binary.
  },
);

test(
  "shared native lifecycle driver exercises cancellation, ordering, stale delivery and policy without frameworks",
  { skip: !enabled },
  async (t) => {
    const root = await fixture(t);
    const compiler = process.env.DESMOSLOCK_NATIVE_CLANG;
    const sdk = process.env.DESMOSLOCK_NATIVE_SDK;
    assert.ok(
      compiler && sdk,
      "the frozen existing compiler and SDK are required",
    );
    assert.equal(process.versions.node, "24.20.0");
    const output = path.join(root, "aac-lifecycle-driver");
    const env = {
      PATH: `${path.dirname(compiler)}:/usr/bin:/bin`,
      LC_ALL: "C",
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      CLANG_MODULE_CACHE_PATH: root,
    };
    await execute(
      compiler,
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fno-modules",
        "-arch",
        process.arch === "x64" ? "x86_64" : "arm64",
        "-mmacosx-version-min=13.0",
        "-isysroot",
        sdk,
        "-B",
        path.dirname(compiler),
        "-lc++",
        path.join(repository, "tests/native/aac-protection-state.test.cpp"),
        "-o",
        output,
      ],
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const { stdout, stderr } = await execute(output, [], {
      env,
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    assert.equal(stderr, "");
    const observations = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = observations.pop();
    assert.deepEqual(summary, { passed: 13, frameworkCalls: 0 });
    assert.equal(new Set(observations.map((value) => value.case)).size, 13);
    for (const value of observations) {
      assert.equal(value.passed, true, value.case);
    }
    t.diagnostic(JSON.stringify({ syntheticCoreCases: observations, summary }));
  },
);

test(
  "native assessment builder rejects a redirected output ancestor",
  {
    skip: !enabled,
  },
  async (t) => {
    const root = await fixture(t);
    const checkout = path.join(root, "synthetic-checkout");
    const external = path.join(root, "synthetic-external");
    await fs.mkdir(path.join(checkout, "scripts"), { recursive: true });
    await fs.mkdir(path.join(checkout, "apps/desktop"), { recursive: true });
    await fs.mkdir(external);
    await fs.symlink(external, path.join(checkout, "apps/desktop/dist"));
    const copied = path.join(
      checkout,
      "scripts/build-desktop-aac-protection.mjs",
    );
    await fs.copyFile(
      path.join(repository, "scripts/build-desktop-aac-protection.mjs"),
      copied,
    );
    const builder = await import(pathToFileURL(copied).href);
    await assert.rejects(
      builder.buildDesktopAACProtection(),
      /output ancestors must be owned directories/,
    );
    assert.deepEqual(await fs.readdir(external), []);
  },
);
