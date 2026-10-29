import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import plist from "plist";

const helperUrl = new URL("../../scripts/desktop-artifact.mjs", import.meta.url)
  .href;
const fusePolicyUrl = new URL(
  "../../scripts/electron-fuse-policy.mjs",
  import.meta.url,
).href;
const identitySource = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactRecordSource = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const stateKey = Symbol.for("desmoslock.universal-artifact.synthetic-test");
const architectures = ["arm64", "x64"];
const disabledFuses = Object.freeze({
  EnableNodeCliInspectArguments: "DISABLE",
  EnableNodeOptionsEnvironmentVariable: "DISABLE",
  RunAsNode: "DISABLE",
});
const frameworkPath =
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework";
const helperPath =
  "Contents/Frameworks/DesmosLock Internal Helper.app/Contents/MacOS/DesmosLock Internal Helper";
const snapshotPaths = {
  arm64:
    "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.arm64.bin",
  x64: "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.x86_64.bin",
};
const headerString = '{"files":{"synthetic":{"size":1,"offset":"0"}}}';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const headerHash = hash(headerString);
const integrityDigest = Buffer.from(
  hash(`Resources/app.asarSHA256${headerHash}`),
  "hex",
);
const knownIdentity = Object.freeze({
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  packageLockSha256: "c".repeat(64),
  buildId: "d".repeat(64),
});
let activeFixture;
const asars = new Map();
const fixtureUid = process.getuid();
const state = {
  process: {
    platform: "darwin",
    arch: "arm64",
    env: Object.freeze({}),
    getuid: () => fixtureUid,
  },
  fs: {
    ...fs,
    async open(destination, flags, mode) {
      const handle = await fs.open(destination, flags, mode);
      const current = activeFixture;
      if (typeof flags !== "number" || (flags & constants.O_CREAT) === 0)
        return handle;
      const architecture = architectures.find(
        (value) =>
          destination ===
          path.join(
            current.temporaryRoot,
            "electron-packager",
            `tmp-synthetic-${value}`,
            "Electron.app/Contents/Resources/app/dist/native/aac-protection.node",
          ),
      );
      const firstStageFile =
        destination ===
        path.join(current.stageRoot, "dist/build-identity.json");
      if (!architecture && !firstStageFile) return handle;
      assert.notEqual(flags & constants.O_NOFOLLOW, 0);
      assert.notEqual(flags & constants.O_EXCL, 0);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile")
            return async (...args) => {
              if (architecture && current.copyBarrier) {
                current.copyEntrants.add(architecture);
                if (current.copyEntrants.size === 2)
                  current.releaseBothCopies();
                await current.copyBarrier;
                if (architecture === "x64") await current.arm64Completed;
              }
              const result = await target.writeFile(...args);
              if (
                !current.substitutionTriggered &&
                ((current.substitution === "stage" && firstStageFile) ||
                  (current.substitution === "hook" && architecture === "arm64"))
              ) {
                const directory = firstStageFile
                  ? path.dirname(destination)
                  : path.dirname(path.dirname(destination));
                const preserved = `${directory}-before-substitution`;
                await fs.rename(directory, preserved);
                await fs.symlink(current.substitutionTarget, directory);
                current.substitutionTriggered = true;
                current.substitutedDirectory = directory;
                current.preservedDirectory = preserved;
                current.preservedFile = path.join(
                  preserved,
                  path.relative(directory, destination),
                );
              }
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  },
  statFile(archive, filename, followLinks) {
    assert.equal(followLinks, false);
    const entry = asars.get(archive)?.entries.get(filename);
    assert.ok(entry, `Missing synthetic ASAR entry ${filename}`);
    return entry;
  },
  listPackage(archive) {
    assert.ok(asars.has(archive), "Unexpected synthetic ASAR path");
    return [...asars.get(archive).entries.keys()].map((name) => `/${name}`);
  },
  extractFile(archive, filename, followLinks) {
    assert.equal(followLinks, false);
    const bytes = asars.get(archive)?.contents.get(filename);
    assert.ok(bytes !== undefined, `Missing synthetic ASAR bytes ${filename}`);
    return typeof bytes === "function" ? bytes() : bytes;
  },
  getRawHeader(archive) {
    assert.ok(asars.has(archive), "Unexpected synthetic ASAR header path");
    return { headerString };
  },
  uncache() {},
  packager: (...args) => mockPackager(...args),
  hardenPackagedElectron: (...args) => mockHarden(...args),
  async verifyPackagedElectronFuses(filename) {
    const bytes = await fs.readFile(filename);
    const architecture = bytes.readUInt32LE(4) === 0x0100000c ? "arm64" : "x64";
    activeFixture.fuseReads.push(architecture);
    assert.equal(path.basename(filename), `framework-${architecture}.bin`);
    return activeFixture.badFuse === architecture
      ? { ...disabledFuses, RunAsNode: "ENABLE" }
      : { ...disabledFuses };
  },
};
globalThis[stateKey] = state;
const moduleSource = (names) =>
  `const state = globalThis[Symbol.for("desmoslock.universal-artifact.synthetic-test")];\n${names.map((name) => `export const ${name} = (...args) => state.${name}(...args);`).join("\n")}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL === fusePolicyUrl &&
      specifier === "@electron/fuses"
    ) {
      const source = `export const FuseVersion = { V1: "1" };
export const FuseV1Options = { RunAsNode: 0, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3 };
export const FuseState = { DISABLE: 48, ENABLE: 49 };
export function flipFuses() { throw new Error("Actual fuse mutation is forbidden in source tests"); }
export function getCurrentFuseWire() { throw new Error("Actual fuse wire reads are forbidden in source tests"); }`;
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(source)}`,
      };
    }
    if (context.parentURL === helperUrl) {
      if (specifier === "node:fs/promises")
        return {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent('export default globalThis[Symbol.for("desmoslock.universal-artifact.synthetic-test")].fs;')}`,
        };
      if (specifier === "../packages/contracts/dist/build-identity.js")
        return nextResolve(identitySource, context);
      const names =
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
      if (names !== null)
        return {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent(moduleSource(names))}`,
        };
    }
    if (
      context.parentURL === identitySource &&
      specifier === "./exact-record.js"
    )
      return nextResolve(exactRecordSource, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== helperUrl) return loaded;
    return {
      ...loaded,
      source: `const process = globalThis[Symbol.for("desmoslock.universal-artifact.synthetic-test")].process;\n${loaded.source}`,
    };
  },
});
const {
  expectedDesktopDistributionFiles,
  desktopPackagePaths,
  inspectDesktopCommon,
  inspectUniversalDesktop,
  nativeDistributionFiles,
  packageUnsignedUniversalDesktop,
} = await import(helperUrl);
const { createElectronFusePolicy } = await import(fusePolicyUrl);
hooks.deregister();

