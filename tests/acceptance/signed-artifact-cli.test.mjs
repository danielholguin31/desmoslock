import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import nodeTest from "node:test";

const syntheticUncertaintyChild =
  process.argv[2] === "--synthetic-signed-cli-uncertainty";
const test = syntheticUncertaintyChild ? () => {} : nodeTest;

const cliUrl = new URL(
  "../../scripts/sign-desktop-artifact.mjs",
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
const evidenceSource = new URL(
  "../../scripts/unsigned-artifact-evidence.mjs",
  import.meta.url,
).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      [cliUrl, sharedUrl, evidenceSource].includes(context.parentURL) &&
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
  parseSignedArtifactDescriptor,
  signedEvidencePlan,
  parseSignedRunnerArguments,
  signedCanonicalBytes,
  verifySignedExecutionApproval,
  signedCommandEnvironment,
  signedSandboxProfile,
  parseSignedCodeDisplay,
  parseSignedEntitlements,
  parseNotarySubmission,
  parseNotaryInformation,
  verifyNotaryTicket,
  signedToolIds,
  signedRunnerStageIds,
  signDesktopArtifactForTesting,
} = await import(cliUrl);
const { openSignedArtifactEvidenceForTesting, pendingPhysicalCaseIds } =
  await import(evidenceSource);
hooks.deregister();

const runId = "8d63cbaa-8f7b-4939-9ef1-8234c2bebc55";
const submissionId = "ac1e7c53-1c9a-40ed-ad55-9c5e6db6c182";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (character) => character.repeat(64);
const pin = (name, character = "1") => ({
  path: `/synthetic/${name}`,
  sha256: digest(character),
  bytes: 64,
});
const toolIds = [
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
];
const sourcePaths = [
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
];
function descriptor() {
  return {
    schemaVersion: 1,
    kind: "signed-desktop-artifact-inputs",
    artifact: {
      identity: {
        schemaVersion: 1,
        sourceRepository: "danielholguin31/desmoslock",
        sourceCommit: "a".repeat(40),
        sourceTree: "b".repeat(40),
        packageLockSha256: digest("c"),
        buildId: digest("d"),
      },
      source: { commit: "a".repeat(40), tree: "b".repeat(40) },
      ci: {
        commit: "a".repeat(40),
        verificationRunId: "123456",
        securityRunId: "123457",
        receipt: pin("artifact-ci.json", "2"),
      },
      universalCheckpoint: pin("universal-checkpoint.json", "3"),
      inventory: pin("unsigned-inventory.json", "4"),
      treeSha256: digest("5"),
    },
    tooling: {
      source: { commit: "e".repeat(40), tree: "f".repeat(40) },
      ci: {
        commit: "e".repeat(40),
        verificationRunId: "223456",
        securityRunId: "223457",
        receipt: pin("tooling-ci.json", "6"),
      },
      sourceManifest: sourcePaths.map((path) => ({
        path,
        mode: "100644",
        gitBlob: "1".repeat(40),
        sha256: digest("7"),
        bytes: 64,
      })),
      dependencies: [
        {
          name: "@electron/packager",
          version: "20.3.0",
          packageJsonSha256: digest("8"),
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      ],
      tools: Object.fromEntries(
        toolIds.map((id) => [
          id,
          pin(
            `tools/${{ codesignAllocate: "codesign_allocate", sandboxExec: "sandbox-exec" }[id] ?? id}`,
            "9",
          ),
        ]),
      ),
    },
    policy: pin("policy.json", "a"),
    signingSteps: [pin("sign-step-0.json", "b"), pin("sign-step-1.json", "c")],
    authorization: {
      signingIdentitySha1: "A".repeat(40),
      notaryKeychainProfile: "Synthetic-Profile_1",
      executionApproval: pin("approval.json", "d"),
    },
    nativeHelper: pin("durable-record.node", "e"),
  };
}
const operations = [
  "copy",
  "sign-app",
  "create-sign-dmg",
  "submit-one-dmg",
  "reconcile-known-id",
  "staple-dmg",
  "assess",
  "readonly-inspection",
];
function approval(selected = parseSignedArtifactDescriptor(descriptor())) {
  const plan = signedEvidencePlan(selected);
  return {
    schemaVersion: 1,
    kind: "signed-artifact-execution-approval",
    runId,
    artifactIdentity: structuredClone(selected.artifact.identity),
    unsignedCheckpointSha256: plan.unsignedCheckpointSha256,
    unsignedAppTreeSha256: plan.unsignedAppTreeSha256,
    policySha256: plan.policySha256,
    toolingProvenanceSha256: plan.toolingProvenanceSha256,
    signingIdentitySha1: selected.authorization.signingIdentitySha1,
    certificateChainSha256s: [digest("1"), digest("2")],
    notaryKeychainProfile: selected.authorization.notaryKeychainProfile,
    teamId: "SYNTHETIC1",
    trustedHostCustody: "exclusive-reviewed-host",
    authorizedOperations: [...operations],
  };
}
function rejectMutation(make, parse, mutate, message) {
  const value = make();
  mutate(value);
  assert.throws(() => parse(value), message);
}
function assertDeepFrozen(value) {
  if (value !== null && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertDeepFrozen);
  }
}

test("descriptor keeps original artifact identity while separately pinning newer tooling", () => {
  const input = descriptor();
  const parsed = parseSignedArtifactDescriptor(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.artifact.source.commit, parsed.tooling.source.commit);
  assert.equal(
    parsed.artifact.identity.sourceCommit,
    input.artifact.source.commit,
  );
  assertDeepFrozen(parsed);
  input.tooling.tools.codesign.sha256 = digest("f");
  input.signingSteps[0].sha256 = digest("f");
  input.artifact.identity.sourceCommit = "f".repeat(40);
  assert.equal(parsed.tooling.tools.codesign.sha256, digest("9"));
  assert.equal(parsed.signingSteps[0].sha256, digest("b"));
  assert.equal(parsed.artifact.identity.sourceCommit, "a".repeat(40));
});

test("descriptor rejects extra, missing, symbolic and inherited record fields without invoking getters", () => {
  for (const select of [
    (v) => v,
    (v) => v.artifact,
    (v) => v.tooling,
    (v) => v.policy,
    (v) => v.authorization,
    (v) => v.tooling.dependencies[0],
  ]) {
    for (const mutate of [
      (row) => {
        row.extra = true;
      },
      (row) => {
        delete row[Object.keys(row)[0]];
      },
      (row) => {
        row[Symbol("extra")] = true;
      },
      (row) => {
        Object.setPrototypeOf(row, { inherited: true });
      },
    ])
      rejectMutation(descriptor, parseSignedArtifactDescriptor, (value) =>
        mutate(select(value)),
      );
    const input = descriptor();
    const row = select(input);
    const key = Object.keys(row)[0];
    let invoked = false;
    Object.defineProperty(row, key, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("Getter invoked");
      },
    });
    assert.throws(() => parseSignedArtifactDescriptor(input));
    assert.equal(invoked, false);
  }
  const input = descriptor();
  Object.setPrototypeOf(input, null);
  assert.equal(
    parseSignedArtifactDescriptor(input).kind,
    "signed-desktop-artifact-inputs",
  );
});

test("descriptor binds both CI receipts to the corresponding source and original identity", () => {
  for (const mutate of [
    (v) => {
      v.artifact.source.commit = "e".repeat(40);
    },
    (v) => {
      v.artifact.source.tree = "f".repeat(40);
    },
    (v) => {
      v.artifact.ci.commit = v.tooling.source.commit;
    },
    (v) => {
      v.tooling.ci.commit = v.artifact.source.commit;
    },
    (v) => {
      v.artifact.identity.sourceRepository = "someone/else";
    },
    (v) => {
      v.schemaVersion = 2;
    },
    (v) => {
      v.kind = "unsigned-artifact-inputs";
    },
  ])
    rejectMutation(descriptor, parseSignedArtifactDescriptor, mutate);
});

