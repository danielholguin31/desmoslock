import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { packager } from "@electron/packager";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { parseClientBuildIdentity } from "../packages/contracts/dist/build-identity.js";
import {
  hardenPackagedElectron,
  verifyPackagedElectronFuses,
} from "./electron-fuse-policy.mjs";

export const nativeDistributionFiles = Object.freeze([
  "native/aac-protection.node",
  "native/durable-record.node",
]);
export const packagedExecutableName = "desmoslock-internal";
const appName = "DesmosLock Internal";

export function expectedDesktopDistributionFiles(platform = process.platform) {
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Unsupported artifact platform",
  );
  return [
    "build-identity.json",
    "calculator/host.js",
    "calculator/index.html",
    "calculator/styles.css",
    "index.html",
    "main.js",
    ...(platform === "darwin" ? nativeDistributionFiles : []),
    "preload.cjs",
    "renderer.js",
    "styles.css",
  ];
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFile(before, after) {
  for (const key of [
    "dev",
    "ino",
    "mode",
    "nlink",
    "size",
    "mtimeMs",
    "ctimeMs",
  ]) {
    assert.equal(
      after[key],
      before[key],
      "Artifact file changed during inspection",
    );
  }
}

async function measureRegularFile(filename, retainBytes = false) {
  const before = await fs.lstat(filename);
  assert.ok(
    before.isFile() && !before.isSymbolicLink(),
    "Artifact must be a regular file",
  );
  assert.equal(before.nlink, 1, "Artifact must not be hardlinked");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    sameFile(before, await handle.stat());
    const hash = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
      if (retainBytes) chunks.push(chunk);
    }
    assert.equal(bytes, before.size, "Artifact size changed during inspection");
    sameFile(before, await handle.stat());
    sameFile(before, await fs.lstat(filename));
    return {
      sha256: hash.digest("hex"),
      bytes,
      ...(retainBytes ? { contents: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}

function assertContained(root, filename) {
  const relative = path.relative(root, filename);
  assert.ok(
    relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Artifact link escapes the owned tree",
  );
}

async function assertDirectory(root) {
  assert.ok(path.isAbsolute(root), "Artifact root must be absolute");
  assert.equal(root, path.resolve(root), "Artifact root must be normalized");
  let current = path.parse(root).root;
  for (const component of path
    .relative(current, root)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const status = await fs.lstat(current);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Artifact directory ancestry must not contain symlinks",
    );
  }
}

// Resolve only contained components. Never traverse a link outside the tree,
// including an intermediate link whose final target could lead back inside.
async function validateContainedLink(root, relativePath) {
  let pending = relativePath.split("/");
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    const filename = path.resolve(current, component);
    assertContained(root, filename);
    const status = await fs.lstat(filename);
    if (status.isSymbolicLink()) {
      assert.ok(++links <= 40, "Artifact link cycle or excessive indirection");
      const target = await fs.readlink(filename);
      assert.equal(
        path.isAbsolute(target),
        false,
        "Artifact links must be relative",
      );
      const resolved = path.resolve(path.dirname(filename), target);
      assertContained(root, resolved);
      pending = [
        ...path.relative(root, resolved).split(path.sep).filter(Boolean),
        ...pending,
      ];
      current = root;
    } else {
      if (pending.length > 0)
        assert.ok(
          status.isDirectory(),
          "Artifact link parent must be a directory",
        );
      current = filename;
    }
  }
}

