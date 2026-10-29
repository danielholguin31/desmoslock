import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliUrl = new URL(
  "../../scripts/collect-universal-desktop.mjs",
  import.meta.url,
).href;
const sharedUrl = new URL(
  "../../scripts/unsigned-artifact-inputs.mjs",
  import.meta.url,
).href;
const evidenceUrl = new URL(
  "../../scripts/unsigned-artifact-evidence.mjs",
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
  resolve(specifier, context, next) {
    if (
      [cliUrl, sharedUrl, evidenceUrl].includes(context.parentURL) &&
      specifier === "../packages/contracts/dist/build-identity.js"
    )
      return next(identitySource, context);
    if (
      context.parentURL === identitySource &&
      specifier === "./exact-record.js"
    )
      return next(exactSource, context);
    return next(specifier, context);
  },
});
const {
  collectUniversalDesktopForTesting,
  parseUniversalCollectorArguments,
  parseUniversalArtifactDescriptor,
  isUniversalCollectorSourcePath,
  verifyUniversalArtifactInputsForTesting,
} = await import(cliUrl);
const { canonicalClientUniversalBuildInputs } = await import(identitySource);
const {
  openUnsignedUniversalArtifactEvidenceForTesting,
  pendingPhysicalCaseIds,
} = await import(evidenceUrl);
// All workflow observations below are synthetic; no compiler, packager or addon runs.
hooks.deregister();

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runId = "8d63cbaa-8f7b-4939-9ef1-8234c2bebc55";
const checkout = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /\/$/u,
  "",
);
const publicBackend = { environment: "local", url: "http://127.0.0.1:43175" };
async function prepareTestParent(repositoryRoot = checkout) {
  async function validate(filename) {
    const status = await fs.lstat(filename);
    assert.ok(status.isDirectory() && !status.isSymbolicLink());
    assert.equal(await fs.realpath(filename), filename);
    assert.equal(status.uid, process.getuid());
    assert.equal(status.mode & 0o022, 0);
  }
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
async function ownedFixtureRoot(t) {
  const root = await fs.mkdtemp(
    path.join(await prepareTestParent(), "universal-cli-"),
  );
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function descriptor(hostArchitecture = "arm64") {
  return {
    schemaVersion: 1,
    inputs: {
      schemaVersion: 1,
      kind: "desktop-universal",
      sourceRepository: "danielholguin31/desmoslock",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      packageLockSha256: "c".repeat(64),
      packageVersion: "2.0.0",
      platform: "darwin",
      hostArchitecture,
      backendConfigurationSha256: hash(JSON.stringify(publicBackend)),
      graphingProfile: "internal-graphing-v1",
      tools: {
        node: { version: "24.20.0", sha256: "1".repeat(64) },
        npm: { version: "11.12.1", sha256: "2".repeat(64) },
        electron: { version: "44.10.0" },
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
        universal: { version: "3.0.6" },
        lipo: {
          sha256: hash("synthetic lipo bytes; no invocation is permitted\n"),
        },
        codesign: {
          sha256: hash(
            "synthetic codesign bytes; no invocation is permitted\n",
          ),
        },
      },
      slices: {
        arm64: {
          architecture: "arm64",
          electronArchiveSha256: "9".repeat(64),
          deploymentTarget: "13.0",
          napiVersion: 8,
        },
        x64: {
          architecture: "x64",
          electronArchiveSha256: "d".repeat(64),
          deploymentTarget: "13.0",
          napiVersion: 8,
        },
      },
      composition: { mergeASARs: true, nativeLayout: "fixed-addons-v1" },
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
      lipo: "/synthetic/tools/lipo",
      codesign: "/synthetic/tools/codesign",
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
      `@esbuild/darwin-${hostArchitecture}/bin/esbuild`,
    ].map((filename) => ({
      path: filename,
      sha256: "d".repeat(64),
      bytes: 123,
    })),
    nativeHelperSha256: "e".repeat(64),
  };
}
function identity(inputs) {
  const canonical = canonicalClientUniversalBuildInputs(inputs);
  assert.equal(typeof canonical, "string");
  return {
    schemaVersion: 1,
    sourceRepository: inputs.sourceRepository,
    sourceCommit: inputs.sourceCommit,
    sourceTree: inputs.sourceTree,
    packageLockSha256: inputs.packageLockSha256,
    buildId: createHash("sha256")
      .update("desmoslock:universal-build:v1\0")
      .update(canonical)
      .digest("hex"),
  };
}

test("universal CLI accepts only its fixed create/resume argument grammar", () => {
  assert.deepEqual(
    parseUniversalCollectorArguments([
      "create",
      "--run-id",
      runId,
      "--inputs",
      "/synthetic/descriptor.json",
    ]),
    { mode: "create", runId, inputPath: "/synthetic/descriptor.json" },
  );
  assert.deepEqual(
    parseUniversalCollectorArguments(["resume", "--run-id", runId]),
    { mode: "resume", runId },
  );
  for (const args of [
    [],
    ["create", "--run-id", runId],
    ["resume", "--run-id", runId, "--inputs", "/synthetic/descriptor.json"],
    ["create", "--run-id", runId, "--inputs", "relative.json"],
    ["resume", "--run-id", runId.toUpperCase()],
    [
      "create",
      "--run-id",
      runId,
      "--inputs",
      "/synthetic/descriptor.json",
      "--run-command",
      "compiler",
    ],
  ])
    assert.throws(() => parseUniversalCollectorArguments(args));
});

const nativePaths = [
  "dist/native/aac-protection.node",
  "dist/native/durable-record.node",
];
const disabledFuses = {
  RunAsNode: "DISABLE",
  EnableNodeOptionsEnvironmentVariable: "DISABLE",
  EnableNodeCliInspectArguments: "DISABLE",
};
async function workflowFixture(t) {
  const root = await ownedFixtureRoot(t);
  await fs.mkdir(path.join(root, "artifacts"), { mode: 0o755 });
  await fs.mkdir(path.join(root, "artifacts/universal-artifact-inputs"), {
    mode: 0o700,
  });
  const inputPath = path.join(
    root,
    "artifacts/universal-artifact-inputs",
    `${runId}.json`,
  );
  const input = descriptor();
  await fs.mkdir(path.join(root, "tools"), { mode: 0o700 });
  for (const name of ["lipo", "codesign"]) {
    input.paths[name] = path.join(root, "tools", name);
    const bytes = `synthetic ${name} bytes; no invocation is permitted\n`;
    input.inputs.tools[name].sha256 = hash(bytes);
    await fs.writeFile(input.paths[name], bytes, { flag: "wx", mode: 0o700 });
  }
  const buildIdentity = identity(input.inputs);
  await fs.writeFile(inputPath, JSON.stringify(input), {
    flag: "wx",
    mode: 0o600,
  });
  const runRoot = path.join(root, "artifacts/universal-artifact-runs", runId);
  const lease = path.join(root, "artifacts/unsigned-artifact-collector.lock");
  const calls = [];
  let snapshot;
  let openCount = 0;
  let closeCount = 0;
  let ownedWork = 0;
  const state = {
    failBuild: false,
    failPackage: false,
    failInputs: false,
    failEvidence: null,
    outputUncertain: false,
    closeFailureOrdinal: null,
    changedArtifact: false,
    finalReadbackChanged: false,
  };
  const archives = Object.fromEntries(
    ["arm64", "x64"].map((architecture) => [
      architecture,
      {
        directory: input.paths.electronZipDirectory,
        filename: `synthetic-electron-${architecture}.zip`,
        sha256: input.inputs.slices[architecture].electronArchiveSha256,
        bytes: 128,
      },
    ]),
  );
  const common = {
    files: [{ path: "main.js", sha256: "1".repeat(64), bytes: 64 }],
    buildIdentity,
  };
  const nativeSlices = Object.fromEntries(
    ["arm64", "x64"].map((architecture) => [
      architecture,
      {
        root: path.join(runRoot, "slices", architecture, "native"),
        artifacts: nativePaths.map((filename, index) => ({
          path: filename,
          architecture,
          sha256: String(
            architecture === "arm64" ? index + 2 : index + 4,
          ).repeat(64),
          bytes: 64,
        })),
      },
    ]),
  );
  const preFuseNativeArtifacts = nativePaths.map((filename, index) => ({
    path: filename,
    sha256: String(index + 6).repeat(64),
    bytes: 8192,
    slices: Object.fromEntries(
      ["arm64", "x64"].map((architecture) => [
        architecture,
        {
          offset: architecture === "arm64" ? 1024 : 4096,
          bytes: 64,
          sha256: nativeSlices[architecture].artifacts[index].sha256,
        },
      ]),
    ),
  }));
  const sealedNativeArtifacts = preFuseNativeArtifacts.map((entry, index) => ({
    ...entry,
    sha256: (index === 0 ? "a" : "b").repeat(64),
    slices: {
      arm64: { ...entry.slices.arm64, sha256: "c".repeat(64) },
      x64: { ...entry.slices.x64, sha256: "d".repeat(64) },
    },
  }));
  function packaged(packageDirectory) {
    const appBundle = path.join(packageDirectory, "DesmosLock Internal.app");
    return {
      schemaVersion: 1,
      kind: "unsigned-universal-app-inventory",
      packageDirectory,
      appBundle,
      executable: path.join(appBundle, "Contents/MacOS/desmoslock-internal"),
      resourcesDirectory: path.join(appBundle, "Contents/Resources"),
      platform: "darwin",
      architecture: "universal",
      buildIdentity,
      packageVersion: "2.0.0",
      nativeArtifacts: structuredClone(sealedNativeArtifacts),
      fuses: { arm64: { ...disabledFuses }, x64: { ...disabledFuses } },
      measurements: {
        executable: {
          sha256: "e".repeat(64),
          bytes: 8192,
          architecture: "universal",
        },
        asar: { sha256: "f".repeat(64), bytes: 128 },
        infoPlist: { sha256: "1".repeat(64), bytes: 64 },
      },
      tree: {
        entries: [
          {
            path: "synthetic.txt",
            type: "file",
            sha256: hash("synthetic app bytes"),
            bytes: Buffer.byteLength("synthetic app bytes"),
            mode: 0o600,
          },
        ],
        sha256: (state.changedArtifact ? "2" : "f").repeat(64),
      },
      composition: {
        common: structuredClone(common),
        electronArchives: structuredClone(archives),
        nativeSlices: structuredClone(nativeSlices),
        preFuseNativeArtifacts: structuredClone(preFuseNativeArtifacts),
        machOFiles: structuredClone(sealedNativeArtifacts),
        snapshotResources: { arm64: [], x64: [] },
        integrity: {
          arm64: {
            algorithm: "SHA256",
            expectedDigest: "e".repeat(64),
            observedDigest: "e".repeat(64),
          },
          x64: {
            algorithm: "SHA256",
            expectedDigest: "e".repeat(64),
            observedDigest: "e".repeat(64),
          },
        },
      },
    };
  }
  async function validateReferences() {
    for (const attempt of snapshot.attempts)
      for (const reference of attempt.evidence) {
        const bytes = await fs.readFile(
          path.join(runRoot, "evidence", reference.sha256),
        );
        assert.equal(bytes.length, reference.bytes);
        assert.equal(hash(bytes), reference.sha256);
      }
  }
  const dependencies = {
    command() {
      assert.fail("No real command is permitted in synthetic workflow tests");
    },
    build: {
      createUniversalDesktopBuildContext: (inputs) => ({
        identity: identity(inputs),
      }),
    },
    async verifyInputs(_root, value) {
      calls.push("verify-inputs");
      if (state.failInputs) throw new Error("Synthetic source mismatch");
      return {
        kind: "source-evidence",
        descriptorSha256: hash(`${JSON.stringify(value)}\n`),
        electronArchives: structuredClone(archives),
      };
    },
    async buildDistribution(
      repositoryRoot,
      value,
      actualRunRoot,
      _dependencies,
      scope,
    ) {
      assert.equal(repositoryRoot, root);
      assert.equal(actualRunRoot, runRoot);
      assert.deepEqual(value.inputs, input.inputs);
      return scope.own(async () => {
        calls.push("build-distribution");
        if (state.failBuild)
          throw new Error("Synthetic compiler descendants uncertain");
        for (const directory of [
          path.join(runRoot, "common"),
          ...Object.values(nativeSlices).map((slice) => slice.root),
        ])
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        return {
          common: structuredClone(common),
          nativeSlices: structuredClone(nativeSlices),
        };
      });
    },
    async packageArtifact(options, commandOptions) {
      calls.push("package");
      assert.ok(ownedWork > 0, "Packaging must be inside owned scoped work");
      if (state.failPackage)
        throw new Error("Synthetic package descendants uncertain");
      assert.equal(options.repositoryRoot, root);
      assert.equal(options.commonRoot, path.join(runRoot, "common"));
      assert.deepEqual(options.nativeSlices, nativeSlices);
      assert.deepEqual(options.electronArchives, archives);
      assert.deepEqual(options.expectedBuildIdentity, buildIdentity);
      assert.equal(options.electronVersion, "44.10.0");
      assert.equal(commandOptions.node, input.paths.node);
      assert.equal(
        commandOptions.env.TMPDIR.startsWith(path.join(runRoot, "temporary")),
        true,
      );
      assert.equal(path.basename(commandOptions.env.TMPDIR), "os-temporary");
      assert.equal(commandOptions.env.TMP, commandOptions.env.TMPDIR);
      assert.equal(commandOptions.env.TEMP, commandOptions.env.TMPDIR);
      assert.equal(
        commandOptions.env.PATH,
        `${path.join(runRoot, "temporary", "tools-bin")}:${path.dirname(input.paths.node)}:/usr/bin:/bin`,
      );
      assert.equal(
        (await fs.lstat(commandOptions.env.TMPDIR)).mode & 0o777,
        0o700,
      );
      assert.equal(Object.hasOwn(commandOptions.env, "NODE_OPTIONS"), false);
      for (const directory of [
        options.stageRoot,
        options.outputRoot,
        options.temporaryRoot,
      ])
        await fs.mkdir(directory, { mode: 0o700 });
      const packageDirectory = path.join(
        options.outputRoot,
        "DesmosLock Internal-darwin-universal",
      );
      await fs.mkdir(path.join(packageDirectory, "DesmosLock Internal.app"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(
        path.join(packageDirectory, "DesmosLock Internal.app/synthetic.txt"),
        "synthetic app bytes",
        { mode: 0o600 },
      );
      return packaged(packageDirectory);
    },
    artifact: {
      async inspectUniversalDesktop(options) {
        calls.push({ kind: "inspect", options: structuredClone(options) });
        assert.deepEqual(options.expectedBuildIdentity, buildIdentity);
        assert.deepEqual(options.commonObservation, common);
        assert.deepEqual(options.nativeSliceObservations, nativeSlices);
        assert.deepEqual(options.electronArchiveObservations, archives);
        assert.deepEqual(
          options.preFuseNativeArtifacts,
          preFuseNativeArtifacts,
          "Retained historical pre-fuse bytes must be supplied exactly",
        );
        await fs.stat(
          path.join(
            options.packageDirectory,
            "DesmosLock Internal.app/synthetic.txt",
          ),
        );
        if (state.finalReadbackChanged && openCount >= 2)
          state.changedArtifact = true;
        return packaged(options.packageDirectory);
      },
    },
    evidence: {
      unsignedEvidenceNativePath:
        "/synthetic/unsigned-artifact-tools/durable-record.node",
      async openUnsignedUniversalArtifactEvidence(options) {
        calls.push(`open:${options.mode}`);
        openCount += 1;
        assert.equal(options.runRoot, runRoot);
        assert.deepEqual(options.identity, buildIdentity);
        if (options.mode === "create") {
          await fs.mkdir(path.dirname(runRoot), { mode: 0o700 });
          await fs.mkdir(path.join(runRoot, "evidence"), {
            recursive: true,
            mode: 0o700,
          });
          snapshot = {
            schemaVersion: 1,
            kind: "desmoslock-unsigned-universal-artifact-evidence",
            runId,
            revision: 1,
            identity: buildIdentity,
            candidate: null,
            attempts: [],
            pendingPhysicalCaseIds: [...pendingPhysicalCaseIds],
          };
        }
        assert.equal(
          snapshot.kind,
          "desmoslock-unsigned-universal-artifact-evidence",
          "Synthetic wrapper refuses cross-kind records",
        );
        await validateReferences();
        return {
          async readSnapshot() {
            await validateReferences();
            return structuredClone(snapshot);
          },
          async revalidate({ expectedRevision }) {
            assert.equal(expectedRevision, snapshot.revision);
            await validateReferences();
            calls.push("revalidate");
          },
          async recordCase({ expectedRevision, caseId }, callback) {
            assert.equal(expectedRevision, snapshot.revision);
            calls.push(`case:${caseId}`);
            const attempt = {
              sequence: snapshot.attempts.length + 1,
              caseId,
              state: "pending",
              candidateTreeSha256: snapshot.candidate?.treeSha256 ?? null,
              evidence: [],
              failure: null,
            };
            snapshot.attempts.push(attempt);
            snapshot.revision += 1;
            const scope = {
              async own(work) {
                ownedWork += 1;
                try {
                  return await work();
                } finally {
                  ownedWork -= 1;
                }
              },
              markOutputSettlementUncertain() {
                state.outputUncertain = true;
              },
              async writeEvidence(bytes) {
                if (state.failEvidence === caseId)
                  throw new Error("Synthetic evidence publication failure");
                const reference = { sha256: hash(bytes), bytes: bytes.length };
                const filename = path.join(
                  runRoot,
                  "evidence",
                  reference.sha256,
                );
                try {
                  await fs.writeFile(filename, bytes, {
                    flag: "wx",
                    mode: 0o600,
                  });
                } catch (error) {
                  if (error.code !== "EEXIST") throw error;
                  assert.deepEqual(await fs.readFile(filename), bytes);
                }
                return reference;
              },
            };
            try {
              const result = await callback(scope);
              assert.equal(result.state, "observed-pass");
              if (result.candidate !== undefined) {
                assert.equal(result.candidate.kind, "unsigned-universal-app");
                if (snapshot.candidate !== null)
                  assert.deepEqual(result.candidate, snapshot.candidate);
                snapshot.candidate = result.candidate;
              }
              Object.assign(attempt, {
                state: result.state,
                evidence: result.evidence,
                candidateTreeSha256: snapshot.candidate?.treeSha256 ?? null,
              });
              snapshot.revision += 1;
            } catch {
              if (state.outputUncertain)
                throw Object.assign(
                  new Error("Synthetic output settlement unknown"),
                  { code: "OUTPUT_SETTLEMENT_UNCERTAIN" },
                );
              attempt.state = "observed-fail";
              attempt.failure = "operation_failed";
              snapshot.revision += 1;
            }
            return structuredClone(snapshot);
          },
          async close() {
            calls.push("close");
            closeCount += 1;
            return (
              !state.outputUncertain && closeCount !== state.closeFailureOrdinal
            );
          },
        };
      },
    },
  };
  return {
    root,
    inputPath,
    runRoot,
    lease,
    calls,
    dependencies,
    state,
    preFuseNativeArtifacts,
    sealedNativeArtifacts,
    get snapshot() {
      return snapshot;
    },
    get openCount() {
      return openCount;
    },
    create: () =>
      collectUniversalDesktopForTesting(
        { mode: "create", runId, inputPath, repositoryRoot: root },
        dependencies,
      ),
    resume: () =>
      collectUniversalDesktopForTesting(
        { mode: "resume", runId, repositoryRoot: root },
        dependencies,
      ),
    async rewriteCandidateInventory(mutate) {
      const old = snapshot.candidate.inventory;
      const value = JSON.parse(
        await fs.readFile(path.join(runRoot, "evidence", old.sha256), "utf8"),
      );
      mutate(value);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      const reference = { sha256: hash(bytes), bytes: bytes.length };
      await fs.writeFile(
        path.join(runRoot, "evidence", reference.sha256),
        bytes,
        { flag: "wx", mode: 0o600 },
      );
      snapshot.candidate.inventory = reference;
      for (const attempt of snapshot.attempts)
        attempt.evidence = attempt.evidence.map((entry) =>
          entry.sha256 === old.sha256 ? reference : entry,
        );
    },
  };
}

test("synthetic universal create binds both compiler histories, preserves pre-fuse bytes and leaves physical cases pending", async (t) => {
  const f = await workflowFixture(t);
  const result = await f.create();
  assert.equal(
    result.candidate,
    path.join(f.runRoot, "candidate/DesmosLock Internal.app"),
  );
  assert.deepEqual(result.identity, identity(descriptor().inputs));
  assert.equal(result.physicalAcceptance, "pending");
  assert.equal(result.signing, "ad-hoc-only");
  assert.equal(
    f.snapshot.kind,
    "desmoslock-unsigned-universal-artifact-evidence",
  );
  assert.equal(f.snapshot.candidate.kind, "unsigned-universal-app");
  assert.deepEqual(f.snapshot.pendingPhysicalCaseIds, [
    ...pendingPhysicalCaseIds,
  ]);
  assert.equal(f.snapshot.pendingPhysicalCaseIds.length, 14);
  assert.deepEqual(
    f.snapshot.attempts.map(({ caseId, state }) => [caseId, state]),
    [
      "source-inputs",
      "distribution-inventory",
      "packaged-inventory",
      "packaged-fuses",
      "native-inventory",
      "checkpoint-readback",
    ].map((caseId) => [caseId, "observed-pass"]),
  );
  assert.equal(
    f.calls.filter((call) => call === "build-distribution").length,
    1,
  );
  assert.equal(f.calls.filter((call) => call === "package").length, 1);
  assert.deepEqual(
    f.calls.filter(
      (call) => typeof call === "string" && call.startsWith("open:"),
    ),
    ["open:create", "open:resume"],
  );
  const candidateBytes = await fs.readFile(
    path.join(f.runRoot, "evidence", f.snapshot.candidate.inventory.sha256),
  );
  assert.equal(hash(candidateBytes), f.snapshot.candidate.inventory.sha256);
  const inventory = JSON.parse(candidateBytes);
  assert.deepEqual(
    inventory.composition.preFuseNativeArtifacts,
    f.preFuseNativeArtifacts,
  );
  assert.deepEqual(inventory.nativeArtifacts, f.sealedNativeArtifacts);
  assert.notDeepEqual(
    inventory.nativeArtifacts,
    inventory.composition.preFuseNativeArtifacts,
  );
  for (const architecture of ["arm64", "x64"]) {
    assert.equal(
      inventory.composition.nativeSlices[architecture].root,
      path.join(f.runRoot, "slices", architecture, "native"),
    );
    for (const [index, row] of inventory.composition.nativeSlices[
      architecture
    ].artifacts.entries())
      assert.equal(
        row.sha256,
        inventory.composition.preFuseNativeArtifacts[index].slices[architecture]
          .sha256,
      );
  }
  await assert.rejects(fs.lstat(f.lease), { code: "ENOENT" });
});

test("synthetic fully bound resume only remeasures final bytes with the retained composition history", async (t) => {
  const f = await workflowFixture(t);
  const created = await f.create();
  const bound = structuredClone(f.snapshot.candidate);
  const filename = path.join(created.candidate, "synthetic.txt");
  const bytes = await fs.readFile(filename);
  const before = await fs.stat(filename);
  f.calls.length = 0;
  const resumed = await f.resume();
  assert.equal(resumed.treeSha256, created.treeSha256);
  assert.equal(resumed.candidate, created.candidate);
  assert.deepEqual(f.snapshot.candidate, bound);
  assert.deepEqual(await fs.readFile(filename), bytes);
  const after = await fs.stat(filename);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.calls.includes("build-distribution"), false);
  assert.equal(f.calls.includes("package"), false);
  const inspections = f.calls.filter((call) => call.kind === "inspect");
  assert.equal(inspections.length, 3);
  for (const call of inspections)
    assert.deepEqual(
      call.options.preFuseNativeArtifacts,
      f.preFuseNativeArtifacts,
    );
  assert.deepEqual(f.snapshot.pendingPhysicalCaseIds, [
    ...pendingPhysicalCaseIds,
  ]);
  await assert.rejects(fs.lstat(f.lease), { code: "ENOENT" });
});

test("synthetic resume refuses coherently rehashed but mismatched retained composition history", async (t) => {
  const mutations = [
    [
      (value) => {
        value.composition.common.files[0].sha256 = "0".repeat(64);
      },
      /Retained common build history changed/u,
    ],
    [
      (value) => {
        value.composition.nativeSlices.x64.artifacts[0].sha256 = "0".repeat(64);
      },
      /Retained compiler history changed/u,
    ],
    [
      (value) => {
        value.composition.electronArchives.x64.sha256 = "0".repeat(64);
      },
      /Retained archive history changed/u,
    ],
    [
      (value) => {
        delete value.composition.preFuseNativeArtifacts;
      },
      /Retained historical pre-fuse bytes/u,
    ],
    [
      (value) => {
        value.composition.preFuseNativeArtifacts[0].slices.x64.sha256 =
          "0".repeat(64);
      },
      /Retained historical pre-fuse bytes/u,
    ],
  ];
  for (const [mutate, message] of mutations) {
    const f = await workflowFixture(t);
    await f.create();
    await f.rewriteCandidateInventory(mutate);
    f.calls.length = 0;
    await assert.rejects(f.resume(), message);
    assert.equal(f.calls.includes("build-distribution"), false);
    assert.equal(f.calls.includes("package"), false);
  }
});

test("synthetic resume rejects missing candidate bytes, missing evidence and changed bound tree without rebuilding", async (t) => {
  for (const change of ["candidate", "evidence", "tree"]) {
    const f = await workflowFixture(t);
    await f.create();
    if (change === "candidate")
      await fs.rename(
        path.join(f.runRoot, "candidate"),
        path.join(f.runRoot, "candidate-retained"),
      );
    if (change === "evidence")
      await fs.unlink(
        path.join(f.runRoot, "evidence", f.snapshot.candidate.inventory.sha256),
      );
    if (change === "tree") f.state.changedArtifact = true;
    f.calls.length = 0;
    await assert.rejects(
      f.resume(),
      change === "tree"
        ? /Retained candidate changed/u
        : change === "candidate"
          ? /Retained candidate is missing/u
          : { code: "ENOENT" },
    );
    assert.equal(f.calls.includes("build-distribution"), false);
    assert.equal(f.calls.includes("package"), false);
  }
});

test("synthetic resume refuses descriptor and pinned tool-link substitutions before new work", async (t) => {
  for (const change of ["descriptor", "tool-link"]) {
    const f = await workflowFixture(t);
    await f.create();
    if (change === "descriptor") {
      const filename = path.join(f.runRoot, "descriptor.json");
      const retained = JSON.parse(await fs.readFile(filename, "utf8"));
      retained.review.ciUrl =
        "https://github.com/danielholguin31/desmoslock/actions/runs/999999";
      await fs.writeFile(filename, `${JSON.stringify(retained)}\n`);
    } else {
      const link = path.join(f.runRoot, "temporary/tools-bin/lipo");
      await fs.unlink(link);
      await fs.symlink(path.join(f.root, "tools/codesign"), link);
    }
    f.calls.length = 0;
    await assert.rejects(
      f.resume(),
      change === "descriptor"
        ? /Retained descriptor changed/u
        : /Pinned packaging tool link changed/u,
    );
    assert.equal(f.calls.includes("verify-inputs"), false);
    assert.equal(f.calls.includes("build-distribution"), false);
    assert.equal(f.calls.includes("package"), false);
  }
});

test("pinned command targets must remain executable and exact before any package invocation", async (t) => {
  for (const name of ["lipo", "codesign"]) {
    const f = await workflowFixture(t);
    await fs.chmod(path.join(f.root, "tools", name), 0o600);
    await assert.rejects(
      f.create(),
      /Pinned packaging tool is changed or not executable/u,
    );
    assert.equal(f.calls.includes("build-distribution"), false);
    assert.equal(f.calls.includes("package"), false);
  }
  for (const change of ["mode", "bytes", "link"]) {
    const f = await workflowFixture(t);
    const build = f.dependencies.buildDistribution;
    f.dependencies.buildDistribution = async (...args) => {
      const result = await build(...args);
      if (change === "mode")
        await fs.chmod(path.join(f.root, "tools/lipo"), 0o600);
      if (change === "bytes")
        await fs.writeFile(
          path.join(f.root, "tools/lipo"),
          "changed selected tool bytes",
        );
      if (change === "link") {
        const link = path.join(f.runRoot, "temporary/tools-bin/lipo");
        await fs.unlink(link);
        await fs.symlink(path.join(f.root, "tools/codesign"), link);
      }
      return result;
    };
    await assert.rejects(f.create());
    assert.equal(f.calls.includes("package"), false);
    assert.equal((await fs.lstat(f.lease)).isDirectory(), true);
  }
});

test("synthetic source mismatch fails before mutation and releases the settled lease", async (t) => {
  const f = await workflowFixture(t);
  f.state.failInputs = true;
  await assert.rejects(
    f.create(),
    /Collector observation did not pass: source-inputs/u,
  );
  assert.equal(f.snapshot.attempts.at(-1).state, "observed-fail");
  assert.equal(f.calls.includes("build-distribution"), false);
  assert.equal(f.calls.includes("package"), false);
  await assert.rejects(fs.lstat(f.lease), { code: "ENOENT" });
});

test("synthetic entered build, package and evidence failures retain pending attempts and refuse unsafe resume", async (t) => {
  for (const failure of [
    "build",
    "package",
    "distribution-evidence",
    "package-evidence",
  ]) {
    const f = await workflowFixture(t);
    f.state.failBuild = failure === "build";
    f.state.failPackage = failure === "package";
    f.state.failEvidence =
      failure === "distribution-evidence"
        ? "distribution-inventory"
        : failure === "package-evidence"
          ? "packaged-inventory"
          : null;
    await assert.rejects(f.create(), { code: "OUTPUT_SETTLEMENT_UNCERTAIN" });
    const pending = structuredClone(f.snapshot.attempts.at(-1));
    assert.equal(
      pending.caseId,
      failure.startsWith("package")
        ? "packaged-inventory"
        : "distribution-inventory",
    );
    assert.equal(pending.state, "pending");
    assert.equal(pending.failure, null);
    assert.deepEqual(pending.evidence, []);
    assert.equal(f.snapshot.candidate, null);
    assert.equal(f.calls.includes("case:checkpoint-readback"), false);
    assert.equal(f.openCount, 1);
    const leaseBytes = await fs.readFile(path.join(f.lease, "owner.json"));
    assert.equal(JSON.parse(leaseBytes).runId, runId);
    // A fresh synthetic owner models only reacquisition, not actual process death or descendant settlement.
    f.state.outputUncertain = false;
    f.calls.length = 0;
    await assert.rejects(f.resume(), /fresh isolated checkout/u);
    assert.deepEqual(f.snapshot.attempts.at(-1), pending);
    assert.equal(f.calls.includes("verify-inputs"), false);
    assert.equal(f.calls.includes("build-distribution"), false);
    assert.equal(f.calls.includes("package"), false);
    assert.deepEqual(
      await fs.readFile(path.join(f.lease, "owner.json")),
      leaseBytes,
    );
  }
});

test("synthetic packaging rejects changed inputs and mismatched composition while retaining pending ownership", async (t) => {
  for (const mismatch of [
    "source",
    "common",
    "compiler",
    "archive",
    "published-tree",
  ]) {
    const f = await workflowFixture(t);
    if (mismatch === "source") {
      const original = f.dependencies.verifyInputs;
      let verifications = 0;
      f.dependencies.verifyInputs = async (...args) => {
        const result = await original(...args);
        verifications += 1;
        return verifications === 3
          ? { ...result, descriptorSha256: "0".repeat(64) }
          : result;
      };
    } else {
      const original = f.dependencies.packageArtifact;
      f.dependencies.packageArtifact = async (...args) => {
        const result = await original(...args);
        if (mismatch === "common")
          result.composition.common.files[0].sha256 = "0".repeat(64);
        if (mismatch === "compiler")
          result.composition.nativeSlices.x64.artifacts[0].sha256 = "0".repeat(
            64,
          );
        if (mismatch === "archive")
          result.composition.electronArchives.x64.sha256 = "0".repeat(64);
        if (mismatch === "published-tree") f.state.changedArtifact = true;
        return result;
      };
    }
    await assert.rejects(f.create(), { code: "OUTPUT_SETTLEMENT_UNCERTAIN" });
    assert.equal(f.snapshot.attempts.at(-1).caseId, "packaged-inventory");
    assert.equal(f.snapshot.attempts.at(-1).state, "pending");
    assert.equal(f.snapshot.candidate, null);
    assert.equal(f.calls.includes("case:packaged-fuses"), false);
    assert.equal(f.openCount, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.lease, "owner.json"))).runId,
      runId,
    );
  }
});

