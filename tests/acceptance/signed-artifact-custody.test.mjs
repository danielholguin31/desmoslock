import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";
import { createPackageWithOptions, getRawHeader } from "@electron/asar";

const helperUrl = new URL("../../scripts/desktop-artifact.mjs", import.meta.url)
  .href;
const identityUrl = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactUrl = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === helperUrl) {
      if (specifier === "../packages/contracts/dist/build-identity.js")
        return nextResolve(identityUrl, context);
      const exports =
        specifier === "@electron/packager"
          ? ["packager"]
          : specifier === "./electron-fuse-policy.mjs"
            ? ["hardenPackagedElectron", "verifyPackagedElectronFuses"]
            : null;
      if (exports)
        return {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent(exports.map((name) => `export function ${name}(){throw new Error("Runtime artifact operation forbidden in pure planning tests");}`).join("\n"))}`,
        };
    }
    if (context.parentURL === identityUrl && specifier === "./exact-record.js")
      return nextResolve(exactUrl, context);
    return nextResolve(specifier, context);
  },
});
const {
  deriveSignedArtifactPlan,
  assertSignedArtifactCopy,
  assertSigningStepTransition,
  inspectSignedArtifactCustody,
  inspectArtifactTree,
  expectedDesktopDistributionFiles,
} = await import(helperUrl);
hooks.deregister();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = {
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  packageLockSha256: "c".repeat(64),
  buildId: "d".repeat(64),
};
const requirement = (identifier) =>
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "AAAAAAAAAA" and identifier "${identifier}"`;

function fixture() {
  const objects = [
    [".", "Contents/MacOS/desmoslock-internal", null, "main"],
    [
      "Contents/Frameworks/Helper (Renderer).app",
      "Contents/Frameworks/Helper (Renderer).app/Contents/MacOS/Helper",
      ".",
      "helper",
    ],
    [
      "Contents/Frameworks/Electron Framework.framework",
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      ".",
      "framework",
    ],
    [
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
      "Contents/Frameworks/Electron Framework.framework",
      "library",
    ],
    [
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
      "Contents/Frameworks/Electron Framework.framework",
      "helper",
    ],
    [
      "Contents/Resources/app.asar.unpacked/dist/native/aac-protection.node",
      "Contents/Resources/app.asar.unpacked/dist/native/aac-protection.node",
      ".",
      "addon",
    ],
  ].map(([objectPath, primaryPath, parentPath, role], index) => {
    const identifier = `org.desmoslock.fixture.${index}`;
    const directory =
      role === "main"
        ? "Contents/_CodeSignature"
        : role === "helper" && objectPath.endsWith(".app")
          ? `${objectPath}/Contents/_CodeSignature`
          : role === "framework"
            ? `${objectPath}/Versions/A/_CodeSignature`
            : null;
    return {
      objectPath,
      primaryPath,
      parentPath,
      role,
      identifier,
      requirement: requirement(identifier),
      entitlements: {},
      runtime: ["main", "helper"].includes(role),
      signatureFiles: directory ? [`${directory}/CodeResources`] : [],
      signatureDirectories: directory ? [directory] : [],
    };
  });
  const entries = new Map();
  for (const row of objects) {
    const parts = row.primaryPath.split("/");
    for (let count = 1; count < parts.length; count++)
      entries.set(parts.slice(0, count).join("/"), {
        path: parts.slice(0, count).join("/"),
        type: "directory",
        mode: 0o755,
      });
    entries.set(row.primaryPath, {
      path: row.primaryPath,
      type: "file",
      mode: 0o755,
      sha256: hash(row.primaryPath),
      bytes: 128,
    });
  }
  const tree = {
    entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  tree.sha256 = hash(JSON.stringify(tree.entries));
  const machOFiles = objects.map((row) => ({
    path: row.primaryPath,
    sha256: hash(row.primaryPath),
    bytes: 128,
    slices: {
      arm64: {
        offset: 64,
        bytes: 32,
        sha256: hash(`${row.primaryPath}:arm64`),
      },
      x64: { offset: 96, bytes: 32, sha256: hash(`${row.primaryPath}:x64`) },
    },
  }));
  const unsignedInventory = {
    schemaVersion: 1,
    kind: "unsigned-universal-app-inventory",
    buildIdentity: identity,
    tree,
    composition: { machOFiles },
  };
  const policy = {
    schemaVersion: 1,
    kind: "signed-artifact-policy",
    teamId: "AAAAAAAAAA",
    objects,
    metadata: {
      ownerUid: 501,
      ownerGid: 20,
      allowedXattrs: [],
      copySymlinkMtime: "record-destination",
    },
  };
  const depth = (row) =>
    row.objectPath === "." ? 0 : row.objectPath.split("/").length;
  const signingSteps = [...objects].sort(
    (a, b) => depth(b) - depth(a) || (a.objectPath < b.objectPath ? -1 : 1),
  );
  return { unsignedInventory, policy, signingSteps };
}

test("freezes every code object once, children before containers, with separate immutable unsigned provenance", () => {
  const input = fixture();
  const plan = deriveSignedArtifactPlan(input);
  assert.equal(plan.kind, "signed-artifact-plan");
  assert.equal(plan.unsignedTreeSha256, input.unsignedInventory.tree.sha256);
  assert.equal(plan.signingSteps.at(-1).objectPath, ".");
  const { sha256, ...content } = plan;
  assert.equal(sha256, hash(`${JSON.stringify(content)}\n`));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.signingSteps[0]));
  input.policy.objects[0].identifier = "changed";
  assert.equal(plan.objects[0].identifier, "org.desmoslock.fixture.0");
  assert.ok(!("toolingSourceCommit" in plan) && !("signedTreeSha256" in plan));
});