export async function inspectArtifactTree(root, { allowSymlinks = true } = {}) {
  await assertDirectory(root);
  const entries = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, relativeDirectory);
    const before = await fs.lstat(directory);
    assert.ok(
      before.isDirectory() && !before.isSymbolicLink(),
      "Artifact directory was substituted",
    );
    const children = await fs.readdir(directory);
    for (const name of children.sort()) {
      const relativePath = path.posix.join(relativeDirectory, name);
      const filename = path.join(root, relativePath);
      const status = await fs.lstat(filename);
      const mode = status.mode & 0o777;
      if (status.isSymbolicLink()) {
        assert.ok(allowSymlinks, "Artifact inventory does not allow symlinks");
        const target = await fs.readlink(filename);
        await validateContainedLink(root, relativePath);
        sameFile(status, await fs.lstat(filename));
        entries.push({ path: relativePath, type: "symlink", mode, target });
      } else if (status.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        await visit(relativePath);
      } else {
        entries.push({
          path: relativePath,
          type: "file",
          mode,
          ...(await measureRegularFile(filename)),
        });
      }
    }
    sameFile(before, await fs.lstat(directory));
  }
  await visit("");
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

export function assertBuildIdentity(value, expected = null) {
  if (expected === null) {
    assert.equal(
      value,
      null,
      "Ordinary development artifact must have null build identity",
    );
    return null;
  }
  const parsedExpected = parseClientBuildIdentity(expected);
  const parsedValue = parseClientBuildIdentity(value);
  assert.notEqual(parsedExpected, null, "Candidate build identity is invalid");
  assert.notEqual(parsedValue, null, "Embedded build identity is invalid");
  assert.deepEqual(
    value,
    expected,
    "Embedded artifact build identity differs from the selected candidate",
  );
  return parsedValue;
}

function inspectBuildIdentityAsset(bytes, expectedBuildIdentity) {
  assert.ok(bytes.length <= 2048, "Build identity asset is oversized");
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  assert.equal(
    text,
    `${JSON.stringify(value)}\n`,
    "Build identity asset must be compact JSON plus one newline",
  );
  return assertBuildIdentity(value, expectedBuildIdentity);
}

export function inspectMachOHeader(bytes, architecture, fileType = 8) {
  assert.ok(
    bytes.length >= 32,
    "Native artifact must contain a Mach-O64 header",
  );
  assert.equal(
    bytes.readUInt32LE(0),
    0xfeedfacf,
    "Native artifact must be little-endian Mach-O64",
  );
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Native artifact architecture is unsupported",
  );
  assert.equal(
    bytes.readUInt32LE(4),
    architecture === "arm64" ? 0x0100000c : 0x01000007,
    "Native artifact CPU must match the selected runtime",
  );
  assert.equal(
    bytes.readUInt32LE(12),
    fileType,
    "Native artifact has an unexpected Mach-O file type",
  );
  return architecture;
}

export async function inspectNativeArtifact(
  root,
  relativePath,
  architecture = process.arch,
) {
  assert.ok(nativeDistributionFiles.includes(relativePath));
  await assertDirectory(root);
  await assertDirectory(path.join(root, "native"));
  const { contents, ...measurement } = await measureRegularFile(
    path.join(root, relativePath),
    true,
  );
  inspectMachOHeader(contents, architecture);
  return { path: `dist/${relativePath}`, architecture, ...measurement };
}

export async function inspectDesktopDistribution({
  distributionRoot,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Artifact architecture is unsupported",
  );
  const tree = await inspectArtifactTree(distributionRoot, {
    allowSymlinks: false,
  });
  const files = tree.entries.filter((entry) => entry.type === "file");
  assert.deepEqual(
    files.map((entry) => entry.path),
    expectedDesktopDistributionFiles(platform),
    "Production build must contain only the reviewed runtime assets and no source maps",
  );
  assert.deepEqual(
    tree.entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path),
    ["calculator", ...(platform === "darwin" ? ["native"] : [])],
    "Unexpected distribution directory",
  );
  const identityBytes = await measureRegularFile(
    path.join(distributionRoot, "build-identity.json"),
    true,
  );
  assert.equal(
    identityBytes.sha256,
    files.find((entry) => entry.path === "build-identity.json").sha256,
  );
  const buildIdentity = inspectBuildIdentityAsset(
    identityBytes.contents,
    expectedBuildIdentity,
  );
  const nativeArtifacts =
    platform === "darwin"
      ? await Promise.all(
          nativeDistributionFiles.map((relativePath) =>
            inspectNativeArtifact(distributionRoot, relativePath, architecture),
          ),
        )
      : [];
  for (const artifact of nativeArtifacts)
    assert.equal(
      artifact.sha256,
      files.find((entry) => `dist/${entry.path}` === artifact.path).sha256,
    );
  return { files, buildIdentity, nativeArtifacts };
}

