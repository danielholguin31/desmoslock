import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { buildDesktopDurableRecord } from "./build-desktop-durable-record.mjs";
import { buildDesktopAACProtection } from "./build-desktop-aac-protection.mjs";

import {
  parsePublicBackendConfiguration,
  parsePublicStaffAuthConfiguration,
} from "../packages/contracts/dist/index.js";
import {
  parseClientBuildInputs,
  canonicalClientBuildInputs,
  parseClientUniversalBuildInputs,
  canonicalClientUniversalBuildInputs,
} from "../packages/contracts/dist/build-identity.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

const publicWebConfigurationKeys = [
  "environment",
  "url",
  "origin",
  "publishableKey",
];

function snapshotExactConfiguration(configuration, expectedKeys) {
  try {
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(configuration);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const ownKeys = Reflect.ownKeys(configuration);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key),
      )
    ) {
      return null;
    }

    const snapshot = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasControlText(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function parsePublicWebOrigin(value) {
  if (typeof value !== "string" || hasControlText(value)) return null;

  let origin;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }

  const isLoopbackHostname =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "[::1]";
  if (
    origin.origin !== value ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && isLoopbackHostname))
  ) {
    return null;
  }
  return origin.origin;
}

export function createAppBrowserDefine(appName, configuration) {
  if (appName !== "desktop" && appName !== "web") {
    throw new Error("build-app expects exactly one app name: desktop or web");
  }

  const expectedKeys =
    appName === "desktop" ? ["environment", "url"] : publicWebConfigurationKeys;
  const exactConfiguration = snapshotExactConfiguration(
    configuration,
    expectedKeys,
  );
  if (exactConfiguration === null) {
    throw new Error(
      appName === "desktop"
        ? "Public backend build configuration is invalid"
        : "Public web build configuration is invalid",
    );
  }

  const publicBackendConfiguration = parsePublicBackendConfiguration({
    environment: exactConfiguration.environment,
    url: exactConfiguration.url,
  });
  if (publicBackendConfiguration === null) {
    throw new Error("Public backend build configuration is invalid");
  }

  const backendDefine = {
    __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: JSON.stringify(
      publicBackendConfiguration.environment,
    ),
    __DESMOSLOCK_PUBLIC_BACKEND_URL__: JSON.stringify(
      publicBackendConfiguration.url,
    ),
  };
  if (appName === "desktop") return backendDefine;

  const publicStaffAuthConfiguration = parsePublicStaffAuthConfiguration({
    publishableKey: exactConfiguration.publishableKey,
  });
  const publicWebOrigin = parsePublicWebOrigin(exactConfiguration.origin);
  if (publicStaffAuthConfiguration === null || publicWebOrigin === null) {
    throw new Error("Public web build configuration is invalid");
  }

  return {
    ...backendDefine,
    __DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
      publicStaffAuthConfiguration.publishableKey,
    ),
    __DESMOSLOCK_PUBLIC_WEB_ORIGIN__: JSON.stringify(publicWebOrigin),
  };
}

/** Pure provenance serialization; the collector verifies source and tools. */
export function createDesktopBuildContext(inputs, configuration) {
  return buildContext(
    inputs,
    configuration,
    parseClientBuildInputs,
    canonicalClientBuildInputs,
    "",
  );
}

export function createUniversalDesktopBuildContext(inputs, configuration) {
  if (inputs === null) throw new Error("Candidate build inputs are invalid");
  return buildContext(
    inputs,
    configuration,
    parseClientUniversalBuildInputs,
    canonicalClientUniversalBuildInputs,
    "desmoslock:universal-build:v1\0",
  );
}

