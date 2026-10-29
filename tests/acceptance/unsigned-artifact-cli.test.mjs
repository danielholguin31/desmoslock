import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliUrl = new URL(
  "../../scripts/collect-unsigned-desktop.mjs",
  import.meta.url,
).href;
const sharedUrl = new URL(
  "../../scripts/unsigned-artifact-inputs.mjs",
  import.meta.url,
).href;
const identitySource = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactSource = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      [cliUrl, sharedUrl].includes(context.parentURL) &&
      specifier === "../packages/contracts/dist/build-identity.js"
    )
      return nextResolve(identitySource, context);
    if (
      context.parentURL === identitySource &&
      specifier === "./exact-record.js"
    )
      return nextResolve(exactSource, context);
    return nextResolve(specifier, context);
  },
});
const {
  collectUnsignedDesktopForTesting,
  createUnsignedCollectorCommandEnvironment,
  isUnsignedCollectorSourcePath,
  inspectUnsignedCollectorDependencyNames,
  parseUnsignedArtifactDescriptor,
  parseUnsignedCollectorArguments,
  verifyUnsignedArtifactInputsForTesting,
} = await import(cliUrl);
const { canonicalClientBuildInputs } = await import(identitySource);
hooks.deregister();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runId = "8d63cbaa-8f7b-4939-9ef1-8234c2bebc55";
const testParent = fileURLToPath(
  new URL("../../artifacts/local-tool-tmp", import.meta.url),
);
async function prepareTestParent(
  repositoryRoot = path.resolve(testParent, "../.."),
) {
  const validate = async (filename) => {
    const status = await fs.lstat(filename);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Synthetic fixture parent must be a real directory",
    );
    assert.equal(
      await fs.realpath(filename),
      filename,
      "Synthetic fixture parent must have real ancestors",
    );
    assert.equal(
      status.uid,
      process.getuid(),
      "Synthetic fixture parent must be owned",
    );
    assert.equal(
      status.mode & 0o022,
      0,
      "Synthetic fixture parent must not be shared writable",
    );
  };
  await validate(repositoryRoot);
  let current = repositoryRoot;
  for (const component of ["artifacts", "local-tool-tmp"]) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await validate(current);
  }
  return current;
}
const publicBackend = { environment: "local", url: "http://127.0.0.1:43175" };
function descriptor() {
  return {
    schemaVersion: 1,
    inputs: {
      schemaVersion: 1,
      sourceRepository: "danielholguin31/desmoslock",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      packageLockSha256: "c".repeat(64),
      packageVersion: "2.0.0",
      platform: "darwin",
      architecture: "arm64",
      backendConfigurationSha256: hash(JSON.stringify(publicBackend)),
      graphingProfile: "internal-graphing-v1",
      tools: {
        node: { version: "24.20.0", sha256: "1".repeat(64) },
        npm: { version: "11.12.1", sha256: "2".repeat(64) },
        electron: { version: "43.8.4", archiveSha256: "3".repeat(64) },
        packager: { version: "20.3.0" },
        fuses: { version: "2.1.3" },
        compiler: {
          version: "Apple clang version 17.0.0",
          sha256: "4".repeat(64),
        },
        sdk: {
          version: "26.2",
          buildVersion: "25C57",
          settingsSha256: "5".repeat(64),
        },
        nodeHeadersSha256: "6".repeat(64),
      },
    },
    review: {
      sourceCommit: "a".repeat(40),
      mainRef: "refs/remotes/origin/main",
      ciCommit: "a".repeat(40),
      ciUrl:
        "https://github.com/danielholguin31/desmoslock/actions/runs/123456",
    },
    publicBackend,
    sourceManifest: [
      {
        path: "package.json",
        mode: "100644",
        gitBlob: "7".repeat(40),
        sha256: "8".repeat(64),
        bytes: 64,
      },
    ],
    paths: {
      node: "/synthetic/node/bin/node",
      npm: "/synthetic/npm/bin/npm-cli.js",
      compiler: "/synthetic/tools/clang",
      sdk: "/synthetic/SDK",
      nodeHeaders: "/synthetic/headers",
      electronZipDirectory: "/synthetic/electron",
      dependencies: "/synthetic/provider/node_modules",
    },
    dependencies: [
      {
        name: "typescript",
        version: "6.0.3",
        packageJsonSha256: "9".repeat(64),
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    ],
    executionFiles: [
      "typescript/bin/tsc",
      "typescript/lib/_tsc.js",
      "esbuild/lib/main.js",
      "@esbuild/darwin-arm64/bin/esbuild",
    ].map((filename) => ({
      path: filename,
      sha256: "d".repeat(64),
      bytes: 123,
    })),
    nativeHelperSha256: "e".repeat(64),
  };
}
function identity(inputs) {
  return {
    schemaVersion: 1,
    sourceRepository: inputs.sourceRepository,
    sourceCommit: inputs.sourceCommit,
    sourceTree: inputs.sourceTree,
    packageLockSha256: inputs.packageLockSha256,
    buildId: hash(canonicalClientBuildInputs(inputs)),
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await prepareTestParent(), "unsigned-cli-"),
  );
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "artifacts"), { mode: 0o755 });
  await fs.mkdir(path.join(root, "artifacts/unsigned-artifact-inputs"), {
    mode: 0o700,
  });
  const inputPath = path.join(
    root,
    "artifacts/unsigned-artifact-inputs",
    `${runId}.json`,
  );
  await fs.writeFile(inputPath, JSON.stringify(descriptor()), {
    flag: "wx",
    mode: 0o600,
  });
  const calls = [];
  let snapshot;
  let changed = false;
  let verificationFailure = false;
  let buildFailure = false;
  let packageFailure = false;
  let drain = true;
  let closeCount = 0;
  let closeFailureOrdinal = null;
  let outputUncertain = false;
  let evidenceFailureCase = null;
  let openCount = 0;
  const packaged = (packageDirectory) => ({
    packageDirectory,
    appBundle: path.join(packageDirectory, "DesmosLock Internal.app"),
    executable: path.join(
      packageDirectory,
      "DesmosLock Internal.app/Contents/MacOS/desmoslock-internal",
    ),
    tree: {
      entries: [
        {
          path: "synthetic.txt",
          type: "file",
          sha256: "f".repeat(64),
          bytes: 4,
          mode: 0o600,
        },
      ],
      sha256: (changed ? "2" : "f").repeat(64),
    },
    nativeArtifacts: [
      {
        path: "dist/native/durable-record.node",
        architecture: "arm64",
        sha256: "3".repeat(64),
        bytes: 32,
      },
    ],
    fuses: {
      RunAsNode: "DISABLE",
      EnableNodeOptionsEnvironmentVariable: "DISABLE",
      EnableNodeCliInspectArguments: "DISABLE",
    },
  });
  const dependencies = {
    command() {
      throw new Error("Actual child command forbidden in synthetic CLI tests");
    },
    build: {
      createDesktopBuildContext: (inputs) => ({ identity: identity(inputs) }),
    },
    async verifyInputs(_root, value) {
      calls.push("verify-inputs");
      if (verificationFailure)
        throw new Error("Synthetic changed source input");
      return {
        kind: "source-evidence",
        descriptorSha256: hash(`${JSON.stringify(value)}\n`),
        electronArchive: {
          directory: value.paths.electronZipDirectory,
          filename: "synthetic.zip",
          sha256: value.inputs.tools.electron.archiveSha256,
          bytes: 128,
        },
      };
    },
    async buildDistribution(
      _root,
      _descriptor,
      _runRoot,
      _dependencies,
      scope,
    ) {
      await scope.own(async () => {
        calls.push("build-distribution");
        if (buildFailure) throw new Error("Synthetic failed build");
      });
    },
    artifact: {
      async inspectDesktopDistribution(options) {
        calls.push("inspect-distribution");
        return {
          files: [],
          buildIdentity: options.expectedBuildIdentity,
          nativeArtifacts: [],
        };
      },
      async packageUnsignedDesktop(options) {
        calls.push("package");
        if (packageFailure) throw new Error("Synthetic failed package command");
        assert.equal(options.platform, "darwin");
        assert.equal(options.architecture, "arm64");
        assert.equal(
          options.expectedBuildIdentity.buildId,
          identity(descriptor().inputs).buildId,
        );
        for (const directory of [
          options.stageRoot,
          options.outputRoot,
          options.temporaryRoot,
        ])
          await fs.mkdir(directory, { mode: 0o700 });
        const result = path.join(
          options.outputRoot,
          "DesmosLock Internal-darwin-arm64",
        );
        await fs.mkdir(result, { mode: 0o700 });
        await fs.mkdir(path.join(result, "DesmosLock Internal.app"), {
          mode: 0o700,
        });
        return packaged(result);
      },
      async inspectPackagedDesktop(options) {
        calls.push("inspect-package");
        await fs.stat(
          path.join(options.packageDirectory, "DesmosLock Internal.app"),
        );
        return packaged(options.packageDirectory);
      },
    },
    evidence: {
      unsignedEvidenceNativePath:
        "/synthetic/unsigned-artifact-tools/durable-record.node",
      async openUnsignedArtifactEvidence(options) {
        calls.push(`open:${options.mode}`);
        openCount += 1;
        if (options.mode === "create") {
          await fs.mkdir(path.dirname(options.runRoot), { mode: 0o700 });
          await fs.mkdir(options.runRoot, { mode: 0o700 });
          await fs.mkdir(path.join(options.runRoot, "evidence"), {
            mode: 0o700,
          });
          snapshot = {
            revision: 1,
            candidate: null,
            attempts: [],
            pendingPhysicalCaseIds: ["protected-graphing"],
          };
        }
        return {
          async readSnapshot() {
            return structuredClone(snapshot);
          },
          async revalidate({ expectedRevision }) {
            assert.equal(expectedRevision, snapshot.revision);
            calls.push("revalidate");
          },
          async recordCase({ expectedRevision, caseId }, callback) {
            assert.equal(expectedRevision, snapshot.revision);
            calls.push(`case:${caseId}`);
            const attempt = { caseId, state: "pending", evidence: [] };
            snapshot.attempts.push(attempt);
            snapshot.revision += 1;
            const scope = {
              own: (work) => work(),
              markOutputSettlementUncertain() {
                outputUncertain = true;
              },
              async writeEvidence(bytes) {
                if (caseId === evidenceFailureCase)
                  throw new Error("Synthetic evidence publication failure");
                const ref = { sha256: hash(bytes), bytes: bytes.length };
                await fs.writeFile(
                  path.join(options.runRoot, "evidence", ref.sha256),
                  bytes,
                  { mode: 0o600 },
                );
                return ref;
              },
            };
            try {
              const result = await callback(scope);
              assert.equal(result.state, "observed-pass");
              Object.assign(attempt, {
                state: result.state,
                evidence: result.evidence,
              });
              if (result.candidate !== undefined) {
                if (snapshot.candidate !== null)
                  assert.deepEqual(result.candidate, snapshot.candidate);
                snapshot.candidate = result.candidate;
              }
              snapshot.revision += 1;
            } catch {
              if (outputUncertain) {
                const error = new Error(
                  "Synthetic output settlement remains uncertain",
                );
                error.code = "OUTPUT_SETTLEMENT_UNCERTAIN";
                throw error;
              }
              attempt.state = "observed-fail";
              snapshot.revision += 1;
            }
            return structuredClone(snapshot);
          },
          async close() {
            calls.push("close");
            closeCount += 1;
            return (
              !outputUncertain && drain && closeCount !== closeFailureOrdinal
            );
          },
        };
      },
    },
  };
  return {
    root,
    inputPath,
    calls,
    dependencies,
    get snapshot() {
      return snapshot;
    },
    get openCount() {
      return openCount;
    },
    changeArtifact: () => {
      changed = true;
    },
    failVerification: () => {
      verificationFailure = true;
    },
    keepDraining: () => {
      drain = false;
    },
    failBuild: () => {
      buildFailure = true;
    },
    failPackage: () => {
      packageFailure = true;
    },
    failFinalClose: () => {
      closeFailureOrdinal = 2;
    },
    failEvidence: (caseId) => {
      evidenceFailureCase = caseId;
    },
    create: () =>
      collectUnsignedDesktopForTesting(
        { mode: "create", runId, inputPath, repositoryRoot: root },
        dependencies,
      ),
    resume: () =>
      collectUnsignedDesktopForTesting(
        { mode: "resume", runId, repositoryRoot: root },
        dependencies,
      ),
  };
}

