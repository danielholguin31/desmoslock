import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";
import { parseClientBuildIdentity } from "../packages/contracts/dist/build-identity.js";
import {
  absolute,
  exact,
  readRegular,
  directory,
  ownedDirectory,
  inspectUnsignedCollectorDependencyNames,
} from "./unsigned-artifact-inputs.mjs";

const checkout = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const digestPattern = /^(?!0{64}$)[0-9a-f]{64}$/;
const gitPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const submissionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const appName = "DesmosLock Internal.app";
const commandNeverStarted = Symbol("commandNeverStarted");
const maximumInput = 64 * 1024 * 1024;
export const signedToolIds = Object.freeze([
  "node",
  "codesign",
  "codesignAllocate",
  "ditto",
  "hdiutil",
  "notarytool",
  "stapler",
  "spctl",
  "stat",
  "xattr",
  "ls",
  "sandboxExec",
]);
export const signedRunnerStageIds = Object.freeze([
  "input-validation",
  "custody-copies",
  "sign-code",
  "signed-app-verification",
  "dmg-create",
  "dmg-sign",
  "notary-submit",
  "notary-reconcile",
  "dmg-staple",
  "dmg-verification",
  "inspection-copy-mount",
  "checkpoint-readback",
]);
const toolingSources = Object.freeze([
  "scripts/sign-desktop-artifact.mjs",
  "scripts/desktop-artifact.mjs",
  "scripts/unsigned-artifact-evidence.mjs",
  "scripts/unsigned-artifact-inputs.mjs",
  "scripts/electron-fuse-policy.mjs",
  "packages/contracts/src/build-identity.ts",
  "packages/contracts/src/exact-record.ts",
  "packages/contracts/dist/build-identity.js",
  "packages/contracts/dist/exact-record.js",
  "package.json",
  "package-lock.json",
]);
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
function fail() {
  throw new Error("Signed artifact input or observation rejected");
}
function check(value) {
  if (!value) fail();
}
function hasControl(value) {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
function matches(expression, value) {
  return (
    typeof value === "string" && !hasControl(value) && expression.test(value)
  );
}
function data(value) {
  if (typeof value === "string") {
    check(!hasControl(value));
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  check(typeof value === "object");
  if (Array.isArray(value)) {
    boundedRows(value, 2048, 0).forEach(data);
    return;
  }
  const row = exact(value, Object.keys(value));
  Object.values(row).forEach(data);
}
function boundedRows(value, max, min = 1) {
  check(
    Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      value.length >= min &&
      value.length <= max &&
      Reflect.ownKeys(value).length === value.length + 1,
  );
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    check(entry?.enumerable && Object.hasOwn(entry, "value"));
    return entry.value;
  });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function signedCanonicalBytes(value) {
  return encode(canonical(value));
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function filePin(value, maximum = maximumInput) {
  const row = exact(value, ["path", "sha256", "bytes"]);
  absolute(row.path);
  check(
    digestPattern.test(row.sha256) &&
      Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= maximum,
  );
  return { ...row };
}
function source(value) {
  const row = exact(value, ["commit", "tree"]);
  check(gitPattern.test(row.commit) && gitPattern.test(row.tree));
  return { ...row };
}
function ci(value, commit) {
  const row = exact(value, [
    "commit",
    "verificationRunId",
    "securityRunId",
    "receipt",
  ]);
  check(
    row.commit === commit &&
      /^[1-9][0-9]{0,19}$/.test(row.verificationRunId) &&
      /^[1-9][0-9]{0,19}$/.test(row.securityRunId),
  );
  return { ...row, receipt: filePin(row.receipt) };
}
export function parseSignedArtifactDescriptor(value) {
  data(value);
  const row = exact(value, [
    "schemaVersion",
    "kind",
    "artifact",
    "tooling",
    "policy",
    "signingSteps",
    "authorization",
    "nativeHelper",
  ]);
  check(
    row.schemaVersion === 1 && row.kind === "signed-desktop-artifact-inputs",
  );
  const artifact = exact(row.artifact, [
    "identity",
    "source",
    "ci",
    "universalCheckpoint",
    "inventory",
    "treeSha256",
  ]);
  const identity = parseClientBuildIdentity(artifact.identity);
  check(identity !== null && digestPattern.test(artifact.treeSha256));
  const artifactSource = source(artifact.source);
  check(
    artifactSource.commit === identity.sourceCommit &&
      artifactSource.tree === identity.sourceTree,
  );
  const tooling = exact(row.tooling, [
    "source",
    "ci",
    "sourceManifest",
    "dependencies",
    "tools",
  ]);
  const toolingSource = source(tooling.source);
  const tools = exact(tooling.tools, signedToolIds);
  for (const id of signedToolIds) {
    tools[id] = filePin(tools[id], 256 * 1024 * 1024);
    const basename =
      { codesignAllocate: "codesign_allocate", sandboxExec: "sandbox-exec" }[
        id
      ] ?? id;
    check(path.basename(tools[id].path) === basename);
  }
  const manifest = boundedRows(
    tooling.sourceManifest,
    toolingSources.length,
  ).map((entry) => {
    const item = exact(entry, ["path", "mode", "gitBlob", "sha256", "bytes"]);
    check(
      toolingSources.includes(item.path) &&
        ["100644", "100755"].includes(item.mode) &&
        gitPattern.test(item.gitBlob) &&
        digestPattern.test(item.sha256) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes > 0 &&
        item.bytes <= maximumInput,
    );
    return { ...item };
  });
  assert.deepEqual(
    manifest.map((entry) => entry.path).sort(),
    [...toolingSources].sort(),
  );
  const dependencies = boundedRows(tooling.dependencies, 512).map((entry) => {
    const item = exact(entry, [
      "name",
      "version",
      "packageJsonSha256",
      "integrity",
    ]);
    check(
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name) &&
        /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item.version) &&
        digestPattern.test(item.packageJsonSha256) &&
        /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity),
    );
    return { ...item };
  });
  check(
    new Set(dependencies.map((entry) => entry.name)).size ===
      dependencies.length,
  );
  const authorization = exact(row.authorization, [
    "signingIdentitySha1",
    "notaryKeychainProfile",
    "executionApproval",
  ]);
  check(
    /^(?!0{40}$)[0-9A-F]{40}$/.test(authorization.signingIdentitySha1) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(
        authorization.notaryKeychainProfile,
      ),
  );
  const signingSteps = boundedRows(row.signingSteps, 50).map((entry) =>
    filePin(entry),
  );
  check(
    new Set(signingSteps.map((entry) => entry.path)).size ===
      signingSteps.length,
  );
  return freeze({
    schemaVersion: 1,
    kind: row.kind,
    artifact: {
      identity,
      source: artifactSource,
      ci: ci(artifact.ci, artifactSource.commit),
      universalCheckpoint: filePin(artifact.universalCheckpoint),
      inventory: filePin(artifact.inventory),
      treeSha256: artifact.treeSha256,
    },
    tooling: {
      source: toolingSource,
      ci: ci(tooling.ci, toolingSource.commit),
      sourceManifest: manifest,
      dependencies,
      tools: { ...tools },
    },
    policy: filePin(row.policy),
    signingSteps,
    authorization: {
      ...authorization,
      executionApproval: filePin(authorization.executionApproval),
    },
    nativeHelper: filePin(row.nativeHelper),
  });
}
export function signedEvidencePlan(descriptor) {
  return freeze({
    sha256: hash(signedCanonicalBytes(descriptor)),
    policySha256: descriptor.policy.sha256,
    unsignedCheckpointSha256: descriptor.artifact.universalCheckpoint.sha256,
    unsignedAppTreeSha256: descriptor.artifact.treeSha256,
    unsignedAppInventorySha256: descriptor.artifact.inventory.sha256,
    toolingProvenanceSha256: hash(signedCanonicalBytes(descriptor.tooling)),
    signingStepSha256s: descriptor.signingSteps.map((row) => row.sha256),
  });
}
export function parseSignedRunnerArguments(args) {
  data(args);
  check(
    Array.isArray(args) && args[1] === "--run-id" && uuidPattern.test(args[2]),
  );
  if (args[0] === "create") {
    check(args.length === 5 && args[3] === "--inputs");
    return {
      mode: "create",
      runId: args[2],
      descriptorPath: absolute(args[4]),
    };
  }
  check(
    ["resume", "reconcile", "readback"].includes(args[0]) && args.length === 3,
  );
  return { mode: args[0], runId: args[2], descriptorPath: null };
}
async function pinBytes(pin) {
  const measured = await readRegular(
    pin.path,
    Math.max(maximumInput, pin.bytes),
  );
  check(measured.sha256 === pin.sha256 && measured.bytes.length === pin.bytes);
  return measured.bytes;
}
const pinJson = async (pin) =>
  JSON.parse((await pinBytes(pin)).toString("utf8"));