test("admits only the fixed standalone crashpad helper with framework parent, runtime and no bundle signature resources", () => {
  const input = fixture();
  const plan = deriveSignedArtifactPlan(input);
  const crashpad = plan.objects.find((row) =>
    row.primaryPath.endsWith("/chrome_crashpad_handler"),
  );
  assert.equal(crashpad.objectPath, crashpad.primaryPath);
  assert.equal(
    crashpad.parentPath,
    "Contents/Frameworks/Electron Framework.framework",
  );
  assert.equal(crashpad.runtime, true);
  assert.deepEqual(crashpad.signatureFiles, []);
  assert.deepEqual(crashpad.signatureDirectories, []);
  for (const mutate of [
    (row) => {
      row.objectPath = row.primaryPath = row.primaryPath.replace(
        "chrome_crashpad_handler",
        "other-helper",
      );
    },
    (row) => {
      row.parentPath = ".";
    },
    (row) => {
      row.runtime = false;
    },
    (row) => {
      row.signatureFiles = [`${row.objectPath}/_CodeSignature/CodeResources`];
    },
  ]) {
    const value = fixture();
    mutate(
      value.policy.objects.find((row) =>
        row.primaryPath.endsWith("/chrome_crashpad_handler"),
      ),
    );
    assert.throws(() => deriveSignedArtifactPlan(value));
  }
});

test("refuses a complete prospective metadata schedule above its command capacity before file or tool access", () => {
  const input = fixture();
  for (let index = 0; index < 7000; index++)
    input.unsignedInventory.tree.entries.push({
      path: `Contents/Resources/${String(index).padStart(5, "0")}-${"x".repeat(220)}`,
      type: "file",
      mode: 0o600,
      bytes: 1,
      sha256: hash("finite resource"),
    });
  input.unsignedInventory.tree.entries.sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  input.unsignedInventory.tree.sha256 = hash(
    JSON.stringify(input.unsignedInventory.tree.entries),
  );
  assert.throws(
    () => deriveSignedArtifactPlan(input),
    /Metadata command capacity exhausted before observation/,
  );
});