export async function selectExistingElectronArchive({
  repositoryRoot,
  electronVersion,
  platform = process.platform,
  architecture = process.arch,
  directory = process.env.DESMOSLOCK_ELECTRON_ZIP_DIR,
}) {
  assert.equal(
    electronVersion,
    "43.4.1",
    "Packaging requires the reviewed Electron version",
  );
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Packaging platform is unsupported",
  );
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Packaging architecture is unsupported",
  );
  const filename = `electron-v${electronVersion}-${platform}-${architecture}.zip`;
  const checksums = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules/electron/checksums.json"),
      "utf8",
    ),
  );
  const expectedHash = checksums[filename];
  assert.match(
    expectedHash ?? "",
    /^[0-9a-f]{64}$/,
    "The installed Electron package must pin the exact archive checksum",
  );
  if (directory === undefined) {
    // Address one existing official cache entry, matching @electron/get's
    // Cache.getCacheDirectory and env-paths('electron', { suffix: '' }).
    // npm ci already populates this entry in CI; this verifier never downloads.
    const defaultCacheRoot =
      platform === "darwin"
        ? path.join(os.homedir(), "Library/Caches/electron")
        : platform === "win32"
          ? path.join(
              process.env.LOCALAPPDATA ||
                path.join(os.homedir(), "AppData/Local"),
              "electron/Cache",
            )
          : path.join(
              process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
              "electron",
            );
    const cacheRoot = process.env.electron_config_cache ?? defaultCacheRoot;
    assert.equal(
      path.isAbsolute(cacheRoot),
      true,
      "The selected Electron cache root must be absolute",
    );
    const releaseDirectory = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
    directory = path.join(
      cacheRoot,
      createHash("sha256").update(releaseDirectory).digest("hex"),
    );
  }
  assert.equal(
    path.isAbsolute(directory),
    true,
    "The selected Electron ZIP directory must be absolute",
  );
  const archivePath = path.join(directory, filename);
  let status;
  try {
    status = await fs.lstat(archivePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Required existing ${filename} is unavailable. Select its verified directory with DESMOSLOCK_ELECTRON_ZIP_DIR or retain npm ci's official Electron cache; this verifier will not download or search for it.`,
      { cause: error },
    );
  }
  assert.equal(
    status.isFile() && !status.isSymbolicLink(),
    true,
    "The selected Electron ZIP must be a regular archive file",
  );
  assert.equal(
    status.nlink,
    1,
    "The selected Electron ZIP must not be hardlinked",
  );
  const { sha256, bytes } = await measureRegularFile(archivePath);
  assert.equal(
    bytes,
    status.size,
    "The selected Electron archive changed while being verified",
  );
  assert.equal(
    sha256,
    expectedHash,
    "The existing Electron archive does not match the installed package's checksum",
  );
  if (platform === "darwin" && architecture === "arm64") {
    assert.equal(
      sha256,
      "fe3cac8cbfd9ba1739fac6c69166cf30848741f93cbe251d800ae6ef7cebb64b",
    );
    assert.equal(bytes, 122_238_952);
  }
  return { directory: await fs.realpath(directory), filename, sha256, bytes };
}