function verifyCiReceipt(value, selected) {
  const row = exact(value, [
    "schemaVersion",
    "kind",
    "sourceCommit",
    "verificationRunId",
    "securityRunId",
    "verification",
    "security",
  ]);
  check(
    row.schemaVersion === 1 &&
      row.kind === "accepted-artifact-ci" &&
      row.sourceCommit === selected.commit &&
      row.verificationRunId === selected.verificationRunId &&
      row.securityRunId === selected.securityRunId &&
      row.verification === "success" &&
      row.security === "success",
  );
}
export function verifySignedExecutionApproval(value, descriptor, runId) {
  data(value);
  const row = exact(value, [
    "schemaVersion",
    "kind",
    "runId",
    "artifactIdentity",
    "unsignedCheckpointSha256",
    "unsignedAppTreeSha256",
    "policySha256",
    "toolingProvenanceSha256",
    "signingIdentitySha1",
    "certificateChainSha256s",
    "notaryKeychainProfile",
    "teamId",
    "trustedHostCustody",
    "authorizedOperations",
  ]);
  const plan = signedEvidencePlan(descriptor);
  check(
    row.schemaVersion === 1 &&
      row.kind === "signed-artifact-execution-approval" &&
      row.runId === runId &&
      uuidPattern.test(runId),
  );
  assert.deepEqual(row.artifactIdentity, descriptor.artifact.identity);
  for (const name of [
    "unsignedCheckpointSha256",
    "unsignedAppTreeSha256",
    "policySha256",
    "toolingProvenanceSha256",
  ])
    check(row[name] === plan[name]);
  check(
    row.signingIdentitySha1 === descriptor.authorization.signingIdentitySha1 &&
      row.notaryKeychainProfile ===
        descriptor.authorization.notaryKeychainProfile &&
      /^[A-Z0-9]{10}$/.test(row.teamId) &&
      row.trustedHostCustody === "exclusive-reviewed-host",
  );
  boundedRows(row.certificateChainSha256s, 4, 2).forEach((entry) =>
    check(digestPattern.test(entry)),
  );
  assert.deepEqual(row.authorizedOperations, [
    "copy",
    "sign-app",
    "create-sign-dmg",
    "submit-one-dmg",
    "reconcile-known-id",
    "staple-dmg",
    "assess",
    "readonly-inspection",
  ]);
  return freeze(JSON.parse(JSON.stringify(row)));
}
async function verifyInputs(repositoryRoot, descriptor, runId, observer) {
  check(
    (await fs.realpath(process.execPath)) ===
      descriptor.tooling.tools.node.path,
  );
  for (const item of descriptor.tooling.sourceManifest) {
    const measured = await readRegular(
      path.join(repositoryRoot, item.path),
      maximumInput,
    );
    check(
      measured.sha256 === item.sha256 &&
        measured.bytes.length === item.bytes &&
        hash(
          Buffer.concat([Buffer.from(`blob ${item.bytes}\0`), measured.bytes]),
          "sha1",
        ) === item.gitBlob &&
        ((measured.mode & 0o111) !== 0) === (item.mode === "100755"),
    );
  }
  const lock = JSON.parse(
    (
      await readRegular(path.join(repositoryRoot, "package-lock.json"))
    ).bytes.toString("utf8"),
  );
  const modulesRoot = path.join(repositoryRoot, "node_modules");
  const plistPackage = absolute(
    await fs.realpath(path.join(modulesRoot, "plist/package.json")),
  );
  check(plistPackage.endsWith("/node_modules/plist/package.json"));
  const providerRoot = path.resolve(plistPackage, "../../..");
  assert.deepEqual(
    await inspectUnsignedCollectorDependencyNames(modulesRoot, providerRoot),
    descriptor.tooling.dependencies.map((entry) => entry.name).sort(),
  );
  for (const dependency of descriptor.tooling.dependencies) {
    const packagePath = absolute(
      await fs.realpath(
        path.join(modulesRoot, dependency.name, "package.json"),
      ),
    );
    check(
      [modulesRoot, providerRoot].some(
        (root) =>
          packagePath === path.join(root, dependency.name, "package.json"),
      ),
    );
    const packageBytes = await readRegular(packagePath);
    const installed = JSON.parse(packageBytes.bytes.toString("utf8"));
    const locked = lock.packages?.[`node_modules/${dependency.name}`];
    check(
      packageBytes.sha256 === dependency.packageJsonSha256 &&
        installed.version === dependency.version &&
        locked?.version === dependency.version &&
        locked.integrity === dependency.integrity,
    );
  }
  for (const pin of Object.values(descriptor.tooling.tools))
    await pinBytes(pin);
  await pinBytes(descriptor.nativeHelper);
  check(
    descriptor.nativeHelper.path ===
      path.join(
        repositoryRoot,
        "artifacts/unsigned-artifact-tools/durable-record.node",
      ),
  );
  verifyCiReceipt(
    await pinJson(descriptor.artifact.ci.receipt),
    descriptor.artifact.ci,
  );
  verifyCiReceipt(
    await pinJson(descriptor.tooling.ci.receipt),
    descriptor.tooling.ci,
  );
  const unsignedCheckpoint = await pinJson(
    descriptor.artifact.universalCheckpoint,
  );
  const inventoryBytes = await pinBytes(descriptor.artifact.inventory);
  const unsignedInventory = JSON.parse(inventoryBytes.toString("utf8"));
  check(
    unsignedCheckpoint.schemaVersion === 1 &&
      unsignedCheckpoint.kind ===
        "desmoslock-unsigned-universal-artifact-evidence" &&
      uuidPattern.test(unsignedCheckpoint.runId) &&
      unsignedCheckpoint.candidate?.kind === "unsigned-universal-app",
  );
  assert.deepEqual(unsignedCheckpoint.identity, descriptor.artifact.identity);
  assert.deepEqual(unsignedCheckpoint.candidate.inventory, {
    sha256: descriptor.artifact.inventory.sha256,
    bytes: descriptor.artifact.inventory.bytes,
  });
  check(
    unsignedCheckpoint.candidate.treeSha256 ===
      descriptor.artifact.treeSha256 &&
      unsignedInventory.tree.sha256 === descriptor.artifact.treeSha256,
  );
  assert.deepEqual(
    unsignedInventory.buildIdentity,
    descriptor.artifact.identity,
  );
  check(
    unsignedCheckpoint.attempts.length > 0 &&
      unsignedCheckpoint.attempts.every(
        (attempt) => attempt.state === "observed-pass",
      ),
  );
  const unsignedRoot = path.resolve(unsignedInventory.appBundle, "../..");
  check(
    path.basename(unsignedRoot) === unsignedCheckpoint.runId &&
      path.basename(path.dirname(unsignedRoot)) === "universal-artifact-runs",
  );
  const originalApp = path.join(unsignedRoot, "candidate", appName);
  check(unsignedInventory.appBundle === originalApp);
  for (const name of [
    "source-inputs",
    "distribution-inventory",
    "packaged-inventory",
    "packaged-fuses",
    "native-inventory",
    "checkpoint-readback",
  ])
    check(
      unsignedCheckpoint.attempts.some(
        (entry) => entry.caseId === name && entry.state === "observed-pass",
      ),
    );
  for (const attempt of boundedRows(unsignedCheckpoint.attempts, 64)) {
    for (const value of boundedRows(attempt.evidence, 32)) {
      const ref = exact(value, ["sha256", "bytes"]);
      check(
        digestPattern.test(ref.sha256) &&
          Number.isSafeInteger(ref.bytes) &&
          ref.bytes > 0 &&
          ref.bytes <= maximumInput,
      );
      await pinBytes({
        path: path.join(unsignedRoot, "evidence", ref.sha256),
        ...ref,
      });
    }
  }
  const policy = await pinJson(descriptor.policy);
  const signingSteps = [];
  for (const pin of descriptor.signingSteps)
    signingSteps.push(await pinJson(pin));
  const derivedPlan = observer.deriveSignedArtifactPlan({
    unsignedInventory,
    policy,
    signingSteps,
  });
  const approval = verifySignedExecutionApproval(
    await pinJson(descriptor.authorization.executionApproval),
    descriptor,
    runId,
  );
  check(approval.teamId === policy.teamId);
  return {
    unsignedInventory,
    inventoryBytes,
    policy,
    derivedPlan,
    approval,
    originalApp,
  };
}