test("descriptor requires exactly the reviewed source and tool inventories", () => {
  assert.deepEqual(signedToolIds, toolIds);
  assert.ok(Object.isFrozen(signedToolIds));
  for (const missingPath of [
    "packages/contracts/dist/build-identity.js",
    "packages/contracts/dist/exact-record.js",
  ])
    rejectMutation(
      descriptor,
      parseSignedArtifactDescriptor,
      (v) => {
        v.tooling.sourceManifest = v.tooling.sourceManifest.filter(
          (entry) => entry.path !== missingPath,
        );
      },
      `missing compiled runtime pin: ${missingPath}`,
    );
  for (const mutate of [
    (v) => {
      delete v.tooling.tools.notarytool;
    },
    (v) => {
      v.tooling.tools.shell = pin("tools/sh");
    },
    (v) => {
      v.tooling.sourceManifest.pop();
    },
    (v) => {
      v.tooling.sourceManifest[1] = { ...v.tooling.sourceManifest[0] };
    },
    (v) => {
      v.tooling.sourceManifest[0].path = "scripts/arbitrary.mjs";
    },
    (v) => {
      v.tooling.sourceManifest[0].mode = "120000";
    },
  ])
    rejectMutation(descriptor, parseSignedArtifactDescriptor, mutate);
});

test("descriptor file pins reject unsafe paths, malformed digests and invalid byte lengths", () => {
  for (const value of [
    "relative",
    "/synthetic/../file",
    "/synthetic//file",
    "/synthetic/.env",
    "/synthetic/file\n",
    "/synthetic/file\0",
  ])
    rejectMutation(
      descriptor,
      parseSignedArtifactDescriptor,
      (v) => {
        v.policy.path = value;
      },
      value,
    );
  for (const value of [digest("0"), "A".repeat(64), "a".repeat(63), null, 123])
    rejectMutation(descriptor, parseSignedArtifactDescriptor, (v) => {
      v.policy.sha256 = value;
    });
  for (const value of [
    0,
    -1,
    1.5,
    "64",
    64 * 1024 * 1024 + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    rejectMutation(descriptor, parseSignedArtifactDescriptor, (v) => {
      v.policy.bytes = value;
    });
  const input = descriptor();
  input.policy.bytes = 64 * 1024 * 1024;
  assert.equal(
    parseSignedArtifactDescriptor(input).policy.bytes,
    64 * 1024 * 1024,
  );
});

test("descriptor rejects trailing newline and coerced nonstring pin/source/profile/CI values", () => {
  for (const [select, field] of [
    [(v) => v.policy, "sha256"],
    [(v) => v.tooling.source, "tree"],
    [(v) => v.tooling.ci, "verificationRunId"],
    [(v) => v.authorization, "signingIdentitySha1"],
    [(v) => v.authorization, "notaryKeychainProfile"],
    [(v) => v.tooling.dependencies[0], "version"],
  ]) {
    rejectMutation(
      descriptor,
      parseSignedArtifactDescriptor,
      (v) => {
        const row = select(v);
        row[field] += "\n";
      },
      field,
    );
    let invoked = false;
    const value = descriptor();
    const row = select(value);
    const original = row[field];
    row[field] = {
      toString() {
        invoked = true;
        return original;
      },
    };
    assert.throws(() => parseSignedArtifactDescriptor(value), field);
    assert.equal(invoked, false, field);
  }
});

test("descriptor bounds signing steps and dependencies and forbids duplicates", () => {
  for (const mutate of [
    (v) => {
      v.signingSteps = [];
    },
    (v) => {
      v.signingSteps = Array.from({ length: 51 }, (_, i) => pin(`step-${i}`));
    },
    (v) => {
      v.signingSteps[1].path = v.signingSteps[0].path;
    },
    (v) => {
      v.tooling.dependencies = [];
    },
    (v) => {
      v.tooling.dependencies.push({ ...v.tooling.dependencies[0] });
    },
    (v) => {
      v.tooling.dependencies = Array.from({ length: 513 }, (_, i) => ({
        ...v.tooling.dependencies[0],
        name: `package-${i}`,
      }));
    },
    (v) => {
      v.tooling.dependencies[0].name = "../outside";
    },
    (v) => {
      v.tooling.dependencies[0].integrity = "sha512-short";
    },
    (v) => {
      v.authorization.notaryKeychainProfile = "--profile";
    },
    (v) => {
      v.authorization.notaryKeychainProfile = "a".repeat(81);
    },
  ])
    rejectMutation(descriptor, parseSignedArtifactDescriptor, mutate);
  const maximum = descriptor();
  maximum.signingSteps = Array.from({ length: 50 }, (_, i) => pin(`step-${i}`));
  maximum.tooling.dependencies = Array.from({ length: 512 }, (_, i) => ({
    ...maximum.tooling.dependencies[0],
    name: `package-${i}`,
  }));
  assert.equal(parseSignedArtifactDescriptor(maximum).signingSteps.length, 50);
});

test("descriptor rejects sparse, extended and custom-prototype arrays", () => {
  for (const select of [
    (v) => v.signingSteps,
    (v) => v.tooling.dependencies,
    (v) => v.tooling.sourceManifest,
  ]) {
    for (const mutate of [
      (rows) => {
        delete rows[0];
      },
      (rows) => {
        rows.extra = true;
      },
      (rows) => {
        rows[Symbol("extra")] = true;
      },
      (rows) => {
        Object.setPrototypeOf(rows, Object.create(Array.prototype));
      },
    ])
      rejectMutation(descriptor, parseSignedArtifactDescriptor, (v) =>
        mutate(select(v)),
      );
  }
});

test("descriptor rejects array accessors without calling them", () => {
  const input = descriptor();
  let invoked = false;
  const original = input.signingSteps[0];
  Object.defineProperty(input.signingSteps, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return original;
    },
  });
  assert.throws(() => parseSignedArtifactDescriptor(input));
  assert.equal(invoked, false);
});

test("canonical bytes sort nested object keys, preserve array order and include one final newline", () => {
  const expected = Buffer.from('{"a":{"x":1,"y":2},"z":[{"a":3,"b":4},2]}\n');
  assert.deepEqual(
    signedCanonicalBytes({ z: [{ b: 4, a: 3 }, 2], a: { y: 2, x: 1 } }),
    expected,
  );
  assert.notDeepEqual(
    signedCanonicalBytes({ z: [2, { b: 4, a: 3 }], a: { x: 1, y: 2 } }),
    expected,
  );
});

test("evidence plan binds every descriptor pin and the ordered signing steps", () => {
  const parsed = parseSignedArtifactDescriptor(descriptor());
  const plan = signedEvidencePlan(parsed);
  assert.deepEqual(plan, {
    sha256: sha256(signedCanonicalBytes(parsed)),
    policySha256: digest("a"),
    unsignedCheckpointSha256: digest("3"),
    unsignedAppTreeSha256: digest("5"),
    unsignedAppInventorySha256: digest("4"),
    toolingProvenanceSha256: sha256(signedCanonicalBytes(parsed.tooling)),
    signingStepSha256s: [digest("b"), digest("c")],
  });
  assertDeepFrozen(plan);
  const reordered = Object.fromEntries(Object.entries(parsed).reverse());
  assert.deepEqual(signedEvidencePlan(reordered), plan);
  for (const mutate of [
    (v) => {
      v.artifact.inventory.sha256 = digest("f");
    },
    (v) => {
      v.tooling.tools.codesign.sha256 = digest("f");
    },
    (v) => {
      v.tooling.dependencies[0].integrity = `sha512-${"B".repeat(86)}==`;
    },
    (v) => {
      v.policy.sha256 = digest("f");
    },
    (v) => {
      v.signingSteps.reverse();
    },
    (v) => {
      v.authorization.executionApproval.sha256 = digest("f");
    },
    (v) => {
      v.nativeHelper.sha256 = digest("f");
    },
  ]) {
    const changed = descriptor();
    mutate(changed);
    assert.notEqual(
      signedEvidencePlan(parseSignedArtifactDescriptor(changed)).sha256,
      plan.sha256,
    );
  }
});