function thin(architecture, fileType, tail = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(32 + Buffer.byteLength(tail));
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(fileType, 12);
  Buffer.from(tail).copy(bytes, 32);
  return bytes;
}

// This builder records its own slice offsets; expected observations never call
// the production parser being tested.
function fat(
  slices,
  relativePath,
  { fat64 = false, littleEndian = false } = {},
) {
  const firstOffset = 128;
  const secondOffset =
    Math.ceil((firstOffset + slices.arm64.length + 64) / 128) * 128;
  const bytes = Buffer.alloc(secondOffset + slices.x64.length);
  const u32 = (value, offset) =>
    littleEndian
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset);
  const u64 = (value, offset) =>
    littleEndian
      ? bytes.writeBigUInt64LE(BigInt(value), offset)
      : bytes.writeBigUInt64BE(BigInt(value), offset);
  u32(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  u32(2, 4);
  const observations = {};
  for (const [index, architecture] of architectures.entries()) {
    const offset = index === 0 ? firstOffset : secondOffset;
    const row = 8 + index * (fat64 ? 32 : 20);
    u32(architecture === "arm64" ? 0x0100000c : 0x01000007, row);
    u32(0, row + 4);
    if (fat64) {
      u64(offset, row + 8);
      u64(slices[architecture].length, row + 16);
      u32(7, row + 24);
      u32(0, row + 28);
    } else {
      u32(offset, row + 8);
      u32(slices[architecture].length, row + 12);
      u32(7, row + 16);
    }
    slices[architecture].copy(bytes, offset);
    observations[architecture] = {
      offset,
      bytes: slices[architecture].length,
      sha256: hash(slices[architecture]),
    };
  }
  return {
    bytes,
    observation: {
      path: relativePath,
      sha256: hash(bytes),
      bytes: bytes.length,
      slices: observations,
    },
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, contents } of entries) {
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, filename, contents);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + contents.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

async function write(root, filename, bytes, mode = 0o600) {
  const target = path.join(root, filename);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, bytes, { flag: "wx", mode });
  return target;
}