test("synthetic create respects the shared native/universal checkout lease before opening a checkpoint", async (t) => {
  const f = await workflowFixture(t);
  await fs.mkdir(f.lease, { mode: 0o700 });
  const ownerPath = path.join(f.lease, "owner.json");
  const owner = Buffer.from(
    `${JSON.stringify({ runId: "98fe4fd7-5218-4bb6-812c-bd7c824152ad", pid: 42 })}\n`,
  );
  await fs.writeFile(ownerPath, owner, { flag: "wx", mode: 0o600 });
  await assert.rejects(f.create(), { code: "EEXIST" });
  assert.deepEqual(f.calls, []);
  assert.equal(f.snapshot, undefined);
  assert.deepEqual(await fs.readFile(ownerPath), owner);
  await assert.rejects(fs.lstat(f.runRoot), { code: "ENOENT" });
});

test("synthetic final checkpoint close failure retains the lease and cannot report success", async (t) => {
  const f = await workflowFixture(t);
  f.state.closeFailureOrdinal = 2;
  await assert.rejects(f.create(), /Checkpoint did not drain/u);
  assert.equal(f.snapshot.attempts.at(-1).caseId, "checkpoint-readback");
  assert.equal(f.openCount, 2);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.lease, "owner.json"))).runId,
    runId,
  );
});

