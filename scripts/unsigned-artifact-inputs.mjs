import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseClientBuildInputs,
  parseClientUniversalBuildInputs,
} from "../packages/contracts/dist/build-identity.js";

const executeFile = promisify(execFile);
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^(?!0{64}$)[0-9a-f]{64}$/;
const blob = /^(?!0{40}$)[0-9a-f]{40}$/;
const sourceDirectories = Object.freeze([
  "apps/desktop/src",
  "apps/desktop/native",
  "packages/domain/src",
  "packages/contracts/src",
  "packages/test-support/src",
]);
const sourceFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  ...["domain", "contracts", "test-support"].flatMap((name) => [
    `packages/${name}/package.json`,
    `packages/${name}/tsconfig.json`,
    `packages/${name}/tsconfig.build.json`,
  ]),
  "scripts/build-app.mjs",
  "scripts/build-desktop-durable-record.mjs",
  "scripts/build-desktop-aac-protection.mjs",
  "scripts/desktop-artifact.mjs",
  "scripts/electron-fuse-policy.mjs",
  "scripts/unsigned-artifact-evidence.mjs",
  "scripts/collect-unsigned-desktop.mjs",
  "scripts/unsigned-artifact-inputs.mjs",
]);
const universalSourceFiles = Object.freeze([
  ...sourceFiles,
  "scripts/collect-universal-desktop.mjs",
]);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
export function fail(message, code) {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  throw error;
}
export function exact(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Invalid collector descriptor");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    fail("Invalid collector descriptor");
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    fail("Invalid collector descriptor fields");
  const result = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value"))
      fail("Invalid collector descriptor field");
    result[key] = property.value;
  }
  return result;
}
function safeRelative(value) {
  return (
    typeof value === "string" &&
    value.length <= 500 &&
    /^[A-Za-z0-9@_.+/-]+$/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !part.toLowerCase().startsWith(".env") &&
          !/^(?:\.?env(?:\.|$)|\.git$|\.ssh$|\.aws$|\.gnupg$|\.config$|keychains?$|credentials?(?:\.|$)|secrets?(?:\.|$)|auth-cache$)/i.test(
            part,
          ),
      )
  );
}
export function absolute(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    ) ||
    !safeRelative(value.slice(1))
  )
    fail("Invalid explicit input path");
  return value;
}
function safeDependencyScope(value) {
  return (
    typeof value === "string" &&
    /^@[a-z0-9._-]+$/.test(value) &&
    safeRelative(value.slice(1))
  );
}
function safeDependencyName(value) {
  return (
    typeof value === "string" &&
    /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value) &&
    safeRelative(value) &&
    (!value.startsWith("@") || safeDependencyScope(value.split("/")[0]))
  );
}
export function isUnsignedCollectorSourcePath(value) {
  return isCollectorSourcePath(value, false);
}
export function isUniversalCollectorSourcePath(value) {
  return isCollectorSourcePath(value, true);
}
function isCollectorSourcePath(value, universal) {
  return (
    safeRelative(value) &&
    ((universal ? universalSourceFiles : sourceFiles).includes(value) ||
      sourceDirectories.some((directory) => value.startsWith(`${directory}/`)))
  );
}
function rows(value, limit) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > limit ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail("Invalid bounded collector manifest");
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, "value"))
      fail("Invalid collector manifest row");
    return property.value;
  });
}
export function parseUnsignedArtifactDescriptor(value) {
  return parseArtifactDescriptor(value, false);
}
export function parseUniversalArtifactDescriptor(value) {
  return parseArtifactDescriptor(value, true);
}
function parseArtifactDescriptor(value, universal) {
  const row = exact(value, [
    "schemaVersion",
    "inputs",
    "review",
    "publicBackend",
    "sourceManifest",
    "paths",
    "dependencies",
    "executionFiles",
    "nativeHelperSha256",
  ]);
  const inputs = universal
    ? parseClientUniversalBuildInputs(row.inputs)
    : parseClientBuildInputs(row.inputs);
  if (
    row.schemaVersion !== 1 ||
    inputs === null ||
    !digest.test(row.nativeHelperSha256 ?? "")
  )
    fail("Invalid collector build inputs");
  const review = exact(row.review, [
    "sourceCommit",
    "mainRef",
    "ciCommit",
    "ciUrl",
  ]);
  if (
    review.sourceCommit !== inputs.sourceCommit ||
    review.ciCommit !== inputs.sourceCommit ||
    review.mainRef !== "refs/remotes/origin/main" ||
    typeof review.ciUrl !== "string" ||
    !/^https:\/\/github\.com\/danielholguin31\/desmoslock\/actions\/runs\/[1-9][0-9]{0,19}$/.test(
      review.ciUrl,
    )
  )
    fail("Reviewed source and CI reference must name the selected main commit");
  const backend = exact(row.publicBackend, ["environment", "url"]);
  // The build helper applies the shared public configuration parser before use.
  if (
    !["local", "staging"].includes(backend.environment) ||
    typeof backend.url !== "string" ||
    backend.url.length > 2048
  )
    fail("Invalid public backend configuration");
  const paths = exact(row.paths, [
    "node",
    "npm",
    "electronZipDirectory",
    "compiler",
    "sdk",
    "nodeHeaders",
    "dependencies",
    ...(universal ? ["lipo", "codesign"] : []),
  ]);
  for (const key of Object.keys(paths)) paths[key] = absolute(paths[key]);
  if (
    !paths.node.endsWith("/bin/node") ||
    !paths.npm.endsWith("/bin/npm-cli.js")
  )
    fail("Explicit Node and npm CLI paths are required");
  const sourceManifest = rows(row.sourceManifest, 2048).map((item) => {
    const entry = exact(item, ["path", "mode", "gitBlob", "sha256", "bytes"]);
    if (
      !isCollectorSourcePath(entry.path, universal) ||
      !["100644", "100755"].includes(entry.mode) ||
      !blob.test(entry.gitBlob ?? "") ||
      !digest.test(entry.sha256 ?? "") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 16 * 1024 * 1024
    )
      fail("Source manifest contains an undeclared or unsafe input");
    return { ...entry };
  });
  if (
    new Set(sourceManifest.map((entry) => entry.path)).size !==
    sourceManifest.length
  )
    fail("Duplicate source manifest path");
  const dependencies = rows(row.dependencies, 512).map((item) => {
    const entry = exact(item, [
      "name",
      "version",
      "packageJsonSha256",
      "integrity",
    ]);
    if (
      !safeDependencyName(entry.name) ||
      typeof entry.version !== "string" ||
      entry.version.length > 64 ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(entry.version) ||
      !digest.test(entry.packageJsonSha256 ?? "") ||
      typeof entry.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
    )
      fail("Invalid declared dependency");
    return { ...entry };
  });
  if (
    new Set(dependencies.map((entry) => entry.name)).size !==
    dependencies.length
  )
    fail("Duplicate dependency");
  const requiredExecutionFiles = [
    "typescript/bin/tsc",
    "typescript/lib/_tsc.js",
    "esbuild/lib/main.js",
    `@esbuild/darwin-${universal ? inputs.hostArchitecture : inputs.architecture}/bin/esbuild`,
  ].sort();
  const executionFiles = rows(row.executionFiles, 4)
    .map((item) => {
      const entry = exact(item, ["path", "sha256", "bytes"]);
      if (
        !requiredExecutionFiles.includes(entry.path) ||
        !digest.test(entry.sha256 ?? "") ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        entry.bytes > 256 * 1024 * 1024
      )
        fail("Invalid fixed execution file measurement");
      return { ...entry };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(
    executionFiles.map((entry) => entry.path),
    requiredExecutionFiles,
  );
  return {
    schemaVersion: 1,
    inputs,
    review: { ...review },
    publicBackend: { ...backend },
    sourceManifest: sourceManifest.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    paths: { ...paths },
    dependencies: dependencies.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    executionFiles,
    nativeHelperSha256: row.nativeHelperSha256,
  };
}

export async function directory(filename) {
  const status = await fs.lstat(filename);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (await fs.realpath(filename)) !== filename
  )
    fail("Collector directories must have real, nonsymlink ancestors");
  return status;
}
export async function ownedDirectory(filename, create = false) {
  if (create) await fs.mkdir(filename, { mode: 0o700 });
  const status = await directory(filename);
  if (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)
    fail("Collector output directories must be owned and private");
}
export async function readRegular(filename, maximum = 16 * 1024 * 1024) {
  await directory(path.dirname(filename));
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
      fail("Input must be a bounded, nonlinked regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      bytes.length !== before.size
    )
      fail("Input changed while being measured");
    return { bytes, sha256: sha256(bytes), mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}
export async function readJson(filename, maximum) {
  return JSON.parse(
    (await readRegular(filename, maximum)).bytes.toString("utf8"),
  );
}
export async function fileInventory(root, { headers = false } = {}) {
  await directory(root);
  const entries = [];
  let total = 0;
  async function visit(relative) {
    const parent = path.join(root, relative);
    await directory(parent);
    for (const name of (await fs.readdir(parent)).sort()) {
      const item = relative === "" ? name : `${relative}/${name}`;
      if (!safeRelative(item))
        fail("Undeclared sensitive or unsafe tree entry");
      const filename = path.join(root, item);
      const status = await fs.lstat(filename);
      if (status.isDirectory()) {
        await visit(item);
        continue;
      }
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        (headers && !/\.(?:h|gypi)$/.test(item))
      )
        fail("Input tree contains unsupported links or file types");
      const measured = await readRegular(filename, 256 * 1024 * 1024);
      total += measured.bytes.length;
      if (entries.length >= 50000 || total > 2 * 1024 * 1024 * 1024)
        fail("Input tree capacity exceeded");
      entries.push({
        path: item,
        mode: measured.mode,
        sha256: measured.sha256,
        bytes: measured.bytes.length,
      });
    }
  }
  await visit("");
  return { entries, sha256: sha256(Buffer.from(JSON.stringify(entries))) };
}
async function sourceNames(repositoryRoot, universal) {
  const names = [...(universal ? universalSourceFiles : sourceFiles)];
  async function visit(relative) {
    const root = path.join(repositoryRoot, relative);
    await directory(root);
    for (const name of (await fs.readdir(root)).sort()) {
      const item = `${relative}/${name}`;
      if (!isCollectorSourcePath(item, universal))
        fail("Source directory contains an unsafe name");
      const status = await fs.lstat(path.join(repositoryRoot, item));
      if (status.isDirectory()) await visit(item);
      else if (status.isFile() && !status.isSymbolicLink()) names.push(item);
      else fail("Source directory contains a link or nonregular input");
    }
  }
  for (const item of sourceDirectories) await visit(item);
  return names.sort();
}
export async function inspectUnsignedCollectorDependencyNames(
  modulesRoot,
  providerRoot,
) {
  await directory(modulesRoot);
  await directory(providerRoot);
  if (path.basename(providerRoot) !== "node_modules")
    fail(
      "Declared dependency root must be the prepared node_modules directory",
    );
  const installed = [];
  for (const name of (await fs.readdir(modulesRoot)).sort()) {
    if (
      name === ".bin" ||
      name === ".package-lock.json" ||
      name.startsWith(".cache") ||
      name === ".vite" ||
      name === ".vite-temp" ||
      name === "@desmoslock"
    )
      continue;
    if (name.startsWith("@")) {
      if (!safeDependencyScope(name)) fail("Unsafe installed dependency scope");
      const scopeRoot = path.join(modulesRoot, name);
      const actualScope = await fs.realpath(scopeRoot);
      if (
        actualScope !== scopeRoot &&
        actualScope !== path.join(providerRoot, name)
      )
        fail("Installed dependency scope escaped its declared provider");
      await directory(actualScope);
      for (const child of (await fs.readdir(actualScope)).sort()) {
        const fullName = `${name}/${child}`;
        if (!safeDependencyName(fullName))
          fail("Unsafe installed dependency name");
        installed.push(fullName);
      }
    } else {
      if (!safeDependencyName(name)) fail("Unsafe installed dependency name");
      installed.push(name);
    }
  }
  return installed.sort();
}
export function createUnsignedCollectorCommandEnvironment(
  descriptor,
  temporaryRoot,
) {
  return {
    PATH: `${path.dirname(descriptor.paths.node)}:/usr/bin:/bin`,
    LC_ALL: "C",
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    NODE_DISABLE_COMPILE_CACHE: "1",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_USERCONFIG: path.join(temporaryRoot, "npm-user.ini"),
    NPM_CONFIG_GLOBALCONFIG: path.join(temporaryRoot, "npm-global.ini"),
    NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
    DESMOSLOCK_NATIVE_CLANG: descriptor.paths.compiler,
    DESMOSLOCK_NATIVE_SDK: descriptor.paths.sdk,
    DESMOSLOCK_NATIVE_NODE_HEADERS: descriptor.paths.nodeHeaders,
    DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: descriptor.publicBackend.environment,
    DESMOSLOCK_PUBLIC_BACKEND_URL: descriptor.publicBackend.url,
  };
}
export async function command(file, args, options) {
  // Fixed callers below supply every command and argument. No shell or descriptor commands.
  return executeFile(file, args, {
    ...options,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
}
export async function verifyInputs(
  repositoryRoot,
  descriptor,
  temporaryRoot,
  dependencies,
) {
  return verifyArtifactInputs(
    repositoryRoot,
    descriptor,
    temporaryRoot,
    dependencies,
    false,
  );
}
export async function verifyUniversalInputs(
  repositoryRoot,
  descriptor,
  temporaryRoot,
  dependencies,
) {
  return verifyArtifactInputs(
    repositoryRoot,
    descriptor,
    temporaryRoot,
    dependencies,
    true,
  );
}
async function verifyArtifactInputs(
  repositoryRoot,
  descriptor,
  temporaryRoot,
  dependencies,
  universal,
) {
  const { inputs, paths } = descriptor;
  const env = createUnsignedCollectorCommandEnvironment(
    descriptor,
    temporaryRoot,
  );
  const options = { cwd: repositoryRoot, env };
  const git = async (args) =>
    (
      await dependencies.command(
        "/usr/bin/git",
        ["--no-optional-locks", ...args],
        options,
      )
    ).stdout.trim();
  for (const revision of ["HEAD", descriptor.review.mainRef]) {
    if (
      (await git(["rev-parse", "--verify", `${revision}^{commit}`])) !==
      inputs.sourceCommit
    )
      fail("Checkout and selected main ref must match the reviewed commit");
  }
  if (
    (await git(["rev-parse", "--verify", `${inputs.sourceCommit}^{tree}`])) !==
    inputs.sourceTree
  )
    fail("Source tree differs from the selected commit");
  const treeRows = (
    await git([
      "ls-tree",
      "-r",
      "-z",
      inputs.sourceCommit,
      "--",
      ...(universal ? universalSourceFiles : sourceFiles),
      ...sourceDirectories,
    ])
  )
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\n]+)$/.exec(
        line,
      );
      if (match === null || !isCollectorSourcePath(match[3], universal))
        fail("Selected source tree includes an unsupported entry");
      return { mode: match[1], gitBlob: match[2], path: match[3] };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(
    treeRows,
    descriptor.sourceManifest.map(({ mode, gitBlob, path: filename }) => ({
      mode,
      gitBlob,
      path: filename,
    })),
    "Positive source manifest differs from the selected Git tree",
  );
  assert.deepEqual(
    await sourceNames(repositoryRoot, universal),
    descriptor.sourceManifest.map((entry) => entry.path),
    "Untracked or missing positive build inputs",
  );
  for (const entry of descriptor.sourceManifest) {
    const measured = await readRegular(path.join(repositoryRoot, entry.path));
    const gitBlob = createHash("sha1")
      .update(`blob ${measured.bytes.length}\0`)
      .update(measured.bytes)
      .digest("hex");
    if (
      measured.sha256 !== entry.sha256 ||
      measured.bytes.length !== entry.bytes ||
      gitBlob !== entry.gitBlob ||
      ((measured.mode & 0o111) !== 0 ? "100755" : "100644") !== entry.mode
    )
      fail("Positive source bytes or mode changed");
  }
  const lockFile = await readRegular(
    path.join(repositoryRoot, "package-lock.json"),
  );
  if (lockFile.sha256 !== inputs.packageLockSha256)
    fail("Package lock digest differs from build inputs");
  const lock = JSON.parse(lockFile.bytes.toString("utf8"));
  const rootPackage = await readJson(path.join(repositoryRoot, "package.json"));
  if (
    rootPackage.version !== inputs.packageVersion ||
    lock.version !== inputs.packageVersion ||
    lock.lockfileVersion !== 3 ||
    rootPackage.engines?.node !== inputs.tools.node.version ||
    !rootPackage.packageManager?.startsWith(
      `npm@${inputs.tools.npm.version}+sha512.`,
    )
  )
    fail("Workspace version or pinned tool declaration differs");
  if (
    process.platform !== inputs.platform ||
    process.arch !==
      (universal ? inputs.hostArchitecture : inputs.architecture) ||
    process.versions.node !== inputs.tools.node.version ||
    (await fs.realpath(process.execPath)) !== paths.node
  )
    fail("Collector must use the selected native Node executable");
  for (const [name, filename] of [
    ["node", paths.node],
    ["npm", paths.npm],
    ["compiler", paths.compiler],
    ...(universal
      ? [
          ["lipo", paths.lipo],
          ["codesign", paths.codesign],
        ]
      : []),
  ]) {
    if (
      (await readRegular(filename, 256 * 1024 * 1024)).sha256 !==
      inputs.tools[name].sha256
    )
      fail("Pinned tool bytes differ from build inputs");
  }
  const versions = {
    node: (
      await dependencies.command(paths.node, ["--version"], options)
    ).stdout
      .trim()
      .replace(/^v/, ""),
    npm: (
      await dependencies.command(
        paths.node,
        [
          paths.npm,
          "--global",
          "--version",
          `--userconfig=${env.NPM_CONFIG_USERCONFIG}`,
          `--globalconfig=${env.NPM_CONFIG_GLOBALCONFIG}`,
        ],
        { ...options, cwd: temporaryRoot },
      )
    ).stdout.trim(),
    compiler: (
      await dependencies.command(paths.compiler, ["--version"], options)
    ).stdout.split(/\r?\n/, 1)[0],
  };
  for (const name of Object.keys(versions))
    if (versions[name] !== inputs.tools[name].version)
      fail("Observed tool version differs from build inputs");
  const settingsFile = await readRegular(
    path.join(paths.sdk, "SDKSettings.json"),
  );
  const settings = JSON.parse(settingsFile.bytes.toString("utf8"));
  const systemVersionPath = path.join(
    paths.sdk,
    "System/Library/CoreServices/SystemVersion.plist",
  );
  const systemVersionFile = await readRegular(systemVersionPath, 16384);
  const sdkVersion = (
    await dependencies.command(
      "/usr/bin/plutil",
      ["-extract", "ProductVersion", "raw", "-o", "-", systemVersionPath],
      options,
    )
  ).stdout.trim();
  const sdkBuildVersion = (
    await dependencies.command(
      "/usr/bin/plutil",
      ["-extract", "ProductBuildVersion", "raw", "-o", "-", systemVersionPath],
      options,
    )
  ).stdout.trim();
  if (
    (await readRegular(systemVersionPath, 16384)).sha256 !==
    systemVersionFile.sha256
  )
    fail("SDK system metadata changed during inspection");
  if (
    settingsFile.sha256 !== inputs.tools.sdk.settingsSha256 ||
    settings.Version !== inputs.tools.sdk.version ||
    sdkVersion !== inputs.tools.sdk.version ||
    sdkBuildVersion !== inputs.tools.sdk.buildVersion
  )
    fail("SDK metadata differs from build inputs");
  const headers = await fileInventory(paths.nodeHeaders, { headers: true });
  if (
    headers.sha256 !== inputs.tools.nodeHeadersSha256 ||
    !headers.entries.some((entry) => entry.path === "node_api.h")
  )
    fail("Node header inventory differs from build inputs");
  const modulesRoot = path.join(repositoryRoot, "node_modules");
  const installed = await inspectUnsignedCollectorDependencyNames(
    modulesRoot,
    paths.dependencies,
  );
  assert.deepEqual(
    installed.sort(),
    descriptor.dependencies.map((entry) => entry.name),
    "Every installed third-party package must be declared",
  );
  const dependencyMeasurements = [];
  for (const [name, relative] of [
    ["domain", "packages/domain"],
    ["contracts", "packages/contracts"],
    ["test-support", "packages/test-support"],
    ["desktop", "apps/desktop"],
    ["web", "apps/web"],
  ]) {
    if (
      (await fs.realpath(path.join(modulesRoot, "@desmoslock", name))) !==
      path.join(repositoryRoot, relative)
    )
      fail("Workspace package location changed");
  }
  for (const entry of descriptor.dependencies) {
    const root = path.join(paths.dependencies, entry.name);
    if ((await fs.realpath(path.join(modulesRoot, entry.name))) !== root)
      fail("Dependency location changed");
    const metadataFile = await readRegular(path.join(root, "package.json"));
    const metadata = JSON.parse(metadataFile.bytes.toString("utf8"));
    if (
      metadata.name !== entry.name ||
      metadata.version !== entry.version ||
      lock.packages?.[`node_modules/${entry.name}`]?.version !== entry.version
    )
      fail("Dependency metadata differs from the package lock");
    if (
      metadataFile.sha256 !== entry.packageJsonSha256 ||
      lock.packages?.[`node_modules/${entry.name}`]?.integrity !==
        entry.integrity
    )
      fail(
        "Dependency metadata or lock integrity differs from the reviewed descriptor",
      );
    dependencyMeasurements.push({ ...entry });
  }
  for (const entry of descriptor.executionFiles) {
    const measured = await readRegular(
      path.join(paths.dependencies, entry.path),
      256 * 1024 * 1024,
    );
    if (
      measured.sha256 !== entry.sha256 ||
      measured.bytes.length !== entry.bytes
    )
      fail("Fixed execution file bytes changed");
  }
  for (const [name, key] of [
    ["@electron/packager", "packager"],
    ["@electron/fuses", "fuses"],
    ["electron", "electron"],
    ...(universal ? [["@electron/universal", "universal"]] : []),
  ]) {
    if (
      dependencyMeasurements.find((entry) => entry.name === name)?.version !==
      inputs.tools[key].version
    )
      fail("Artifact tool version differs from build inputs");
  }
  let electronArchive;
  let electronArchives;
  if (universal) {
    electronArchives =
      await dependencies.artifact.selectExistingUniversalElectronArchives({
        repositoryRoot,
        electronVersion: inputs.tools.electron.version,
        directory: paths.electronZipDirectory,
      });
    for (const architecture of ["arm64", "x64"])
      if (
        electronArchives[architecture].sha256 !==
        inputs.slices[architecture].electronArchiveSha256
      )
        fail("Electron ZIP digest differs from build inputs");
  } else {
    electronArchive = await dependencies.artifact.selectExistingElectronArchive(
      {
        repositoryRoot,
        electronVersion: inputs.tools.electron.version,
        platform: inputs.platform,
        architecture: inputs.architecture,
        directory: paths.electronZipDirectory,
      },
    );
    if (electronArchive.sha256 !== inputs.tools.electron.archiveSha256)
      fail("Electron ZIP digest differs from build inputs");
  }
  return {
    kind: "source-evidence",
    descriptorSha256: sha256(jsonBytes(descriptor)),
    identity: dependencies.build[
      universal
        ? "createUniversalDesktopBuildContext"
        : "createDesktopBuildContext"
    ](inputs, descriptor.publicBackend).identity,
    sourceManifest: descriptor.sourceManifest,
    reviewReference: descriptor.review,
    tools: inputs.tools,
    sdkSystemVersion: {
      sha256: systemVersionFile.sha256,
      bytes: systemVersionFile.bytes.length,
      version: sdkVersion,
      buildVersion: sdkBuildVersion,
    },
    dependencies: dependencyMeasurements,
    executionFiles: descriptor.executionFiles,
    ...(universal ? { electronArchives } : { electronArchive }),
    limitations: [
      "CI URL is a supplied reference; no remote status or human review was independently verified",
      "Only the fixed build-relevant positive source set is byte-verified; other tracked paths are commit/tree metadata only",
      "SDK identity measures SDKSettings.json and SystemVersion.plist metadata, not every SDK binary",
      "Dependency package metadata and fixed execution files are measured; lock integrity strings are compared, not independently verified against npm tarball bytes",
    ],
  };
}