async function prepareTestParent(repositoryRoot) {
  const validate = async (directory) => {
    const status = await fs.lstat(directory);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Synthetic fixture parent must be a real directory",
    );
    assert.equal(
      await fs.realpath(directory),
      directory,
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

async function fixture(root, { format = {}, packageOnly = false } = {}) {
  const current = {
    root,
    format,
    commonRoot: path.join(root, "common"),
    repositoryRoot: path.join(root, "repository"),
    nativeSlices: {},
    electronArchives: {},
    nativeBytes: {},
    snapshotBytes: {},
    stageRoot: path.join(root, "stage"),
    outputRoot: path.join(root, "output"),
    temporaryRoot: path.join(root, "temporary"),
    fuseReads: [],
    hookCompletions: [],
    packageCalls: 0,
    hardenCalls: 0,
    copyEntrants: new Set(),
    postSealArtifacts: [],
  };
  activeFixture = current;
  for (const filename of expectedDesktopDistributionFiles("linux")) {
    await write(
      current.commonRoot,
      filename,
      filename === "build-identity.json"
        ? `${JSON.stringify(knownIdentity)}\n`
        : `shared synthetic ${filename}\n`,
    );
  }
  current.commonObservation = await inspectDesktopCommon({
    commonRoot: current.commonRoot,
    expectedBuildIdentity: knownIdentity,
  });
  const checksums = {};
  for (const architecture of architectures) {
    const nativeRoot = path.join(root, "slices", architecture, "native");
    current.nativeBytes[architecture] = [];
    const artifacts = [];
    for (const name of nativeDistributionFiles) {
      const bytes = thin(
        architecture,
        8,
        `${architecture}:${name}:compiler-output`,
      );
      await write(nativeRoot, path.basename(name), bytes);
      current.nativeBytes[architecture].push(bytes);
      artifacts.push({
        path: `dist/${name}`,
        architecture,
        sha256: hash(bytes),
        bytes: bytes.length,
      });
    }
    current.nativeSlices[architecture] = { root: nativeRoot, artifacts };
    const snapshot = Buffer.from(`selected-${architecture}-snapshot`);
    current.snapshotBytes[architecture] = snapshot;
    const zip = storedZip([
      { name: snapshotPaths[architecture], contents: snapshot },
    ]);
    const directory = path.join(root, "archives");
    const filename = `electron-v43.8.4-darwin-${architecture}.zip`;
    await write(directory, filename, zip);
    current.electronArchives[architecture] = {
      directory,
      filename,
      sha256: hash(zip),
      bytes: zip.length,
    };
    checksums[filename] = hash(zip);
  }
  await write(
    current.repositoryRoot,
    "package.json",
    JSON.stringify({ name: "desmoslock", version: "2.0.0" }),
  );
  await write(
    current.repositoryRoot,
    "apps/desktop/package.json",
    JSON.stringify({ name: "@desmoslock/desktop", version: "2.0.0" }),
  );
  await write(
    current.repositoryRoot,
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      version: "2.0.0",
      packages: {
        "": { version: "2.0.0" },
        "apps/desktop": { version: "2.0.0" },
      },
    }),
  );
  await write(
    current.repositoryRoot,
    "node_modules/electron/checksums.json",
    JSON.stringify(checksums),
  );
  current.packageDirectory = packageOnly
    ? path.join(current.outputRoot, "DesmosLock Internal-darwin-universal")
    : path.join(root, "packaged");
  if (!packageOnly) {
    await populatePackage(current);
  }
  return current;
}