test("synthetic final remeasurement catches a tree change after checkpoint reopen", async (t) => {
  const f = await workflowFixture(t);
  f.state.finalReadbackChanged = true;
  await assert.rejects(
    f.create(),
    /Candidate changed during checkpoint reopen/u,
  );
  assert.equal(f.openCount, 2);
  assert.equal(f.snapshot.candidate.treeSha256, "f".repeat(64));
});

test("synthetic readonly resume preserves an inherited lease and refuses a different run owner", async (t) => {
  const f = await workflowFixture(t);
  await f.create();
  await fs.mkdir(f.lease, { mode: 0o700 });
  const ownerPath = path.join(f.lease, "owner.json");
  const inherited = Buffer.from(`${JSON.stringify({ runId, pid: 42 })}\n`);
  await fs.writeFile(ownerPath, inherited, { flag: "wx", mode: 0o600 });
  await f.resume();
  assert.deepEqual(await fs.readFile(ownerPath), inherited);
  await fs.writeFile(
    ownerPath,
    `${JSON.stringify({ runId: "98fe4fd7-5218-4bb6-812c-bd7c824152ad", pid: 42 })}\n`,
  );
  f.calls.length = 0;
  await assert.rejects(f.resume(), /different run owns/u);
  assert.deepEqual(f.calls, []);
});