test("runner exposes the fixed twelve-stage sequence and exact mode-specific arguments", () => {
  assert.deepEqual(signedRunnerStageIds, [
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
  assert.ok(Object.isFrozen(signedRunnerStageIds));
  assert.deepEqual(
    parseSignedRunnerArguments([
      "create",
      "--run-id",
      runId,
      "--inputs",
      "/synthetic/inputs.json",
    ]),
    { mode: "create", runId, descriptorPath: "/synthetic/inputs.json" },
  );
  for (const mode of ["resume", "reconcile", "readback"])
    assert.deepEqual(parseSignedRunnerArguments([mode, "--run-id", runId]), {
      mode,
      runId,
      descriptorPath: null,
    });
});

test("runner rejects arbitrary commands, extra flags, reordered flags and noncanonical run IDs", () => {
  for (const args of [
    null,
    [],
    ["sign", "--run-id", runId],
    ["create", "--run-id", runId],
    ["resume", "--run-id", runId, "--inputs", "/synthetic/inputs.json"],
    ["create", "--inputs", "/synthetic/inputs.json", "--run-id", runId],
    ["create", "--run-id", runId, "--inputs", "relative.json"],
    ["resume", "--run-id", runId, "--tool", "/bin/sh"],
    ["readback", "--run-id", runId.toUpperCase()],
    ["readback", "--run-id", runId.replace("4939", "1939")],
  ])
    assert.throws(() => parseSignedRunnerArguments(args));
});

test("runner rejects UUID trailing newline and accessor/extended argument arrays", () => {
  assert.throws(() =>
    parseSignedRunnerArguments(["resume", "--run-id", `${runId}\n`]),
  );
  const extended = ["resume", "--run-id", runId];
  extended.extra = "--unsafe";
  assert.throws(() => parseSignedRunnerArguments(extended));
  const args = ["resume", "--run-id", runId];
  let invoked = false;
  Object.defineProperty(args, "2", {
    enumerable: true,
    get() {
      invoked = true;
      return runId;
    },
  });
  assert.throws(() => parseSignedRunnerArguments(args));
  assert.equal(invoked, false);
});

test("execution approval returns an immutable detached snapshot of all bound operations", () => {
  const selected = parseSignedArtifactDescriptor(descriptor());
  const input = approval(selected);
  const parsed = verifySignedExecutionApproval(input, selected, runId);
  assert.deepEqual(parsed, input);
  assertDeepFrozen(parsed);
  input.certificateChainSha256s[0] = digest("f");
  input.authorizedOperations.pop();
  assert.equal(parsed.certificateChainSha256s[0], digest("1"));
  assert.deepEqual(parsed.authorizedOperations, operations);
});

test("execution approval rejects every changed identity, authority, operation or evidence binding", () => {
  const selected = parseSignedArtifactDescriptor(descriptor());
  const parse = (value) =>
    verifySignedExecutionApproval(value, selected, runId);
  for (const key of [
    "unsignedCheckpointSha256",
    "unsignedAppTreeSha256",
    "policySha256",
    "toolingProvenanceSha256",
  ])
    rejectMutation(
      () => approval(selected),
      parse,
      (v) => {
        v[key] = digest("f");
      },
      key,
    );
  for (const mutate of [
    (v) => {
      v.runId = submissionId;
    },
    (v) => {
      v.artifactIdentity.buildId = digest("f");
    },
    (v) => {
      v.signingIdentitySha1 = "B".repeat(40);
    },
    (v) => {
      v.notaryKeychainProfile = "Other-Profile";
    },
    (v) => {
      v.trustedHostCustody = "shared-host";
    },
    (v) => {
      v.teamId = "short";
    },
    (v) => {
      v.authorizedOperations.reverse();
    },
    (v) => {
      v.authorizedOperations.push("submit-again");
    },
    (v) => {
      v.certificateChainSha256s.pop();
    },
    (v) => {
      v.certificateChainSha256s = Array(5).fill(digest("1"));
    },
    (v) => {
      v.certificateChainSha256s[0] = digest("0");
    },
    (v) => {
      v.extra = true;
    },
    (v) => {
      Object.setPrototypeOf(v, { extra: true });
    },
  ])
    rejectMutation(() => approval(selected), parse, mutate);
});

test("execution approval rejects a tooling pin change even when the original artifact is unchanged", () => {
  const before = parseSignedArtifactDescriptor(descriptor());
  const changed = descriptor();
  changed.tooling.tools.notarytool.sha256 = digest("f");
  assert.throws(() =>
    verifySignedExecutionApproval(
      approval(before),
      parseSignedArtifactDescriptor(changed),
      runId,
    ),
  );
});

test("command environment contains only the fixed locale, temporary paths and pinned allocator", () => {
  const selected = parseSignedArtifactDescriptor(descriptor());
  assert.deepEqual(signedCommandEnvironment(selected, "/synthetic/tmp"), {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    TMPDIR: "/synthetic/tmp",
    TMP: "/synthetic/tmp",
    TEMP: "/synthetic/tmp",
    CODESIGN_ALLOCATE: "/synthetic/tools/codesign_allocate",
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
});

test("sandbox profile limits execution to the two pinned signing tools and writes to the two working roots", () => {
  const selected = parseSignedArtifactDescriptor(descriptor());
  const profile = signedSandboxProfile(
    "/synthetic/work",
    "/synthetic/tmp",
    selected.tooling.tools,
  );
  assert.ok(profile.startsWith("(version 1)\n(deny default)\n"));
  assert.equal(
    profile
      .split("\n")
      .filter((line) => line.startsWith("(allow process-exec"))
      .join("\n"),
    '(allow process-exec (literal "/synthetic/tools/codesign") (literal "/synthetic/tools/codesign_allocate"))',
  );
  assert.equal(
    profile
      .split("\n")
      .filter((line) => line.startsWith("(allow file-write"))
      .join("\n"),
    '(allow file-write* (subpath "/synthetic/work") (subpath "/synthetic/tmp"))',
  );
  const unusualRoot = '/synthetic/quote"\\\n(allow default)';
  const quoted = signedSandboxProfile(
    unusualRoot,
    "/synthetic/tmp",
    selected.tooling.tools,
  );
  assert.ok(quoted.includes(`(subpath ${JSON.stringify(unusualRoot)})`));
  assert.equal(quoted.split("\n").includes("(allow default)"), false);
});

const expectedCode = {
  identifier: "com.desmoslock.internal",
  teamId: "SYNTHETIC1",
  runtime: true,
};
function codeDisplay() {
  return [
    "Executable=/synthetic/app",
    `Identifier=${expectedCode.identifier}`,
    "Format=app bundle with Mach-O universal (arm64 x86_64)",
    "CodeDirectory v=20500 size=1000 flags=0x10000(runtime) hashes=10+7 location=embedded",
    `CDHash=${"a".repeat(40)}`,
    "Authority=Developer ID Application: Synthetic",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "Timestamp=Sep 13, 2026 at 12:00:00 PM",
    `TeamIdentifier=${expectedCode.teamId}`,
    "",
  ].join("\n");
}
test("code display requires the selected identity, team, runtime, CDHash and trusted timestamp", () => {
  assert.deepEqual(parseSignedCodeDisplay(codeDisplay(), expectedCode), {
    cdhash: "a".repeat(40),
    ...expectedCode,
    timestamp: "Sep 13, 2026 at 12:00:00 PM",
  });
  assert.equal(
    parseSignedCodeDisplay(
      codeDisplay().replace("flags=0x10000(runtime)", "flags=0x0(none)"),
      { ...expectedCode, runtime: false },
    ).runtime,
    false,
  );
  for (const mutate of [
    (v) => v.replace(expectedCode.identifier, "com.other.app"),
    (v) => v.replace(expectedCode.teamId, "OTHERTEAM1"),
    (v) => v.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
    (v) => v.replace("a".repeat(40), "z".repeat(40)),
    (v) =>
      v.replace("Timestamp=Sep 13, 2026 at 12:00:00 PM", "Timestamp=not set"),
    (v) => v.replaceAll(/^Authority=.*\n/gm, ""),
    (v) => `${v}Signature=adhoc\n`,
    (v) => `${v}CDHash=${"a".repeat(40)}\n`,
    (v) => `${v}CodeDirectory flags=0x10000(runtime)\n`,
    (v) => `${v}\0`,
    () => "x".repeat(131073),
  ])
    assert.throws(() =>
      parseSignedCodeDisplay(mutate(codeDisplay()), expectedCode),
    );
});

const entitlementXml =
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
test("entitlements must match the complete reviewed plist rather than merely being present", () => {
  const expected = { "com.apple.security.cs.allow-jit": true };
  assert.deepEqual(
    parseSignedEntitlements(entitlementXml, "", expected),
    expected,
  );
  assert.throws(() =>
    parseSignedEntitlements(
      entitlementXml.replace("<true/>", "<false/>"),
      "",
      expected,
    ),
  );
  assert.throws(() => parseSignedEntitlements(entitlementXml, "", {}));
  assert.throws(() =>
    parseSignedEntitlements(entitlementXml, "", {
      ...expected,
      "com.apple.security.get-task-allow": true,
    }),
  );
  assert.throws(() =>
    parseSignedEntitlements(
      '<!ENTITY injected "value">' + entitlementXml,
      "",
      expected,
    ),
  );
  assert.throws(() => parseSignedEntitlements("x".repeat(32769), "", expected));
});

test("empty entitlement output only proves absence with explicit no-entitlements evidence", () => {
  for (const stderr of [
    "no entitlements\n",
    "/synthetic/code: no entitlements\n",
    "No entitlements\r\n",
  ])
    assert.deepEqual(parseSignedEntitlements(" \n", stderr, {}), {});
  for (const stderr of [
    "",
    "warning: command failed",
    "no entitlements but failed",
    "not no entitlements\n",
  ])
    assert.throws(() => parseSignedEntitlements("", stderr, {}));
  assert.throws(() =>
    parseSignedEntitlements("", "no entitlements\n", {
      "com.apple.security.cs.allow-jit": true,
    }),
  );
  assert.throws(() => parseSignedEntitlements("", "x".repeat(131073), {}));
});

const submission = () => ({
  id: submissionId,
  message: "Successfully received submission",
  path: "/synthetic/submitted.dmg",
});
const information = () => ({
  id: submissionId,
  createdDate: "2026-09-13T12:00:00Z",
  message: "Successfully received submission info",
  name: "submitted.dmg",
  status: "Accepted",
});
test("notary submission and status parsers require exact schemas and the same submission ID", () => {
  assert.equal(parseNotarySubmission(submission()), submissionId);
  for (const [status, expected] of [
    ["In Progress", "in-progress"],
    ["Accepted", "accepted"],
    ["Rejected", "rejected"],
    ["Invalid", "rejected"],
  ])
    assert.equal(
      parseNotaryInformation({ ...information(), status }, submissionId),
      expected,
    );
  for (const make of [submission, information]) {
    const parse =
      make === submission
        ? parseNotarySubmission
        : (value) => parseNotaryInformation(value, submissionId);
    for (const mutate of [
      (v) => {
        v.extra = true;
      },
      (v) => {
        v.id = "not-an-id";
      },
      (v) => {
        v.message = null;
      },
      (v) => {
        Object.setPrototypeOf(v, { status: "Accepted" });
      },
    ])
      rejectMutation(make, parse, mutate);
  }
  assert.throws(() => parseNotaryInformation(information(), runId));
});

test("notary status rejects inherited object names and nonstring coercion", () => {
  for (const status of [
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "accepted",
    "Unknown",
    null,
    { toString: () => "Accepted" },
  ])
    assert.throws(
      () => parseNotaryInformation({ ...information(), status }, submissionId),
      String(status),
    );
});

test("notary submission rejects ID trailing newline and nonstring coercion", () => {
  assert.throws(() =>
    parseNotarySubmission({ ...submission(), id: `${submissionId}\n` }),
  );
  assert.throws(() =>
    parseNotaryInformation(
      { ...information(), id: `${submissionId}\n` },
      `${submissionId}\n`,
    ),
  );
  let invoked = false;
  assert.throws(() =>
    parseNotarySubmission({
      ...submission(),
      id: {
        toString() {
          invoked = true;
          return submissionId;
        },
      },
    }),
  );
  assert.equal(invoked, false);
});

const executableSuffix =
  "DesmosLock Internal.app/Contents/MacOS/desmoslock-internal";
const expectedTicketHashes = [
  { path: executableSuffix, cdhash: "a".repeat(40), arch: "arm64" },
  { path: executableSuffix, cdhash: "b".repeat(40), arch: "x86_64" },
  { path: "submitted.dmg", cdhash: "c".repeat(40), arch: null },
];
function ticket() {
  return {
    logFormatVersion: 1,
    jobId: submissionId,
    status: "Accepted",
    statusSummary: "Ready for distribution",
    statusCode: 0,
    archiveFilename: "submitted.dmg",
    uploadDate: "2026-09-13T12:00:00Z",
    sha256: digest("d"),
    ticketContents: expectedTicketHashes.map((entry) => ({
      ...entry,
      path: `upload/${entry.path}`,
      digestAlgorithm: "SHA-256",
    })),
    issues: null,
  };
}
const verifyTicket = (value) =>
  verifyNotaryTicket(value, submissionId, digest("d"), expectedTicketHashes);
test("accepted ticket must cover both architectures and the submitted DMG hash", () => {
  assert.deepEqual(verifyTicket(ticket()), {
    id: submissionId,
    submittedSha256: digest("d"),
    covered: expectedTicketHashes,
  });
  for (const index of [0, 1, 2])
    rejectMutation(
      ticket,
      verifyTicket,
      (v) => {
        v.ticketContents.splice(index, 1);
      },
      `missing ticket entry ${index}`,
    );
  for (const mutate of [
    (v) => {
      v.jobId = runId;
    },
    (v) => {
      v.sha256 = digest("e");
    },
    (v) => {
      v.status = "Rejected";
    },
    (v) => {
      v.statusCode = 1;
    },
    (v) => {
      v.issues = [];
    },
    (v) => {
      v.ticketContents[1].arch = "arm64";
    },
    (v) => {
      v.ticketContents[1].cdhash = "a".repeat(40);
    },
    (v) => {
      v.ticketContents[0].path = "Some Other.app/Contents/MacOS/other";
    },
    (v) => {
      v.ticketContents[0].digestAlgorithm = "SHA-1";
    },
    (v) => {
      v.ticketContents[0].extra = true;
    },
    (v) => {
      v.extra = true;
    },
  ])
    rejectMutation(ticket, verifyTicket, mutate);
});

test("ticket parser bounds contents and rejects sparse arrays or forged record prototypes", () => {
  for (const mutate of [
    (v) => {
      v.ticketContents = [];
    },
    (v) => {
      v.ticketContents = Array(257).fill(v.ticketContents[0]);
    },
    (v) => {
      delete v.ticketContents[0];
    },
    (v) => {
      v.ticketContents.extra = true;
    },
    (v) => {
      Object.setPrototypeOf(v.ticketContents[0], { arch: "arm64" });
    },
    (v) => {
      v.ticketContents[0].path = "a".repeat(4097);
    },
    (v) => {
      v.ticketContents[0].arch = "x64";
    },
  ])
    rejectMutation(ticket, verifyTicket, mutate);
});

// Real CLI scheduling, reservation sidecars, checkpoint validation and owner
// reopening; synthetic command/observer/native adapters never sign or submit.
// This adapter proves protocol behavior, not native durability or physical QA.
async function runnerFixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "desmoslock-signed-cli-"),
  );
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, "artifacts"), { mode: 0o700 });
  const runRoot = path.join(root, "artifacts/signed-artifact-runs", runId);
  const descriptorPath = path.join(root, "inputs.json");
  const input = descriptor();
  const inventoryBytes = Buffer.from('{"syntheticUnsignedInventory":true}\n');
  input.artifact.inventory.sha256 = sha256(inventoryBytes);
  input.artifact.inventory.bytes = inventoryBytes.length;
  await fs.writeFile(descriptorPath, signedCanonicalBytes(input), {
    mode: 0o600,
  });
  const selected = parseSignedArtifactDescriptor(input);
  const main = {
    role: "main",
    objectPath: ".",
    primaryPath: "Contents/MacOS/desmoslock-internal",
    identifier: expectedCode.identifier,
    requirement: 'identifier "com.desmoslock.internal"',
    runtime: true,
    entitlements: {},
  };
  const child = {
    ...main,
    role: "helper",
    objectPath: "Contents/Frameworks/Synthetic Helper.app",
    primaryPath:
      "Contents/Frameworks/Synthetic Helper.app/Contents/MacOS/helper",
    identifier: "com.desmoslock.internal.helper",
  };
  const derivedPlan = {
    sha256: digest("f"),
    objects: [child, main],
    signingSteps: [child, main],
  };
  const context = {
    unsignedInventory: { buildIdentity: selected.artifact.identity },
    inventoryBytes,
    policy: { teamId: expectedCode.teamId },
    derivedPlan,
    approval: approval(selected),
    originalApp: path.join(root, "original/DesmosLock Internal.app"),
  };
  const appTrees = new Map([
    [context.originalApp, selected.artifact.treeSha256],
  ]);
  const dmgs = new Map();
  const owners = [];
  let storedBytes = null;
  let locked = false;
  const state = {
    calls: [],
    opens: [],
    closes: 0,
    writes: [],
    beforeWrite: null,
    beforeObserve: null,
    observations: [],
    notaryStatus: "Accepted",
    malformedNotary: null,
    loseSubmissionId: false,
    failSign: false,
    failInfo: false,
    failLog: false,
    throwInfo: false,
    throwLog: false,
    failTerminalDiagnostic: false,
    terminalDiagnosticAttempts: 0,
    availabilityCommands: [],
    failDetach: false,
    failClose: false,
    derives: 0,
  };
  const stored = () => (storedBytes === null ? null : JSON.parse(storedBytes));
  const native = {
    maximumRecordBytes: 65536,
    async openStore() {
      assert.equal(locked, false, "one native checkpoint owner at a time");
      locked = true;
      return {
        async loadEncryptedRecord() {
          return storedBytes === null ? null : Buffer.from(storedBytes);
        },
        async replaceEncryptedRecord(value) {
          const copy = Buffer.from(value);
          const checkpoint = JSON.parse(copy);
          state.writes.push({
            revision: checkpoint.revision,
            stage: checkpoint.attempts.at(-1)?.stageId,
            phase: checkpoint.attempts.at(-1)?.state,
          });
          await state.beforeWrite?.(checkpoint);
          storedBytes = copy;
        },
        async quarantineEncryptedRecord() {
          assert.fail("no automatic quarantine in signed runner");
        },
        async close() {
          state.closes += 1;
          if (state.failClose) throw new Error("Synthetic unconfirmed close");
          locked = false;
        },
      };
    },
  };
  const workApp = path.join(runRoot, "work/DesmosLock Internal.app");
  const dmgPath = path.join(runRoot, "image/DesmosLock-Internal.dmg");
  const finalDmgPath = path.join(
    runRoot,
    "image/DesmosLock-Internal-stapled.dmg",
  );
  const cdhashFor = (row, arch) =>
    sha256(`${row.primaryPath}:${arch}`).slice(0, 40);
  const appMetadata = new Map();
  let metadataGeneration = 0;
  const allocateMetadata = (appBundle) => {
    metadataGeneration += 1;
    const entries = [
      ".",
      ...derivedPlan.signingSteps.map((row) => row.primaryPath),
    ]
      .sort()
      .map((relative, index) => ({
        path: relative,
        type: relative === "." ? "directory" : "file",
        mode: relative === "." ? 0o40700 : 0o100700,
        uid: 501,
        gid: 20,
        links: relative === "." ? 3 : 1,
        flags: 0,
        mtimeNs: "1000000000",
        ctimeNs: String(1000000000 + metadataGeneration),
        device: "1",
        inode: String(metadataGeneration * 100 + index),
        xattrs: [],
      }));
    appMetadata.set(appBundle, entries);
  };
  const copyMetadata = (from, target) => {
    allocateMetadata(target);
    const sourceEntries = appMetadata.get(from);
    for (const entry of appMetadata.get(target))
      entry.mtimeNs = sourceEntries.find(
        (row) => row.path === entry.path,
      ).mtimeNs;
  };
  allocateMetadata(context.originalApp);
  const observation = (appBundle) => {
    const entries = structuredClone(appMetadata.get(appBundle));
    return {
      kind: "signed-artifact-custody",
      tree: { sha256: appTrees.get(appBundle) },
      machOFiles: derivedPlan.signingSteps.map((row) => ({
        path: row.primaryPath,
        sha256: sha256(row.primaryPath),
      })),
      metadata: {
        schemaVersion: 1,
        sha256: sha256(`${JSON.stringify(entries)}\n`),
        entries,
        commandCount: 0,
        singleFileFallbackCount: 0,
      },
    };
  };
  const measured = (filename) => {
    assert.ok(
      dmgs.has(filename),
      `synthetic DMG exists: ${path.basename(filename)}`,
    );
    return { kind: "dmg-file", ...dmgs.get(filename) };
  };
  const unavailableCommand = (scope, operation) =>
    scope.own(async () => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.resume();
      stderr.resume();
      const childClosed = scope.trackChild(child);
      const stdoutClosed = scope.trackStream(stdout);
      const stderrClosed = scope.trackStream(stderr);
      stdout.end();
      stderr.end();
      await Promise.all([stdoutClosed, stderrClosed]);
      child.emit("close", 1, null);
      await childClosed;
      state.availabilityCommands.push({
        operation,
        exitCode: 1,
        signal: null,
        streamsClosed: stdout.closed && stderr.closed,
      });
      return {
        stdout: "",
        stderr: "Synthetic known-ID read unavailable",
        exitCode: 1,
      };
    });
  const dependencies = {
    evidence: {
      async openSignedArtifactEvidence(options) {
        state.opens.push(options.mode);
        const owner = await openSignedArtifactEvidenceForTesting(
          { ...options, nativeModule: null },
          native,
        );
        owners.push(owner);
        return {
          ...owner,
          recordStage(request, operation) {
            return owner.recordStage(request, (scope) =>
              operation({
                ...scope,
                writeEvidence(value) {
                  const observation = JSON.parse(value.toString("utf8"));
                  if (
                    observation.kind === "known-notary-status" &&
                    observation.status === "rejected"
                  ) {
                    state.terminalDiagnosticAttempts += 1;
                    if (state.failTerminalDiagnostic)
                      return scope.own(async () => {
                        throw new Error(
                          "Synthetic optional terminal diagnostic unavailable",
                        );
                      });
                  }
                  return scope.writeEvidence(value);
                },
              }),
            );
          },
        };
      },
    },
    async verifyInputs(repositoryRoot, admitted, selectedRunId) {
      assert.equal(repositoryRoot, root);
      assert.equal(selectedRunId, runId);
      assert.deepEqual(admitted, selected);
      return {
        ...structuredClone(context),
        inventoryBytes: Buffer.from(inventoryBytes),
      };
    },
    observer: {
      deriveSignedArtifactPlan(args) {
        state.derives += 1;
        assert.deepEqual(args.unsignedInventory, context.unsignedInventory);
        assert.deepEqual(args.policy, context.policy);
        assert.deepEqual(args.signingSteps, context.derivedPlan.signingSteps);
        return structuredClone(derivedPlan);
      },
      async inspectSignedArtifactCustody({ appBundle }) {
        await state.beforeObserve?.(appBundle, stored());
        assert.ok(
          appTrees.has(appBundle),
          `synthetic app exists: ${appBundle}`,
        );
        const result = observation(appBundle);
        state.observations.push({
          appBundle,
          observation: structuredClone(result),
        });
        return result;
      },
      assertSignedArtifactCopy({ before, after }) {
        assert.deepEqual(before.tree, after.tree);
        assert.deepEqual(before.machOFiles, after.machOFiles);
        const copyStable = (entries) =>
          entries.map(({ device, inode, ctimeNs, ...rest }) => {
            void device;
            void inode;
            void ctimeNs;
            return rest;
          });
        assert.deepEqual(
          copyStable(before.metadata.entries),
          copyStable(after.metadata.entries),
        );
        assert.notEqual(
          before.metadata.entries[0].inode,
          after.metadata.entries[0].inode,
          "separate copies have separate inode identities",
        );
      },
      assertSigningStepTransition({ before, after }) {
        assert.notEqual(before.tree.sha256, after.tree.sha256);
      },
    },
    async measureDmg(filename) {
      return measured(filename);
    },
    async verifyCode({ row, architectures = ["arm64", "x86_64"] }) {
      return architectures.map((arch) => ({
        path: row.primaryPath,
        arch,
        cdhash: cdhashFor(row, arch),
      }));
    },
    async inspectMountedImage(output) {
      assert.equal(output, "synthetic-mounted-device");
      return "/dev/synthetic-test-only";
    },
    async command(scope, admitted, temporaryRoot, toolId, args, settings) {
      assert.deepEqual(admitted, selected);
      assert.ok(temporaryRoot.startsWith(runRoot + "/temporary/"));
      const checkpoint = stored();
      const pending = checkpoint.attempts.at(-1);
      assert.equal(
        pending.state,
        "pending",
        `${toolId} starts only after committed pending`,
      );
      const reservationBytes = await fs.readFile(
        path.join(runRoot, "evidence", pending.reservation.sha256),
      );
      assert.equal(sha256(reservationBytes), pending.reservation.sha256);
      const reservation = JSON.parse(reservationBytes);
      assert.equal(reservation.stageId, pending.stageId);
      assert.equal(reservation.planSha256, signedEvidencePlan(selected).sha256);
      state.calls.push({
        toolId,
        args: [...args],
        settings,
        stage: pending.stageId,
        signingIndex: pending.signingIndex,
        pendingRevision: checkpoint.revision,
      });
      const target = args.at(-1);
      let stdout = "";
      if (toolId === "ditto") {
        const from = args.at(-2);
        if (appTrees.has(from)) {
          appTrees.set(target, appTrees.get(from));
          copyMetadata(from, target);
          await fs.mkdir(target, { recursive: true, mode: 0o700 });
        } else {
          dmgs.set(target, { ...dmgs.get(from) });
          await fs.writeFile(target, "synthetic inspection image", {
            flag: "wx",
            mode: 0o600,
          });
        }
      } else if (toolId === "codesign" && args.includes("--sign")) {
        assert.equal(settings.confined, true);
        assert.equal(
          settings.workRoot,
          target === dmgPath ? path.dirname(dmgPath) : path.dirname(workApp),
        );
        if (target !== dmgPath)
          assert.equal(typeof settings.beforeInvoke, "function");
        assert.equal(
          args[args.indexOf("--sign") + 1],
          selected.authorization.signingIdentitySha1,
        );
        if (state.failSign)
          throw new Error("Synthetic signing command unavailable");
        if (target === dmgPath)
          dmgs.set(target, { sha256: sha256("signed DMG"), bytes: 4096 });
        else {
          appTrees.set(workApp, sha256(`signed step ${pending.signingIndex}`));
          const changed = appMetadata
            .get(workApp)
            .find(
              (row) =>
                row.path ===
                derivedPlan.signingSteps[pending.signingIndex].primaryPath,
            );
          changed.mtimeNs = String(Number(changed.mtimeNs) + 1);
          changed.ctimeNs = String(Number(changed.ctimeNs) + 1);
        }
      } else if (toolId === "hdiutil" && args[0] === "create") {
        dmgs.set(target, { sha256: sha256("unsigned DMG"), bytes: 4096 });
        await fs.writeFile(target, "synthetic DMG", {
          flag: "wx",
          mode: 0o600,
        });
      } else if (toolId === "notarytool") {
        assert.equal(
          args[args.indexOf("--keychain-profile") + 1],
          selected.authorization.notaryKeychainProfile,
        );
        if (args[0] === "submit")
          stdout = JSON.stringify({
            ...submission(),
            id: state.loseSubmissionId ? "lost-id" : submissionId,
            path: args[1],
          });
        else if (args[0] === "info") {
          assert.equal(args[1], submissionId);
          if (state.throwInfo)
            throw new Error("Synthetic status lookup unavailable");
          if (state.failInfo) return unavailableCommand(scope, "info");
          stdout = JSON.stringify({
            ...information(),
            status: state.notaryStatus,
          });
          if (state.malformedNotary === "info-json") stdout = "not-json";
          if (state.malformedNotary === "info-status")
            stdout = JSON.stringify({ ...information(), status: "toString" });
        } else if (args[0] === "log") {
          if (state.throwLog)
            throw new Error("Synthetic log lookup unavailable");
          if (state.failLog) return unavailableCommand(scope, "log");
          const value = ticket();
          value.sha256 = measured(dmgPath).sha256;
          value.ticketContents = derivedPlan.signingSteps.flatMap((row) =>
            ["arm64", "x86_64"].map((arch) => ({
              path: `uploaded/DesmosLock Internal.app/${row.primaryPath}`,
              arch,
              cdhash: cdhashFor(row, arch),
              digestAlgorithm: "SHA-256",
            })),
          );
          if (state.malformedNotary === "ticket-architecture")
            value.ticketContents = value.ticketContents.filter(
              (entry) => entry.arch !== "x86_64",
            );
          stdout = JSON.stringify(value);
          if (state.malformedNotary === "log-json") stdout = "not-json";
        } else assert.fail("unplanned notary command");
      } else if (toolId === "stapler" && args[0] === "staple")
        dmgs.set(target, { sha256: sha256("stapled DMG"), bytes: 4352 });
      else if (toolId === "hdiutil" && args[0] === "attach") {
        assert.ok(args.includes("-readonly"));
        const mountPoint = args[args.indexOf("-mountpoint") + 1];
        appTrees.set(
          path.join(mountPoint, "DesmosLock Internal.app"),
          appTrees.get(workApp),
        );
        copyMetadata(workApp, path.join(mountPoint, "DesmosLock Internal.app"));
        stdout = "synthetic-mounted-device";
      } else if (
        toolId === "hdiutil" &&
        args[0] === "detach" &&
        state.failDetach
      )
        throw new Error("Synthetic detach unavailable");
      void scope;
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
  t.after(async () => {
    state.beforeWrite = null;
    state.failClose = false;
    for (const owner of owners)
      assert.equal(await owner.close({ timeoutMs: 1000 }), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    runRoot,
    state,
    stored,
    selected,
    workApp,
    appTrees,
    appMetadata,
    dmgs,
    finalDmgPath,
    lease: path.join(root, "artifacts/unsigned-artifact-collector.lock"),
    run(mode = "create") {
      return signDesktopArtifactForTesting(
        {
          mode,
          runId,
          descriptorPath: mode === "create" ? descriptorPath : null,
          repositoryRoot: root,
        },
        dependencies,
      );
    },
  };
}

test("actual runner commits every pending reservation before synthetic commands and reopens for final readback", async (t) => {
  const f = await runnerFixture(t);
  const result = await f.run();
  const snapshot = f.stored();
  const expectedStages = signedRunnerStageIds.flatMap((stageId) =>
    stageId === "sign-code" ? [stageId, stageId] : [stageId],
  );
  assert.deepEqual(
    snapshot.attempts.map((entry) => entry.stageId),
    expectedStages,
  );
  assert.ok(
    snapshot.attempts.every((entry) => entry.state === "observed-pass"),
  );
  assert.deepEqual(snapshot.pendingPhysicalCaseIds, pendingPhysicalCaseIds);
  assert.equal(result.physicalAcceptance, "pending");
  assert.equal(result.notaryStatus, "accepted");
  assert.equal(result.candidates.signedApp.treeSha256, sha256("signed step 1"));
  assert.equal(result.candidates.submittedDmg.sha256, sha256("signed DMG"));
  assert.equal(result.candidates.finalDmg.sha256, sha256("stapled DMG"));
  assert.deepEqual(f.state.opens, ["create", "resume"]);
  assert.equal(f.state.closes, 2);
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "notarytool" && call.args[0] === "submit",
    ).length,
    1,
  );
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "hdiutil" && call.args[0] === "detach",
    ).length,
    1,
  );
  await assert.rejects(fs.lstat(f.lease), { code: "ENOENT" });
  const callsBeforeResume = f.state.calls.length;
  await f.run("resume");
  assert.equal(
    f.state.calls.length,
    callsBeforeResume,
    "completed work is not replayed",
  );
});

