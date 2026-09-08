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

export async function buildDesktopDurableRecord() {
  const outputDirectory = path.join(repositoryRoot, "apps/desktop/dist/native");
  const outputFile = path.join(outputDirectory, "durable-record.node");
  if (process.platform !== "darwin") {
    try {
      await fs.lstat(outputFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { supported: false, reason: "macOS native storage unavailable" };
      }
      throw error;
    }
    throw new Error(
      "An unsupported-platform build must not retain a native storage artifact",
    );
  }
  if (
    process.versions.node !== "24.20.0" ||
    !["arm64", "x64"].includes(process.arch)
  ) {
    throw new Error(
      "Native storage builds require the selected Node 24.20.0 toolchain and macOS architecture",
    );
  }
  const compiler = await existingFile(
    process.env.DESMOSLOCK_NATIVE_CLANG ??
      (await selectedXcodeArgument(["--find", "clang"])),
    "compiler",
  );
  const sdk = await fs.realpath(
    process.env.DESMOSLOCK_NATIVE_SDK ??
      (await selectedXcodeArgument(["--sdk", "macosx", "--show-sdk-path"])),
  );
  const headers = await fs.realpath(
    process.env.DESMOSLOCK_NATIVE_NODE_HEADERS ??
      path.resolve(path.dirname(process.execPath), "../include/node"),
  );
  await existingFile(path.join(headers, "node_api.h"), "Node headers");
  await existingFile(path.join(sdk, "usr/include/sys/fcntl.h"), "macOS SDK");
  const actualRepository = await fs.realpath(repositoryRoot);
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
  const actualOutput = await fs.realpath(outputDirectory);
  if (
    actualOutput !== path.join(actualRepository, "apps/desktop/dist/native")
  ) {
    throw new Error("Native build output must remain inside this checkout");
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(actualOutput, ".build-"),
  );
  const temporaryOutput = path.join(temporaryDirectory, "durable-record.node");
  try {
    await execute(
      compiler,
      [
        "-std=c11",
        "-arch",
        process.arch === "x64" ? "x86_64" : "arm64",
        "-mmacosx-version-min=13.0",
        "-fno-modules",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DNAPI_VERSION=8",
        "-DNODE_GYP_MODULE_NAME=durable_record",
        "-isysroot",
        sdk,
        "-I",
        headers,
        "-B",
        path.dirname(compiler),
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        path.join(actualRepository, "apps/desktop/native/durable-record.c"),
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
    await fs.rename(temporaryOutput, outputFile);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { supported: true, architecture: process.arch, napi: 8, outputFile };
}

if (process.argv[1] === scriptPath) {
  process.stdout.write(
    `${JSON.stringify(await buildDesktopDurableRecord())}\n`,
  );
}