test("actual universal checkpoint decoder rejects native checkpoint kind through the CLI before observation", async (t) => {
  const f = await workflowFixture(t);
  await f.create();
  await fs.mkdir(path.join(f.runRoot, "checkpoint"), { mode: 0o700 });
  const wrongKind = {
    ...structuredClone(f.snapshot),
    kind: "desmoslock-unsigned-artifact-evidence",
  };
  const bytes = Buffer.from(JSON.stringify(wrongKind));
  let loads = 0;
  let writes = 0;
  let closes = 0;
  const native = {
    maximumRecordBytes: 65536,
    async openStore(directory) {
      assert.equal(directory, path.join(f.runRoot, "checkpoint"));
      return {
        async loadEncryptedRecord() {
          loads += 1;
          return Buffer.from(bytes);
        },
        async replaceEncryptedRecord() {
          writes += 1;
          assert.fail("A cross-kind record must never be rewritten");
        },
        async quarantineEncryptedRecord() {
          assert.fail(
            "A cross-kind record must never be quarantined automatically",
          );
        },
        async close() {
          closes += 1;
        },
      };
    },
  };
  f.dependencies.evidence.openUnsignedUniversalArtifactEvidence = (options) =>
    openUnsignedUniversalArtifactEvidenceForTesting(options, native);
  f.calls.length = 0;
  await assert.rejects(f.resume(), { code: "OPEN_FAILED" });
  assert.equal(loads, 1);
  assert.equal(writes, 0);
  assert.equal(closes, 1);
  assert.deepEqual(f.calls, []);
});