function buildContext(
  inputs,
  configuration,
  parseInputs,
  canonicalInputs,
  domain,
) {
  const browserDefine = createAppBrowserDefine("desktop", configuration);
  let identity = null;
  if (inputs !== null) {
    const parsed = parseInputs(inputs);
    const backend = {
      environment: JSON.parse(
        browserDefine.__DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__,
      ),
      url: JSON.parse(browserDefine.__DESMOSLOCK_PUBLIC_BACKEND_URL__),
    };
    const backendDigest = createHash("sha256")
      .update(JSON.stringify(backend))
      .digest("hex");
    if (
      parsed === null ||
      parsed.backendConfigurationSha256 !== backendDigest
    ) {
      throw new Error("Candidate build inputs are invalid");
    }
    identity = Object.freeze({
      schemaVersion: 1,
      sourceRepository: parsed.sourceRepository,
      sourceCommit: parsed.sourceCommit,
      sourceTree: parsed.sourceTree,
      packageLockSha256: parsed.packageLockSha256,
      buildId: createHash("sha256")
        .update(domain)
        .update(canonicalInputs(parsed))
        .digest("hex"),
    });
  }
  const identityJson = JSON.stringify(identity);
  return Object.freeze({
    identity,
    identityJson,
    mainDefine: Object.freeze({
      ...browserDefine,
      __DESMOSLOCK_CLIENT_BUILD_IDENTITY__: identityJson,
    }),
  });
}

/** A single common JavaScript build, shared byte-for-byte by both target slices. */
export async function buildDesktopCommon(options) {
  const row = snapshotExactConfiguration(options, [
    "outputRoot",
    "productionMode",
    "publicBackend",
    "buildInputs",
  ]);
  if (
    row === null ||
    typeof row.outputRoot !== "string" ||
    !path.isAbsolute(row.outputRoot) ||
    path.normalize(row.outputRoot) !== row.outputRoot ||
    typeof row.productionMode !== "boolean"
  )
    throw new Error("Common build options are invalid");
  const relative = path.relative(repositoryRoot, row.outputRoot);
  if (
    !/^artifacts\/universal-artifact-runs\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/common$/u.test(
      relative,
    )
  )
    throw new Error("Common build output must use the owned run path");
  const universal = parseClientUniversalBuildInputs(row.buildInputs);
  if (universal !== null && row.productionMode !== true)
    throw new Error("Universal common builds require production mode");
  const context =
    universal !== null
      ? createUniversalDesktopBuildContext(universal, row.publicBackend)
      : createDesktopBuildContext(row.buildInputs, row.publicBackend);
  const browserDefine = createAppBrowserDefine("desktop", row.publicBackend);
  let current = repositoryRoot;
  const ancestors = [];
  const emittedEntries = new Map();
  for (const part of ["", ...relative.split(path.sep)]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.geteuid() ||
      (stat.mode & 0o022) !== 0 ||
      (current === row.outputRoot && (stat.mode & 0o077) !== 0) ||
      (await fs.realpath(current)) !== current
    )
      throw new Error("Common build output ancestor is invalid");
    ancestors.push({ filename: current, dev: stat.dev, ino: stat.ino });
  }
  const verifyOwnership = async () => {
    for (const ancestor of ancestors) {
      const stat = await fs.lstat(ancestor.filename);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== ancestor.dev ||
        stat.ino !== ancestor.ino ||
        stat.uid !== process.geteuid() ||
        (stat.mode & 0o022) !== 0 ||
        (ancestor.filename === row.outputRoot && (stat.mode & 0o077) !== 0) ||
        (await fs.realpath(ancestor.filename)) !== ancestor.filename
      )
        throw new Error("Common build output ownership changed");
    }
    const allowed = new Set([
      "main.js",
      "main.js.map",
      "preload.cjs",
      "preload.cjs.map",
      "renderer.js",
      "renderer.js.map",
      "index.html",
      "styles.css",
      "build-identity.json",
      "calculator",
      "calculator/host.js",
      "calculator/host.js.map",
      "calculator/index.html",
      "calculator/styles.css",
    ]);
    const found = new Set();
    const inspect = async (relative) => {
      for (const name of await fs.readdir(
        path.join(row.outputRoot, relative),
      )) {
        const entry = relative === "" ? name : `${relative}/${name}`;
        if (!allowed.has(entry))
          throw new Error("Common build output ownership changed");
        const filename = path.join(row.outputRoot, entry);
        const stat = await fs.lstat(filename);
        const previous = emittedEntries.get(entry);
        if (
          stat.isSymbolicLink() ||
          stat.uid !== process.geteuid() ||
          (stat.mode & 0o022) !== 0 ||
          (entry === "calculator"
            ? !stat.isDirectory()
            : !stat.isFile() || stat.nlink !== 1) ||
          (await fs.realpath(filename)) !== filename ||
          (previous !== undefined &&
            (previous.dev !== stat.dev || previous.ino !== stat.ino))
        )
          throw new Error("Common build output ownership changed");
        found.add(entry);
        if (previous === undefined)
          emittedEntries.set(entry, { dev: stat.dev, ino: stat.ino });
        if (entry === "calculator") await inspect(entry);
      }
    };
    await inspect("");
    for (const entry of emittedEntries.keys())
      if (!found.has(entry))
        throw new Error("Common build output ownership changed");
  };
  if ((await fs.readdir(row.outputRoot)).length !== 0)
    throw new Error("Common build output must be empty");
  await emitDesktopCommon(
    row.outputRoot,
    row.productionMode,
    context,
    browserDefine,
    verifyOwnership,
  );
  return Object.freeze({
    outputRoot: row.outputRoot,
    identity: context.identity,
  });
}