const controls = [
  [
    "missing code object",
    (f) => {
      f.policy.objects.pop();
      f.signingSteps = f.signingSteps.filter((row) => row.role !== "addon");
    },
  ],
  [
    "extra declared object",
    (f) => {
      f.policy.objects.push({
        ...f.policy.objects.at(-1),
        objectPath: "Contents/extra.node",
        primaryPath: "Contents/extra.node",
      });
    },
  ],
  [
    "duplicate primary",
    (f) => {
      f.policy.objects.push({ ...f.policy.objects[0] });
    },
  ],
  [
    "outer-before-inner schedule",
    (f) => {
      f.signingSteps.reverse();
    },
  ],
  [
    "wrong containing object",
    (f) => {
      f.policy.objects.find((row) => row.role === "library").parentPath = ".";
    },
  ],
  [
    "arbitrary signature-directory exception",
    (f) => {
      f.policy.objects[0].signatureDirectories.push("Contents/Resources");
    },
  ],
  [
    "arbitrary signature-file exception",
    (f) => {
      f.policy.objects[0].signatureFiles.push("Contents/Resources/app.asar");
    },
  ],
  [
    "wrong Team requirement",
    (f) => {
      f.policy.objects[0].requirement = "anchor apple generic";
    },
  ],
  [
    "library entitlements",
    (f) => {
      f.policy.objects.find((row) => row.role === "library").entitlements = {
        "com.apple.security.cs.allow-jit": true,
      };
    },
  ],
  [
    "main lacks runtime",
    (f) => {
      f.policy.objects[0].runtime = false;
    },
  ],
  [
    "unsigned tree digest mismatch",
    (f) => {
      f.unsignedInventory.tree.entries[0].mode = 0;
    },
  ],
  [
    "wrong build identity",
    (f) => {
      f.unsignedInventory.buildIdentity = null;
    },
  ],
  [
    "missing x64 slice",
    (f) => {
      delete f.unsignedInventory.composition.machOFiles[0].slices.x64;
    },
  ],
  [
    "overlapping Mach-O slices",
    (f) => {
      f.unsignedInventory.composition.machOFiles[0].slices.x64.offset = 64;
    },
  ],
  [
    "unknown metadata attribute",
    (f) => {
      f.policy.metadata.allowedXattrs = [
        {
          path: ".",
          name: "com.apple.FinderInfo",
          bytes: 32,
          sha256: hash("fixture"),
        },
      ];
    },
  ],
  [
    "metadata normalization policy",
    (f) => {
      f.policy.metadata.copySymlinkMtime = "ignore-all-times";
    },
  ],
  [
    "shell/control path",
    (f) => {
      f.policy.objects[0].primaryPath = "Contents/MacOS/test\ncommand";
    },
  ],
  [
    "private path",
    (f) => {
      f.policy.objects[0].primaryPath = "Contents/.env.private";
    },
  ],
];
for (const [label, mutate] of controls)
  test(`rejects ${label} before any artifact command`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => deriveSignedArtifactPlan(input));
  });

test("rejects executable resources and undeclared signature paths even with a recomputed tree hash", () => {
  for (const row of [
    {
      path: "Contents/Resources/run.sh",
      type: "file",
      mode: 0o755,
      sha256: hash("shell"),
      bytes: 20,
    },
    {
      path: "Contents/Resources/_CodeSignature",
      type: "directory",
      mode: 0o755,
    },
  ]) {
    const input = fixture();
    input.unsignedInventory.tree.entries.push(row);
    input.unsignedInventory.tree.entries.sort((a, b) =>
      a.path < b.path ? -1 : 1,
    );
    input.unsignedInventory.tree.sha256 = hash(
      JSON.stringify(input.unsignedInventory.tree.entries),
    );
    assert.throws(() => deriveSignedArtifactPlan(input));
  }
});

test("accepts only exact sorted finite approved quarantine/provenance observations", () => {
  const input = fixture();
  input.policy.metadata.allowedXattrs = [
    {
      path: ".",
      name: "com.apple.provenance",
      bytes: 11,
      sha256: hash("fixture"),
    },
    {
      path: ".",
      name: "com.apple.quarantine",
      bytes: 32,
      sha256: hash("quarantine"),
    },
  ];
  assert.ok(deriveSignedArtifactPlan(input));
  input.policy.metadata.allowedXattrs.reverse();
  assert.throws(() => deriveSignedArtifactPlan(input));
});

function seal(snapshot) {
  snapshot.tree.entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  snapshot.tree.sha256 = hash(JSON.stringify(snapshot.tree.entries));
  snapshot.machOFiles.sort((a, b) => (a.path < b.path ? -1 : 1));
  snapshot.metadata.entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  snapshot.metadata.sha256 = hash(
    `${JSON.stringify(snapshot.metadata.entries)}\n`,
  );
  return snapshot;
}

function metadataRow(row, index) {
  return {
    path: row.path,
    type: row.type,
    mode:
      (row.type === "file"
        ? 0o100000
        : row.type === "symlink"
          ? 0o120000
          : 0o40000) | row.mode,
    uid: 501,
    gid: 20,
    links: row.type === "directory" ? 2 : 1,
    flags: 0,
    mtimeNs: "100",
    ctimeNs: "110",
    device: "1",
    inode: String(index + 1),
    xattrs: [],
  };
}

