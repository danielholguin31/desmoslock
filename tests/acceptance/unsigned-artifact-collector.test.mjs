import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Load only the pinned pure sanitizer, avoiding the packager barrel's native ZIP loader.
import { defaultSanitizePackageJson } from "../../node_modules/@electron/packager/dist/sanitize-package-json.js";

const helperUrl = new URL("../../scripts/desktop-artifact.mjs", import.meta.url)
  .href;
const identitySource = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactRecordSource = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const stateKey = Symbol.for("desmoslock.unsigned-artifact.synthetic-test");
const disabledFuses = {
  EnableNodeCliInspectArguments: "DISABLE",
  EnableNodeOptionsEnvironmentVariable: "DISABLE",
  RunAsNode: "DISABLE",
};
let archiveEntries = new Map();
let archiveContents = new Map();
let fuseResult = disabledFuses;
let packageCalls = 0;
let hardenCalls = 0;
globalThis[stateKey] = {
  statFile(_archive, filename, followLinks) {
    assert.equal(followLinks, false);
    assert.ok(
      archiveEntries.has(filename),
      `Missing synthetic ASAR entry ${filename}`,
    );
    return archiveEntries.get(filename);
  },
  listPackage() {
    return [...archiveEntries.keys()].map((filename) => `/${filename}`);
  },
  extractFile(_archive, filename, followLinks) {
    assert.equal(followLinks, false);
    const value = archiveContents.get(filename);
    assert.ok(value !== undefined, `Missing synthetic ASAR bytes ${filename}`);
    return typeof value === "function" ? value() : value;
  },
  uncache() {},
  getRawHeader() {
    throw new Error("Universal ASAR reader must not run in native controls");
  },
  packager() {
    packageCalls += 1;
    throw new Error("Actual packager is forbidden in source tests");
  },
  hardenPackagedElectron() {
    hardenCalls += 1;
    throw new Error("Actual fuse mutation is forbidden in source tests");
  },
  verifyPackagedElectronFuses() {
    return Promise.resolve(fuseResult);
  },
};
const moduleSource = (names) =>
  `const state = globalThis[Symbol.for("desmoslock.unsigned-artifact.synthetic-test")];\n${names.map((name) => `export const ${name} = (...args) => state.${name}(...args);`).join("\n")}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === helperUrl) {
      if (specifier === "../packages/contracts/dist/build-identity.js")
        return nextResolve(identitySource, context);
      const exports =
        specifier === "@electron/asar"
          ? [
              "extractFile",
              "getRawHeader",
              "listPackage",
              "statFile",
              "uncache",
            ]
          : specifier === "@electron/packager"
            ? ["packager"]
            : specifier === "./electron-fuse-policy.mjs"
              ? ["hardenPackagedElectron", "verifyPackagedElectronFuses"]
              : null;
      if (exports !== null)
        return {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent(moduleSource(exports))}`,
        };
    }
    if (
      context.parentURL === identitySource &&
      specifier === "./exact-record.js"
    )
      return nextResolve(exactRecordSource, context);
    return nextResolve(specifier, context);
  },
});
const {
  assertBuildIdentity,
  expectedDesktopDistributionFiles,
  inspectArtifactTree,
  inspectDesktopDistribution,
  inspectMachOHeader,
  inspectNativeArtifact,
  inspectPackagedDesktop,
  nativeDistributionFiles,
  packageUnsignedDesktop,
  selectExistingElectronArchive,
} = await import(helperUrl);
hooks.deregister();