test("actual runner pauses for in-progress notarization, reconciles a known ID and resumes without resubmission", async (t) => {
  const f = await runnerFixture(t);
  f.state.notaryStatus = "In Progress";
  const waiting = await f.run();
  assert.equal(waiting.notaryStatus, "in-progress");
  assert.equal(waiting.candidates.finalDmg, null);
  assert.equal(f.stored().attempts.at(-1).stageId, "notary-reconcile");
  assert.equal(
    f.state.calls.some((call) => call.toolId === "stapler"),
    false,
  );
  f.state.notaryStatus = "Accepted";
  const reconciled = await f.run("reconcile");
  assert.equal(reconciled.notaryStatus, "accepted");
  assert.equal(reconciled.candidates.finalDmg, null);
  const completed = await f.run("resume");
  assert.equal(completed.candidates.finalDmg.sha256, sha256("stapled DMG"));
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "notarytool" && call.args[0] === "submit",
    ).length,
    1,
  );
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "codesign" && call.args.includes("--sign"),
    ).length,
    3,
  );
});

test("actual runner retries only known-ID reconciliation after a read-only status failure", async (t) => {
  const f = await runnerFixture(t);
  f.state.failInfo = true;
  await assert.rejects(f.run());
  assert.equal(f.stored().submission.id, submissionId);
  assert.equal(f.stored().attempts.at(-1).failure, "operation_failed");
  await assert.rejects(fs.lstat(f.lease), { code: "ENOENT" });
  f.state.failInfo = false;
  await f.run("reconcile");
  await f.run("resume");
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "notarytool" && call.args[0] === "submit",
    ).length,
    1,
  );
});

