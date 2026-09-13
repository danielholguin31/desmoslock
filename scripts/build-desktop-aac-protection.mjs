import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

async function existingFile(filename, label) {
  const resolved = await fs.realpath(filename);
  if (!(await fs.stat(resolved)).isFile()) {
    throw new Error(`The selected native ${label} is unavailable`);
  }
  return resolved;
}

async function selectedXcodeArgument(argument) {
  const { stdout } = await execute("/usr/bin/xcrun", argument, {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 10_000,
    maxBuffer: 16_384,
  });
  const value = stdout.trim();
  if (!path.isAbsolute(value) || value.includes("\n")) {
    throw new Error("The selected native toolchain path is invalid");
  }
  return value;
}

function targetOptions(value) {
  if (value === undefined) return null;
  function exact(input, keys) {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error();
    const names = Reflect.ownKeys(input);
    if (
      names.length !== keys.length ||
      names.some((key) => !keys.includes(key))
    )
      throw new Error();
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error();
      copy[key] = descriptor.value;
    }
    return copy;
  }
  function absolute(filename) {
    if (
      typeof filename !== "string" ||
      !path.isAbsolute(filename) ||
      path.normalize(filename) !== filename ||
      [...filename].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      filename.endsWith("/")
    )
      throw new Error();
    return filename;
  }
  try {
    const row = exact(value, ["architecture", "outputDirectory", "toolchain"]);
    const tools = exact(row.toolchain, ["compiler", "sdk", "nodeHeaders"]);
    if (!["arm64", "x64"].includes(row.architecture)) throw new Error();
    const outputDirectory = absolute(row.outputDirectory);
    const parts = path
      .relative(repositoryRoot, outputDirectory)
      .split(path.sep);
    if (
      parts.length !== 6 ||
      parts[0] !== "artifacts" ||
      parts[1] !== "universal-artifact-runs" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        parts[2],
      ) ||
      parts[3] !== "slices" ||
      parts[4] !== row.architecture ||
      parts[5] !== "native"
    )
      throw new Error();
    return Object.freeze({
      architecture: row.architecture,
      outputDirectory,
      toolchain: Object.freeze({
        compiler: absolute(tools.compiler),
        sdk: absolute(tools.sdk),
        nodeHeaders: absolute(tools.nodeHeaders),
      }),
    });
  } catch {
    throw new Error(
      "Explicit native build targets require exact owned slice options",
    );
  }
}

async function targetDirectory(filename, privateDirectory) {
  const status = await fs.lstat(filename);
  const withinCheckout =
    filename === repositoryRoot || filename.startsWith(`${repositoryRoot}/`);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (withinCheckout
      ? status.uid !== process.geteuid()
      : ![0, process.geteuid()].includes(status.uid)) ||
    (status.mode & (privateDirectory ? 0o077 : 0o022)) !== 0 ||
    (await fs.realpath(filename)) !== filename
  ) {
    throw new Error(
      "Explicit native build ancestors must be unchanged owned directories",
    );
  }
  return { filename, privateDirectory, dev: status.dev, ino: status.ino };
}

async function targetDirectories(outputDirectory) {
  const entries = [];
  let current = path.parse(outputDirectory).root;
  const privateRoot = path.join(
    repositoryRoot,
    "artifacts/universal-artifact-runs",
  );
  for (const component of outputDirectory
    .slice(current.length)
    .split(path.sep)) {
    current = path.join(current, component);
    entries.push(
      await targetDirectory(
        current,
        current === privateRoot || current.startsWith(`${privateRoot}/`),
      ),
    );
  }
  return entries;
}

async function unchangedTarget(entries) {
  for (const entry of entries) {
    const current = await targetDirectory(
      entry.filename,
      entry.privateDirectory,
    );
    if (current.dev !== entry.dev || current.ino !== entry.ino)
      throw new Error("Explicit native build output directory changed");
  }
}

async function absentTarget(outputFile) {
  try {
    await fs.lstat(outputFile);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Explicit native build target already exists");
}

async function compiledTarget(outputFile) {
  const status = await fs.lstat(outputFile);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.uid !== process.geteuid() ||
    status.nlink !== 1 ||
    status.size < 1 ||
    (await fs.realpath(outputFile)) !== outputFile
  )
    throw new Error("Explicit native compiler output is invalid");
  return status;
}