test("universal descriptor is exact, uses both slices and selects execution files for the actual host", () => {
  for (const host of ["arm64", "x64"]) {
    const value = descriptor(host);
    const parsed = parseUniversalArtifactDescriptor(value);
    assert.deepEqual(parsed.inputs, value.inputs);
    assert.equal(Object.keys(parsed).length, 9);
    assert.equal(Object.keys(parsed.paths).length, 9);
    assert.equal(parsed.executionFiles.length, 4);
    assert.ok(
      parsed.executionFiles.some(
        (entry) => entry.path === `@esbuild/darwin-${host}/bin/esbuild`,
      ),
    );
    const changed = descriptor(host);
    changed.inputs.slices.x64.electronArchiveSha256 = "f".repeat(64);
    assert.notEqual(
      identity(changed.inputs).buildId,
      identity(value.inputs).buildId,
    );
  }
});

test("universal descriptor refuses native-only, private, mismatched and caller-command fields", () => {
  const mutations = [
    (value) => {
      delete value.inputs.kind;
      value.inputs.architecture = "arm64";
    },
    (value) => {
      delete value.inputs.slices.x64;
    },
    (value) => {
      value.inputs.composition.mergeASARs = false;
    },
    (value) => {
      value.inputs.slices.x64.architecture = "arm64";
    },
    (value) => {
      value.inputs.buildId = "f".repeat(64);
    },
    (value) => {
      value.review.ciCommit = "f".repeat(40);
    },
    (value) => {
      value.paths.lipo = "/synthetic/.ssh/lipo";
    },
    (value) => {
      delete value.paths.codesign;
    },
    (value) => {
      value.paths.command = "/synthetic/shell";
    },
    (value) => {
      value.dependencies[0].root = "/synthetic/unselected";
    },
    (value) => {
      value.executionFiles[3].path = "@esbuild/darwin-x64/bin/esbuild";
    },
    (value) => {
      value.sourceManifest[0].path = "docs/AGENTS.md";
    },
  ];
  for (const mutate of mutations) {
    const value = descriptor();
    mutate(value);
    assert.throws(() => parseUniversalArtifactDescriptor(value));
  }
  let reads = 0;
  const value = descriptor();
  Object.defineProperty(value.paths, "codesign", {
    enumerable: true,
    get() {
      reads += 1;
      return "/synthetic/tools/codesign";
    },
  });
  assert.throws(() => parseUniversalArtifactDescriptor(value));
  assert.equal(reads, 0);
});