async function emitDesktopCommon(
  outputRoot,
  productionMode,
  desktopContext,
  browserDefine,
  verifyOwnership = async () => {},
) {
  const phase = async (operation) => {
    await verifyOwnership();
    await operation();
    await verifyOwnership();
  };
  const sourceRoot = path.join(repositoryRoot, "apps", "desktop", "src");
  await phase(() =>
    build({
      bundle: true,
      define: desktopContext.mainDefine,
      entryPoints: [path.join(sourceRoot, "main.ts")],
      external: ["electron"],
      format: "esm",
      outdir: outputRoot,
      platform: "node",
      sourcemap: !productionMode,
      target: "node24",
    }),
  );
  await phase(() =>
    build({
      bundle: true,
      define: browserDefine,
      entryPoints: [path.join(sourceRoot, "preload.ts")],
      external: ["electron"],
      format: "cjs",
      outfile: path.join(outputRoot, "preload.cjs"),
      platform: "node",
      sourcemap: !productionMode,
      target: "node24",
    }),
  );
  await phase(() =>
    build({
      bundle: true,
      define: browserDefine,
      entryPoints: {
        "calculator/host": path.join(sourceRoot, "calculator", "host.ts"),
        renderer: path.join(sourceRoot, "renderer.ts"),
      },
      format: "esm",
      outdir: outputRoot,
      platform: "browser",
      sourcemap: !productionMode,
      target: "chrome136",
    }),
  );
  await phase(() =>
    Promise.all(
      ["index.html", "styles.css"].map((filename) =>
        fs.copyFile(
          path.join(sourceRoot, filename),
          path.join(outputRoot, filename),
        ),
      ),
    ),
  );
  await phase(() =>
    fs.mkdir(path.join(outputRoot, "calculator"), { recursive: true }),
  );
  await phase(() =>
    fs.writeFile(
      path.join(outputRoot, "build-identity.json"),
      `${desktopContext.identityJson}\n`,
      { flag: "wx" },
    ),
  );
  await phase(() =>
    Promise.all(
      ["index.html", "styles.css"].map((filename) =>
        fs.copyFile(
          path.join(sourceRoot, "calculator", filename),
          path.join(outputRoot, "calculator", filename),
        ),
      ),
    ),
  );
}