async function populatePackage(current) {
  current.appBundle = path.join(
    current.packageDirectory,
    "DesmosLock Internal.app",
  );
  current.resources = path.join(current.appBundle, "Contents/Resources");
  const addFat = async (relativePath, fileType, tail = "") => {
    const value = fat(
      Object.fromEntries(
        architectures.map((architecture) => [
          architecture,
          thin(architecture, fileType, tail),
        ]),
      ),
      relativePath,
      current.format,
    );
    await write(
      current.appBundle,
      relativePath,
      value.bytes,
      fileType === 2 ? 0o700 : 0o600,
    );
    return value;
  };
  current.launcher = await addFat(
    "Contents/MacOS/desmoslock-internal",
    2,
    "launcher",
  );
  await addFat(helperPath, 2, "helper");
  const frameworkTail = Buffer.concat([
    Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"),
    Buffer.from([1, 1]),
    integrityDigest,
  ]);
  current.framework = await addFat(frameworkPath, 6, frameworkTail);
  await write(
    current.appBundle,
    "Contents/Info.plist",
    plist.build({
      CFBundleExecutable: "desmoslock-internal",
      CFBundleVersion: "2.0.0",
      CFBundleShortVersionString: "2.0.0",
      ElectronAsarIntegrity: {
        "Resources/app.asar": { algorithm: "SHA256", hash: headerHash },
      },
    }),
  );
  for (const architecture of architectures)
    await write(
      current.appBundle,
      snapshotPaths[architecture].slice("Electron.app/".length),
      current.snapshotBytes[architecture],
    );
  const archive = await write(
    current.resources,
    "app.asar",
    "synthetic merged ASAR bytes\n",
  );
  const data = {
    entries: new Map([
      ["dist", { files: {} }],
      ["dist/calculator", { files: {} }],
      ["dist/native", { files: {} }],
    ]),
    contents: new Map(),
  };
  asars.set(archive, data);
  current.asar = archive;
  current.asarData = data;
  for (const { path: name } of current.commonObservation.files) {
    const bytes = await fs.readFile(path.join(current.commonRoot, name));
    data.entries.set(`dist/${name}`, { size: bytes.length });
    data.contents.set(`dist/${name}`, bytes);
  }
  current.preFuseNativeArtifacts = [];
  current.nativeFat = [];
  for (const [index, name] of nativeDistributionFiles.entries()) {
    const relativePath = `dist/${name}`;
    const value = fat(
      {
        arm64: current.nativeBytes.arm64[index],
        x64: current.nativeBytes.x64[index],
      },
      relativePath,
      current.format,
    );
    current.preFuseNativeArtifacts.push(value.observation);
    current.nativeFat.push(value);
    const nativePath = await write(
      current.resources,
      `app.asar.unpacked/${relativePath}`,
      value.bytes,
    );
    data.entries.set(relativePath, {
      size: value.bytes.length,
      unpacked: true,
    });
    data.contents.set(relativePath, () => readFileSync(nativePath));
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
  data.entries.set("package.json", { size: metadata.length });
  data.contents.set("package.json", metadata);
}

function inspectOptions(current) {
  return {
    packageDirectory: current.packageDirectory,
    expectedBuildIdentity: knownIdentity,
    commonObservation: current.commonObservation,
    nativeSliceObservations: current.nativeSlices,
    electronArchiveObservations: current.electronArchives,
    preFuseNativeArtifacts: current.preFuseNativeArtifacts,
    temporaryRoot: current.temporaryRoot,
  };
}

function packageOptions(current) {
  return {
    repositoryRoot: current.repositoryRoot,
    commonRoot: current.commonRoot,
    nativeSlices: current.nativeSlices,
    electronArchives: current.electronArchives,
    stageRoot: current.stageRoot,
    outputRoot: current.outputRoot,
    temporaryRoot: current.temporaryRoot,
    electronVersion: "43.8.4",
    expectedBuildIdentity: knownIdentity,
  };
}

async function replaceSyntheticArchive(current, architecture, bytes) {
  const original = current.electronArchives[architecture];
  await fs.writeFile(path.join(original.directory, original.filename), bytes);
  // The retained outer measurement deliberately matches these synthetic bytes,
  // so a rejection must come from the archive parser or snapshot provenance.
  current.electronArchives[architecture] = {
    ...original,
    sha256: hash(bytes),
    bytes: bytes.length,
  };
}

async function mockPackager(options) {
  const current = activeFixture;
  current.packageCalls += 1;
  assert.equal(options.arch, "universal");
  assert.equal(options.platform, "darwin");
  assert.equal(options.electronVersion, "43.8.4");
  assert.equal(
    options.electronZipDir,
    current.electronArchives.arm64.directory,
  );
  assert.deepEqual(options.asar, {
    unpack: "{aac-protection,durable-record}.node",
  });
  assert.deepEqual(options.osxUniversal, { mergeASARs: true });
  for (const key of ["osxSign", "overwrite", "prune"])
    assert.equal(options[key], false);
  assert.equal(options.dir, current.stageRoot);
  assert.equal(options.out, current.outputRoot);
  assert.equal(options.tmpdir, current.temporaryRoot);
  assert.equal(options.afterCopy.length, 1);
  if (current.hookFailure) {
    const buildPath =
      current.hookFailure === "foreign"
        ? path.join(
            current.root,
            "foreign",
            "Electron.app/Contents/Resources/app",
          )
        : path.join(
            current.temporaryRoot,
            "electron-packager",
            "tmp-synthetic-arm64",
            "Electron.app/Contents/Resources/app",
          );
    await fs.mkdir(path.dirname(buildPath), { recursive: true, mode: 0o700 });
    await fs.cp(current.stageRoot, buildPath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const hook = {
      buildPath,
      electronVersion: "43.8.4",
      platform: "darwin",
      arch: "arm64",
    };
    if (current.hookFailure === "extra-object") hook.unexpected = true;
    await options.afterCopy[0](hook);
    if (current.hookFailure === "duplicate")
      await options.afterCopy[0]({ ...hook });
    return [current.packageDirectory];
  }
  let releaseX64;
  current.arm64Completed = new Promise((resolve) => {
    releaseX64 = resolve;
  });
  current.copyBarrier = new Promise((resolve) => {
    current.releaseBothCopies = resolve;
  });
  const runHook = async (architecture) => {
    const buildPath = path.join(
      current.temporaryRoot,
      "electron-packager",
      `tmp-synthetic-${architecture}`,
      "Electron.app/Contents/Resources/app",
    );
    await fs.mkdir(path.dirname(buildPath), { recursive: true, mode: 0o700 });
    await fs.cp(current.stageRoot, buildPath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    try {
      await options.afterCopy[0]({
        buildPath,
        electronVersion: "43.8.4",
        platform: "darwin",
        arch: architecture,
      });
      current.hookCompletions.push(architecture);
      for (const [index, name] of nativeDistributionFiles.entries())
        assert.deepEqual(
          await fs.readFile(path.join(buildPath, "dist", name)),
          current.nativeBytes[architecture][index],
        );
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(
            path.join(buildPath, "dist/build-identity.json"),
            "utf8",
          ),
        ),
        knownIdentity,
      );
    } finally {
      current.releaseBothCopies();
      if (architecture === "arm64") releaseX64();
    }
  };
  await Promise.all([runHook("x64"), runHook("arm64")]);
  await populatePackage(current);
  return [current.packageDirectory];
}

async function mockHarden(executable, platform, architecture) {
  const current = activeFixture;
  current.hardenCalls += 1;
  assert.equal(
    executable,
    path.join(current.appBundle, "Contents/MacOS/desmoslock-internal"),
  );
  assert.equal(platform, "darwin");
  assert.equal(architecture, "universal");
  if (!current.changeOnSeal) return;
  for (const [index, name] of nativeDistributionFiles.entries()) {
    const final = fat(
      Object.fromEntries(
        architectures.map((target) => [
          target,
          Buffer.concat([
            current.nativeBytes[target][index],
            Buffer.from(`:local-seal-${target}`),
          ]),
        ]),
      ),
      `dist/${name}`,
      current.format,
    );
    await fs.writeFile(
      path.join(current.resources, "app.asar.unpacked/dist", name),
      final.bytes,
    );
    current.postSealArtifacts.push(final.observation);
  }
}

await test("universal composition uses synthetic files and mocked packager, ASAR and fuse APIs", async (t) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temporaryRoot = await fs.mkdtemp(
    path.join(
      await prepareTestParent(path.resolve(repositoryRoot)),
      "universal-composition-",
    ),
  );
  let sequence = 0;
  const make = async (options) => {
    const root = path.join(temporaryRoot, String(sequence++));
    await fs.mkdir(root, { mode: 0o700 });
    return fixture(root, options);
  };
  try {
    for (const architecture of ["arm64", "universal", "x64"]) {
      await t.test(
        `pure ${architecture} fuse policy preserves the required local signing condition`,
        () => {
          assert.deepEqual(createElectronFusePolicy("darwin", architecture), {
            version: "1",
            0: false,
            2: false,
            3: false,
            ...(architecture === "x64"
              ? {}
              : { resetAdHocDarwinSignature: true }),
          });
          assert.deepEqual(createElectronFusePolicy("linux", architecture), {
            version: "1",
            0: false,
            2: false,
            3: false,
          });
        },
      );
    }
    for (const [name, inspect] of [
      ["inspectDesktopCommon", inspectDesktopCommon],
      ["packageUnsignedUniversalDesktop", packageUnsignedUniversalDesktop],
      ["inspectUniversalDesktop", inspectUniversalDesktop],
    ]) {
      for (const [identityCase, options] of [
        ["omitted", {}],
        ["explicit null", { expectedBuildIdentity: null }],
      ]) {
        await t.test(
          `${name} rejects ${identityCase} identity before reads or mutations`,
          async () => {
            activeFixture = { packageCalls: 0, hardenCalls: 0 };
            await assert.rejects(
              inspect(options),
              /Universal artifacts require a selected build identity/,
            );
            assert.equal(activeFixture.packageCalls, 0);
            assert.equal(activeFixture.hardenCalls, 0);
          },
        );
      }
    }
    await t.test(
      "validates packaged executable mode without requesting sandbox execution authority",
      async () => {
        const current = await make();
        const previousAccess = state.fs.access;
        let executableAccessAttempts = 0;
        state.fs.access = async (filename, mode) => {
          if (mode === constants.X_OK) {
            executableAccessAttempts += 1;
            const error = new Error(
              `Synthetic sandbox denied executable access: ${filename}`,
            );
            error.code = "EPERM";
            throw error;
          }
          return fs.access(filename, mode);
        };
        try {
          const paths = await desktopPackagePaths(
            current.packageDirectory,
            "darwin",
          );
          assert.equal(
            paths.executable,
            path.join(current.appBundle, "Contents/MacOS/desmoslock-internal"),
          );
          assert.equal(executableAccessAttempts, 0);

          await fs.chmod(paths.executable, 0o600);
          await assert.rejects(
            desktopPackagePaths(current.packageDirectory, "darwin"),
            /Packaged executable must have an executable mode bit/,
          );
        } finally {
          state.fs.access = previousAccess;
        }
      },
    );
    await t.test(
      "common inventory is exactly nine production files with one identity",
      async () => {
        const current = await make();
        assert.equal(current.commonObservation.files.length, 9);
        assert.deepEqual(
          current.commonObservation.buildIdentity,
          knownIdentity,
        );
        await write(current.commonRoot, "unexpected.js", "extra");
        await assert.rejects(
          inspectDesktopCommon({
            commonRoot: current.commonRoot,
            expectedBuildIdentity: knownIdentity,
          }),
        );
      },
    );

    for (const fat64 of [false, true])
      for (const littleEndian of [false, true]) {
        await t.test(
          `accepts both slices in fat${fat64 ? 64 : 32} ${littleEndian ? "little" : "big"} endian tables`,
          async () => {
            const current = await make({ format: { fat64, littleEndian } });
            const result = await inspectUniversalDesktop(
              inspectOptions(current),
            );
            assert.equal(result.kind, "unsigned-universal-app-inventory");
            assert.equal(result.architecture, "universal");
            assert.deepEqual(result.buildIdentity, knownIdentity);
            assert.deepEqual(
              result.nativeArtifacts,
              current.preFuseNativeArtifacts,
            );
            assert.deepEqual(
              result.composition.preFuseNativeArtifacts,
              current.preFuseNativeArtifacts,
            );
            assert.deepEqual(result.fuses, {
              arm64: disabledFuses,
              x64: disabledFuses,
            });
            assert.deepEqual(current.fuseReads, architectures);
            assert.equal(result.composition.machOFiles.length, 5);
            for (const architecture of architectures) {
              assert.equal(
                result.composition.snapshotResources[architecture].length,
                1,
              );
              assert.equal(
                result.composition.snapshotResources[architecture][0]
                  .archivePath,
                snapshotPaths[architecture],
              );
              assert.deepEqual(result.composition.integrity[architecture], {
                algorithm: "SHA256",
                expectedDigest: integrityDigest.toString("hex"),
                observedDigest: integrityDigest.toString("hex"),
              });
            }
          },
        );
      }

    const fatFailures = [
      [
        "truncated table",
        (bytes) => bytes.subarray(0, 30),
        /Truncated fat Mach-O table/,
      ],
      [
        "duplicate architecture",
        (bytes) => {
          bytes.writeUInt32BE(0x0100000c, 28);
          return bytes;
        },
        /Duplicate fat Mach-O architecture/,
      ],
      [
        "out-of-bounds slice",
        (bytes) => {
          bytes.writeUInt32BE(bytes.length, 36);
          return bytes;
        },
        /out of bounds/,
      ],
      [
        "overlapping otherwise valid slices",
        (bytes) => {
          bytes.writeUInt32BE(
            bytes.readUInt32BE(36) - bytes.readUInt32BE(16) + 1,
            20,
          );
          return bytes;
        },
        /Overlapping fat Mach-O slices/,
      ],
      [
        "inner CPU mismatch",
        (bytes) => {
          bytes.writeUInt32LE(0x0100000c, bytes.readUInt32BE(36) + 4);
          return bytes;
        },
        /CPU|architecture/,
      ],
      [
        "misaligned slice",
        (bytes) => {
          bytes.writeUInt32BE(9, 24);
          return bytes;
        },
        /Misaligned fat Mach-O slice/,
      ],
    ];
    for (const [label, mutate, error] of fatFailures) {
      await t.test(`rejects ${label}`, async () => {
        const current = await make();
        await fs.writeFile(
          path.join(current.appBundle, "Contents/MacOS/desmoslock-internal"),
          mutate(Buffer.from(current.launcher.bytes)),
        );
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          error,
        );
      });
    }

    await t.test("rejects a thin-only nested helper", async () => {
      const current = await make();
      await fs.writeFile(
        path.join(current.appBundle, helperPath),
        thin("arm64", 2),
      );
      await assert.rejects(
        inspectUniversalDesktop(inspectOptions(current)),
        /universal/,
      );
    });
    await t.test(
      "requires disabled fuses in the second framework slice",
      async () => {
        const current = await make();
        current.badFuse = "x64";
        await assert.rejects(inspectUniversalDesktop(inspectOptions(current)));
        assert.deepEqual(current.fuseReads, architectures);
      },
    );
    await t.test(
      "rejects the second framework slice's incorrect integrity digest",
      async () => {
        const current = await make();
        const bytes = Buffer.from(current.framework.bytes);
        bytes[current.framework.observation.slices.x64.offset + 32 + 34] ^=
          0xff;
        await fs.writeFile(path.join(current.appBundle, frameworkPath), bytes);
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          /integrity|digest/i,
        );
      },
    );
    await t.test("requires explicit retained pre-fuse history", async () => {
      const current = await make();
      const options = inspectOptions(current);
      delete options.preFuseNativeArtifacts;
      await assert.rejects(inspectUniversalDesktop(options), /Pre-fuse|array/);
    });
    await t.test(
      "rejects retained pre-fuse slices that disagree with compiler outputs",
      async () => {
        const current = await make();
        const options = inspectOptions(current);
        options.preFuseNativeArtifacts = structuredClone(
          current.preFuseNativeArtifacts,
        );
        options.preFuseNativeArtifacts[1].slices.x64.sha256 = "e".repeat(64);
        await assert.rejects(
          inspectUniversalDesktop(options),
          /compiler output/,
        );
      },
    );
    await t.test(
      "rejects common bytes changed in the merged ASAR",
      async () => {
        const current = await make();
        current.asarData.contents.set(
          "dist/main.js",
          Buffer.from("changed shared main"),
        );
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          /Common runtime bytes/,
        );
      },
    );
    await t.test(
      "rejects an extra private field in the sanitized final package metadata",
      async () => {
        const current = await make();
        const metadata = JSON.parse(
          current.asarData.contents.get("package.json").toString("utf8"),
        );
        current.asarData.contents.set(
          "package.json",
          Buffer.from(JSON.stringify({ ...metadata, private: true })),
        );
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          /metadata.*unexpected fields/,
        );
      },
    );
    await t.test("rejects an extra unpacked native file", async () => {
      const current = await make();
      await write(
        current.resources,
        "app.asar.unpacked/dist/native/extra.node",
        thin("arm64", 8),
      );
      await assert.rejects(inspectUniversalDesktop(inspectOptions(current)));
    });
    await t.test(
      "rejects changed compiler output before consuming native observations",
      async () => {
        const current = await make();
        await fs.appendFile(
          path.join(current.nativeSlices.x64.root, "durable-record.node"),
          "changed",
        );
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          /Compiler output/,
        );
      },
    );
    await t.test(
      "rejects the superseded Electron minor before packaging or output creation",
      async () => {
        const current = await make({ packageOnly: true });
        const before = await fs.readdir(current.root);
        await assert.rejects(
          packageUnsignedUniversalDesktop({
            ...packageOptions(current),
            electronVersion: "43.4.1",
          }),
          /Universal packaging requires the reviewed Electron version/,
        );
        assert.equal(current.packageCalls, 0);
        assert.equal(current.hardenCalls, 0);
        assert.deepEqual(await fs.readdir(current.root), before);
        for (const directory of [
          current.stageRoot,
          current.outputRoot,
          current.temporaryRoot,
        ])
          await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
      },
    );
    await t.test(
      "rejects a synthetic Linux host before entering packaging, hardening or output creation",
      async () => {
        const current = await make({ packageOnly: true });
        const before = await fs.readdir(current.root);
        const actualHost = process.platform;
        const previousPlatform = state.process.platform;
        const previousMkdir = state.fs.mkdir;
        let outputEntries = 0;
        state.process.platform = "linux";
        state.fs.mkdir = async () => {
          outputEntries += 1;
          throw new Error("Unexpected synthetic Linux output creation");
        };
        try {
          await assert.rejects(
            packageUnsignedUniversalDesktop(packageOptions(current)),
            /Universal packaging requires macOS/,
          );
          assert.equal(current.packageCalls, 0);
          assert.equal(current.hardenCalls, 0);
          assert.equal(outputEntries, 0);
          assert.deepEqual(await fs.readdir(current.root), before);
          for (const directory of [
            current.stageRoot,
            current.outputRoot,
            current.temporaryRoot,
          ])
            await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
          assert.equal(process.platform, actualHost);
        } finally {
          state.process.platform = previousPlatform;
          state.fs.mkdir = previousMkdir;
        }
      },
    );
    await t.test(
      "packages reversed concurrent hooks with one identity and retains pre-seal native history",
      async () => {
        const current = await make({ packageOnly: true });
        current.changeOnSeal = true;
        const result = await packageUnsignedUniversalDesktop(
          packageOptions(current),
        );
        assert.equal(current.packageCalls, 1);
        assert.equal(current.hardenCalls, 1);
        assert.deepEqual(current.hookCompletions, ["arm64", "x64"]);
        assert.deepEqual(
          [...current.copyEntrants].sort(),
          [...architectures].sort(),
        );
        assert.deepEqual(
          result.composition.preFuseNativeArtifacts,
          current.preFuseNativeArtifacts,
        );
        assert.deepEqual(result.nativeArtifacts, current.postSealArtifacts);
        for (const [index, row] of result.nativeArtifacts.entries())
          for (const architecture of architectures) {
            assert.notEqual(
              row.slices[architecture].sha256,
              current.preFuseNativeArtifacts[index].slices[architecture].sha256,
            );
            assert.equal(
              result.composition.preFuseNativeArtifacts[index].slices[
                architecture
              ].sha256,
              current.nativeSlices[architecture].artifacts[index].sha256,
            );
          }
        assert.deepEqual(
          await fs.readdir(path.join(current.stageRoot, "dist")),
          [
            ...expectedDesktopDistributionFiles("linux")
              .map((name) => name.split("/")[0])
              .filter((name, index, names) => names.indexOf(name) === index),
          ].sort(),
        );
        const retained = JSON.parse(JSON.stringify(result));
        const resumed = await inspectUniversalDesktop({
          packageDirectory: retained.packageDirectory,
          expectedBuildIdentity: retained.buildIdentity,
          commonObservation: retained.composition.common,
          nativeSliceObservations: retained.composition.nativeSlices,
          electronArchiveObservations: retained.composition.electronArchives,
          preFuseNativeArtifacts: retained.composition.preFuseNativeArtifacts,
          temporaryRoot: path.join(current.root, "resume-readback"),
        });
        assert.deepEqual(resumed, retained);
        assert.deepEqual(resumed.tree, result.tree);
        assert.deepEqual(resumed.nativeArtifacts, current.postSealArtifacts);
        assert.deepEqual(
          resumed.composition.preFuseNativeArtifacts,
          current.preFuseNativeArtifacts,
        );
        assert.equal(
          current.packageCalls,
          1,
          "Read-only resume must not package again",
        );
        assert.equal(
          current.hardenCalls,
          1,
          "Read-only resume must not harden again",
        );
      },
    );

    for (const [mode, error] of [
      ["missing", /Both afterCopy architectures must finish/],
      ["duplicate", /Duplicate afterCopy architecture/],
      ["foreign", /Unexpected afterCopy build path/],
      ["extra-object", /Universal afterCopy hook has unexpected fields/],
    ]) {
      await t.test(
        `rejects ${mode} afterCopy hook evidence before hardening`,
        async () => {
          const current = await make({ packageOnly: true });
          current.hookFailure = mode;
          await assert.rejects(
            packageUnsignedUniversalDesktop(packageOptions(current)),
            error,
          );
          assert.equal(current.packageCalls, 1);
          assert.equal(current.hardenCalls, 0);
        },
      );
    }

    for (const location of ["stage", "hook"]) {
      await t.test(
        `rejects ${location} output directory substitution before a later write`,
        async () => {
          const current = await make({ packageOnly: true });
          current.substitution = location;
          current.substitutionTarget = path.join(
            current.root,
            "replacement-target",
          );
          await fs.mkdir(current.substitutionTarget, { mode: 0o700 });
          if (location === "hook") current.hookFailure = "single";
          await assert.rejects(
            packageUnsignedUniversalDesktop(packageOptions(current)),
            /Universal directory fence was substituted/,
          );
          assert.equal(current.substitutionTriggered, true);
          assert.equal(current.packageCalls, location === "stage" ? 0 : 1);
          assert.equal(current.hardenCalls, 0);
          assert.deepEqual(await fs.readdir(current.substitutionTarget), []);
          const preserved = await fs.lstat(current.preservedDirectory);
          assert.equal(preserved.isDirectory(), true);
          assert.equal(preserved.isSymbolicLink(), false);
          assert.equal(
            (await fs.lstat(current.substitutedDirectory)).isSymbolicLink(),
            true,
          );
          assert.equal(
            await fs.readlink(current.substitutedDirectory),
            current.substitutionTarget,
          );
          const expected =
            location === "stage"
              ? Buffer.from(`${JSON.stringify(knownIdentity)}\n`)
              : current.nativeBytes.arm64[0];
          assert.deepEqual(await fs.readFile(current.preservedFile), expected);
        },
      );
    }

    for (const mode of [
      "wrong-path",
      "extra-bin",
      "bad-crc",
      "bad-central-range",
    ]) {
      await t.test(`rejects a synthetic ZIP with ${mode}`, async () => {
        const current = await make();
        const architecture = "x64";
        const entries = [
          {
            name: snapshotPaths[architecture],
            contents: current.snapshotBytes[architecture],
          },
        ];
        if (mode === "wrong-path") entries[0].name = snapshotPaths.arm64;
        if (mode === "extra-bin")
          entries.push({
            name: "Electron.app/Contents/Resources/unreviewed.bin",
            contents: Buffer.from("extra"),
          });
        const bytes = storedZip(entries);
        const end = bytes.length - 22;
        const central = bytes.readUInt32LE(end + 16);
        if (mode === "bad-crc")
          bytes.writeUInt32LE(
            (bytes.readUInt32LE(central + 16) ^ 0xff) >>> 0,
            central + 16,
          );
        if (mode === "bad-central-range")
          bytes.writeUInt32LE(central + 1, end + 16);
        await replaceSyntheticArchive(current, architecture, bytes);
        const error =
          mode === "bad-crc"
            ? /Snapshot ZIP CRC disagrees/
            : mode === "bad-central-range"
              ? /Invalid ZIP central-directory extent/
              : /exactly its reviewed snapshot/;
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          error,
        );
        assert.equal(current.hardenCalls, 0);
        assert.equal(current.packageCalls, 0);
      });
    }
    await t.test(
      "accepts a deflate-compressed snapshot with exact archive provenance",
      async () => {
        const current = await make();
        const contents = current.snapshotBytes.x64;
        const compressed = deflateRawSync(contents);
        const name = Buffer.from(snapshotPaths.x64);
        const checksum = crc32(contents);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(contents.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x0314, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(contents.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(1, 8);
        end.writeUInt16LE(1, 10);
        end.writeUInt32LE(central.length + name.length, 12);
        end.writeUInt32LE(local.length + name.length + compressed.length, 16);
        await replaceSyntheticArchive(
          current,
          "x64",
          Buffer.concat([local, name, compressed, central, name, end]),
        );
        const result = await inspectUniversalDesktop(inspectOptions(current));
        assert.deepEqual(result.composition.snapshotResources.x64, [
          {
            path: snapshotPaths.x64.slice("Electron.app/".length),
            archivePath: snapshotPaths.x64,
            sha256: hash(contents),
            bytes: contents.length,
          },
        ]);
        assert.deepEqual(
          result.composition.electronArchives.x64,
          current.electronArchives.x64,
        );
        assert.equal(current.packageCalls, 0);
        assert.equal(current.hardenCalls, 0);
      },
    );
    await t.test(
      "rejects final snapshot bytes changed from the selected architecture archive",
      async () => {
        const current = await make();
        await fs.appendFile(
          path.join(
            current.appBundle,
            snapshotPaths.x64.slice("Electron.app/".length),
          ),
          "changed",
        );
        await assert.rejects(
          inspectUniversalDesktop(inspectOptions(current)),
          /Final Electron snapshot differs from its architecture ZIP/,
        );
      },
    );
    await t.test("rejects an unreviewed final .bin resource", async () => {
      const current = await make();
      await write(current.resources, "unreviewed.bin", "extra final snapshot");
      await assert.rejects(
        inspectUniversalDesktop(inspectOptions(current)),
        /Additional final .bin resources are forbidden/,
      );
    });
  } finally {
    asars.clear();
    delete globalThis[stateKey];
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