export async function buildDesktopAACProtection(options) {
  const selected = targetOptions(options);
  const outputDirectory =
    selected?.outputDirectory ??
    path.join(repositoryRoot, "apps/desktop/dist/native");
  const outputFile = path.join(outputDirectory, "aac-protection.node");
  if (process.platform !== "darwin") {
    if (selected !== null)
      throw new Error("Explicit native build targets require macOS");
    try {
      await fs.lstat(outputFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          supported: false,
          reason: "macOS native assessment unavailable",
        };
      }
      throw error;
    }
    throw new Error(
      "An unsupported-platform build must not retain a native assessment artifact",
    );
  }
  if (
    process.versions.node !== "24.20.0" ||
    !["arm64", "x64"].includes(process.arch)
  ) {
    throw new Error(
      "Native assessment builds require the selected Node 24.20.0 toolchain and macOS architecture",
    );
  }
  const architecture = selected?.architecture ?? process.arch;
  const targetChain =
    selected === null ? null : await targetDirectories(outputDirectory);
  if (selected !== null) await absentTarget(outputFile);
  const compiler = await existingFile(
    selected?.toolchain.compiler ??
      process.env.DESMOSLOCK_NATIVE_CLANG ??
      (await selectedXcodeArgument(["--find", "clang"])),
    "compiler",
  );
  const sdk = await fs.realpath(
    selected?.toolchain.sdk ??
      process.env.DESMOSLOCK_NATIVE_SDK ??
      (await selectedXcodeArgument(["--sdk", "macosx", "--show-sdk-path"])),
  );
  const headers = await fs.realpath(
    selected?.toolchain.nodeHeaders ??
      process.env.DESMOSLOCK_NATIVE_NODE_HEADERS ??
      path.resolve(path.dirname(process.execPath), "../include/node"),
  );
  await existingFile(path.join(headers, "node_api.h"), "Node headers");
  await existingFile(path.join(sdk, "usr/include/sys/fcntl.h"), "macOS SDK");
  const actualRepository = await fs.realpath(repositoryRoot);
  if (selected === null) {
    let ancestor = actualRepository;
    for (const component of ["apps", "desktop", "dist", "native"]) {
      ancestor = path.join(ancestor, component);
      try {
        const status = await fs.lstat(ancestor);
        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw new Error(
            "Native build output ancestors must be owned directories",
          );
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.mkdir(ancestor);
      }
      if ((await fs.realpath(ancestor)) !== ancestor) {
        throw new Error("Native build output must remain inside this checkout");
      }
    }
  } else await unchangedTarget(targetChain);
  const actualOutput = await fs.realpath(outputDirectory);
  if (
    actualOutput !==
    (selected?.outputDirectory ??
      path.join(actualRepository, "apps/desktop/dist/native"))
  ) {
    throw new Error("Native build output must remain inside this checkout");
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(actualOutput, ".build-"),
  );
  if (selected !== null) {
    targetChain.push(await targetDirectory(temporaryDirectory, true));
    await unchangedTarget(targetChain);
  }
  const temporaryOutput = path.join(temporaryDirectory, "aac-protection.node");
  let compilerCompleted = false;
  let compiledIdentity = null;
  try {
    await execute(
      compiler,
      [
        "-std=c++17",
        "-fobjc-arc",
        "-fvisibility=hidden",
        "-arch",
        architecture === "x64" ? "x86_64" : "arm64",
        "-mmacosx-version-min=13.0",
        "-fno-modules",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DNAPI_VERSION=8",
        "-DNODE_GYP_MODULE_NAME=aac_protection",
        "-isysroot",
        sdk,
        "-I",
        headers,
        "-B",
        path.dirname(compiler),
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-framework",
        "Foundation",
        "-framework",
        "AppKit",
        "-framework",
        "AutomaticAssessmentConfiguration",
        "-framework",
        "IOKit",
        "-lc++",
        path.join(actualRepository, "apps/desktop/native/aac-protection.mm"),
        "-o",
        temporaryOutput,
      ],
      {
        cwd: actualRepository,
        env: {
          PATH: `${path.dirname(compiler)}:/usr/bin:/bin`,
          LC_ALL: "C",
          TMPDIR: temporaryDirectory,
          TMP: temporaryDirectory,
          TEMP: temporaryDirectory,
          CLANG_MODULE_CACHE_PATH: temporaryDirectory,
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    compilerCompleted = true;
    if (selected === null) await fs.rename(temporaryOutput, outputFile);
    else {
      await unchangedTarget(targetChain);
      compiledIdentity = await compiledTarget(temporaryOutput);
      // Exclusive link publication cannot replace a target created by another
      // builder. Removing our temporary link leaves the final artifact single-linked.
      await fs.link(temporaryOutput, outputFile);
    }
  } finally {
    if (selected === null || compilerCompleted) {
      if (selected !== null) await unchangedTarget(targetChain);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
    // A failed explicit compiler invocation may still have unknown descendants.
    // Preserve its private output for the coordinator's retained checkout lease.
  }
  if (selected !== null) {
    await unchangedTarget(targetChain.slice(0, -1));
    const published = await compiledTarget(outputFile);
    if (
      published.dev !== compiledIdentity.dev ||
      published.ino !== compiledIdentity.ino
    )
      throw new Error(
        "Explicit native compiler output changed during publication",
      );
  }
  return { supported: true, architecture, napi: 8, outputFile };
}

if (process.argv[1] === scriptPath) {
  process.stdout.write(
    `${JSON.stringify(await buildDesktopAACProtection())}\n`,
  );
}
