import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { parsePublicBackendConfiguration } from "../packages/contracts/dist/index.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appName = process.argv[2];

if (appName !== "desktop" && appName !== "web") {
  throw new Error("build-app expects exactly one app name: desktop or web");
}

const appRoot = path.join(repositoryRoot, "apps", appName);
const sourceRoot = path.join(appRoot, "src");
const outputRoot = path.join(appRoot, "dist");
const productionMode = process.argv.includes("--production");
const publicBackendConfiguration = parsePublicBackendConfiguration({
  environment: process.env.DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT,
  url: process.env.DESMOSLOCK_PUBLIC_BACKEND_URL,
});

if (publicBackendConfiguration === null) {
  throw new Error("Public backend build configuration is invalid");
}

const browserDefine = {
  __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: JSON.stringify(
    publicBackendConfiguration.environment,
  ),
  __DESMOSLOCK_PUBLIC_BACKEND_URL__: JSON.stringify(
    publicBackendConfiguration.url,
  ),
};

await fs.rm(outputRoot, { force: true, recursive: true });
await fs.mkdir(outputRoot, { recursive: true });

if (appName === "desktop") {
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
}