test("actual runner never resubmits when a successful submit response lacks a usable ID", async (t) => {
  const f = await runnerFixture(t);
  f.state.loseSubmissionId = true;
  await assert.rejects(f.run());
  assert.equal(f.stored().submission, null);
  assert.equal(f.stored().attempts.at(-1).stageId, "notary-submit");
  assert.notEqual(f.stored().attempts.at(-1).state, "observed-pass");
  const callsBeforeResume = f.state.calls.length;
  await assert.rejects(f.run("resume"));
  assert.equal(f.state.calls.length, callsBeforeResume);
  assert.equal(
    f.state.calls.filter(
      (call) => call.toolId === "notarytool" && call.args[0] === "submit",
    ).length,
    1,
  );
});

test("actual runner refuses forged retained signature paths before commands", async (t) => {
  const f = await runnerFixture(t);
  f.state.notaryStatus = "In Progress";
  await f.run();
  const retainedPath = path.join(f.runRoot, "derived-plan.json");
  const retained = JSON.parse(await fs.readFile(retainedPath, "utf8"));
  retained.signingSteps[0].objectPath = "Contents/Other.app";
  retained.sha256 = sha256(signedCanonicalBytes(retained));
  await fs.writeFile(retainedPath, JSON.stringify(retained), { mode: 0o600 });
  const callsBeforeResume = f.state.calls.length;
  await assert.rejects(f.run("resume"));
  assert.equal(f.state.calls.length, callsBeforeResume);
  assert.ok(
    f.state.derives >= 2,
    "each invocation rederives from admitted inputs",
  );
});