// Never pass inherited credential/config/loader environment or descriptor commands.
export function signedCommandEnvironment(descriptor, temporaryRoot) {
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    CODESIGN_ALLOCATE: descriptor.tooling.tools.codesignAllocate.path,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}
export function signedSandboxProfile(workRoot, temporaryRoot, tools) {
  const quote = (value) => JSON.stringify(value);
  return `(version 1)\n(deny default)\n(allow file-read*)\n(allow sysctl-read)\n(allow process-fork)\n(allow process-exec (literal ${quote(tools.codesign.path)}) (literal ${quote(tools.codesignAllocate.path)}))\n(allow file-write* (subpath ${quote(workRoot)}) (subpath ${quote(temporaryRoot)}))\n(allow mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.trustd") (global-name "com.apple.ocspd"))\n(allow network-outbound)\n`;
}
async function trackedCommand(
  scope,
  descriptor,
  temporaryRoot,
  toolId,
  args,
  {
    confined = false,
    workRoot = null,
    timeoutMs = 120000,
    beforeInvoke = null,
  } = {},
) {
  let started = false;
  try {
    check(
      signedToolIds.includes(toolId) &&
        toolId !== "node" &&
        toolId !== "codesignAllocate" &&
        toolId !== "sandboxExec" &&
        Array.isArray(args) &&
        args.every(
          (arg) =>
            typeof arg === "string" && arg.length < 32768 && !hasControl(arg),
        ) &&
        args.join("\0").length <= 131072,
    );
    await pinBytes(descriptor.tooling.tools[toolId]);
    if (toolId === "codesign")
      await pinBytes(descriptor.tooling.tools.codesignAllocate);
    let executable = descriptor.tooling.tools[toolId].path;
    let argv = args;
    if (confined) {
      check(toolId === "codesign" && workRoot !== null);
      await pinBytes(descriptor.tooling.tools.sandboxExec);
      argv = [
        "-p",
        signedSandboxProfile(workRoot, temporaryRoot, descriptor.tooling.tools),
        executable,
        ...args,
      ];
      executable = descriptor.tooling.tools.sandboxExec.path;
    }
    return await scope.own(
      () =>
        new Promise((resolve, reject) => {
          if (beforeInvoke !== null) beforeInvoke();
          const child = spawn(executable, argv, {
            cwd: temporaryRoot,
            env: signedCommandEnvironment(descriptor, temporaryRoot),
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          });
          started = true;
          scope.trackChild(child);
          scope.trackStream(child.stdout);
          scope.trackStream(child.stderr);
          let stdout = Buffer.alloc(0);
          let stderr = Buffer.alloc(0);
          let invalid = false;
          let spawnFailed = false;
          let hardTimer = null;
          const terminate = () => {
            invalid = true;
            child.kill("SIGKILL");
            hardTimer ??= setTimeout(() => {
              scope.markOutputSettlementUncertain();
              reject(new Error("Pinned command close is unconfirmed"));
            }, 1000);
          };
          const timer = setTimeout(terminate, timeoutMs);
          const collect = (name, bytes) => {
            const prior = name === "stdout" ? stdout : stderr;
            if (prior.length + bytes.length > 8 * 1024 * 1024) {
              terminate();
              return;
            }
            if (name === "stdout") stdout = Buffer.concat([prior, bytes]);
            else stderr = Buffer.concat([prior, bytes]);
          };
          child.stdout.on("data", (bytes) => collect("stdout", bytes));
          child.stderr.on("data", (bytes) => collect("stderr", bytes));
          child.on("error", () => {
            spawnFailed = true;
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (hardTimer !== null) clearTimeout(hardTimer);
            if (invalid || signal !== null)
              scope.markOutputSettlementUncertain();
            if (
              invalid ||
              spawnFailed ||
              signal !== null ||
              !Number.isInteger(code)
            ) {
              reject(new Error("Pinned command did not settle successfully"));
              return;
            }
            resolve({
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
              exitCode: code,
            });
          });
        }),
    );
  } catch (error) {
    if (!started) error[commandNeverStarted] = true;
    throw error;
  }
}

