import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { buildDesktopDurableRecord } from "./build-desktop-durable-record.mjs";
import { buildDesktopAACProtection } from "./build-desktop-aac-protection.mjs";

import {
  parsePublicBackendConfiguration,
  parsePublicStaffAuthConfiguration,
} from "../packages/contracts/dist/index.js";

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

  await fs.rm(outputRoot, { force: true, recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });

  if (appName === "desktop") {
    await buildDesktopDurableRecord();
    await buildDesktopAACProtection();
    await build({
      bundle: true,
      define: browserDefine,
      entryPoints: [path.join(sourceRoot, "main.ts")],
      external: ["electron"],
      format: "esm",
      outdir: outputRoot,
      platform: "node",
      sourcemap: !productionMode,
      target: "node24",
    });
    await build({
      bundle: true,
      define: browserDefine,
      entryPoints: [path.join(sourceRoot, "preload.ts")],
      external: ["electron"],
      format: "cjs",
      outfile: path.join(outputRoot, "preload.cjs"),
      platform: "node",
      sourcemap: !productionMode,
      target: "node24",
    });
    await build({
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
    });
    await Promise.all(
      ["index.html", "styles.css"].map((filename) =>
        fs.copyFile(
          path.join(sourceRoot, filename),
          path.join(outputRoot, filename),
        ),
      ),
    );
    await fs.mkdir(path.join(outputRoot, "calculator"), { recursive: true });
    await Promise.all(
      ["index.html", "styles.css"].map((filename) =>
        fs.copyFile(
          path.join(sourceRoot, "calculator", filename),
          path.join(outputRoot, "calculator", filename),
        ),
      ),
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