function observation(input = fixture()) {
  const tree = structuredClone(input.unsignedInventory.tree);
  const fuseWires = {
    arm64: { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, version: "1" },
    x64: { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, version: "1" },
  };
  const integrity = {
    algorithm: "SHA256",
    expectedDigest: hash("integrity"),
    observedDigest: hash("integrity"),
  };
  return seal({
    schemaVersion: 1,
    kind: "signed-artifact-custody",
    buildIdentity: identity,
    tree,
    machOFiles: structuredClone(input.unsignedInventory.composition.machOFiles),
    metadata: {
      schemaVersion: 1,
      entries: [
        { path: ".", type: "directory", mode: 0o755 },
        ...tree.entries,
      ].map(metadataRow),
      commandCount: 3,
      singleFileFallbackCount: 0,
    },
    fuseWires,
    asarIntegrity: { arm64: { ...integrity }, x64: { ...integrity } },
  });
}

test("records copied identity and symlink times but requires all resource bytes and file/directory mtimes", () => {
  const input = fixture();
  const before = observation(input);
  const link = {
    path: "Contents/Frameworks/current",
    type: "symlink",
    mode: 0o755,
    target: "Electron Framework.framework",
  };
  before.tree.entries.push(link);
  before.metadata.entries.push(metadataRow(link, 100));
  seal(before);
  const after = structuredClone(before);
  for (const row of after.metadata.entries) {
    row.device = "2";
    row.inode = String(Number(row.inode) + 1000);
    row.ctimeNs = "500";
  }
  after.metadata.entries.find((row) => row.type === "symlink").mtimeNs = "400";
  seal(after);
  const copy = assertSignedArtifactCopy({
    before,
    after,
    policy: input.policy,
  });
  assert.equal(copy.beforeTreeSha256, copy.afterTreeSha256);
  assert.deepEqual(copy.copiedSymlinkMtimes, [
    { path: link.path, mtimeNs: "400" },
  ]);
  const file = after.metadata.entries.find((row) => row.type === "file");
  file.mtimeNs = "401";
  seal(after);
  assert.throws(() =>
    assertSignedArtifactCopy({ before, after, policy: input.policy }),
  );
});

test("retains the actual quarantine-copy failure as strict rejection", () => {
  const input = fixture();
  const before = observation(input);
  const attribute = {
    name: "com.apple.quarantine",
    bytes: 32,
    sha256: "cf6e798b7c41cc55cf39a4d60343cade409adf32e562de0ea27b8ab036769cdb",
  };
  before.metadata.entries[0].xattrs = [attribute];
  seal(before);
  input.policy.metadata.allowedXattrs = [{ path: ".", ...attribute }];
  const after = structuredClone(before);
  after.metadata.entries[0].xattrs[0] = {
    name: attribute.name,
    bytes: 15,
    sha256: "a01abf34bfdc469fcc409810752f62f39f32f2cc262c68e89274f48ea619b708",
  };
  seal(after);
  assert.throws(
    () => assertSignedArtifactCopy({ before, after, policy: input.policy }),
    /approved values/,
  );
});

function changedPrimary(before, target) {
  const after = structuredClone(before);
  const file = after.machOFiles.find((row) => row.path === target);
  file.sha256 = hash("controlled signed layout");
  file.bytes = 160;
  file.slices.arm64.sha256 = hash("new arm64 layout");
  file.slices.x64 = { offset: 96, bytes: 64, sha256: hash("new x64 layout") };
  const treeEntry = after.tree.entries.find((row) => row.path === target);
  treeEntry.sha256 = file.sha256;
  treeEntry.bytes = file.bytes;
  const metadata = after.metadata.entries.find((row) => row.path === target);
  metadata.inode = "5000";
  metadata.mtimeNs = "200";
  metadata.ctimeNs = "210";
  return seal(after);
}

test("accepts a controlled target layout change with distinct raw and per-slice hashes and no equivalence claim", () => {
  const input = fixture();
  const plan = deriveSignedArtifactPlan(input);
  const before = observation(input);
  const after = changedPrimary(before, plan.signingSteps[0].primaryPath);
  const report = assertSigningStepTransition({
    before,
    after,
    plan,
    signingIndex: 0,
  });
  assert.notEqual(report.beforeTreeSha256, report.afterTreeSha256);
  assert.notEqual(report.inputMachO.sha256, report.outputMachO.sha256);
  assert.equal(report.equivalenceClaim, null);
});

