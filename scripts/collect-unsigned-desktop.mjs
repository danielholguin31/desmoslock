import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalClientBuildInputs } from "../packages/contracts/dist/build-identity.js";
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
  verifyInputs,
  parseUnsignedArtifactDescriptor,
  createUnsignedCollectorCommandEnvironment,
} from "./unsigned-artifact-inputs.mjs";
export {
  parseUnsignedArtifactDescriptor,
  createUnsignedCollectorCommandEnvironment,
  isUnsignedCollectorSourcePath,
  inspectUnsignedCollectorDependencyNames,
} from "./unsigned-artifact-inputs.mjs";
const scriptPath = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(scriptPath), "..");
const outputDirectories = Object.freeze([
  "packages/domain/dist",
  "packages/contracts/dist",
  "packages/test-support/dist",
  "apps/desktop/dist",
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
    const script = (
      await readJson(
        path.join(repositoryRoot, "packages", name, "package.json"),
      )
    ).scripts?.build;
    if (script !== "tsc -p tsconfig.build.json")
      fail("Reviewed package build command changed");
    await scope.own(() =>
      dependencies.command(
        descriptor.paths.node,
        [tsc, "-p", `packages/${name}/tsconfig.build.json`],
        options,
      ),
    );
  }
  await scope.own(() =>
    dependencies.command(
      descriptor.paths.node,
      [
        path.join(repositoryRoot, "scripts/build-app.mjs"),
        "desktop",
        "--production",
        "--candidate-inputs",
        path.join(runRoot, "build-inputs.json"),
      ],
      options,
    ),
  );
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
  };
}
async function collect(options, dependencies) {
  const { mode, runId, repositoryRoot } = options;
  if (!["create", "resume"].includes(mode) || !uuid.test(runId ?? ""))
    fail("Expected create or resume and a canonical UUIDv4");
  await directory(repositoryRoot);
  const artifactsRoot = path.join(repositoryRoot, "artifacts");
  await directory(artifactsRoot);
  const runRoot = path.join(artifactsRoot, "unsigned-artifact-runs", runId);
  const descriptorPath =
    mode === "create"
      ? path.join(artifactsRoot, "unsigned-artifact-inputs", `${runId}.json`)
      : path.join(runRoot, "descriptor.json");
  if (
    (mode === "create" && options.inputPath !== descriptorPath) ||
    (mode === "resume" && options.inputPath !== undefined)
  )
    fail(
      "Create inputs must use the fixed owned UUID descriptor path; resume uses retained inputs",
    );
  await ownedDirectory(path.dirname(descriptorPath));
  const descriptor = parseUnsignedArtifactDescriptor(
    await readJson(descriptorPath, 2 * 1024 * 1024),
  );
  const context = dependencies.build.createDesktopBuildContext(
    descriptor.inputs,
    descriptor.publicBackend,
  );
  assert.equal(
    context.identity.buildId,
    sha256(Buffer.from(canonicalClientBuildInputs(descriptor.inputs))),
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
    store = await dependencies.evidence.openUnsignedArtifactEvidence({
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
        `${canonicalClientBuildInputs(descriptor.inputs)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await ownedDirectory(path.join(runRoot, "temporary"), true);
      for (const name of ["npm-user.ini", "npm-global.ini"])
        await fs.writeFile(path.join(runRoot, "temporary", name), "", {
          flag: "wx",
          mode: 0o600,
        });
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
        `${canonicalClientBuildInputs(descriptor.inputs)}\n`
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
                      kind: "unsigned-native-app",
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
      if (
        !prior.attempts.some(
          (attempt) =>
            attempt.caseId === "distribution-inventory" &&
            attempt.state === "observed-pass",
        )
      )
        fail("Candidate has no completed source-to-distribution observation");
      packaged = await dependencies.artifact.inspectPackagedDesktop({
        packageDirectory: candidateDirectory,
        platform: descriptor.inputs.platform,
        architecture: descriptor.inputs.architecture,
        expectedBuildIdentity: context.identity,
      });
      if (
        prior.candidate !== null &&
        packaged.tree.sha256 !== prior.candidate.treeSha256
      )
        fail(
          "Retained candidate changed; prior observations cannot be continued",
        );
    } else {
      let distribution;
      await record(
        "distribution-inventory",
        async (scope) => {
          mutationUncertain = true;
          await dependencies.buildDistribution(
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
          distribution = await dependencies.artifact.inspectDesktopDistribution(
            {
              distributionRoot: path.join(repositoryRoot, "apps/desktop/dist"),
              platform: descriptor.inputs.platform,
              architecture: descriptor.inputs.architecture,
              expectedBuildIdentity: context.identity,
            },
          );
          return { kind: "distribution-evidence", ...distribution };
        },
        true,
      );
      mutationUncertain = false;
      // Every packaging retry has new roots, preserving previous partial outputs.
      const attempt = path.join(runRoot, "temporary", randomUUID());
      await ownedDirectory(attempt, true);
      await record(
        "packaged-inventory",
        async (scope) => {
          mutationUncertain = true;
          const result = await scope.own(() =>
            dependencies.artifact.packageUnsignedDesktop({
              repositoryRoot,
              distributionRoot: path.join(repositoryRoot, "apps/desktop/dist"),
              stageRoot: path.join(attempt, "stage"),
              outputRoot: path.join(attempt, "package"),
              temporaryRoot: path.join(attempt, "tools"),
              electronVersion: descriptor.inputs.tools.electron.version,
              electronArchive: inputObservation.electronArchive,
              platform: descriptor.inputs.platform,
              architecture: descriptor.inputs.architecture,
              expectedBuildIdentity: context.identity,
            }),
          );
          // Rename the package directory atomically: no half-created final candidate directory.
          await fs.rename(result.packageDirectory, candidateDirectory);
          packaged = await dependencies.artifact.inspectPackagedDesktop({
            packageDirectory: candidateDirectory,
            distribution,
            platform: descriptor.inputs.platform,
            architecture: descriptor.inputs.architecture,
            expectedBuildIdentity: context.identity,
          });
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
      const current = await dependencies.artifact.inspectPackagedDesktop({
        packageDirectory: candidateDirectory,
        platform: descriptor.inputs.platform,
        architecture: descriptor.inputs.architecture,
        expectedBuildIdentity: context.identity,
      });
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
      architecture: descriptor.inputs.architecture,
      execution: "not-performed",
    }));
    await store.revalidate({
      expectedRevision: (await store.readSnapshot()).revision,
    });
    if (!(await store.close({ timeoutMs: 60000 })))
      fail("Checkpoint did not drain; collector lease is retained");
    store = null;
    store = await dependencies.evidence.openUnsignedArtifactEvidence({
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
    const finalArtifact = await dependencies.artifact.inspectPackagedDesktop({
      packageDirectory: candidateDirectory,
      platform: descriptor.inputs.platform,
      architecture: descriptor.inputs.architecture,
      expectedBuildIdentity: context.identity,
    });
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
export async function collectUnsignedDesktop(options) {
  return collect(
    { ...options, repositoryRoot: checkout },
    await productionDependencies(),
  );
}
/** Explicit synthetic seam. Production CLI never accepts dependencies or another checkout. */
export async function collectUnsignedDesktopForTesting(options, dependencies) {
  return collect(options, dependencies);
}
/** Source preflight seam: tests supply synthetic Git responses and owned files. */
export async function verifyUnsignedArtifactInputsForTesting(
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
export function parseUnsignedCollectorArguments(args) {
  if (
    !Array.isArray(args) ||
    !["create", "resume"].includes(args[0]) ||
    args[1] !== "--run-id" ||
    !uuid.test(args[2] ?? "") ||
    (args[0] === "create" && (args.length !== 5 || args[3] !== "--inputs")) ||
    (args[0] === "resume" && args.length !== 3)
  )
    fail(
      "Usage: collect-unsigned-desktop.mjs create --run-id <uuid> --inputs <owned descriptor>, or resume --run-id <uuid>",
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
      `${JSON.stringify(await collectUnsignedDesktop(parseUnsignedCollectorArguments(process.argv.slice(2))))}\n`,
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