test("universal source predicate includes only the selected product/build set and universal CLI", () => {
  for (const filename of [
    "scripts/collect-universal-desktop.mjs",
    "scripts/unsigned-artifact-inputs.mjs",
    "scripts/build-app.mjs",
    "apps/desktop/native/durable-record.c",
    "apps/desktop/src/main/main.ts",
    "packages/contracts/src/build-identity.ts",
  ])
    assert.equal(isUniversalCollectorSourcePath(filename), true, filename);
  for (const filename of [
    ".env",
    "apps/desktop/src/.env.local",
    "apps/desktop/src/../secrets.json",
    "scripts/arbitrary.mjs",
    "docs/MACOS_RELEASE.md",
    "/tmp/unselected.ts",
    "packages/contracts/src/.ssh/key",
    "desktop/main.js",
  ])
    assert.equal(isUniversalCollectorSourcePath(filename), false, filename);
});

async function sourceFixture(t) {
  const root = await ownedFixtureRoot(t);
  const filenames = [
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "apps/desktop/package.json",
    "apps/desktop/tsconfig.json",
    ...["domain", "contracts", "test-support"].flatMap((name) =>
      ["package.json", "tsconfig.json", "tsconfig.build.json"].map(
        (filename) => `packages/${name}/${filename}`,
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
      "collect-universal-desktop",
      "unsigned-artifact-inputs",
    ].map((name) => `scripts/${name}.mjs`),
  ].sort();
  for (const directory of [
    "apps/desktop/src",
    "apps/desktop/native",
    "packages/domain/src",
    "packages/contracts/src",
    "packages/test-support/src",
  ])
    await fs.mkdir(path.join(root, directory), {
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
    await fs.mkdir(path.dirname(path.join(root, filename)), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(path.join(root, filename), bytes, { mode: 0o600 });
  }
  let selectedTree = structuredClone(value.sourceManifest);
  let selectedCommit = value.inputs.sourceCommit;
  let selectedTreeIdentity = value.inputs.sourceTree;
  const dependencies = {
    async command(file, args) {
      assert.equal(
        file,
        "/usr/bin/git",
        "Source negatives must stop before tool execution",
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
          ? selectedTreeIdentity
          : selectedCommit,
      };
    },
  };
  return {
    root,
    value,
    selectTree: (tree) => {
      selectedTree = tree;
    },
    selectCommit: (commit) => {
      selectedCommit = commit;
    },
    selectTreeIdentity: (tree) => {
      selectedTreeIdentity = tree;
    },
    verify: () =>
      verifyUniversalArtifactInputsForTesting(
        {
          repositoryRoot: root,
          descriptor: parseUniversalArtifactDescriptor(value),
          temporaryRoot: root,
        },
        dependencies,
      ),
  };
}

test("universal preflight rejects a descriptor-selected source subset before reading files", async (t) => {
  const f = await sourceFixture(t);
  f.value.sourceManifest.pop();
  await assert.rejects(f.verify(), /Positive source manifest differs/u);
});

test("universal preflight rejects modified source bytes and executable mode", async (t) => {
  const f = await sourceFixture(t);
  const filename = path.join(f.root, f.value.sourceManifest[0].path);
  await fs.writeFile(filename, "changed synthetic public bytes\n");
  await assert.rejects(f.verify(), /Positive source bytes or mode changed/u);
  await fs.writeFile(filename, "synthetic public source\n");
  await fs.chmod(filename, 0o700);
  await assert.rejects(f.verify(), /Positive source bytes or mode changed/u);
});

test("universal preflight refuses a different selected main commit or tree", async (t) => {
  const f = await sourceFixture(t);
  f.selectCommit("f".repeat(40));
  await assert.rejects(f.verify(), /match the reviewed commit/u);
  f.selectCommit(f.value.inputs.sourceCommit);
  f.selectTreeIdentity("e".repeat(40));
  await assert.rejects(f.verify(), /Source tree differs/u);
});

test("fixture parent can start absent and rejects redirected or shared writable parents", async (t) => {
  const root = await ownedFixtureRoot(t);
  const created = await prepareTestParent(root);
  assert.equal(created, path.join(root, "artifacts/local-tool-tmp"));
  await fs.writeFile(
    path.join(created, "retained.txt"),
    "synthetic retained bytes",
    { mode: 0o600 },
  );
  assert.deepEqual(
    await Promise.all([prepareTestParent(root), prepareTestParent(root)]),
    [created, created],
  );
  assert.equal(
    await fs.readFile(path.join(created, "retained.txt"), "utf8"),
    "synthetic retained bytes",
  );
  await fs.chmod(created, 0o777);
  await assert.rejects(prepareTestParent(root));
  await fs.chmod(created, 0o700);
  await fs.rename(created, `${created}-retained`);
  await fs.symlink(`${created}-retained`, created);
  await assert.rejects(prepareTestParent(root));
});