for (const [label, mutate] of [
  [
    "changed other code object",
    (after, before, plan) => {
      const other = after.tree.entries.find(
        (row) =>
          row.type === "file" && row.path !== plan.signingSteps[0].primaryPath,
      );
      other.sha256 = hash("foreign code");
      after.machOFiles.find((row) => row.path === other.path).sha256 =
        other.sha256;
    },
  ],
  [
    "changed unrelated metadata",
    (after) => {
      after.metadata.entries[0].uid = 502;
    },
  ],
  [
    "changed secondary-slice fuse",
    (after) => {
      after.fuseWires.x64[1] = 48;
    },
  ],
  [
    "changed ASAR integrity",
    (after) => {
      after.asarIntegrity.x64.expectedDigest = hash("other");
      after.asarIntegrity.x64.observedDigest = hash("other");
    },
  ],
  [
    "changed target mode",
    (after, before, plan) => {
      const name = plan.signingSteps[0].primaryPath;
      after.tree.entries.find((row) => row.path === name).mode = 0o700;
      after.metadata.entries.find((row) => row.path === name).mode = 0o100700;
    },
  ],
  [
    "new arbitrary signature directory",
    (after) => {
      const row = {
        path: "Contents/_CodeSignature",
        type: "directory",
        mode: 0o755,
      };
      after.tree.entries.push(row);
      after.metadata.entries.push(metadataRow(row, 100));
    },
  ],
  [
    "lost object",
    (after, before, plan) => {
      const name = plan.signingSteps[0].primaryPath;
      after.tree.entries = after.tree.entries.filter(
        (row) => row.path !== name,
      );
      after.metadata.entries = after.metadata.entries.filter(
        (row) => row.path !== name,
      );
      after.machOFiles = after.machOFiles.filter((row) => row.path !== name);
    },
  ],
])
  test(`rejects ${label} during controlled signing`, () => {
    const input = fixture();
    const plan = deriveSignedArtifactPlan(input);
    const before = observation(input);
    const after = changedPrimary(before, plan.signingSteps[0].primaryPath);
    mutate(after, before, plan);
    seal(after);
    assert.throws(() =>
      assertSigningStepTransition({ before, after, plan, signingIndex: 0 }),
    );
  });

test("requires complete exact CodeResources and signature directory for a bundled signing step", () => {
  const input = fixture();
  const plan = deriveSignedArtifactPlan(input);
  const before = observation(input);
  const signingIndex = plan.signingSteps.findIndex(
    (row) => row.role === "helper" && row.objectPath.endsWith(".app"),
  );
  const step = plan.signingSteps[signingIndex];
  const after = changedPrimary(before, step.primaryPath);
  assert.throws(
    () => assertSigningStepTransition({ before, after, plan, signingIndex }),
    /complete declared signature/,
  );
  const newRows = [
    { path: step.signatureDirectories[0], type: "directory", mode: 0o755 },
    {
      path: step.signatureFiles[0],
      type: "file",
      mode: 0o644,
      sha256: hash("CodeResources"),
      bytes: 100,
    },
  ];
  for (const row of newRows) {
    after.tree.entries.push(row);
    after.metadata.entries.push(
      metadataRow(row, after.metadata.entries.length + 1),
    );
  }
  seal(after);
  assert.ok(assertSigningStepTransition({ before, after, plan, signingIndex }));
  after.metadata.entries.find(
    (row) => row.path === step.signatureFiles[0],
  ).xattrs = [
    { name: "com.apple.provenance", bytes: 11, sha256: hash("new metadata") },
  ];
  seal(after);
  assert.throws(
    () => assertSigningStepTransition({ before, after, plan, signingIndex }),
    /Unexpected metadata on new signature/,
  );
});

function fatFixture(fileType, payload = Buffer.alloc(0)) {
  const length = 32 + payload.length;
  const result = Buffer.alloc(64 + length * 2);
  result.writeUInt32BE(0xcafebabe, 0);
  result.writeUInt32BE(2, 4);
  const slices = {};
  for (const [index, architecture] of ["arm64", "x64"].entries()) {
    const cpu = architecture === "arm64" ? 0x0100000c : 0x01000007;
    const offset = 64 + length * index;
    const record = 8 + index * 20;
    result.writeUInt32BE(cpu, record);
    result.writeUInt32BE(0, record + 4);
    result.writeUInt32BE(offset, record + 8);
    result.writeUInt32BE(length, record + 12);
    result.writeUInt32BE(0, record + 16);
    result.writeUInt32LE(0xfeedfacf, offset);
    result.writeUInt32LE(cpu, offset + 4);
    result.writeUInt32LE(0, offset + 8);
    result.writeUInt32LE(fileType, offset + 12);
    payload.copy(result, offset + 32);
    slices[architecture] = {
      offset,
      bytes: length,
      sha256: hash(result.subarray(offset, offset + length)),
    };
  }
  return { bytes: result, slices };
}