test("actual runner rechecks custody after pending commit and refuses a changed work tree before signing", async (t) => {
  const f = await runnerFixture(t);
  f.state.beforeWrite = async (checkpoint) => {
    const attempt = checkpoint.attempts.at(-1);
    if (attempt?.stageId === "sign-code" && attempt.state === "pending")
      f.appTrees.set(f.workApp, sha256("tampered at pending boundary"));
  };
  await assert.rejects(f.run());
  assert.equal(
    f.state.calls.some(
      (call) => call.toolId === "codesign" && call.args.includes("--sign"),
    ),
    false,
  );
  assert.equal(f.stored().attempts.at(-1).stageId, "sign-code");
  assert.equal(f.stored().attempts.at(-1).state, "observed-fail");
});

async function acceptedBeforeStaple(f) {
  f.state.notaryStatus = "In Progress";
  await f.run();
  f.state.notaryStatus = "Accepted";
  await f.run("reconcile");
  assert.equal(f.stored().notaryStatus, "accepted");
  assert.equal(f.stored().candidates.finalDmg, null);
}

for (const malformed of [
  "info-json",
  "info-status",
  "log-json",
  "ticket-architecture",
]) {
  test(`accepted reconciliation followed by malformed ${malformed} permanently blocks mutation without erasing accepted history`, async (t) => {
    const f = await runnerFixture(t);
    await acceptedBeforeStaple(f);
    f.state.malformedNotary = malformed;
    await assert.rejects(f.run("reconcile"));
    const rejected = f.stored();
    const failed = rejected.attempts.at(-1);
    const callsBeforeResume = f.state.calls.length;
    await assert.rejects(
      f.run("resume"),
      "malformed reconciliation must prevent stapling even after an earlier accepted result",
    );
    assert.equal(f.state.calls.length, callsBeforeResume);
    assert.equal(rejected.notaryStatus, "accepted");
    assert.equal(failed.state, "observed-fail");
    assert.equal(failed.failure, "observation_failed");
    assert.equal(failed.notaryStatus, null);
    assert.equal(
      f.state.calls.some((call) => call.toolId === "stapler"),
      false,
    );
    f.state.malformedNotary = null;
    await f.run("reconcile");
    await assert.rejects(
      f.run("resume"),
      "a later valid reconciliation cannot clear an invalid observation",
    );
  });
}