const knownIdentity = Object.freeze({
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  packageLockSha256: "c".repeat(64),
  buildId: "d".repeat(64),
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
function machO(architecture = "arm64", fileType = 8, tail = "") {
  const buffer = Buffer.alloc(32 + Buffer.byteLength(tail));
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(fileType, 12);
  buffer.write(tail, 32);
  return buffer;
}
async function write(root, filename, bytes, mode = 0o600) {
  const target = path.join(root, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx", mode });
  return target;
}
async function syntheticDistribution(
  root,
  identity = knownIdentity,
  platform = "darwin",
) {
  for (const filename of expectedDesktopDistributionFiles(platform)) {
    await write(
      root,
      filename,
      nativeDistributionFiles.includes(filename)
        ? machO("arm64", 8, filename)
        : filename === "build-identity.json"
          ? `${JSON.stringify(identity)}\n`
          : `synthetic:${filename}\n`,
    );
  }
  return inspectDesktopDistribution({
    distributionRoot: root,
    platform,
    architecture: "arm64",
    expectedBuildIdentity: identity,
  });
}
async function syntheticPackage(root, distributionRoot, distribution) {
  archiveEntries = new Map([
    ["dist", { files: {} }],
    ["dist/calculator", { files: {} }],
    ["dist/native", { files: {} }],
  ]);
  archiveContents = new Map();
  const appBundle = path.join(root, "DesmosLock Internal.app");
  const resources = path.join(appBundle, "Contents/Resources");
  await write(
    appBundle,
    "Contents/MacOS/desmoslock-internal",
    machO("arm64", 2),
    0o700,
  );
  await write(appBundle, "Contents/Info.plist", "<plist>synthetic</plist>\n");
  await write(
    resources,
    "app.asar",
    "synthetic ASAR bytes; parser is mocked\n",
  );
  for (const { path: filename } of distribution.files) {
    const bytes = await fs.readFile(path.join(distributionRoot, filename));
    const native = nativeDistributionFiles.includes(filename);
    archiveEntries.set(`dist/${filename}`, {
      size: bytes.length,
      ...(native ? { unpacked: true } : {}),
    });
    if (native) {
      const nativePath = await write(
        resources,
        `app.asar.unpacked/dist/${filename}`,
        bytes,
      );
      archiveContents.set(`dist/${filename}`, () => readFileSync(nativePath));
    } else archiveContents.set(`dist/${filename}`, bytes);
  }
  const metadata = Buffer.from(
    JSON.stringify({
      main: "dist/main.js",
      name: "desmoslock-internal",
      productName: "DesmosLock Internal",
      type: "module",
      version: "2.0.0",
    }),
  );
  archiveEntries.set("package.json", { size: metadata.length });
  archiveContents.set("package.json", metadata);
  fuseResult = disabledFuses;
  return {
    packageDirectory: root,
    appBundle,
    resources,
    distribution,
    platform: "darwin",
    architecture: "arm64",
    expectedBuildIdentity: knownIdentity,
  };
}

await test("unsigned desktop artifact inspection uses synthetic files and mocked archive/fuse readers only", async (t) => {
  const temporaryParent = fileURLToPath(
    new URL("../../artifacts/local-tool-tmp/", import.meta.url),
  );
  await fs.mkdir(temporaryParent, { recursive: true });
  assert.equal((await fs.lstat(temporaryParent)).isSymbolicLink(), false);
  const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, "unsigned-artifact-test-"),
  );
  let sequence = 0;
  const directory = async () => {
    const root = path.join(temporaryRoot, String(sequence++));
    await fs.mkdir(root);
    return root;
  };
  try {
    await t.test(
      "requires the shared exact candidate identity and permits only explicit null development identity",
      () => {
        assert.equal(assertBuildIdentity(null), null);
        assert.deepEqual(
          assertBuildIdentity(knownIdentity, knownIdentity),
          knownIdentity,
        );
        for (const bad of [
          null,
          { ...knownIdentity, extra: true },
          { ...knownIdentity, sourceCommit: "0".repeat(40) },
          { ...knownIdentity, buildId: "e".repeat(64) },
        ])
          assert.throws(() => assertBuildIdentity(bad, knownIdentity));
        assert.throws(() => assertBuildIdentity(knownIdentity));
        assert.throws(() =>
          assertBuildIdentity(knownIdentity, {
            ...knownIdentity,
            buildId: "0".repeat(64),
          }),
        );
      },
    );
    await t.test(
      "measures the two distinct native files and rejects architecture, header, file type, link, and hardlink substitutions",
      async () => {
        const root = await directory();
        await syntheticDistribution(root);
        const first = await inspectNativeArtifact(
          root,
          nativeDistributionFiles[0],
          "arm64",
        );
        const second = await inspectNativeArtifact(
          root,
          nativeDistributionFiles[1],
          "arm64",
        );
        assert.notEqual(first.sha256, second.sha256);
        assert.equal(first.path, "dist/native/aac-protection.node");
        assert.equal(second.path, "dist/native/durable-record.node");
        for (const [bytes, architecture] of [
          [Buffer.alloc(31), "arm64"],
          [Buffer.alloc(32), "arm64"],
          [machO("x64"), "arm64"],
          [machO("arm64", 2), "arm64"],
          [machO(), "universal"],
        ])
          assert.throws(() => inspectMachOHeader(bytes, architecture));
        assert.equal(inspectMachOHeader(machO("x64"), "x64"), "x64");
        const native = path.join(root, nativeDistributionFiles[0]);
        await fs.link(native, path.join(root, "alias.node"));
        await assert.rejects(
          inspectNativeArtifact(root, nativeDistributionFiles[0], "arm64"),
          /hardlinked/,
        );
        await fs.unlink(path.join(root, "alias.node"));
        await fs.rename(native, path.join(root, "retained.node"));
        await fs.symlink("../retained.node", native);
        await assert.rejects(
          inspectNativeArtifact(root, nativeDistributionFiles[0], "arm64"),
          /regular file/,
        );
      },
    );
    await t.test(
      "rejects missing, extra, symlinked, and wrong-identity distribution assets",
      async () => {
        const root = await directory();
        const original = await syntheticDistribution(root);
        assert.equal(original.files.length, 11);
        await write(root, "extra.map", "extra");
        await assert.rejects(
          inspectDesktopDistribution({
            distributionRoot: root,
            platform: "darwin",
            architecture: "arm64",
            expectedBuildIdentity: knownIdentity,
          }),
          /reviewed runtime assets/,
        );
        await fs.unlink(path.join(root, "extra.map"));
        await fs.writeFile(path.join(root, "build-identity.json"), "null\n");
        await assert.rejects(
          inspectDesktopDistribution({
            distributionRoot: root,
            platform: "darwin",
            architecture: "arm64",
            expectedBuildIdentity: knownIdentity,
          }),
          /identity is invalid/,
        );
        await fs.writeFile(
          path.join(root, "build-identity.json"),
          `${JSON.stringify(knownIdentity)}\n`,
        );
        await fs.rename(
          path.join(root, "renderer.js"),
          path.join(root, "retained.js"),
        );
        await fs.symlink("retained.js", path.join(root, "renderer.js"));
        await assert.rejects(
          inspectDesktopDistribution({
            distributionRoot: root,
            platform: "darwin",
            architecture: "arm64",
            expectedBuildIdentity: knownIdentity,
          }),
          /symlinks/,
        );
      },
    );
    await t.test(
      "requires the identity asset for Linux and forbids both native addons",
      async () => {
        const root = await directory();
        await syntheticDistribution(root, null, "linux");
        await write(root, nativeDistributionFiles[1], machO());
        await assert.rejects(
          inspectDesktopDistribution({
            distributionRoot: root,
            platform: "linux",
            architecture: "arm64",
          }),
          /reviewed runtime assets/,
        );
        await fs.unlink(path.join(root, nativeDistributionFiles[1]));
        await fs.rmdir(path.join(root, "native"));
        await fs.unlink(path.join(root, "build-identity.json"));
        await assert.rejects(
          inspectDesktopDistribution({
            distributionRoot: root,
            platform: "linux",
            architecture: "arm64",
          }),
          /reviewed runtime assets/,
        );
      },
    );
    await t.test(
      "records contained framework symlinks deterministically without duplicating their target bytes",
      async () => {
        const root = await directory();
        await write(
          root,
          "Framework/Versions/A/Framework",
          "synthetic framework",
        );
        await fs.symlink("A", path.join(root, "Framework/Versions/Current"));
        await fs.symlink(
          "Versions/Current/Framework",
          path.join(root, "Framework/Framework"),
        );
        const tree = await inspectArtifactTree(root);
        assert.equal(
          tree.entries.filter((entry) => entry.type === "file").length,
          1,
        );
        assert.equal(
          tree.entries.filter((entry) => entry.type === "symlink").length,
          2,
        );
        assert.equal(tree.sha256, hash(JSON.stringify(tree.entries)));
        assert.deepEqual(await inspectArtifactTree(root), tree);
        await fs.writeFile(
          path.join(root, "Framework/Versions/A/Framework"),
          "changed",
        );
        assert.notEqual((await inspectArtifactTree(root)).sha256, tree.sha256);
      },
    );
    await t.test(
      "rejects escaping, absolute, broken, circular, and hardlinked tree entries",
      async () => {
        for (const target of ["../outside", "/tmp", "missing", "link"]) {
          const root = await directory();
          await fs.symlink(target, path.join(root, "link"));
          await assert.rejects(inspectArtifactTree(root));
        }
        const root = await directory();
        const source = await write(root, "one", "synthetic");
        await fs.link(source, path.join(root, "two"));
        await assert.rejects(inspectArtifactTree(root), /hardlinked/);
      },
    );
    await t.test(
      "matches all packaged bytes, native headers, app-tree entries and observed fuse values without launching",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        const result = await inspectPackagedDesktop(options);
        assert.deepEqual(result.nativeArtifacts, distribution.nativeArtifacts);
        assert.deepEqual(result.buildIdentity, knownIdentity);
        assert.deepEqual(result.fuses, disabledFuses);
        assert.equal(result.packageVersion, "2.0.0");
        assert.equal(result.measurements.infoPlist.path, "Contents/Info.plist");
        assert.equal(result.measurements.executable.bytes, 32);
        assert.equal(packageCalls, 0);
        assert.equal(hardenCalls, 0);
      },
    );
    await t.test(
      "accepts the pinned public packager sanitizer's exact final manifest",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        const expected = JSON.parse(archiveContents.get("package.json"));
        const staged = { ...expected, private: true };
        const sanitized = defaultSanitizePackageJson({ ...staged });
        assert.deepEqual(Object.keys(sanitized).sort(), [
          "main",
          "name",
          "productName",
          "type",
          "version",
        ]);
        assert.deepEqual(sanitized, expected);
        assert.equal(staged.private, true);
        const metadata = Buffer.from(JSON.stringify(sanitized));
        archiveEntries.set("package.json", { size: metadata.length });
        archiveContents.set("package.json", metadata);
        assert.equal(
          (await inspectPackagedDesktop(options)).packageVersion,
          "2.0.0",
        );
        assert.equal(packageCalls, 0);
        assert.equal(hardenCalls, 0);
      },
    );
    await t.test(
      "rejects extra, missing and changed final manifest fields",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        const expected = JSON.parse(archiveContents.get("package.json"));
        const setMetadata = (value) => {
          const metadata = Buffer.from(JSON.stringify(value));
          archiveEntries.set("package.json", { size: metadata.length });
          archiveContents.set("package.json", metadata);
        };
        await inspectPackagedDesktop(options);
        const invalid = [
          { ...expected, private: true },
          { ...expected, private: false },
          { ...expected, unexpected: "field" },
          ...Object.keys(expected).map((key) => {
            const missing = { ...expected };
            delete missing[key];
            return missing;
          }),
          ...Object.keys(expected).map((key) => ({
            ...expected,
            [key]: "invalid",
          })),
        ];
        for (const value of invalid) {
          setMetadata(value);
          await assert.rejects(inspectPackagedDesktop(options), {
            code: "ERR_ASSERTION",
          });
        }
        setMetadata(expected);
        await inspectPackagedDesktop(options);
      },
    );
    await t.test(
      "rejects a substituted bundle directory before reading ASAR data",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        const retained = path.join(
          options.packageDirectory,
          "retained-contents",
        );
        await fs.rename(path.join(options.appBundle, "Contents"), retained);
        await fs.symlink(
          "../retained-contents",
          path.join(options.appBundle, "Contents"),
        );
        await assert.rejects(
          inspectPackagedDesktop(options),
          /ancestry must not contain symlinks/,
        );
      },
    );
    await t.test(
      "inspects non-Mac inventory with no native or unpacked entries",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(
          distributionRoot,
          null,
          "linux",
        );
        const packageDirectory = await directory();
        const resources = path.join(packageDirectory, "resources");
        await write(
          packageDirectory,
          "desmoslock-internal",
          "synthetic ELF bytes",
          0o700,
        );
        await write(resources, "app.asar", "synthetic archive");
        archiveEntries = new Map([
          ["dist", { files: {} }],
          ["dist/calculator", { files: {} }],
        ]);
        archiveContents = new Map();
        for (const file of distribution.files) {
          const contents = await fs.readFile(
            path.join(distributionRoot, file.path),
          );
          archiveEntries.set(`dist/${file.path}`, { size: contents.length });
          archiveContents.set(`dist/${file.path}`, contents);
        }
        const metadata = Buffer.from(
          JSON.stringify({
            main: "dist/main.js",
            name: "desmoslock-internal",
            productName: "DesmosLock Internal",
            type: "module",
            version: "2.0.0",
          }),
        );
        archiveEntries.set("package.json", { size: metadata.length });
        archiveContents.set("package.json", metadata);
        fuseResult = disabledFuses;
        const options = {
          packageDirectory,
          distribution,
          platform: "linux",
          architecture: "x64",
        };
        const result = await inspectPackagedDesktop(options);
        assert.deepEqual(result.nativeArtifacts, []);
        assert.equal(result.measurements.infoPlist, null);
        assert.equal(result.buildIdentity, null);
        await fs.mkdir(path.join(resources, "app.asar.unpacked"));
        await assert.rejects(
          inspectPackagedDesktop(options),
          /must not contain unpacked assets/,
        );
      },
    );
    await t.test(
      "rejects changed runtime bytes and a swapped embedded identity",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        const original = archiveContents.get("dist/main.js");
        archiveContents.set("dist/main.js", Buffer.from("changed runtime"));
        await assert.rejects(
          inspectPackagedDesktop(options),
          /runtime bytes differ/,
        );
        archiveContents.set("dist/main.js", original);
        archiveContents.set(
          "dist/build-identity.json",
          Buffer.from(
            `${JSON.stringify({ ...knownIdentity, sourceCommit: "e".repeat(40) })}\n`,
          ),
        );
        await assert.rejects(
          inspectPackagedDesktop({ ...options, distribution: undefined }),
          /differs from the selected candidate/,
        );
      },
    );
    await t.test(
      "rejects native copy/hash swaps and missing ASAR unpack flags",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        archiveEntries.get("dist/native/aac-protection.node").unpacked = false;
        await assert.rejects(
          inspectPackagedDesktop(options),
          /two native artifacts/,
        );
        archiveEntries.get("dist/native/aac-protection.node").unpacked = true;
        await fs.copyFile(
          path.join(
            options.resources,
            "app.asar.unpacked/dist/native/durable-record.node",
          ),
          path.join(
            options.resources,
            "app.asar.unpacked/dist/native/aac-protection.node",
          ),
        );
        await assert.rejects(
          inspectPackagedDesktop(options),
          /runtime bytes differ/,
        );
      },
    );
    await t.test(
      "rejects extra or linked ASAR/unpacked entries and enabled fuses",
      async () => {
        const distributionRoot = await directory();
        const distribution = await syntheticDistribution(distributionRoot);
        const options = await syntheticPackage(
          await directory(),
          distributionRoot,
          distribution,
        );
        archiveEntries.set("unexpected.js", { size: 1 });
        await assert.rejects(
          inspectPackagedDesktop(options),
          /ASAR inventory differs/,
        );
        archiveEntries.delete("unexpected.js");
        archiveEntries.set("dist/main.js", { link: "dist/preload.cjs" });
        await assert.rejects(
          inspectPackagedDesktop(options),
          /must not contain links/,
        );
        archiveEntries.set("dist/main.js", { size: 1 });
        await write(options.resources, "app.asar.unpacked/extra.node", machO());
        await assert.rejects(inspectPackagedDesktop(options));
        await fs.unlink(
          path.join(options.resources, "app.asar.unpacked/extra.node"),
        );
        fuseResult = { ...disabledFuses, RunAsNode: "ENABLE" };
        await assert.rejects(inspectPackagedDesktop(options));
      },
    );
    await t.test(
      "selects only the exact declared verified archive and rejects substitutions without downloads",
      async () => {
        const root = await directory();
        const zipRoot = path.join(root, "archive");
        const bytes = Buffer.from("synthetic archive checksum fixture");
        const filename = "electron-v44.10.0-linux-x64.zip";
        await write(
          root,
          "node_modules/electron/checksums.json",
          JSON.stringify({ [filename]: hash(bytes) }),
        );
        const archive = await write(zipRoot, filename, bytes);
        const options = {
          repositoryRoot: root,
          electronVersion: "44.10.0",
          platform: "linux",
          architecture: "x64",
          directory: zipRoot,
        };
        await assert.rejects(
          selectExistingElectronArchive({
            ...options,
            electronVersion: "43.4.1",
          }),
          /requires the reviewed Electron version/,
        );
        assert.deepEqual(await selectExistingElectronArchive(options), {
          directory: zipRoot,
          filename,
          bytes: bytes.length,
          sha256: hash(bytes),
        });
        await fs.writeFile(archive, "swapped archive");
        await assert.rejects(
          selectExistingElectronArchive(options),
          /does not match/,
        );
        await fs.unlink(archive);
        await assert.rejects(
          selectExistingElectronArchive(options),
          /will not download or search/,
        );
        await fs.symlink("missing", archive);
        await assert.rejects(
          selectExistingElectronArchive(options),
          /regular archive/,
        );
      },
    );
    await t.test(
      "rejects cross-platform packaging and version disagreement before the packager runs",
      async () => {
        await assert.rejects(
          packageUnsignedDesktop({ platform: "unsupported" }),
          /current host platform/,
        );
        const root = await directory();
        await write(
          root,
          "package.json",
          JSON.stringify({ name: "desmoslock", version: "2.0.1" }),
        );
        await write(
          root,
          "apps/desktop/package.json",
          JSON.stringify({ name: "@desmoslock/desktop", version: "2.0.0" }),
        );
        await write(
          root,
          "package-lock.json",
          JSON.stringify({ lockfileVersion: 3 }),
        );
        await assert.rejects(
          packageUnsignedDesktop({ repositoryRoot: root }),
          /versions differ/,
        );
        assert.equal(packageCalls, 0);
        assert.equal(hardenCalls, 0);
      },
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    delete globalThis[stateKey];
  }
});