async function diskFixture(t) {
  const parent = fileURLToPath(
    new URL("../../artifacts/local-tool-tmp/", import.meta.url),
  );
  await fs.mkdir(parent, { recursive: true });
  assert.ok(
    (await fs.lstat(parent)).isDirectory() &&
      !(await fs.lstat(parent)).isSymbolicLink(),
  );
  const root = await fs.mkdtemp(path.join(parent, "signed-custody-"));
  t.after(async () => {
    assert.ok(root.startsWith(path.join(parent, "signed-custody-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  const appBundle = path.join(root, "Synthetic Fixture.app");
  const archiveSource = path.join(root, "synthetic-asar-source");
  const resources = path.join(appBundle, "Contents/Resources");
  await fs.mkdir(path.join(archiveSource, "dist/calculator"), {
    recursive: true,
  });
  await fs.mkdir(path.join(archiveSource, "dist/native"));
  await fs.mkdir(resources, { recursive: true });
  const commonFiles = [];
  for (const name of expectedDesktopDistributionFiles("linux")) {
    const content = Buffer.from(
      name === "build-identity.json"
        ? `${JSON.stringify(identity)}\n`
        : `synthetic ${name}\n`,
    );
    await fs.writeFile(path.join(archiveSource, "dist", name), content, {
      mode: 0o600,
    });
    commonFiles.push({
      path: name,
      type: "file",
      mode: 0o600,
      bytes: content.length,
      sha256: hash(content),
    });
  }
  const native = fatFixture(8);
  for (const name of ["aac-protection.node", "durable-record.node"])
    await fs.writeFile(
      path.join(archiveSource, "dist/native", name),
      native.bytes,
      { mode: 0o600 },
    );
  await fs.writeFile(
    path.join(archiveSource, "package.json"),
    JSON.stringify({
      main: "dist/main.js",
      name: "desmoslock-internal",
      productName: "DesmosLock Internal",
      type: "module",
      version: "1.0.0",
    }),
  );
  await createPackageWithOptions(
    archiveSource,
    path.join(resources, "app.asar"),
    { unpack: "**/*.node" },
  );
  const header = getRawHeader(path.join(resources, "app.asar"));
  const headerHash = hash(header.headerString);
  const frameworkPayload = Buffer.concat([
    Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"),
    Buffer.from([1, 1]),
    Buffer.from(hash(`Resources/app.asarSHA256${headerHash}`), "hex"),
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([1, 5, 48, 49, 48, 48, 49]),
  ]);
  const main = fatFixture(2),
    framework = fatFixture(6, frameworkPayload);
  const input = fixture();
  const objects = input.policy.objects.filter(
    (row) =>
      ["main", "framework", "addon"].includes(row.role) ||
      (row.role === "helper" && row.objectPath === row.primaryPath),
  );
  const otherAddon = {
    ...objects.find((row) => row.role === "addon"),
    objectPath:
      "Contents/Resources/app.asar.unpacked/dist/native/durable-record.node",
    primaryPath:
      "Contents/Resources/app.asar.unpacked/dist/native/durable-record.node",
    identifier: "org.desmoslock.fixture.durable",
    requirement: requirement("org.desmoslock.fixture.durable"),
  };
  objects.push(otherAddon);
  for (const object of objects) {
    if (object.role === "addon") continue;
    await fs.mkdir(path.dirname(path.join(appBundle, object.primaryPath)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(appBundle, object.primaryPath),
      ["main", "helper"].includes(object.role) ? main.bytes : framework.bytes,
      { mode: 0o700 },
    );
    if (object.role === "helper" && object.objectPath === object.primaryPath)
      continue;
    const infoPath =
      object.role === "main"
        ? "Contents/Info.plist"
        : `${object.objectPath}/Versions/A/Resources/Info.plist`;
    await fs.mkdir(path.dirname(path.join(appBundle, infoPath)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(appBundle, infoPath),
      plist.build({
        CFBundleIdentifier: object.identifier,
        CFBundleExecutable: path.posix.basename(object.primaryPath),
        CFBundleVersion: "1.0.0",
        CFBundleShortVersionString: "1.0.0",
        ...(object.role === "main"
          ? {
              ElectronAsarIntegrity: {
                "Resources/app.asar": { algorithm: "SHA256", hash: headerHash },
              },
            }
          : {}),
      }),
    );
    if (object.role === "framework") {
      await fs.symlink(
        "A",
        path.join(appBundle, object.objectPath, "Versions/Current"),
      );
      await fs.symlink(
        "Versions/Current/Electron Framework",
        path.join(appBundle, object.objectPath, "Electron Framework"),
      );
    }
  }
  const tree = await inspectArtifactTree(appBundle);
  const machOFiles = objects
    .map((object) => {
      const data = ["main", "helper"].includes(object.role)
        ? main
        : object.role === "framework"
          ? framework
          : native;
      return {
        path: object.primaryPath,
        sha256: hash(data.bytes),
        bytes: data.bytes.length,
        slices: data.slices,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const unsignedInventory = {
    schemaVersion: 1,
    kind: "unsigned-universal-app-inventory",
    buildIdentity: identity,
    packageVersion: "1.0.0",
    tree,
    composition: {
      machOFiles,
      common: { files: commonFiles, buildIdentity: identity },
    },
  };
  const policy = {
    ...input.policy,
    objects,
    metadata: {
      ...input.policy.metadata,
      ownerUid: process.getuid(),
      ownerGid: process.getgid(),
    },
  };
  let mode = "valid";
  const calls = [];
  async function runCommand(toolId, args) {
    calls.push({ toolId, args });
    let stdout = "";
    if (toolId === "stat") {
      for (const name of args.slice(2)) {
        const s = await fs.lstat(name, { bigint: true });
        stdout += `${name}\t${s.mode.toString(8)}\t${s.nlink}\t${s.uid}\t${s.gid}\t0\t${s.dev}\t${s.ino}\n`;
      }
      if (mode === "foreign-stat")
        stdout = stdout.replace(appBundle, `${appBundle}-foreign`);
      if (mode === "partial-stat")
        stdout = stdout.slice(stdout.indexOf("\n") + 1);
      if (
        mode === "partial-second-stat" &&
        calls.filter((row) => row.toolId === "stat").length === 2
      )
        stdout = stdout.slice(stdout.indexOf("\n") + 1);
      if (mode === "oversized") stdout = "x".repeat(65537);
      if (mode === "substitution")
        await fs.writeFile(
          path.join(appBundle, objects[0].primaryPath),
          Buffer.from("changed during metadata observation"),
        );
    } else if (toolId === "ls") {
      for (const name of args.slice(5)) {
        const s = await fs.lstat(name);
        const prefix = s.isDirectory()
          ? "drwx------"
          : s.isSymbolicLink()
            ? "lrwxr-xr-x"
            : "-rw-------";
        stdout += `${prefix}@ ${s.nlink} ${s.uid} ${s.gid} ${s.size} Sep 13 15:00 ${name}${s.isSymbolicLink() ? ` -> ${await fs.readlink(name)}` : ""}\n`;
      }
      if (mode === "acl-hidden-by-at")
        stdout = stdout.replace(
          "\n",
          "\n 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C deny delete\n",
        );
    } else if (toolId === "xattr") {
      if (mode === "unknown-attribute")
        stdout = `${appBundle}: com.apple.FinderInfo\n`;
      if (mode === "foreign-attribute")
        stdout = `${appBundle}-foreign: com.apple.provenance\n`;
      if (mode === "unplanned-value")
        stdout = `${appBundle}: com.apple.provenance\n`;
      if (mode.startsWith("xattr-")) {
        if (!args.includes("-p")) {
          stdout = `${appBundle}: com.apple.provenance\n${appBundle}: com.apple.quarantine\n`;
          if (mode === "xattr-duplicate-name")
            stdout += `${appBundle}: com.apple.provenance\n`;
        } else {
          const bytes = Buffer.from(
            args[4] === "com.apple.provenance"
              ? "public-meta"
              : "test-quarantine",
          );
          stdout = `${appBundle}: \n${bytes.toString("hex").toUpperCase().match(/../g).join(" ")}\n`;
          if (mode === "xattr-missing-value") stdout = "";
          if (mode === "xattr-foreign-value")
            stdout = stdout.replace(appBundle, `${appBundle}-foreign`);
          if (mode === "xattr-malformed-hex") stdout = `${appBundle}: \nGG\n`;
          if (mode === "xattr-oversized-value")
            stdout = `${appBundle}: \n${"AA ".repeat(4097)}\n`;
        }
      }
    } else assert.fail("Unexpected tool");
    return {
      stdout,
      stderr: mode === "stderr" ? "finite diagnostic" : "",
      exitCode: mode === "exit" ? 1 : 0,
    };
  }
  return {
    appBundle,
    unsignedInventory,
    policy,
    calls,
    async addResources(count) {
      for (let index = 0; index < count; index++)
        await fs.writeFile(
          path.join(resources, `batch-${String(index).padStart(3, "0")}.txt`),
          "public batch fixture\n",
          { mode: 0o600 },
        );
      unsignedInventory.tree = await inspectArtifactTree(appBundle);
    },
    setMode(value) {
      mode = value;
      if (mode.startsWith("xattr-"))
        policy.metadata.allowedXattrs = [
          {
            path: ".",
            name: "com.apple.provenance",
            bytes: 11,
            sha256: hash("public-meta"),
          },
          {
            path: ".",
            name: "com.apple.quarantine",
            bytes: 15,
            sha256: hash("test-quarantine"),
          },
        ];
    },
    async inspect(index) {
      return inspectSignedArtifactCustody({
        appBundle,
        temporaryRoot: path.join(root, `observe-${index}`),
        expectedBuildIdentity: identity,
        unsignedInventory,
        policy,
        runCommand,
      });
    },
  };
}

test("observes a real synthetic ASAR, both Mach-O slices, full fuse wires, aliases, and root-inclusive batched metadata", async (t) => {
  const current = await diskFixture(t);
  const result = await current.inspect(0);
  assert.equal(result.tree.sha256, current.unsignedInventory.tree.sha256);
  assert.equal(result.metadata.entries[0].path, ".");
  assert.equal(result.metadata.commandCount, 3);
  assert.equal(result.metadata.singleFileFallbackCount, 0);
  assert.equal(result.machOFiles.length, 5);
  assert.deepEqual(result.fuseWires.arm64, result.fuseWires.x64);
  assert.equal(result.fuseWires.x64[4], 49);
  assert.deepEqual(
    current.calls.map((row) => row.toolId),
    ["stat", "ls", "xattr"],
  );
});

test("reads approved xattr values in bounded named batches and returns length/hash only", async (t) => {
  const current = await diskFixture(t);
  current.setMode("xattr-valid");
  const result = await current.inspect(0);
  assert.equal(result.metadata.commandCount, 5);
  assert.deepEqual(
    result.metadata.entries[0].xattrs,
    current.policy.metadata.allowedXattrs.map((row) => ({
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
    })),
  );
  assert.equal(JSON.stringify(result).includes("public-meta"), false);
});

test("attributes every row across multiple bounded metadata batches", async (t) => {
  const current = await diskFixture(t);
  await current.addResources(70);
  const result = await current.inspect(0);
  const stats = current.calls.filter((row) => row.toolId === "stat");
  assert.ok(stats.length >= 2);
  assert.ok(
    stats.every(
      (row) =>
        row.args.length - 2 <= 64 &&
        row.args.reduce(
          (bytes, arg) => bytes + Buffer.byteLength(arg) + 1,
          0,
        ) <= 16384,
    ),
  );
  assert.equal(result.metadata.commandCount, stats.length * 3);
  assert.equal(result.metadata.entries.length, result.tree.entries.length + 1);
  assert.equal(
    new Set(result.metadata.entries.map((row) => row.path)).size,
    result.metadata.entries.length,
  );
});

test("refuses incomplete attribution in the second metadata batch", async (t) => {
  const current = await diskFixture(t);
  await current.addResources(70);
  current.setMode("partial-second-stat");
  await assert.rejects(
    current.inspect(0),
    /Stat batch attribution is incomplete/,
  );
  assert.equal(current.calls.filter((row) => row.toolId === "stat").length, 2);
});

test("refuses an unreserved attribute-value command before invoking the adapter", async (t) => {
  const current = await diskFixture(t);
  current.setMode("unplanned-value");
  await assert.rejects(current.inspect(0), /Metadata command budget exhausted/);
  assert.deepEqual(
    current.calls.map((row) => row.toolId),
    ["stat", "ls", "xattr"],
  );
  assert.ok(current.calls.every((row) => !row.args.includes("-p")));
});

for (const mode of [
  "foreign-stat",
  "partial-stat",
  "oversized",
  "acl-hidden-by-at",
  "unknown-attribute",
  "foreign-attribute",
  "xattr-missing-value",
  "xattr-foreign-value",
  "xattr-malformed-hex",
  "xattr-oversized-value",
  "xattr-duplicate-name",
  "substitution",
  "stderr",
  "exit",
])
  test(`rejects ${mode} from bounded metadata adapter`, async (t) => {
    const current = await diskFixture(t);
    current.setMode(mode);
    await assert.rejects(current.inspect(0));
  });