for (const unavailable of ["failInfo", "failLog"]) {
  test(`accepted reconciliation preserves retryable command availability failure ${unavailable}`, async (t) => {
    const f = await runnerFixture(t);
    await acceptedBeforeStaple(f);
    f.state[unavailable] = true;
    await assert.rejects(f.run("reconcile"));
    assert.equal(f.stored().attempts.at(-1).failure, "operation_failed");
    assert.equal(f.stored().notaryStatus, "accepted");
    f.state[unavailable] = false;
    await f.run("reconcile");
    await f.run("resume");
    assert.deepEqual(f.state.availabilityCommands, [
      {
        operation: unavailable === "failInfo" ? "info" : "log",
        exitCode: 1,
        signal: null,
        streamsClosed: true,
      },
    ]);
    assert.equal(
      f.state.calls.filter(
        (call) => call.toolId === "notarytool" && call.args[0] === "submit",
      ).length,
      1,
    );
  });
}

test("accepted status followed by In Progress cannot turn an invalid replay into permission to staple", async (t) => {
  const f = await runnerFixture(t);
  await acceptedBeforeStaple(f);
  f.state.notaryStatus = "In Progress";
  await assert.rejects(f.run("reconcile"));
  const contradictory = f.stored();
  const callsBeforeResume = f.state.calls.length;
  await assert.rejects(f.run("resume"));
  assert.equal(f.state.calls.length, callsBeforeResume);
  assert.equal(contradictory.notaryStatus, "accepted");
  assert.equal(contradictory.attempts.at(-1).state, "observed-fail");
  assert.equal(contradictory.attempts.at(-1).failure, "observation_failed");
  assert.equal(contradictory.attempts.at(-1).notaryStatus, null);
  assert.equal(
    f.state.calls.some((call) => call.toolId === "stapler"),
    false,
  );
});