export async function desktopPackagePaths(
  packageDirectory,
  platform = process.platform,
) {
  expectedDesktopDistributionFiles(platform);
  await assertDirectory(packageDirectory);
  const appBundle =
    platform === "darwin"
      ? path.join(packageDirectory, `${appName}.app`)
      : null;
  const executable =
    platform === "darwin"
      ? path.join(appBundle, "Contents", "MacOS", packagedExecutableName)
      : path.join(
          packageDirectory,
          `${packagedExecutableName}${platform === "win32" ? ".exe" : ""}`,
        );
  const resourcesDirectory =
    platform === "darwin"
      ? path.join(appBundle, "Contents", "Resources")
      : path.join(packageDirectory, "resources");
  await assertDirectory(path.dirname(executable));
  await assertDirectory(resourcesDirectory);
  const executableStatus = await fs.lstat(executable);
  assert.ok(
    executableStatus.isFile() && !executableStatus.isSymbolicLink(),
    "Packaged executable must be a regular file",
  );
  assert.equal(
    executableStatus.nlink,
    1,
    "Packaged executable must not be hardlinked",
  );
  await fs.access(
    executable,
    platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  return { packageDirectory, appBundle, executable, resourcesDirectory };
}

export async function inspectPackagedDesktop({
  packageDirectory,
  distribution,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Artifact architecture is unsupported",
  );
  const paths = await desktopPackagePaths(packageDirectory, platform);
  const tree = await inspectArtifactTree(paths.appBundle ?? packageDirectory);
  const archivePath = path.join(paths.resourcesDirectory, "app.asar");
  await assertDirectory(paths.resourcesDirectory);
  const archive = await measureRegularFile(archivePath);
  uncache(archivePath);
  const archiveEntries = listPackage(archivePath)
    .map((listedFilename) => {
      const filename =
        process.platform === "win32"
          ? listedFilename.split("\\").join("/")
          : listedFilename;
      assert.ok(filename.startsWith("/"));
      const relativePath = filename.slice(1);
      assert.ok(
        relativePath !== "" &&
          !relativePath.includes("\\") &&
          relativePath
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
        "Invalid ASAR path",
      );
      const entry = statFile(archivePath, relativePath, false);
      assert.equal(
        "link" in entry,
        false,
        "ASAR inventory must not contain links",
      );
      return {
        path: relativePath,
        directory: "files" in entry,
        unpacked: entry.unpacked === true,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const expectedFiles = [
    ...expectedDesktopDistributionFiles(platform).map(
      (filename) => `dist/${filename}`,
    ),
    "package.json",
  ].sort();
  assert.deepEqual(
    archiveEntries
      .filter((entry) => !entry.directory)
      .map((entry) => entry.path),
    expectedFiles,
    "ASAR inventory differs from reviewed runtime assets",
  );
  assert.deepEqual(
    archiveEntries
      .filter((entry) => entry.directory)
      .map((entry) => entry.path),
    [
      "dist",
      "dist/calculator",
      ...(platform === "darwin" ? ["dist/native"] : []),
    ],
  );
  assert.deepEqual(
    archiveEntries
      .filter((entry) => !entry.directory && entry.unpacked)
      .map((entry) => entry.path),
    platform === "darwin"
      ? nativeDistributionFiles.map((filename) => `dist/${filename}`)
      : [],
    "Only the two native artifacts may be unpacked",
  );
  const unpackedRoot = path.join(paths.resourcesDirectory, "app.asar.unpacked");
  if (platform === "darwin") {
    const unpackedTree = await inspectArtifactTree(unpackedRoot, {
      allowSymlinks: false,
    });
    assert.deepEqual(
      unpackedTree.entries.map((entry) => entry.path),
      [
        "dist",
        "dist/native",
        ...nativeDistributionFiles.map((filename) => `dist/${filename}`),
      ],
    );
  } else {
    await assert.rejects(
      fs.lstat(unpackedRoot),
      { code: "ENOENT" },
      "Non-Mac package must not contain unpacked assets",
    );
  }
  const packagedFiles = expectedDesktopDistributionFiles(platform).map(
    (filename) => {
      const bytes = extractFile(archivePath, `dist/${filename}`, false);
      return { path: filename, bytes: bytes.length, sha256: digest(bytes) };
    },
  );
  if (distribution !== undefined) {
    assert.deepEqual(
      packagedFiles,
      distribution.files.map(({ path: filename, bytes, sha256 }) => ({
        path: filename,
        bytes,
        sha256,
      })),
      "Packaged runtime bytes differ from the inspected distribution",
    );
  }
  const identityBytes = extractFile(
    archivePath,
    "dist/build-identity.json",
    false,
  );
  const buildIdentity = inspectBuildIdentityAsset(
    identityBytes,
    expectedBuildIdentity,
  );
  const packageMetadata = JSON.parse(
    extractFile(archivePath, "package.json", false).toString("utf8"),
  );
  // Packager removes the staging-only private field before creating ASAR.
  assert.deepEqual(Object.keys(packageMetadata).sort(), [
    "main",
    "name",
    "productName",
    "type",
    "version",
  ]);
  assert.deepEqual(
    { ...packageMetadata, version: undefined },
    {
      main: "dist/main.js",
      name: packagedExecutableName,
      productName: appName,
      type: "module",
      version: undefined,
    },
  );
  assert.match(
    packageMetadata.version,
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,
  );
  const nativeArtifacts =
    platform === "darwin"
      ? await Promise.all(
          nativeDistributionFiles.map((relativePath) =>
            inspectNativeArtifact(
              path.join(unpackedRoot, "dist"),
              relativePath,
              architecture,
            ),
          ),
        )
      : [];
  if (distribution !== undefined)
    assert.deepEqual(
      nativeArtifacts,
      distribution.nativeArtifacts,
      "Packaged native artifact differs from its distribution",
    );
  const { contents: executableBytes, ...executable } = await measureRegularFile(
    paths.executable,
    platform === "darwin",
  );
  if (platform === "darwin")
    inspectMachOHeader(executableBytes, architecture, 2);
  const infoPlist =
    platform === "darwin"
      ? await measureRegularFile(
          path.join(paths.appBundle, "Contents", "Info.plist"),
        )
      : null;
  const fuses = await verifyPackagedElectronFuses(paths.executable);
  assert.deepEqual(fuses, {
    EnableNodeCliInspectArguments: "DISABLE",
    EnableNodeOptionsEnvironmentVariable: "DISABLE",
    RunAsNode: "DISABLE",
  });
  assert.deepEqual(
    await measureRegularFile(archivePath),
    archive,
    "ASAR changed during inspection",
  );
  // Bind every separately observed file to the completed app-tree snapshot.
  const treeRoot = paths.appBundle ?? packageDirectory;
  const measurements = {
    executable: {
      path: path.relative(treeRoot, paths.executable).split(path.sep).join("/"),
      ...executable,
      architecture: platform === "darwin" ? architecture : null,
    },
    asar: {
      path: path.relative(treeRoot, archivePath).split(path.sep).join("/"),
      ...archive,
    },
    infoPlist:
      infoPlist === null ? null : { path: "Contents/Info.plist", ...infoPlist },
  };
  for (const measurement of [
    ...Object.values(measurements).filter((value) => value !== null),
    ...nativeArtifacts.map((artifact) => ({
      ...artifact,
      path: path
        .relative(treeRoot, path.join(unpackedRoot, artifact.path))
        .split(path.sep)
        .join("/"),
    })),
  ]) {
    const entry = tree.entries.find((value) => value.path === measurement.path);
    assert.equal(entry?.type, "file");
    assert.equal(
      entry.sha256,
      measurement.sha256,
      "Artifact tree and file measurements disagree",
    );
    assert.equal(entry.bytes, measurement.bytes);
  }
  assert.deepEqual(
    await inspectArtifactTree(treeRoot),
    tree,
    "Artifact tree changed during inspection",
  );
  return {
    ...paths,
    platform,
    architecture,
    buildIdentity,
    packageVersion: packageMetadata.version,
    nativeArtifacts,
    fuses,
    measurements,
    tree,
  };
}

async function readWorkspaceVersion(repositoryRoot) {
  const read = async (filename) =>
    JSON.parse(await fs.readFile(path.join(repositoryRoot, filename), "utf8"));
  const [root, desktop, lock] = await Promise.all([
    read("package.json"),
    read("apps/desktop/package.json"),
    read("package-lock.json"),
  ]);
  assert.equal(root.name, "desmoslock");
  assert.equal(desktop.name, "@desmoslock/desktop");
  assert.match(root.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(lock.lockfileVersion, 3);
  for (const version of [
    desktop.version,
    lock.version,
    lock.packages?.[""]?.version,
    lock.packages?.["apps/desktop"]?.version,
  ])
    assert.equal(
      version,
      root.version,
      "Workspace and lockfile package versions differ",
    );
  return root.version;
}

export async function packageUnsignedDesktop({
  repositoryRoot,
  distributionRoot,
  stageRoot,
  outputRoot,
  temporaryRoot,
  electronVersion,
  electronArchive,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.equal(
    platform,
    process.platform,
    "Unsigned packaging only supports the current host platform",
  );
  assert.equal(
    architecture,
    process.arch,
    "Unsigned packaging only establishes the current host architecture",
  );
  const version = await readWorkspaceVersion(repositoryRoot);
  const distribution = await inspectDesktopDistribution({
    distributionRoot,
    platform,
    architecture,
    expectedBuildIdentity,
  });
  const archive = await selectExistingElectronArchive({
    repositoryRoot,
    electronVersion,
    platform,
    architecture,
    directory: electronArchive.directory,
  });
  assert.deepEqual(
    archive,
    electronArchive,
    "Selected Electron archive changed before packaging",
  );
  const roots = [stageRoot, outputRoot, temporaryRoot, distributionRoot].map(
    (root) => {
      assert.ok(path.isAbsolute(root), "Packaging paths must be absolute");
      return path.resolve(root);
    },
  );
  for (let left = 0; left < roots.length; left += 1)
    for (let right = left + 1; right < roots.length; right += 1) {
      const relative = path.relative(roots[left], roots[right]);
      const reverse = path.relative(roots[right], roots[left]);
      assert.ok(
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        "Packaging roots must be disjoint",
      );
      assert.ok(
        reverse.startsWith(`..${path.sep}`) || path.isAbsolute(reverse),
        "Packaging roots must be disjoint",
      );
    }
  for (const root of roots.slice(0, 3)) {
    await assertDirectory(path.dirname(root));
    await fs.mkdir(root, { mode: 0o700 });
  }
  await fs.cp(distributionRoot, path.join(stageRoot, "dist"), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  assert.deepEqual(
    await inspectDesktopDistribution({
      distributionRoot: path.join(stageRoot, "dist"),
      platform,
      architecture,
      expectedBuildIdentity,
    }),
    distribution,
    "Staged runtime differs from the inspected distribution",
  );
  await fs.writeFile(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify({ main: "dist/main.js", name: packagedExecutableName, private: true, productName: appName, type: "module", version }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const packageDirectories = await packager({
    arch: architecture,
    // ASAR matches absolute source names with matchBase. Exact inventories
    // constrain these two basenames to their fixed dist/native paths.
    asar:
      platform === "darwin"
        ? { unpack: "{aac-protection,durable-record}.node" }
        : true,
    dir: stageRoot,
    electronVersion,
    electronZipDir: archive.directory,
    executableName: packagedExecutableName,
    name: appName,
    osxSign: false,
    out: outputRoot,
    tmpdir: temporaryRoot,
    overwrite: false,
    platform,
    prune: false,
    quiet: true,
  });
  assert.equal(packageDirectories.length, 1);
  const packageDirectory = path.resolve(packageDirectories[0]);
  assert.equal(
    path.dirname(packageDirectory),
    path.resolve(outputRoot),
    "Packager returned an unexpected output directory",
  );
  const packaged = await desktopPackagePaths(packageDirectory, platform);
  await hardenPackagedElectron(packaged.executable, platform, architecture);
  const inspection = await inspectPackagedDesktop({
    packageDirectory,
    distribution,
    platform,
    architecture,
    expectedBuildIdentity,
  });
  assert.equal(
    inspection.packageVersion,
    version,
    "Packager changed the workspace version",
  );
  return { ...inspection, distribution, electronArchive: archive };
}
