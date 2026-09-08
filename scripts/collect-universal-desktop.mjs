import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalClientUniversalBuildInputs } from "../packages/contracts/dist/build-identity.js";
import {
  uuid,
  sha256,
  jsonBytes,
  fail,
  exact,
  absolute,
  directory,
  ownedDirectory,
  readRegular,
  readJson,
  fileInventory,
  command,
  verifyUniversalInputs as verifyInputs,
  parseUniversalArtifactDescriptor,
  createUnsignedCollectorCommandEnvironment,
} from "./unsigned-artifact-inputs.mjs";
export {
  parseUniversalArtifactDescriptor,
  createUnsignedCollectorCommandEnvironment,
  isUniversalCollectorSourcePath,
  inspectUnsignedCollectorDependencyNames,
} from "./unsigned-artifact-inputs.mjs";
const scriptPath = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(scriptPath), "..");
const outputDirectories = Object.freeze([
  "packages/domain/dist",
  "packages/contracts/dist",
  "packages/test-support/dist",
]);
async function verifyOutputRoots(repositoryRoot) {
  for (const item of outputDirectories) {
    const filename = path.join(repositoryRoot, item);
    await directory(path.dirname(filename));
    try {
      await fileInventory(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
const architectures = Object.freeze(["arm64", "x64"]);
const nativeFiles = Object.freeze([
  "native/aac-protection.node",
  "native/durable-record.node",
]);

async function buildDistribution(
  repositoryRoot,
  descriptor,
  runRoot,
  dependencies,
  scope,
) {
  await verifyOutputRoots(repositoryRoot);
  const options = {
    cwd: repositoryRoot,
    env: createUnsignedCollectorCommandEnvironment(
      descriptor,
      path.join(runRoot, "temporary"),
    ),
  };
  const tsc = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
  for (const name of ["domain", "contracts", "test-support"]) {
    if (
      (
        await readJson(
          path.join(repositoryRoot, "packages", name, "package.json"),
        )
      ).scripts?.build !== "tsc -p tsconfig.build.json"
    )
      fail("Reviewed package build command changed");
    await scope.own(() =>
      dependencies.command(
        descriptor.paths.node,
        [tsc, "-p", `packages/${name}/tsconfig.build.json`],
        options,
      ),
    );
  }
  const commonRoot = path.join(runRoot, "common");
  await ownedDirectory(commonRoot, true);
  await ownedDirectory(path.join(runRoot, "slices"), true);
  for (const architecture of architectures) {
    await ownedDirectory(path.join(runRoot, "slices", architecture), true);
    await ownedDirectory(
      path.join(runRoot, "slices", architecture, "native"),
      true,
    );
  }
  // These are fixed program bodies with data arguments, never descriptor-selected commands.
  const program = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const row = JSON.parse(process.argv[1]);
    const load = name => import(pathToFileURL(path.join(row.repositoryRoot, "scripts", name)).href);
    const { buildDesktopCommon } = await load("build-app.mjs");
    const { buildDesktopAACProtection } = await load("build-desktop-aac-protection.mjs");
    const { buildDesktopDurableRecord } = await load("build-desktop-durable-record.mjs");
    await buildDesktopCommon({outputRoot: row.commonRoot, productionMode: true, publicBackend: row.publicBackend, buildInputs: row.inputs});
    for (const architecture of ["arm64", "x64"]) {
      const options = {architecture, outputDirectory: path.join(row.runRoot, "slices", architecture, "native"), toolchain: row.toolchain};
      await buildDesktopAACProtection(options);
      await buildDesktopDurableRecord(options);
    }
  `;
  await scope.own(() =>
    dependencies.command(
      descriptor.paths.node,
      [
        "--input-type=module",
        "--eval",
        program,
        JSON.stringify({
          repositoryRoot,
          commonRoot,
          runRoot,
          publicBackend: descriptor.publicBackend,
          inputs: descriptor.inputs,
          toolchain: {
            compiler: descriptor.paths.compiler,
            sdk: descriptor.paths.sdk,
            nodeHeaders: descriptor.paths.nodeHeaders,
          },
        }),
      ],
      options,
    ),
  );
  const context = dependencies.build.createUniversalDesktopBuildContext(
    descriptor.inputs,
    descriptor.publicBackend,
  );
  const common = await dependencies.artifact.inspectDesktopCommon({
    commonRoot,
    expectedBuildIdentity: context.identity,
  });
  const nativeSlices = {};
  for (const architecture of architectures) {
    const root = path.join(runRoot, "slices", architecture, "native");
    const artifacts = [];
    for (const filename of nativeFiles)
      artifacts.push(
        await dependencies.artifact.inspectNativeArtifact(
          path.dirname(root),
          filename,
          architecture,
        ),
      );
    nativeSlices[architecture] = { root, artifacts };
  }
  return { common, nativeSlices };
}

async function productionDependencies() {
  const [artifact, evidence, build] = await Promise.all([
    import("./desktop-artifact.mjs"),
    import("./unsigned-artifact-evidence.mjs"),
    import("./build-app.mjs"),
  ]);
  return {
    artifact,
    evidence,
    build,
    command,
    verifyInputs,
    buildDistribution,
    async packageArtifact(input, options) {
      const program = `
        import path from "node:path";
        import {pathToFileURL} from "node:url";
        const options = JSON.parse(process.argv[1]);
        const {packageUnsignedUniversalDesktop} = await import(pathToFileURL(path.join(options.repositoryRoot, "scripts/desktop-artifact.mjs")).href);
        process.stdout.write(JSON.stringify(await packageUnsignedUniversalDesktop(options)));
      `;
      const result = await command(
        options.node,
        ["--input-type=module", "--eval", program, JSON.stringify(input)],
        { cwd: input.repositoryRoot, env: options.env },
      );
      return JSON.parse(result.stdout);
    },
  };
}
async function collect(options, dependencies) {
  const { mode, runId, repositoryRoot } = options;
  if (!["create", "resume"].includes(mode) || !uuid.test(runId ?? ""))
    fail("Expected create or resume and a canonical UUIDv4");
  await directory(repositoryRoot);
  const artifactsRoot = path.join(repositoryRoot, "artifacts");
  await directory(artifactsRoot);
  const runRoot = path.join(artifactsRoot, "universal-artifact-runs", runId);
  const descriptorPath =
    mode === "create"
      ? path.join(artifactsRoot, "universal-artifact-inputs", `${runId}.json`)
      : path.join(runRoot, "descriptor.json");
  if (
    (mode === "create" && options.inputPath !== descriptorPath) ||
    (mode === "resume" && options.inputPath !== undefined)
  )
    fail(
      "Create inputs must use the fixed owned UUID descriptor path; resume uses retained inputs",
    );
  await ownedDirectory(path.dirname(descriptorPath));
  const descriptor = parseUniversalArtifactDescriptor(
    await readJson(descriptorPath, 2 * 1024 * 1024),
  );
  const context = dependencies.build.createUniversalDesktopBuildContext(
    descriptor.inputs,
    descriptor.publicBackend,
  );
  assert.equal(
    context.identity.buildId,
    sha256(
      Buffer.from(
        `desmoslock:universal-build:v1\0${canonicalClientUniversalBuildInputs(descriptor.inputs)}`,
      ),
    ),
  );
  const lease = path.join(artifactsRoot, "unsigned-artifact-collector.lock");
  let ownsLease = false;
  try {
    await ownedDirectory(lease, true);
    ownsLease = true;
  } catch (error) {
    if (error.code !== "EEXIST" || mode !== "resume") throw error;
    await ownedDirectory(lease);
    const retainedOwner = exact(
      await readJson(path.join(lease, "owner.json")),
      ["runId", "pid"],
    );
    if (retainedOwner.runId !== runId)
      fail("A different run owns the checkout build lease");
  }
  let store = null;
  let leaseOwnerWritten = false;
  // A rejected direct-child promise does not prove its compiler/packager descendants stopped.
  // Only a completed mutating observation clears this flag. Failure retains the build lease.
  let mutationUncertain = false;
  try {
    if (ownsLease) {
      await fs.writeFile(
        path.join(lease, "owner.json"),
        jsonBytes({ runId, pid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
      leaseOwnerWritten = true;
    }
    store = await dependencies.evidence.openUnsignedUniversalArtifactEvidence({
      mode,
      runRoot,
      runId,
      identity: context.identity,
      nativeModule: {
        path: dependencies.evidence.unsignedEvidenceNativePath,
        sha256: descriptor.nativeHelperSha256,
      },
    });
    if (mode === "create") {
      await fs.writeFile(
        path.join(runRoot, "descriptor.json"),
        jsonBytes(descriptor),
        { flag: "wx", mode: 0o600 },
      );
      await fs.writeFile(
        path.join(runRoot, "build-inputs.json"),
        `${canonicalClientUniversalBuildInputs(descriptor.inputs)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await ownedDirectory(path.join(runRoot, "temporary"), true);
      for (const name of ["npm-user.ini", "npm-global.ini"])
        await fs.writeFile(path.join(runRoot, "temporary", name), "", {
          flag: "wx",
          mode: 0o600,
        });
      await ownedDirectory(path.join(runRoot, "temporary", "tools-bin"), true);
      for (const name of ["lipo", "codesign"])
        await fs.symlink(
          descriptor.paths[name],
          path.join(runRoot, "temporary", "tools-bin", name),
        );
    } else {
      await ownedDirectory(path.join(runRoot, "temporary"));
      for (const name of ["npm-user.ini", "npm-global.ini"])
        if (
          (await readRegular(path.join(runRoot, "temporary", name))).bytes
            .length !== 0
        )
          fail("Owned tool configuration changed");
      if (
        (
          await readRegular(path.join(runRoot, "build-inputs.json"))
        ).bytes.toString("utf8") !==
        `${canonicalClientUniversalBuildInputs(descriptor.inputs)}\n`
      )
        fail("Retained canonical inputs changed");
      const retained = await store.readSnapshot();
      const lastPackage = retained.attempts.findLast(
        (attempt) => attempt.caseId === "packaged-inventory",
      );
      if (retained.candidate === null || lastPackage?.state !== "observed-pass")
        fail(
          "Resume requires a fully published, checkpoint-bound candidate with no unfinished packaging; recover earlier work in a fresh isolated checkout",
        );
      const sourceAttempt = retained.attempts.find(
        (attempt) =>
          attempt.caseId === "source-inputs" &&
          attempt.state === "observed-pass",
      );
      if (sourceAttempt !== undefined) {
        const original = await readJson(
          path.join(runRoot, "evidence", sourceAttempt.evidence[0].sha256),
          64 * 1024 * 1024,
        );
        if (original.descriptorSha256 !== sha256(jsonBytes(descriptor)))
          fail("Retained descriptor changed");
      }
    }
    const verifyToolLinks = async () => {
      await ownedDirectory(path.join(runRoot, "temporary", "tools-bin"));
      for (const name of ["lipo", "codesign"]) {
        const link = path.join(runRoot, "temporary", "tools-bin", name);
        if (
          !(await fs.lstat(link)).isSymbolicLink() ||
          (await fs.readlink(link)) !== descriptor.paths[name] ||
          (await fs.realpath(link)) !== descriptor.paths[name]
        )
          fail("Pinned packaging tool link changed");
        const measured = await readRegular(
          descriptor.paths[name],
          256 * 1024 * 1024,
        );
        if (
          measured.sha256 !== descriptor.inputs.tools[name].sha256 ||
          (measured.mode & 0o111) === 0
        )
          fail("Pinned packaging tool is changed or not executable");
        try {
          await fs.access(descriptor.paths[name], constants.X_OK);
        } catch {
          fail("Pinned packaging tool is changed or not executable");
        }
      }
    };
    await verifyToolLinks();
    let inputObservation;
    const record = async (caseId, observe, mutatesOutput = false) => {
      const snapshot = await store.readSnapshot();
      const completed = await store.recordCase(
        { expectedRevision: snapshot.revision, caseId },
        async (scope) => {
          try {
            const measurement = await observe(scope);
            const ref = await scope.writeEvidence(jsonBytes(measurement));
            return {
              state: "observed-pass",
              evidence: [ref],
              ...(caseId === "packaged-inventory"
                ? {
                    candidate: {
                      kind: "unsigned-universal-app",
                      treeSha256: measurement.tree.sha256,
                      inventory: ref,
                    },
                  }
                : {}),
            };
          } catch (error) {
            if (mutatesOutput && mutationUncertain)
              scope.markOutputSettlementUncertain();
            throw error;
          }
        },
      );
      const last = completed.attempts.at(-1);
      if (
        completed.attempts.length !== snapshot.attempts.length + 1 ||
        last?.caseId !== caseId ||
        last.state !== "observed-pass"
      )
        fail(`Collector observation did not pass: ${caseId}`);
      return completed;
    };
    await record("source-inputs", async (scope) => {
      inputObservation = await scope.own(() =>
        dependencies.verifyInputs(
          repositoryRoot,
          descriptor,
          path.join(runRoot, "temporary"),
          dependencies,
        ),
      );
      return inputObservation;
    });
    const candidateDirectory = path.join(runRoot, "candidate");
    let packaged;
    let distribution;
    let preFuseNativeArtifacts;
    const inspectCandidate = () =>
      dependencies.artifact.inspectUniversalDesktop({
        packageDirectory: candidateDirectory,
        expectedBuildIdentity: context.identity,
        commonObservation: distribution.common,
        nativeSliceObservations: distribution.nativeSlices,
        electronArchiveObservations: inputObservation.electronArchives,
        preFuseNativeArtifacts,
        temporaryRoot: path.join(runRoot, "temporary", randomUUID()),
      });
    let exists = false;
    try {
      await directory(candidateDirectory);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const prior = await store.readSnapshot();
    if (prior.candidate !== null && !exists)
      fail(
        "Retained candidate is missing; prior observations cannot be continued",
      );
    if (exists) {
      const distributionAttempt = prior.attempts.find(
        (attempt) =>
          attempt.caseId === "distribution-inventory" &&
          attempt.state === "observed-pass",
      );
      if (distributionAttempt === undefined || prior.candidate === null)
        fail("Candidate has no completed source-to-distribution observation");
      distribution = await readJson(
        path.join(runRoot, "evidence", distributionAttempt.evidence[0].sha256),
        64 * 1024 * 1024,
      );
      const retainedInventory = await readJson(
        path.join(runRoot, "evidence", prior.candidate.inventory.sha256),
        64 * 1024 * 1024,
      );
      if (
        retainedInventory.schemaVersion !== 1 ||
        retainedInventory.kind !== "unsigned-universal-app-inventory" ||
        retainedInventory.architecture !== "universal" ||
        retainedInventory.tree.sha256 !== prior.candidate.treeSha256
      )
        fail("Retained universal candidate inventory is invalid");
      assert.deepEqual(
        retainedInventory.composition.common,
        distribution.common,
        "Retained common build history changed",
      );
      assert.deepEqual(
        retainedInventory.composition.nativeSlices,
        distribution.nativeSlices,
        "Retained compiler history changed",
      );
      assert.deepEqual(
        retainedInventory.composition.electronArchives,
        inputObservation.electronArchives,
        "Retained archive history changed",
      );
      preFuseNativeArtifacts =
        retainedInventory.composition.preFuseNativeArtifacts;
      packaged = await inspectCandidate();
      if (
        prior.candidate !== null &&
        packaged.tree.sha256 !== prior.candidate.treeSha256
      )
        fail(
          "Retained candidate changed; prior observations cannot be continued",
        );
    } else {
      await record(
        "distribution-inventory",
        async (scope) => {
          mutationUncertain = true;
          distribution = await dependencies.buildDistribution(
            repositoryRoot,
            descriptor,
            runRoot,
            dependencies,
            scope,
          );
          const after = await scope.own(() =>
            dependencies.verifyInputs(
              repositoryRoot,
              descriptor,
              path.join(runRoot, "temporary"),
              dependencies,
            ),
          );
          assert.deepEqual(
            after,
            inputObservation,
            "Build inputs changed during the build",
          );
          return { kind: "universal-distribution-evidence", ...distribution };
        },
        true,
      );
      mutationUncertain = false;
      // Every packaging retry has new roots, preserving previous partial outputs.
      const attempt = path.join(runRoot, "temporary", randomUUID());
      await ownedDirectory(attempt, true);
      const packagingTemp = path.join(attempt, "os-temporary");
      await ownedDirectory(packagingTemp, true);
      await record(
        "packaged-inventory",
        async (scope) => {
          mutationUncertain = true;
          await verifyToolLinks();
          const result = await scope.own(() =>
            dependencies.packageArtifact(
              {
                repositoryRoot,
                commonRoot: path.join(runRoot, "common"),
                nativeSlices: distribution.nativeSlices,
                stageRoot: path.join(attempt, "stage"),
                outputRoot: path.join(attempt, "package"),
                temporaryRoot: path.join(attempt, "tools"),
                electronVersion: descriptor.inputs.tools.electron.version,
                electronArchives: inputObservation.electronArchives,
                expectedBuildIdentity: context.identity,
              },
              {
                node: descriptor.paths.node,
                env: {
                  ...createUnsignedCollectorCommandEnvironment(
                    descriptor,
                    path.join(runRoot, "temporary"),
                  ),
                  PATH: `${path.join(runRoot, "temporary", "tools-bin")}:${path.dirname(descriptor.paths.node)}:/usr/bin:/bin`,
                  TMPDIR: packagingTemp,
                  TMP: packagingTemp,
                  TEMP: packagingTemp,
                },
              },
            ),
          );
          assert.deepEqual(
            result.composition.common,
            distribution.common,
            "Packager used different common build inputs",
          );
          await verifyToolLinks();
          assert.deepEqual(
            result.composition.nativeSlices,
            distribution.nativeSlices,
            "Packager used different compiler inputs",
          );
          assert.deepEqual(
            result.composition.electronArchives,
            inputObservation.electronArchives,
            "Packager used different Electron archives",
          );
          assert.deepEqual(
            await scope.own(() =>
              dependencies.verifyInputs(
                repositoryRoot,
                descriptor,
                path.join(runRoot, "temporary"),
                dependencies,
              ),
            ),
            inputObservation,
            "Build inputs changed during packaging",
          );
          preFuseNativeArtifacts = result.composition.preFuseNativeArtifacts;
          // Rename the package directory atomically: no half-created final candidate directory.
          await fs.rename(result.packageDirectory, candidateDirectory);
          packaged = await inspectCandidate();
          assert.equal(
            packaged.tree.sha256,
            result.tree.sha256,
            "Candidate changed during publication",
          );
          return {
            kind: "unsigned-artifact-evidence",
            signing: "ad-hoc-only",
            ...packaged,
          };
        },
        true,
      );
      mutationUncertain = false;
    }
    if (exists)
      await record("packaged-inventory", async () => ({
        kind: "unsigned-artifact-evidence",
        signing: "ad-hoc-only",
        ...packaged,
      }));
    await record("packaged-fuses", async () => {
      const current = await inspectCandidate();
      assert.equal(
        current.tree.sha256,
        packaged.tree.sha256,
        "Candidate changed after inventory",
      );
      return {
        kind: "observed-fuses",
        treeSha256: current.tree.sha256,
        fuses: current.fuses,
      };
    });
    await record("native-inventory", async () => ({
      kind: "native-file-evidence",
      treeSha256: packaged.tree.sha256,
      nativeArtifacts: packaged.nativeArtifacts,
      architecture: "universal",
      execution: "not-performed",
    }));
    await store.revalidate({
      expectedRevision: (await store.readSnapshot()).revision,
    });
    if (!(await store.close({ timeoutMs: 60000 })))
      fail("Checkpoint did not drain; collector lease is retained");
    store = null;
    store = await dependencies.evidence.openUnsignedUniversalArtifactEvidence({
      mode: "resume",
      runRoot,
      runId,
      identity: context.identity,
      nativeModule: {
        path: dependencies.evidence.unsignedEvidenceNativePath,
        sha256: descriptor.nativeHelperSha256,
      },
    });
    await store.revalidate({
      expectedRevision: (await store.readSnapshot()).revision,
    });
    await record("checkpoint-readback", async () => ({
      kind: "checkpoint-reopen-evidence",
      runId,
      treeSha256: packaged.tree.sha256,
      statement:
        "Durable checkpoint with revalidated external evidence; no inherited power-loss durability for app or sidecar trees",
    }));
    const finalArtifact = await inspectCandidate();
    assert.equal(
      finalArtifact.tree.sha256,
      packaged.tree.sha256,
      "Candidate changed during checkpoint reopen",
    );
    await store.revalidate({
      expectedRevision: (await store.readSnapshot()).revision,
    });
    const snapshot = await store.readSnapshot();
    return {
      runId,
      runRoot,
      candidate: finalArtifact.appBundle,
      identity: context.identity,
      treeSha256: finalArtifact.tree.sha256,
      checkpointRevision: snapshot.revision,
      physicalAcceptance: "pending",
      signing: "ad-hoc-only",
    };
  } finally {
    // Never release either owner while registered work may still be running.
    const drained = store === null || (await store.close({ timeoutMs: 60000 }));
    if (!drained) {
      if (mutationUncertain) {
        fail(
          "Output settlement remains uncertain; pending checkpoint and collector lease are retained",
          "OUTPUT_SETTLEMENT_UNCERTAIN",
        );
      }
      fail("Checkpoint did not drain; collector lease is retained");
    }
    if (!mutationUncertain && ownsLease) {
      if (leaseOwnerWritten) await fs.unlink(path.join(lease, "owner.json"));
      await fs.rmdir(lease);
    }
  }
}
export async function collectUniversalDesktop(options) {
  return collect(
    { ...options, repositoryRoot: checkout },
    await productionDependencies(),
  );
}
/** Explicit synthetic seam. Production CLI never accepts dependencies or another checkout. */
export async function collectUniversalDesktopForTesting(options, dependencies) {
  return collect(options, dependencies);
}
/** Source preflight seam: tests supply synthetic Git responses and owned files. */
export async function verifyUniversalArtifactInputsForTesting(
  options,
  dependencies,
) {
  return verifyInputs(
    options.repositoryRoot,
    options.descriptor,
    options.temporaryRoot,
    dependencies,
  );
}
export function parseUniversalCollectorArguments(args) {
  if (
    !Array.isArray(args) ||
    !["create", "resume"].includes(args[0]) ||
    args[1] !== "--run-id" ||
    !uuid.test(args[2] ?? "") ||
    (args[0] === "create" && (args.length !== 5 || args[3] !== "--inputs")) ||
    (args[0] === "resume" && args.length !== 3)
  )
    fail(
      "Usage: collect-universal-desktop.mjs create --run-id <uuid> --inputs <owned descriptor>, or resume --run-id <uuid>",
    );
  return {
    mode: args[0],
    runId: args[2],
    ...(args[0] === "create" ? { inputPath: absolute(args[4]) } : {}),
  };
}
if (process.argv[1] === scriptPath) {
  try {
    process.stdout.write(
      `${JSON.stringify(await collectUniversalDesktop(parseUniversalCollectorArguments(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      error?.code === "OUTPUT_SETTLEMENT_UNCERTAIN"
        ? "Unsigned collector stopped with output settlement uncertain. The pending checkpoint and build lease are retained; recover in a fresh isolated checkout.\n"
        : "Unsigned collector stopped. Retained outputs require inspection; no physical acceptance was granted.\n",
    );
    process.exitCode = 1;
  }
}