test("collector arguments accept only fixed create/resume grammar", () => {
  assert.deepEqual(
    parseUnsignedCollectorArguments(["resume", "--run-id", runId]),
    { mode: "resume", runId },
  );
  for (const args of [
    ["resume", "--run-id", runId, "--mark-passed"],
    ["create", "--run-id", runId],
    ["resume", "--run-id", "../escape"],
    ["create", "--run-id", runId, "--inputs", "/private/.env"],
  ])
    assert.throws(() => parseUnsignedCollectorArguments(args));
});
test("descriptor rejects private paths, source subsets with unsafe entries, mismatched commits and command fields", () => {
  const parsed = parseUnsignedArtifactDescriptor(descriptor());
  assert.equal(parsed.inputs.architecture, "arm64");
  for (const filename of [
    ".env",
    ".env.example",
    "apps/desktop/src/.env.local",
    "apps/desktop/src/.envsecret",
    "apps/desktop/src/.ENVwhatever",
    "apps/desktop/src/../../secret.json",
    "docs/private.txt",
    "node_modules/package.json",
    "apps/desktop/src/.ssh/id_rsa",
  ])
    assert.equal(isUnsignedCollectorSourcePath(filename), false);
  for (const mutation of [
    (value) => {
      value.command = "npm install";
    },
    (value) => {
      value.review.ciCommit = "1".repeat(40);
    },
    (value) => {
      value.review.ciUrl =
        "https://github.com/danielholguin31/desmoslock/actions/runs/123?token=synthetic";
    },
    (value) => {
      value.sourceManifest[0].path = "apps/desktop/src/.env";
    },
    (value) => {
      value.paths.dependencies = "/synthetic/.ssh/node_modules";
    },
    (value) => {
      value.executionFiles[0].path = "typescript/.env";
    },
    (value) => {
      value.executionFiles.pop();
    },
    (value) => {
      value.dependencies[0].root = "/arbitrary/private";
    },
  ]) {
    const value = descriptor();
    mutation(value);
    assert.throws(() => parseUnsignedArtifactDescriptor(value));
  }
  const getter = descriptor();
  Object.defineProperty(getter, "inputs", {
    enumerable: true,
    get() {
      throw new Error("Getter must not execute");
    },
  });
  assert.throws(
    () => parseUnsignedArtifactDescriptor(getter),
    /Invalid collector descriptor field/,
  );
});
test("command environment has no ambient credentials, preload flags or implicit package configuration", () => {
  const prior = process.env.SYNTHETIC_COLLECTOR_SECRET;
  process.env.SYNTHETIC_COLLECTOR_SECRET = "synthetic-only";
  try {
    const env = createUnsignedCollectorCommandEnvironment(
      parseUnsignedArtifactDescriptor(descriptor()),
      "/synthetic/run/temporary",
    );
    assert.equal(Object.hasOwn(env, "SYNTHETIC_COLLECTOR_SECRET"), false);
    assert.equal(Object.hasOwn(env, "NODE_OPTIONS"), false);
    assert.equal(env.NPM_CONFIG_OFFLINE, "true");
    assert.equal(
      env.NPM_CONFIG_USERCONFIG,
      "/synthetic/run/temporary/npm-user.ini",
    );
    assert.equal(
      env.NPM_CONFIG_GLOBALCONFIG,
      "/synthetic/run/temporary/npm-global.ini",
    );
    assert.equal(env.PATH.includes("node_modules/.bin"), false);
  } finally {
    if (prior === undefined) delete process.env.SYNTHETIC_COLLECTOR_SECRET;
    else process.env.SYNTHETIC_COLLECTOR_SECRET = prior;
  }
});
test("create measures fixed cases, retains exact candidate path and reopens checkpoint", async (t) => {
  const state = await fixture(t);
  const result = await state.create();
  assert.equal(
    result.candidate,
    path.join(
      state.root,
      "artifacts/unsigned-artifact-runs",
      runId,
      "candidate/DesmosLock Internal.app",
    ),
  );
  assert.equal(result.physicalAcceptance, "pending");
  assert.equal(result.signing, "ad-hoc-only");
  const candidateEvidence = JSON.parse(
    await fs.readFile(
      path.join(
        result.runRoot,
        "evidence",
        state.snapshot.candidate.inventory.sha256,
      ),
      "utf8",
    ),
  );
  assert.equal(candidateEvidence.signing, "ad-hoc-only");
  assert.equal(state.openCount, 2);
  assert.deepEqual(
    state.calls.filter((value) => value.startsWith("case:")),
    [
      "source-inputs",
      "distribution-inventory",
      "packaged-inventory",
      "packaged-fuses",
      "native-inventory",
      "checkpoint-readback",
    ].map((name) => `case:${name}`),
  );
  assert.deepEqual(state.snapshot.pendingPhysicalCaseIds, [
    "protected-graphing",
  ]);
  assert.equal(
    state.calls.filter((value) => value === "verify-inputs").length,
    2,
  );
  assert.equal(
    state.calls.indexOf("verify-inputs") <
      state.calls.indexOf("build-distribution"),
    true,
  );
  await assert.rejects(
    fs.stat(
      path.join(state.root, "artifacts/unsigned-artifact-collector.lock"),
    ),
    { code: "ENOENT" },
  );
});
test("resume remeasures retained bytes and appends attempts without rebuilding or relabeling", async (t) => {
  const state = await fixture(t);
  const first = await state.create();
  const attempts = state.snapshot.attempts.length;
  const second = await state.resume();
  assert.equal(second.signing, "ad-hoc-only");
  assert.deepEqual(second.identity, first.identity);
  assert.equal(second.treeSha256, first.treeSha256);
  assert.equal(
    state.calls.filter((value) => value === "build-distribution").length,
    1,
  );
  assert.equal(state.calls.filter((value) => value === "package").length, 1);
  assert.equal(state.snapshot.attempts.length > attempts, true);
});
test("resume rejects altered descriptor before another input observation", async (t) => {
  const state = await fixture(t);
  await state.create();
  const filename = path.join(
    state.root,
    "artifacts/unsigned-artifact-runs",
    runId,
    "descriptor.json",
  );
  const value = JSON.parse(await fs.readFile(filename, "utf8"));
  value.review.ciUrl =
    "https://github.com/danielholguin31/desmoslock/actions/runs/999";
  await fs.writeFile(filename, JSON.stringify(value));
  await assert.rejects(state.resume(), /Retained descriptor changed/);
  assert.equal(
    state.calls.filter((value) => value === "verify-inputs").length,
    2,
  );
});
test("resume rejects changed candidate without rebuilding or inventing a pass", async (t) => {
  const state = await fixture(t);
  await state.create();
  state.changeArtifact();
  await assert.rejects(state.resume(), /Retained candidate changed/);
  assert.equal(state.calls.filter((value) => value === "package").length, 1);
});
test("resume cannot adopt an app without prior distribution evidence", async (t) => {
  const state = await fixture(t);
  await state.create();
  state.snapshot.attempts.splice(
    state.snapshot.attempts.findIndex(
      (value) => value.caseId === "distribution-inventory",
    ),
    1,
  );
  await assert.rejects(
    state.resume(),
    /no completed source-to-distribution observation/,
  );
});
test("returned failed input observation prevents build and preserves its failure", async (t) => {
  const state = await fixture(t);
  state.failVerification();
  await assert.rejects(
    state.create(),
    /Collector observation did not pass: source-inputs/,
  );
  assert.equal(state.calls.includes("build-distribution"), false);
  assert.equal(state.snapshot.attempts[0].state, "observed-fail");
});
test("failed build command leaves pending checkpoint and retained lease before any packaging", async (t) => {
  const state = await fixture(t);
  state.failBuild();
  await assert.rejects(state.create(), /Output settlement remains uncertain/);
  assert.equal(state.calls.includes("package"), false);
  assert.equal(state.calls.includes("case:packaged-inventory"), false);
  assert.equal(state.snapshot.attempts.at(-1).state, "pending");
  assert.equal(
    (
      await fs.stat(
        path.join(state.root, "artifacts/unsigned-artifact-collector.lock"),
      )
    ).isDirectory(),
    true,
  );
});
test("failed package command retains pending checkpoint and ownership after direct callback settlement", async (t) => {
  const state = await fixture(t);
  state.failPackage();
  await assert.rejects(state.create(), /Output settlement remains uncertain/);
  assert.equal(state.calls.at(-1), "close");
  assert.equal(state.calls.includes("case:packaged-fuses"), false);
  assert.equal(state.snapshot.attempts.at(-1).state, "pending");
  assert.equal(
    (
      await fs.stat(
        path.join(state.root, "artifacts/unsigned-artifact-collector.lock"),
      )
    ).isDirectory(),
    true,
  );
});
test("final close false fails an otherwise successful collection and retains ownership", async (t) => {
  const state = await fixture(t);
  state.failFinalClose();
  await assert.rejects(state.create(), /Checkpoint did not drain/);
  assert.equal(state.snapshot.attempts.at(-1).caseId, "checkpoint-readback");
  assert.equal(state.snapshot.attempts.at(-1).state, "observed-pass");
  assert.equal(
    (
      await fs.stat(
        path.join(state.root, "artifacts/unsigned-artifact-collector.lock"),
      )
    ).isDirectory(),
    true,
  );
});
test("evidence preparation failure after entered packaging cannot terminalize uncertain work", async (t) => {
  const state = await fixture(t);
  state.failEvidence("packaged-inventory");
  await assert.rejects(state.create(), /Output settlement remains uncertain/);
  assert.equal(state.calls.includes("inspect-package"), true);
  assert.equal(state.snapshot.attempts.at(-1).state, "pending");
  assert.equal(state.snapshot.candidate, null);
  assert.equal(
    (
      await fs.stat(
        path.join(state.root, "artifacts/unsigned-artifact-collector.lock"),
      )
    ).isDirectory(),
    true,
  );
});
test("stale lease permits only checkpoint-bound retained-candidate resume and is preserved", async (t) => {
  const state = await fixture(t);
  await state.create();
  const lease = path.join(
    state.root,
    "artifacts/unsigned-artifact-collector.lock",
  );
  await fs.mkdir(lease, { mode: 0o700 });
  await fs.writeFile(
    path.join(lease, "owner.json"),
    JSON.stringify({ runId, pid: 999999999 }),
    { mode: 0o600 },
  );
  const before = await fs.readFile(path.join(lease, "owner.json"));
  await state.resume();
  assert.deepEqual(await fs.readFile(path.join(lease, "owner.json")), before);
  assert.equal(state.calls.filter((value) => value === "package").length, 1);
  assert.equal(
    state.calls.filter((value) => value === "build-distribution").length,
    1,
  );
  state.snapshot.attempts.push({
    caseId: "packaged-inventory",
    state: "incomplete",
    evidence: [],
  });
  await assert.rejects(state.resume(), /no unfinished packaging/);
  assert.deepEqual(await fs.readFile(path.join(lease, "owner.json")), before);
  state.snapshot.attempts.pop();
  state.snapshot.candidate = null;
  await assert.rejects(
    state.resume(),
    /fully published, checkpoint-bound candidate/,
  );
  assert.deepEqual(await fs.readFile(path.join(lease, "owner.json")), before);
});
test("occupied lease fails before opening storage and undrained work retains ownership", async (t) => {
  const state = await fixture(t);
  const lease = path.join(
    state.root,
    "artifacts/unsigned-artifact-collector.lock",
  );
  await fs.mkdir(lease, { mode: 0o700 });
  await assert.rejects(state.create(), { code: "EEXIST" });
  assert.equal(state.openCount, 0);
  await fs.rmdir(lease);
  state.keepDraining();
  await assert.rejects(state.create(), /did not drain/);
  assert.equal((await fs.stat(lease)).isDirectory(), true);
});
test("descriptor links and foreign input paths are refused before storage", async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    collectUnsignedDesktopForTesting(
      {
        mode: "create",
        runId,
        repositoryRoot: state.root,
        inputPath: "/arbitrary/descriptor.json",
      },
      state.dependencies,
    ),
    /fixed owned UUID descriptor path/,
  );
  await fs.rename(state.inputPath, `${state.inputPath}.retained`);
  await fs.symlink(`${state.inputPath}.retained`, state.inputPath);
  await assert.rejects(state.create());
  assert.equal(state.openCount, 0);
});