async function readCandidateInputs(argument) {
  const relative = path.relative(repositoryRoot, path.resolve(argument));
  if (
    !/^artifacts\/unsigned-artifact-runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/build-inputs\.json$/u.test(
      relative,
    )
  ) {
    throw new Error("Candidate inputs must use the owned run path");
  }
  let current = repositoryRoot;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Candidate input ancestor is invalid");
  }
  const handle = await fs.open(
    path.resolve(argument),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384)
      throw new Error("Candidate input file is invalid");
    const inputs = parseClientBuildInputs(
      JSON.parse(await handle.readFile("utf8")),
    );
    if (
      inputs === null ||
      inputs.platform !== process.platform ||
      inputs.architecture !== process.arch ||
      inputs.tools.node.version !== process.versions.node
    ) {
      throw new Error("Candidate inputs do not match the build runtime");
    }
    return inputs;
  } finally {
    await handle.close();
  }
}

async function runCommandLine() {
  const appName = process.argv[2];
  if (appName !== "desktop" && appName !== "web") {
    throw new Error("build-app expects exactly one app name: desktop or web");
  }

  const appRoot = path.join(repositoryRoot, "apps", appName);
  const sourceRoot = path.join(appRoot, "src");
  const outputRoot = path.join(appRoot, "dist");
  const productionMode = process.argv.includes("--production");
  const rawBuildConfiguration =
    appName === "desktop"
      ? {
          environment: process.env.DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT,
          url: process.env.DESMOSLOCK_PUBLIC_BACKEND_URL,
        }
      : {
          environment: process.env.DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT,
          url: process.env.DESMOSLOCK_PUBLIC_BACKEND_URL,
          origin: process.env.DESMOSLOCK_PUBLIC_WEB_ORIGIN,
          publishableKey:
            process.env.DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        };
  const browserDefine = createAppBrowserDefine(appName, rawBuildConfiguration);
  const candidateArguments = process.argv
    .slice(3)
    .filter((argument) => argument.startsWith("--candidate-inputs"));
  const candidateIndex = process.argv.indexOf("--candidate-inputs", 3);
  if (
    candidateArguments.length > 1 ||
    (candidateArguments.length === 1 && candidateIndex < 0) ||
    (candidateIndex >= 0 &&
      (appName !== "desktop" ||
        !productionMode ||
        process.argv[candidateIndex + 1] === undefined))
  ) {
    throw new Error("Candidate build arguments are invalid");
  }
  const desktopContext =
    appName === "desktop"
      ? createDesktopBuildContext(
          candidateIndex < 0
            ? null
            : await readCandidateInputs(process.argv[candidateIndex + 1]),
          rawBuildConfiguration,
        )
      : null;

  await fs.rm(outputRoot, { force: true, recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });

  if (appName === "desktop") {
    await buildDesktopDurableRecord();
    await buildDesktopAACProtection();
    await emitDesktopCommon(
      outputRoot,
      productionMode,
      desktopContext,
      browserDefine,
    );
  } else {
    await build({
      bundle: true,
      define: browserDefine,
      entryPoints: [path.join(sourceRoot, "main.ts")],
      format: "esm",
      outdir: outputRoot,
      platform: "browser",
      sourcemap: !productionMode,
      target: "chrome136",
    });
    await Promise.all(
      ["index.html", "styles.css"].map((filename) =>
        fs.copyFile(
          path.join(sourceRoot, filename),
          path.join(outputRoot, filename),
        ),
      ),
    );
    await fs.mkdir(path.join(outputRoot, "auth"), { recursive: true });
    await fs.copyFile(
      path.join(sourceRoot, "auth", "staff-auth.css"),
      path.join(outputRoot, "auth", "staff-auth.css"),
    );
    await fs.mkdir(path.join(outputRoot, "school-settings"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(sourceRoot, "school-settings", "school-settings.css"),
      path.join(outputRoot, "school-settings", "school-settings.css"),
    );
    await fs.mkdir(path.join(outputRoot, "test-workspace"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(sourceRoot, "test-workspace", "test-workspace.css"),
      path.join(outputRoot, "test-workspace", "test-workspace.css"),
    );
    await fs.mkdir(path.join(outputRoot, "student-sessions"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(sourceRoot, "student-sessions", "student-session.css"),
      path.join(outputRoot, "student-sessions", "student-session.css"),
    );
  }
}

if (process.argv[1] === scriptPath) {
  await runCommandLine();
}