export function parseSignedCodeDisplay(text, expected) {
  check(
    typeof text === "string" && text.length <= 131072 && !text.includes("\0"),
  );
  const lines = text.split(/\r?\n/);
  const one = (name) => {
    const selected = lines.filter((line) => line.startsWith(`${name}=`));
    check(selected.length === 1);
    return selected[0].slice(name.length + 1);
  };
  check(
    one("Identifier") === expected.identifier &&
      one("TeamIdentifier") === expected.teamId,
  );
  const cdhash = one("CDHash");
  check(/^[a-f0-9]{40}$/.test(cdhash));
  check(
    one("Timestamp").length < 128 &&
      Number.isFinite(Date.parse(one("Timestamp").replace(" at ", " "))) &&
      !/^(none|0|not set)$/i.test(one("Timestamp")),
  );
  const directoryLines = lines.filter((line) =>
    line.startsWith("CodeDirectory "),
  );
  check(
    directoryLines.length === 1 &&
      /flags=0x[0-9a-f]+\(/.test(directoryLines[0]),
  );
  const flags = Number.parseInt(
    directoryLines[0].match(/flags=0x([0-9a-f]+)/)[1],
    16,
  );
  check(
    ((flags & 0x10000) !== 0) === expected.runtime &&
      lines.filter((line) => line.startsWith("Authority=")).length >= 2,
  );
  check(
    !lines.some((line) => /Signature=adhoc|TeamIdentifier=not set/.test(line)),
  );
  return {
    cdhash,
    identifier: expected.identifier,
    teamId: expected.teamId,
    runtime: expected.runtime,
    timestamp: one("Timestamp"),
  };
}
export function parseSignedEntitlements(stdout, stderr, expected) {
  check(
    typeof stdout === "string" &&
      typeof stderr === "string" &&
      stdout.length <= 32768 &&
      stderr.length <= 131072,
  );
  let value;
  if (stdout.trim() === "") {
    check(
      /(?:^|\n)(?:[^\n]*: )?no entitlements(?:\r?\n|$)/i.test(stderr) &&
        Object.keys(expected).length === 0,
    );
    value = {};
  } else {
    check(stdout.includes("<plist") && !stdout.includes("<!ENTITY"));
    value = plist.parse(stdout);
  }
  assert.deepEqual(value, expected);
  return value;
}
export function parseNotarySubmission(value) {
  const row = exact(value, ["id", "message", "path"]);
  check(
    matches(submissionPattern, row.id) &&
      typeof row.message === "string" &&
      typeof row.path === "string",
  );
  return row.id;
}
export function parseNotaryInformation(value, id) {
  const row = exact(value, ["createdDate", "id", "message", "name", "status"]);
  check(
    row.id === id &&
      matches(submissionPattern, id) &&
      typeof row.createdDate === "string" &&
      typeof row.message === "string" &&
      typeof row.name === "string",
  );
  check(
    ["In Progress", "Accepted", "Rejected", "Invalid"].includes(row.status),
  );
  return {
    "In Progress": "in-progress",
    Accepted: "accepted",
    Rejected: "rejected",
    Invalid: "rejected",
  }[row.status];
}
export function verifyNotaryTicket(value, id, submittedSha256, expectedHashes) {
  const row = exact(value, [
    "logFormatVersion",
    "jobId",
    "status",
    "statusSummary",
    "statusCode",
    "archiveFilename",
    "uploadDate",
    "sha256",
    "ticketContents",
    "issues",
  ]);
  check(
    row.logFormatVersion === 1 &&
      row.jobId === id &&
      row.status === "Accepted" &&
      row.statusCode === 0 &&
      row.sha256 === submittedSha256 &&
      row.issues === null &&
      typeof row.statusSummary === "string" &&
      typeof row.archiveFilename === "string" &&
      typeof row.uploadDate === "string",
  );
  const contents = boundedRows(row.ticketContents, 256).map((value) => {
    const item = exact(value, ["path", "digestAlgorithm", "cdhash", "arch"]);
    check(
      typeof item.path === "string" &&
        item.path.length <= 4096 &&
        item.digestAlgorithm === "SHA-256" &&
        /^[a-f0-9]{40}$/.test(item.cdhash) &&
        ["arm64", "x86_64", null].includes(item.arch),
    );
    return item;
  });
  for (const expected of expectedHashes)
    check(
      contents.some(
        (item) =>
          item.arch === expected.arch &&
          item.cdhash === expected.cdhash &&
          item.path.endsWith(expected.path),
      ),
    );
  return { id, submittedSha256, covered: expectedHashes };
}

function hashOnly(value) {
  if (value === null) return null;
  return value.kind === "app-tree"
    ? { kind: "app-tree", treeSha256: value.treeSha256 }
    : { kind: "dmg-file", sha256: value.sha256, bytes: value.bytes };
}
function stageSchedule(plan) {
  return signedRunnerStageIds.flatMap((stageId) =>
    stageId === "sign-code"
      ? plan.signingStepSha256s.map((_, signingIndex) => ({
          stageId,
          signingIndex,
        }))
      : [{ stageId, signingIndex: null }],
  );
}
export function signedNextStage(snapshot, mode = "resume") {
  const schedule = stageSchedule(snapshot.plan);
  let cursor = 0;
  let blocked = false;
  for (const attempt of snapshot.attempts) {
    if (attempt.state !== "observed-pass") {
      if (!(
        attempt.stageId === "notary-reconcile" &&
        ["operation_failed", "operation_incomplete"].includes(attempt.failure)
      ))
        blocked = true;
    } else if (
      !blocked &&
      schedule[cursor]?.stageId === attempt.stageId &&
      schedule[cursor].signingIndex === attempt.signingIndex &&
      !(
        attempt.stageId === "notary-reconcile" &&
        attempt.notaryStatus !== "accepted"
      )
    )
      cursor += 1;
  }
  if (mode === "readback")
    return { stageId: "checkpoint-readback", signingIndex: null };
  if (mode === "reconcile") {
    check(snapshot.submission !== null && snapshot.notaryStatus !== "rejected");
    return { stageId: "notary-reconcile", signingIndex: null };
  }
  check(!blocked);
  return schedule[cursor] ?? null;
}
function currentArtifact(snapshot, stageId) {
  if (["notary-reconcile", "dmg-staple"].includes(stageId))
    return hashOnly(snapshot.candidates.submittedDmg);
  if (["dmg-verification", "inspection-copy-mount"].includes(stageId))
    return hashOnly(snapshot.candidates.finalDmg);
  return hashOnly(
    snapshot.attempts.findLast(
      (entry) =>
        entry.state === "observed-pass" && entry.outputArtifact !== null,
    )?.outputArtifact ?? {
      kind: "app-tree",
      treeSha256: snapshot.plan.unsignedAppTreeSha256,
    },
  );
}
async function newDirectory(filename) {
  await ownedDirectory(filename, true);
  return filename;
}
async function newFile(filename, contents) {
  await fs.writeFile(filename, contents, { flag: "wx", mode: 0o600 });
}
async function absent(filename) {
  try {
    await fs.lstat(filename);
    fail();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function measureDmg(filename) {
  await directory(path.dirname(filename));
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    check(
      before.isFile() &&
        before.nlink === 1 &&
        before.size > 0 &&
        before.size <= 4 * 1024 * 1024 * 1024,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (bytes < before.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - bytes),
        bytes,
      );
      check(read.bytesRead > 0);
      digest.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    check(
      !named.isSymbolicLink() &&
        named.dev === before.dev &&
        named.ino === before.ino &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
    );
    return { kind: "dmg-file", sha256: digest.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}
function objectTarget(app, row) {
  return row.objectPath === "." ? app : path.join(app, row.objectPath);
}
function custodyNameFence(app, snapshot) {
  check(realpathSync(app) === app);
  for (const row of snapshot.metadata.entries) {
    const status = lstatSync(path.join(app, row.path === "." ? "" : row.path), {
      bigint: true,
    });
    check(
      String(status.dev) === row.device &&
        String(status.ino) === row.inode &&
        String(status.mtimeNs) === row.mtimeNs &&
        String(status.ctimeNs) === row.ctimeNs &&
        Number(status.mode) === row.mode &&
        Number(status.uid) === row.uid &&
        Number(status.gid) === row.gid &&
        Number(status.nlink) === row.links,
    );
  }
}
async function checkCertificates(prefix, approval) {
  const names = (await fs.readdir(path.dirname(prefix)))
    .filter((name) => name.startsWith(path.basename(prefix)))
    .sort();
  assert.deepEqual(
    names,
    approval.certificateChainSha256s.map(
      (_, index) => `${path.basename(prefix)}${index}`,
    ),
  );
  const fingerprints = [];
  for (let index = 0; index < names.length; index += 1) {
    const measured = await readRegular(`${prefix}${index}`, 65536);
    check(measured.sha256 === approval.certificateChainSha256s[index]);
    const cert = new X509Certificate(measured.bytes);
    if (index === 0)
      check(
        hash(cert.raw, "sha1").toUpperCase() === approval.signingIdentitySha1,
      );
    fingerprints.push(measured.sha256);
  }
  return fingerprints;
}
async function verifyCode({
  command,
  target,
  row,
  approval,
  temporaryRoot,
  architectures = ["arm64", "x86_64"],
  certificates = checkCertificates,
}) {
  await command("codesign", [
    "--verify",
    "--strict",
    "--all-architectures",
    "--verbose=4",
    "--test-requirement",
    row.requirement,
    target,
  ]);
  const results = [];
  for (const arch of architectures) {
    const prefix = path.join(temporaryRoot, `certificate-${results.length}-`);
    const selection = arch === null ? [] : ["--architecture", arch];
    const display = await command("codesign", [
      "--display",
      "--verbose=4",
      ...selection,
      "--extract-certificates",
      prefix,
      target,
    ]);
    const metadata = parseSignedCodeDisplay(display.stderr, {
      ...row,
      teamId: approval.teamId,
    });
    const entitlements = await command("codesign", [
      "--display",
      ...selection,
      "--entitlements",
      "-",
      "--xml",
      target,
    ]);
    parseSignedEntitlements(
      entitlements.stdout,
      entitlements.stderr,
      row.entitlements,
    );
    const requirement = await command("codesign", [
      "--display",
      ...selection,
      "--requirements",
      "-",
      target,
    ]);
    const designated = `${requirement.stdout}\n${requirement.stderr}`
      .split(/\r?\n/)
      .filter((line) => line.startsWith("designated => "));
    assert.deepEqual(designated, [`designated => ${row.requirement}`]);
    results.push({
      arch,
      ...metadata,
      certificateChainSha256s: await certificates(prefix, approval),
      path: row.primaryPath,
    });
  }
  return results;
}
async function inspectMountedImage(output, mountPoint) {
  check(output.length <= 1024 * 1024 && !output.includes("<!ENTITY"));
  const row = plist.parse(output);
  const entities = boundedRows(row["system-entities"], 32);
  const mounted = entities.filter(
    (entry) => entry["mount-point"] !== undefined,
  );
  check(mounted.length === 1 && mounted[0]["mount-point"] === mountPoint);
  const devices = entities
    .map((entry) => entry["dev-entry"])
    .filter((value) => value !== undefined);
  check(
    devices.length > 0 &&
      devices.every((value) =>
        /^\/dev\/disk[1-9][0-9]*(?:s[1-9][0-9]*)?$/.test(value),
      ),
  );
  const base = devices.find((value) => /^\/dev\/disk[1-9][0-9]*$/.test(value));
  check(
    base !== undefined &&
      devices.every((value) => value === base || value.startsWith(`${base}s`)),
  );
  return base;
}
async function productionDependencies() {
  const [observer, evidence] = await Promise.all([
    import("./desktop-artifact.mjs"),
    import("./unsigned-artifact-evidence.mjs"),
  ]);
  return {
    observer,
    evidence,
    verifyInputs,
    command: trackedCommand,
    measureDmg,
    verifyCode,
    inspectMountedImage,
  };
}

async function runSigned(options, dependencies) {
  const { mode, runId, descriptorPath, repositoryRoot } = options;
  check(
    ["create", "resume", "reconcile", "readback"].includes(mode) &&
      uuidPattern.test(runId),
  );
  await directory(repositoryRoot);
  const artifactsRoot = path.join(repositoryRoot, "artifacts");
  await ownedDirectory(artifactsRoot);
  const runRoot = path.join(artifactsRoot, "signed-artifact-runs", runId);
  const storedDescriptor = path.join(runRoot, "descriptor.json");
  const descriptor = parseSignedArtifactDescriptor(
    JSON.parse(
      (
        await readRegular(
          mode === "create" ? absolute(descriptorPath) : storedDescriptor,
          2 * 1024 * 1024,
        )
      ).bytes.toString("utf8"),
    ),
  );
  const binding = signedEvidencePlan(descriptor);
  const context = await dependencies.verifyInputs(
    repositoryRoot,
    descriptor,
    runId,
    dependencies.observer,
  );
  // Always derive from immutable admitted inputs, including on resume. A retained
  // self-hashed plan cannot expand the permitted signature paths.
  const rederived = dependencies.observer.deriveSignedArtifactPlan({
    unsignedInventory: context.unsignedInventory,
    policy: context.policy,
    signingSteps: context.derivedPlan.signingSteps,
  });
  assert.deepEqual(rederived, context.derivedPlan);
  const plan = rederived;
  const lease = path.join(artifactsRoot, "unsigned-artifact-collector.lock");
  await ownedDirectory(lease, true); // Never reclaim a stale/uncertain lease automatically.
  let store = null;
  let uncertain = false;
  const open = (selectedMode) =>
    dependencies.evidence.openSignedArtifactEvidence({
      mode: selectedMode,
      runRoot,
      runId,
      identity: descriptor.artifact.identity,
      nativeModule: {
        path: descriptor.nativeHelper.path,
        sha256: descriptor.nativeHelper.sha256,
      },
      plan: binding,
    });
  try {
    await newFile(
      path.join(lease, "owner.json"),
      encode({ runId, pid: process.pid }),
    );
    try {
      store = await open(mode === "create" ? "create" : "resume");
    } catch (error) {
      uncertain = true;
      throw error;
    }
    const temporaryRoot = path.join(runRoot, "temporary");
    const workRoot = path.join(runRoot, "work");
    const custodyRoot = path.join(runRoot, "unsigned-custody");
    const imageRoot = path.join(runRoot, "image");
    const workApp = path.join(workRoot, appName);
    const custodyApp = path.join(custodyRoot, appName);
    const submittedDmg = path.join(imageRoot, "DesmosLock-Internal.dmg");
    const finalDmg = path.join(imageRoot, "DesmosLock-Internal-stapled.dmg");
    if (mode === "create") {
      await newFile(storedDescriptor, signedCanonicalBytes(descriptor));
      await newFile(path.join(runRoot, "derived-plan.json"), encode(plan));
      await newDirectory(temporaryRoot);
      await newDirectory(workRoot);
      await newDirectory(custodyRoot);
      await newDirectory(imageRoot);
    } else {
      assert.deepEqual(
        JSON.parse(
          (
            await readRegular(path.join(runRoot, "derived-plan.json"))
          ).bytes.toString("utf8"),
        ),
        plan,
      );
      await ownedDirectory(temporaryRoot);
      await ownedDirectory(workRoot);
      await ownedDirectory(custodyRoot);
      await ownedDirectory(imageRoot);
    }
    let oneShot = ["reconcile", "readback"].includes(mode);
    let signatureReport = null;
    const observe = async (appBundle, scope, command) =>
      dependencies.observer.inspectSignedArtifactCustody({
        appBundle,
        temporaryRoot: await newDirectory(
          path.join(temporaryRoot, `observe-${cryptoId()}`),
        ),
        expectedBuildIdentity: descriptor.artifact.identity,
        unsignedInventory: context.unsignedInventory,
        policy: context.policy,
        runCommand: (toolId, args) => command(toolId, args),
      });
    const readOnlyScope = {
      own: (work) => work(),
      trackChild: () => {},
      trackStream: () => {},
      markOutputSettlementUncertain: () => {
        uncertain = true;
      },
    };
    const readOnlyCommand = async (toolId, args) => {
      check(["stat", "ls", "xattr"].includes(toolId));
      const result = await dependencies.command(
        readOnlyScope,
        descriptor,
        temporaryRoot,
        toolId,
        args,
      );
      check(result.exitCode === 0);
      return result;
    };
    const previousWorkArtifact = (snapshot) =>
      snapshot.attempts.findLast(
        (attempt) =>
          attempt.state === "observed-pass" &&
          ["custody-copies", "sign-code", "signed-app-verification"].includes(
            attempt.stageId,
          ),
      )?.outputArtifact ?? null;
    const readWorkInventory = async (artifact) => {
      check(artifact?.kind === "app-tree");
      const ref = artifact.inventory;
      const measured = await readRegular(
        path.join(runRoot, "evidence", ref.sha256),
        maximumInput,
      );
      check(
        measured.sha256 === ref.sha256 && measured.bytes.length === ref.bytes,
      );
      const retained = JSON.parse(measured.bytes.toString("utf8"));
      check(
        retained.kind === "signed-artifact-custody" &&
          retained.tree.sha256 === artifact.treeSha256,
      );
      return retained;
    };
    const revalidateCandidates = async (snapshot) => {
      if (snapshot.candidates.signedApp !== null) {
        const actual = await observe(workApp, readOnlyScope, readOnlyCommand);
        assert.deepEqual(
          actual,
          await readWorkInventory(snapshot.candidates.signedApp),
        );
      }
      if (snapshot.candidates.submittedDmg !== null)
        assert.deepEqual(
          await dependencies.measureDmg(submittedDmg),
          hashOnly(snapshot.candidates.submittedDmg),
        );
      if (snapshot.candidates.finalDmg !== null)
        assert.deepEqual(
          await dependencies.measureDmg(finalDmg),
          hashOnly(snapshot.candidates.finalDmg),
        );
    };
    while (true) {
      let snapshot = await store.readSnapshot();
      const selected = signedNextStage(snapshot, oneShot ? mode : "resume");
      if (selected === null) break;
      const { stageId, signingIndex } = selected;
      const dmg =
        ["dmg-verification", "inspection-copy-mount"].includes(stageId) ||
        (stageId === "checkpoint-readback" &&
          snapshot.candidates.finalDmg !== null)
          ? finalDmg
          : submittedDmg;
      const failureReadback =
        stageId === "checkpoint-readback" &&
        snapshot.attempts.some((attempt) => attempt.state !== "observed-pass");
      if (stageId === "checkpoint-readback") {
        check(await store.close({ timeoutMs: 60000 }));
        store = null;
        try {
          store = await open("resume");
        } catch (error) {
          uncertain = true;
          throw error;
        }
        snapshot = await store.readSnapshot();
        await store.revalidate({ expectedRevision: snapshot.revision });
      }
      const inputArtifact = currentArtifact(snapshot, stageId);
      const step =
        signingIndex === null ? null : plan.signingSteps[signingIndex];
      // Read-only preparation happens before pending; no command that changes an
      // artifact is allowed until recordStage invokes its callback.
      let before = null;
      let beforeApp = null;
      if (["input-validation", "custody-copies"].includes(stageId))
        beforeApp = context.originalApp;
      else if (
        ["sign-code", "signed-app-verification", "dmg-create"].includes(stageId)
      )
        beforeApp = workApp;
      else if (
        stageId === "checkpoint-readback" &&
        inputArtifact.kind === "app-tree" &&
        !failureReadback
      )
        beforeApp =
          previousWorkArtifact(snapshot) === null
            ? context.originalApp
            : workApp;
      if (beforeApp !== null)
        before = await observe(beforeApp, readOnlyScope, readOnlyCommand);
      if (before !== null) {
        check(
          before.tree.sha256 ===
            (inputArtifact.kind === "app-tree"
              ? inputArtifact.treeSha256
              : snapshot.candidates.signedApp.treeSha256),
        );
        if (beforeApp === workApp) {
          // This is the same work copy: retain every acknowledged identity and
          // timestamp. Copy-specific exceptions apply only inside the copy stage.
          assert.deepEqual(
            before,
            await readWorkInventory(previousWorkArtifact(snapshot)),
          );
          const original = await observe(
            custodyApp,
            readOnlyScope,
            readOnlyCommand,
          );
          check(original.tree.sha256 === descriptor.artifact.treeSha256);
        }
      } else if (inputArtifact.kind === "dmg-file" && !failureReadback)
        assert.deepEqual(await dependencies.measureDmg(dmg), inputArtifact);
      const stageTemp = await newDirectory(
        path.join(
          temporaryRoot,
          `stage-${snapshot.attempts.length + 1}-${cryptoId()}`,
        ),
      );
      const entitlementPath = path.join(stageTemp, "entitlements.plist");
      if (step !== null)
        await newFile(entitlementPath, plist.build(step.entitlements));
      const signArgs =
        step === null
          ? null
          : [
              "--force",
              "--sign",
              descriptor.authorization.signingIdentitySha1,
              "--timestamp",
              "--identifier",
              step.identifier,
              "--requirements",
              `=designated => ${step.requirement}`,
              ...(step.runtime ? ["--options", "runtime"] : []),
              ...(Object.keys(step.entitlements).length > 0
                ? ["--entitlements", entitlementPath]
                : []),
              objectTarget(workApp, step),
            ];
      const reservation = encode({
        schemaVersion: 1,
        kind: "signed-command-reservation",
        stageId,
        signingIndex,
        planSha256: binding.sha256,
        derivedPlanSha256: plan.sha256,
        policySha256: binding.policySha256,
        toolingProvenanceSha256: binding.toolingProvenanceSha256,
        inputArtifact,
        before,
        step,
        target:
          step === null
            ? null
            : before.machOFiles.find(
                (entry) => entry.path === step.primaryPath,
              ),
        signingArguments: signArgs,
        tools: descriptor.tooling.tools,
        submission: snapshot.submission,
      });
      let acceptedStatus = null;
      const complete = await store.recordStage(
        {
          expectedRevision: snapshot.revision,
          stageId,
          signingIndex,
          inputArtifact,
          reservation,
        },
        async (scope) => {
          const command = async (toolId, args, settings) => {
            const mutates =
              toolId === "ditto" ||
              (toolId === "codesign" && args.includes("--sign")) ||
              (toolId === "hdiutil" &&
                ["create", "attach", "detach"].includes(args[0])) ||
              (toolId === "stapler" && args[0] === "staple") ||
              (toolId === "notarytool" && args[0] === "submit");
            try {
              const result = await dependencies.command(
                scope,
                descriptor,
                stageTemp,
                toolId,
                args,
                settings,
              );
              check(result.exitCode === 0);
              return result;
            } catch (error) {
              if (mutates && error[commandNeverStarted] !== true) {
                uncertain = true;
                scope.markOutputSettlementUncertain();
              }
              throw error;
            }
          };
          const references = [];
          // The pending commit is an await boundary: bind the actual current
          // bytes again before any mutating child starts, not only at reservation.
          try {
            if (before !== null) {
              assert.deepEqual(
                await observe(beforeApp, scope, command),
                before,
              );
            } else if (inputArtifact.kind === "dmg-file" && !failureReadback)
              assert.deepEqual(
                await dependencies.measureDmg(dmg),
                inputArtifact,
              );
          } catch (error) {
            if (stageId === "notary-reconcile")
              return {
                state: "observed-fail",
                evidence: [],
                outputArtifact: null,
                submission: null,
                notaryStatus: null,
              };
            throw error;
          }
          const write = async (value, raw = false) => {
            const ref = await scope.writeEvidence(raw ? value : encode(value));
            references.push(ref);
            return ref;
          };
          const output = async (observation) => {
            const inventory = await write(observation);
            return observation.kind === "signed-artifact-custody"
              ? {
                  kind: "app-tree",
                  treeSha256: observation.tree.sha256,
                  inventory,
                }
              : { ...observation, inventory };
          };
          let outputArtifact = null;
          let submission = null;
          let notaryStatus = null;
          let invalidNotaryObservation = false;
          if (stageId === "input-validation") {
            check(before.tree.sha256 === descriptor.artifact.treeSha256);
            outputArtifact = {
              ...inputArtifact,
              inventory: await write(context.inventoryBytes, true),
            };
          } else if (stageId === "custody-copies") {
            await absent(custodyApp);
            await absent(workApp);
            await command("ditto", [
              "--rsrc",
              "--extattr",
              "--acl",
              "--qtn",
              context.originalApp,
              custodyApp,
            ]);
            const custody = await observe(custodyApp, scope, command);
            dependencies.observer.assertSignedArtifactCopy({
              before,
              after: custody,
              policy: context.policy,
            });
            await command("ditto", [
              "--rsrc",
              "--extattr",
              "--acl",
              "--qtn",
              custodyApp,
              workApp,
            ]);
            const copied = await observe(workApp, scope, command);
            dependencies.observer.assertSignedArtifactCopy({
              before: custody,
              after: copied,
              policy: context.policy,
            });
            outputArtifact = await output(copied);
          } else if (stageId === "sign-code") {
            await command("codesign", signArgs, {
              confined: true,
              workRoot,
              beforeInvoke: () => custodyNameFence(workApp, before),
            });
            const after = await observe(workApp, scope, command);
            dependencies.observer.assertSigningStepTransition({
              before,
              after,
              plan,
              signingIndex,
            });
            const matrix = await dependencies.verifyCode({
              command,
              target: objectTarget(workApp, step),
              row: step,
              approval: context.approval,
              temporaryRoot: stageTemp,
            });
            await write({
              kind: "signed-object-verification",
              signingIndex,
              matrix,
            });
            outputArtifact = await output(after);
          } else if (stageId === "signed-app-verification") {
            const matrix = [];
            for (const row of plan.signingSteps)
              matrix.push(
                ...(await dependencies.verifyCode({
                  command,
                  target: objectTarget(workApp, row),
                  row,
                  approval: context.approval,
                  temporaryRoot: await newDirectory(
                    path.join(stageTemp, `verify-${matrix.length}`),
                  ),
                })),
              );
            await command("codesign", [
              "--verify",
              "--deep",
              "--strict",
              "--all-architectures",
              "--verbose=4",
              workApp,
            ]);
            signatureReport = { kind: "signed-app-signatures", matrix };
            await write(signatureReport);
            const after = await observe(workApp, scope, command);
            assert.deepEqual(after, before);
            outputArtifact = await output(after);
          } else if (stageId === "dmg-create") {
            await absent(dmg);
            await command("hdiutil", [
              "create",
              "-fs",
              "HFS+",
              "-format",
              "UDZO",
              "-volname",
              "DesmosLock Internal",
              "-srcfolder",
              workRoot,
              dmg,
            ]);
            assert.deepEqual(await observe(workApp, scope, command), before);
            outputArtifact = await output(await dependencies.measureDmg(dmg));
          } else if (stageId === "dmg-sign") {
            const main = plan.objects.find((row) => row.role === "main");
            await command(
              "codesign",
              [
                "--force",
                "--sign",
                descriptor.authorization.signingIdentitySha1,
                "--timestamp",
                "--identifier",
                main.identifier,
                "--requirements",
                `=designated => ${main.requirement}`,
                dmg,
              ],
              { confined: true, workRoot: imageRoot },
            );
            await command("codesign", [
              "--verify",
              "--strict",
              "--verbose=4",
              "--test-requirement",
              main.requirement,
              dmg,
            ]);
            await write({
              kind: "dmg-signature",
              matrix: await dependencies.verifyCode({
                command,
                target: dmg,
                row: {
                  ...main,
                  runtime: false,
                  entitlements: {},
                  primaryPath: path.basename(dmg),
                },
                approval: context.approval,
                temporaryRoot: stageTemp,
                architectures: [null],
              }),
            });
            outputArtifact = await output(await dependencies.measureDmg(dmg));
          } else if (stageId === "notary-submit") {
            const response = await command("notarytool", [
              "submit",
              dmg,
              "--keychain-profile",
              descriptor.authorization.notaryKeychainProfile,
              "--output-format",
              "json",
              "--no-progress",
            ]);
            const parsed = JSON.parse(response.stdout);
            const id = parseNotarySubmission(parsed);
            check(parsed.path === dmg);
            assert.deepEqual(await dependencies.measureDmg(dmg), inputArtifact);
            submission = { id, submittedDmgSha256: inputArtifact.sha256 };
            await write({ kind: "known-notary-submission", ...submission });
          } else if (stageId === "notary-reconcile") {
            check(snapshot.submission !== null);
            const id = snapshot.submission.id;
            const response = await dependencies.command(
              scope,
              descriptor,
              stageTemp,
              "notarytool",
              [
                "info",
                id,
                "--keychain-profile",
                descriptor.authorization.notaryKeychainProfile,
                "--output-format",
                "json",
              ],
            );
            check(
              Number.isSafeInteger(response.exitCode) && response.exitCode >= 0,
            );
            // Only this exact known-ID command boundary may request a retry.
            // The owner independently requires a finite nonzero tracked child
            // exit and complete, otherwise clean owned-work/stream settlement.
            if (response.exitCode !== 0) return scope.notaryReadUnavailable();
            // A successful command with invalid facts is not an availability
            // failure. Preserve the real prior status but permanently block
            // mutation through an explicit observation_failed/null result.
            try {
              notaryStatus = parseNotaryInformation(
                JSON.parse(response.stdout),
                id,
              );
              if (notaryStatus === "accepted" && signatureReport === null) {
                const attempt = snapshot.attempts.find(
                  (row) =>
                    row.stageId === "signed-app-verification" &&
                    row.state === "observed-pass",
                );
                check(attempt !== undefined);
                for (const ref of attempt.evidence) {
                  const bytes = await readRegular(
                    path.join(runRoot, "evidence", ref.sha256),
                    maximumInput,
                  );
                  check(
                    bytes.sha256 === ref.sha256 &&
                      bytes.bytes.length === ref.bytes,
                  );
                  const parsed = JSON.parse(bytes.bytes.toString("utf8"));
                  if (parsed.kind === "signed-app-signatures")
                    signatureReport = parsed;
                }
                check(signatureReport !== null);
              }
            } catch {
              invalidNotaryObservation = true;
            }
            if (!invalidNotaryObservation && notaryStatus === "rejected")
              return {
                state: "observed-fail",
                evidence: [],
                outputArtifact: null,
                submission: null,
                notaryStatus: "rejected",
              };
            let ticket = null;
            if (!invalidNotaryObservation && notaryStatus === "accepted") {
              const log = await dependencies.command(
                scope,
                descriptor,
                stageTemp,
                "notarytool",
                [
                  "log",
                  id,
                  "--keychain-profile",
                  descriptor.authorization.notaryKeychainProfile,
                ],
              );
              check(Number.isSafeInteger(log.exitCode) && log.exitCode >= 0);
              if (log.exitCode !== 0) return scope.notaryReadUnavailable();
              try {
                ticket = verifyNotaryTicket(
                  JSON.parse(log.stdout),
                  id,
                  inputArtifact.sha256,
                  signatureReport.matrix.map((row) => ({
                    arch: row.arch,
                    cdhash: row.cdhash,
                    path: `${appName}/${row.path}`,
                  })),
                );
              } catch {
                invalidNotaryObservation = true;
              }
            }
            if (!invalidNotaryObservation) {
              try {
                assert.deepEqual(
                  await dependencies.measureDmg(dmg),
                  inputArtifact,
                );
              } catch {
                invalidNotaryObservation = true;
              }
            }
            if (invalidNotaryObservation) {
              // No diagnostic write is required to represent this finite typed
              // failure; a failed diagnostic write must not erase its meaning.
              notaryStatus = null;
            } else {
              await write(
                ticket ?? {
                  kind: "known-notary-status",
                  id,
                  status: notaryStatus,
                },
              );
              acceptedStatus = notaryStatus;
            }
          } else if (stageId === "dmg-staple") {
            await absent(finalDmg);
            await command("ditto", [
              "--rsrc",
              "--extattr",
              "--acl",
              "--qtn",
              submittedDmg,
              finalDmg,
            ]);
            assert.deepEqual(
              await dependencies.measureDmg(finalDmg),
              inputArtifact,
            );
            await command("stapler", ["staple", finalDmg]);
            await command("stapler", ["validate", finalDmg]);
            assert.deepEqual(
              await dependencies.measureDmg(submittedDmg),
              inputArtifact,
            );
            outputArtifact = await output(
              await dependencies.measureDmg(finalDmg),
            );
          } else if (stageId === "dmg-verification") {
            await command("hdiutil", ["verify", dmg]);
            await command("codesign", [
              "--verify",
              "--strict",
              "--verbose=4",
              dmg,
            ]);
            await command("stapler", ["validate", dmg]);
            await command("spctl", [
              "--assess",
              "--type",
              "open",
              "--context",
              "context:primary-signature",
              "--verbose=4",
              dmg,
            ]);
            assert.deepEqual(await dependencies.measureDmg(dmg), inputArtifact);
            await write({
              kind: "final-dmg-assessments",
              ...inputArtifact,
              physicalAcceptance: "pending",
            });
          } else if (stageId === "inspection-copy-mount") {
            const inspection = path.join(stageTemp, "inspection.dmg");
            const mountPoint = path.join(stageTemp, "mount");
            await absent(inspection);
            await newDirectory(mountPoint);
            await command("ditto", [
              "--rsrc",
              "--extattr",
              "--acl",
              "--qtn",
              dmg,
              inspection,
            ]);
            assert.deepEqual(
              await dependencies.measureDmg(inspection),
              inputArtifact,
            );
            let device = null;
            try {
              const mounted = await command("hdiutil", [
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-plist",
                "-mountpoint",
                mountPoint,
                inspection,
              ]);
              device = await dependencies.inspectMountedImage(
                mounted.stdout,
                mountPoint,
              );
              const actual = await observe(
                path.join(mountPoint, appName),
                scope,
                command,
              );
              const signed = await observe(workApp, scope, command);
              check(
                signed.tree.sha256 === snapshot.candidates.signedApp.treeSha256,
              );
              dependencies.observer.assertSignedArtifactCopy({
                before: signed,
                after: actual,
                policy: context.policy,
              });
              await write({
                kind: "readonly-mounted-app-custody",
                treeSha256: actual.tree.sha256,
                image: inputArtifact,
                physicalAcceptance: "pending",
              });
            } catch (error) {
              if (device === null) {
                uncertain = true;
                scope.markOutputSettlementUncertain();
              }
              throw error;
            } finally {
              if (device !== null) {
                try {
                  await command("hdiutil", ["detach", device]);
                } catch (error) {
                  uncertain = true;
                  scope.markOutputSettlementUncertain();
                  // eslint-disable-next-line no-unsafe-finally -- Failed detach must override any apparent pass and retain custody.
                  throw error;
                }
              }
            }
            assert.deepEqual(
              await dependencies.measureDmg(inspection),
              inputArtifact,
            );
          } else if (stageId === "checkpoint-readback") {
            await write({
              kind: "signed-checkpoint-reopen",
              runId,
              revision: snapshot.revision,
              planSha256: binding.sha256,
              candidates: snapshot.candidates,
              artifactObservation: failureReadback
                ? "not-revalidated-after-failure"
                : "current-input-revalidated",
              physicalAcceptance: "pending",
            });
          } else fail();
          return {
            state:
              notaryStatus === "rejected" || invalidNotaryObservation
                ? "observed-fail"
                : "observed-pass",
            evidence: references,
            outputArtifact,
            submission,
            notaryStatus,
          };
        },
      );
      const last = complete.attempts.at(-1);
      check(
        complete.attempts.length === snapshot.attempts.length + 1 &&
          last.stageId === stageId &&
          last.signingIndex === signingIndex &&
          last.state === "observed-pass",
      );
      if (oneShot || acceptedStatus === "in-progress") break;
      oneShot = false;
    }
    const snapshot = await store.readSnapshot();
    const historyOnly =
      mode === "readback" &&
      snapshot.attempts.some((attempt) => attempt.state !== "observed-pass");
    if (!historyOnly) await revalidateCandidates(snapshot);
    await store.revalidate({ expectedRevision: snapshot.revision });
    return {
      runId,
      runRoot,
      checkpointRevision: snapshot.revision,
      candidates: snapshot.candidates,
      submission: snapshot.submission,
      notaryStatus: snapshot.notaryStatus,
      artifactObservation: historyOnly
        ? "history-only-after-failure"
        : "current-input-revalidated",
      physicalAcceptance: "pending",
    };
  } finally {
    const drained = store === null || (await store.close({ timeoutMs: 60000 }));
    if (!drained || uncertain)
      // eslint-disable-next-line no-unsafe-finally -- Unconfirmed ownership release must never return a successful artifact.
      throw new Error(
        "Signed output settlement uncertain; retained run and lease require review",
      );
    await fs.unlink(path.join(lease, "owner.json"));
    await fs.rmdir(lease);
  }
}
let operationId = 0;
function cryptoId() {
  operationId += 1;
  return `${process.pid}-${Date.now()}-${operationId}`;
}
export async function signDesktopArtifactForTesting(options, dependencies) {
  return runSigned(options, dependencies);
}
export async function signDesktopArtifact(options) {
  check(process.platform === "darwin" && process.versions.node === "24.20.0");
  return runSigned(
    { ...options, repositoryRoot: checkout },
    await productionDependencies(),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await signDesktopArtifact(
      parseSignedRunnerArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(
      "Signed artifact runner stopped. Retained evidence determines recovery; no mutation was retried automatically.\n",
    );
    process.exitCode = 1;
  }
}
