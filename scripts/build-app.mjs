import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

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

await fs.rm(outputRoot, { force: true, recursive: true });
await fs.mkdir(outputRoot, { recursive: true });

if (appName === "desktop") {
  await build({
    bundle: true,
    entryPoints: [
      path.join(sourceRoot, "main.ts"),
      path.join(sourceRoot, "preload.ts"),
    ],
    external: ["electron"],
    format: "esm",
    outdir: outputRoot,
    platform: "node",
    sourcemap: true,
    target: "node24",
  });
  await build({
    bundle: true,
    entryPoints: [path.join(sourceRoot, "renderer.ts")],
    format: "esm",
    outdir: outputRoot,
    platform: "browser",
    sourcemap: true,
    target: "chrome136",
  });
  await fs.copyFile(
    path.join(sourceRoot, "index.html"),
    path.join(outputRoot, "index.html"),
  );
} else {
  await build({
    bundle: true,
    entryPoints: [path.join(sourceRoot, "main.ts")],
    format: "esm",
    outdir: outputRoot,
    platform: "browser",
    sourcemap: true,
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