async function sourceFixture(t) {
  const state = await fixture(t);
  const filenames = [
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "apps/desktop/package.json",
    "apps/desktop/tsconfig.json",
    ...["domain", "contracts", "test-support"].flatMap((name) =>
      ["package.json", "tsconfig.json", "tsconfig.build.json"].map(
        (file) => `packages/${name}/${file}`,
      ),
    ),
    ...[
      "build-app",
      "build-desktop-durable-record",
      "build-desktop-aac-protection",
      "desktop-artifact",
      "electron-fuse-policy",
      "unsigned-artifact-evidence",
      "collect-unsigned-desktop",
      "unsigned-artifact-inputs",
    ].map((name) => `scripts/${name}.mjs`),
  ].sort();
  for (const name of [
    "apps/desktop/src",
    "apps/desktop/native",
    "packages/domain/src",
    "packages/contracts/src",
    "packages/test-support/src",
  ])
    await fs.mkdir(path.join(state.root, name), {
      recursive: true,
      mode: 0o700,
    });
  const bytes = Buffer.from("synthetic public source\n");
  const gitBlob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const value = descriptor();
  value.sourceManifest = filenames.map((filename) => ({
    path: filename,
    mode: "100644",
    gitBlob,
    sha256: hash(bytes),
    bytes: bytes.length,
  }));
  for (const filename of filenames) {
    await fs.mkdir(path.dirname(path.join(state.root, filename)), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(path.join(state.root, filename), bytes, { mode: 0o600 });
  }
  let selectedTree = structuredClone(value.sourceManifest);
  const deps = {
    async command(file, args) {
      assert.equal(
        file,
        "/usr/bin/git",
        "Negative source checks must stop before tool execution",
      );
      if (args.includes("ls-tree"))
        return {
          stdout: selectedTree
            .map(
              (entry) => `${entry.mode} blob ${entry.gitBlob}\t${entry.path}\0`,
            )
            .join(""),
        };
      return {
        stdout: args.at(-1).endsWith("^{tree}")
          ? value.inputs.sourceTree
          : value.inputs.sourceCommit,
      };
    },
  };
  return {
    root: state.root,
    value,
    selectTree: (tree) => {
      selectedTree = tree;
    },
    verify: () =>
      verifyUnsignedArtifactInputsForTesting(
        {
          repositoryRoot: state.root,
          descriptor: value,
          temporaryRoot: state.root,
        },
        deps,
      ),
  };
}
test("source preflight rejects a caller-selected manifest subset before reading its files", async (t) => {
  const state = await sourceFixture(t);
  state.value.sourceManifest.pop();
  await assert.rejects(
    state.verify(),
    /Positive source manifest differs from the selected Git tree/,
  );
});
test("source preflight rejects dirty bytes and executable mode changes", async (t) => {
  const state = await sourceFixture(t);
  const filename = path.join(state.root, state.value.sourceManifest[0].path);
  await fs.writeFile(filename, "changed public source\n");
  await assert.rejects(state.verify(), /Positive source bytes or mode changed/);
  await fs.writeFile(filename, "synthetic public source\n");
  await fs.chmod(filename, 0o700);
  await assert.rejects(state.verify(), /Positive source bytes or mode changed/);
});
test("source preflight rejects added private or linked names without measuring them", async (t) => {
  const state = await sourceFixture(t);
  const filename = path.join(state.root, "apps/desktop/src/.ENVprivate");
  await fs.writeFile(filename, "synthetic private fixture only", {
    mode: 0o000,
  });
  await assert.rejects(
    state.verify(),
    /Source directory contains an unsafe name/,
  );
  await fs.unlink(filename);
  await fs.symlink(
    path.join(state.root, "package.json"),
    path.join(state.root, "apps/desktop/src/extra.ts"),
  );
  await assert.rejects(
    state.verify(),
    /Source directory contains a link or nonregular input/,
  );
});
test("dependency descriptor refuses private components including scoped paths", () => {
  for (const name of [
    ".env-production",
    "credentials",
    ".envsecret",
    "@safe/.env-local",
    "@safe/credentials",
    "@.env-private/package",
    "@credentials/package",
  ]) {
    const value = descriptor();
    value.dependencies[0].name = name;
    assert.throws(
      () => parseUnsignedArtifactDescriptor(value),
      /Invalid declared dependency/,
    );
  }
});
test("installed private scopes and children fail before private contents are traversed", async (t) => {
  const state = await fixture(t);
  const modules = path.join(state.root, "node_modules");
  const provider = path.join(state.root, "provider/node_modules");
  await fs.mkdir(modules, { mode: 0o700 });
  await fs.mkdir(provider, { recursive: true, mode: 0o700 });
  const unsafeScope = path.join(modules, "@.env-private");
  // A regular unreadable fixture makes an attempted readdir fail differently.
  await fs.writeFile(unsafeScope, "synthetic private fixture", { mode: 0o000 });
  await assert.rejects(
    inspectUnsignedCollectorDependencyNames(modules, provider),
    /Unsafe installed dependency scope/,
  );
  await fs.unlink(unsafeScope);
  await fs.mkdir(path.join(modules, "@safe"), { mode: 0o700 });
  for (const name of [".env-production", "credentials"]) {
    const filename = path.join(modules, "@safe", name);
    await fs.writeFile(filename, "synthetic private fixture", { mode: 0o000 });
    await assert.rejects(
      inspectUnsignedCollectorDependencyNames(modules, provider),
      /Unsafe installed dependency name/,
    );
    await fs.unlink(filename);
  }
  const outside = path.join(state.root, "unapproved-scope");
  await fs.mkdir(outside, { mode: 0o000 });
  await fs.symlink(outside, path.join(modules, "@outside"));
  await assert.rejects(
    inspectUnsignedCollectorDependencyNames(modules, provider),
    /escaped its declared provider/,
  );
  await fs.chmod(outside, 0o700);
});
test("fixture parent preparation creates absent directories and preserves concurrent existing parents", async (t) => {
  const state = await fixture(t);
  const fresh = await fs.mkdtemp(path.join(state.root, "fresh-parent-"));
  await assert.rejects(fs.lstat(path.join(fresh, "artifacts")), {
    code: "ENOENT",
  });
  const parents = await Promise.all(
    Array.from({ length: 4 }, () => prepareTestParent(fresh)),
  );
  assert.equal(new Set(parents).size, 1);
  assert.equal(parents[0], path.join(fresh, "artifacts/local-tool-tmp"));
  const existingArtifacts = path.join(state.root, "artifacts");
  const original = await fs.lstat(existingArtifacts);
  const retained = path.join(existingArtifacts, "unrelated.txt");
  await fs.writeFile(retained, "retained synthetic fixture", {
    flag: "wx",
    mode: 0o600,
  });
  await prepareTestParent(state.root);
  assert.equal((await fs.lstat(existingArtifacts)).ino, original.ino);
  assert.equal((await fs.lstat(existingArtifacts)).mode, original.mode);
  assert.equal(
    await fs.readFile(retained, "utf8"),
    "retained synthetic fixture",
  );
});
test("fixture parent preparation rejects links and shared writable directories without changing them", async (t) => {
  const state = await fixture(t);
  const fresh = await fs.mkdtemp(path.join(state.root, "unsafe-parent-"));
  const target = await fs.mkdtemp(path.join(state.root, "linked-target-"));
  const artifacts = path.join(fresh, "artifacts");
  await fs.symlink(target, artifacts);
  await assert.rejects(prepareTestParent(fresh), /real directory/);
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(artifacts);
  await fs.mkdir(artifacts, { mode: 0o700 });
  await fs.chmod(artifacts, 0o770);
  await assert.rejects(prepareTestParent(fresh), /not be shared writable/);
  assert.equal((await fs.lstat(artifacts)).mode & 0o777, 0o770);
  await fs.chmod(artifacts, 0o700);
});