for (const status of ["Rejected", "Invalid"]) {
  test(`accepted status followed by ${status} blocks staple without depending on optional diagnostic writes`, async (t) => {
    const f = await runnerFixture(t);
    await acceptedBeforeStaple(f);
    f.state.notaryStatus = status;
    f.state.failTerminalDiagnostic = true;
    await assert.rejects(f.run("reconcile"));
    const rejected = f.stored();
    const callsBeforeResume = f.state.calls.length;
    await assert.rejects(f.run("resume"));
    assert.equal(f.state.calls.length, callsBeforeResume);
    assert.equal(rejected.notaryStatus, "rejected");
    assert.equal(rejected.attempts.at(-1).state, "observed-fail");
    assert.equal(rejected.attempts.at(-1).failure, "observation_failed");
    assert.equal(rejected.attempts.at(-1).notaryStatus, "rejected");
    assert.equal(f.state.terminalDiagnosticAttempts, 0);
    assert.equal(
      f.state.calls.some((call) => call.toolId === "stapler"),
      false,
    );
  });
}

for (const failure of ["throwInfo", "throwLog"]) {
  test(`bare ${failure} callback rejection remains a permanent failure rather than command availability`, async (t) => {
    const f = await runnerFixture(t);
    await acceptedBeforeStaple(f);
    f.state[failure] = true;
    await assert.rejects(f.run("reconcile"));
    const rejected = f.stored();
    const callsBeforeResume = f.state.calls.length;
    await assert.rejects(f.run("resume"));
    assert.equal(f.state.calls.length, callsBeforeResume);
    assert.equal(rejected.notaryStatus, "accepted");
    assert.equal(rejected.attempts.at(-1).failure, "observation_failed");
    assert.equal(rejected.attempts.at(-1).notaryStatus, null);
    assert.equal(f.state.availabilityCommands.length, 0);
  });
}

for (const changed of ["missing", "changed"]) {
  test(`completed resume rejects a ${changed} final DMG without replaying mutation`, async (t) => {
    const f = await runnerFixture(t);
    await f.run();
    const callsBeforeResume = f.state.calls.length;
    if (changed === "missing") {
      f.dmgs.delete(f.finalDmgPath);
      await fs.unlink(f.finalDmgPath);
    } else
      f.dmgs.set(f.finalDmgPath, {
        sha256: sha256("changed final image"),
        bytes: 4352,
      });
    await assert.rejects(f.run("resume"));
    assert.equal(f.state.calls.length, callsBeforeResume);
  });
}

test("early readback after a pre-pending observation failure never falsely claims current artifact validation", async (t) => {
  const f = await runnerFixture(t);
  f.state.beforeObserve = () => {
    throw new Error("Synthetic pre-pending observation failure");
  };
  await assert.rejects(f.run());
  assert.equal(f.stored().attempts.length, 0);
  f.state.beforeObserve = null;
  const observationsBeforeReadback = f.state.observations.length;
  await f.run("readback");
  const attempt = f.stored().attempts.at(-1);
  const observations = await Promise.all(
    attempt.evidence.map(async (ref) =>
      JSON.parse(
        await fs.readFile(path.join(f.runRoot, "evidence", ref.sha256), "utf8"),
      ),
    ),
  );
  const receipt = observations.find(
    (entry) => entry.kind === "signed-checkpoint-reopen",
  );
  assert.ok(receipt);
  if (receipt.artifactObservation === "current-input-revalidated")
    assert.ok(
      f.state.observations
        .slice(observationsBeforeReadback)
        .some(
          (entry) =>
            entry.appBundle ===
            path.join(f.root, "original/DesmosLock Internal.app"),
        ),
      "current-input-revalidated requires an actual current original-app observation",
    );
  else
    assert.match(receipt.artifactObservation, /not-revalidated|history-only/);
  assert.equal(f.state.calls.length, 0);
});

for (const field of ["inode", "mtimeNs", "ctimeNs"]) {
  for (const boundary of ["between-stages", "resume"]) {
    test(`same work-copy ${field} change at ${boundary} is rejected against acknowledged custody despite the same tree hash`, async (t) => {
      const f = await runnerFixture(t);
      const mutateMetadata = () => {
        const entry = f.appMetadata
          .get(f.workApp)
          .find((row) => row.type === "file");
        entry[field] = String(Number(entry[field]) + 10000);
      };
      if (boundary === "between-stages") {
        f.state.beforeWrite = (checkpoint) => {
          const last = checkpoint.attempts.at(-1);
          if (
            last?.stageId === "sign-code" &&
            last.signingIndex === 0 &&
            last.state === "observed-pass"
          )
            mutateMetadata();
        };
        await assert.rejects(f.run());
      } else {
        f.state.beforeObserve = (appBundle, checkpoint) => {
          const last = checkpoint?.attempts.at(-1);
          if (
            appBundle === f.workApp &&
            last?.stageId === "sign-code" &&
            last.signingIndex === 0 &&
            last.state === "observed-pass"
          )
            throw new Error(
              "Synthetic pre-pending pause after first signature",
            );
        };
        await assert.rejects(f.run());
        assert.equal(f.stored().attempts.at(-1).state, "observed-pass");
        f.state.beforeObserve = null;
        mutateMetadata();
        await assert.rejects(f.run("resume"));
      }
      assert.equal(f.appTrees.get(f.workApp), sha256("signed step 0"));
      assert.equal(
        f.state.calls.filter(
          (call) => call.toolId === "codesign" && call.args.includes("--sign"),
        ).length,
        1,
      );
      assert.equal(
        f.state.calls.some((call) => call.toolId === "notarytool"),
        false,
      );
    });
  }
}

if (syntheticUncertaintyChild) {
  const scenario = process.argv[3];
  assert.ok(["signing", "detach"].includes(scenario));
  const f = await runnerFixture({ after() {} });
  try {
    f.state.failSign = scenario === "signing";
    f.state.failDetach = scenario === "detach";
    await assert.rejects(f.run(), /settlement uncertain/);
    assert.ok((await fs.lstat(f.lease)).isDirectory());
    assert.equal(f.stored().attempts.at(-1).state, "pending");
    assert.equal(
      f.stored().attempts.at(-1).stageId,
      scenario === "signing" ? "sign-code" : "inspection-copy-mount",
    );
    const callsBeforeResume = f.state.calls.length;
    await assert.rejects(f.run("resume"));
    assert.equal(f.state.calls.length, callsBeforeResume);
    await new Promise((resolve) =>
      process.send(
        {
          scenario,
          retainedPending: true,
          retainedLease: true,
          replayed: false,
        },
        resolve,
      ),
    );
  } finally {
    // This is an isolated synthetic process with no native handles or children.
    // Production intentionally has no API that clears uncertain ownership.
    await fs.rm(f.root, { recursive: true, force: true });
  }
  process.exit(0);
}

for (const scenario of ["signing", "detach"]) {
  test(`actual runner retains pending custody and never retries after uncertain ${scenario}`, async (t) => {
    const child = fork(
      new URL(import.meta.url),
      ["--synthetic-signed-cli-uncertainty", scenario],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        output += bytes.toString("utf8");
        if (output.length > 8192) child.kill("SIGKILL");
      });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let timer;
    const receipt = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Synthetic runner child deadline"));
      }, 5000);
      child.once("message", resolve);
      child.once("error", reject);
      child.once("close", () =>
        reject(new Error(`Synthetic runner closed without receipt: ${output}`)),
      );
    });
    t.after(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    });
    assert.deepEqual(await receipt, {
      scenario,
      retainedPending: true,
      retainedLease: true,
      replayed: false,
    });
    clearTimeout(timer);
    assert.deepEqual(await closed, { code: 0, signal: null });
  });
}
