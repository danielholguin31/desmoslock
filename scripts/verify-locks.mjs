import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const lockPath = path.join(repositoryRoot, "package-lock.json");
const lockContents = fs.readFileSync(lockPath, "utf8");
const lockfile = JSON.parse(lockContents);
const expectedWorkspaces = [
  "apps/desktop",
  "apps/web",
  "packages/contracts",
  "packages/domain",
  "packages/test-support",
];

if (lockfile.lockfileVersion !== 3) {
  throw new Error(
    `Expected npm lockfileVersion 3, received ${lockfile.lockfileVersion}`,
  );
}
if (
  JSON.stringify(lockfile.packages?.[""]?.workspaces) !==
  JSON.stringify(packageJson.workspaces)
) {
  throw new Error("Root package and lockfile workspace declarations differ");
}
if (
  JSON.stringify(lockfile.packages?.[""]?.devDependencies) !==
  JSON.stringify(packageJson.devDependencies)
) {
  throw new Error("Root package and lockfile development dependencies differ");
}

for (const workspace of expectedWorkspaces) {
  if (lockfile.packages?.[workspace] === undefined) {
    throw new Error(`Root lockfile is missing workspace ${workspace}`);
  }
}

for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (
    location === "" ||
    expectedWorkspaces.includes(location) ||
    metadata.link === true
  ) {
    continue;
  }
  if (!location.startsWith("node_modules/")) {
    throw new Error(`Unexpected non-workspace lockfile entry: ${location}`);
  }
  if (
    typeof metadata.resolved !== "string" ||
    !metadata.resolved.startsWith("https://registry.npmjs.org/")
  ) {
    throw new Error(`${location} is not pinned to the npm registry`);
  }
  if (
    typeof metadata.integrity !== "string" ||
    !/^sha(256|384|512)-/u.test(metadata.integrity)
  ) {
    throw new Error(`${location} is missing a cryptographic integrity value`);
  }
}

for (const workspaceRoot of ["apps", "packages"]) {
  const pending = [path.join(repositoryRoot, workspaceRoot)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist" && entry.name !== "node_modules") {
          pending.push(absolutePath);
        }
      } else if (entry.name === "package-lock.json") {
        throw new Error(
          `Nested v2 lockfile is forbidden: ${path.relative(repositoryRoot, absolutePath)}`,
        );
      }
    }
  }
}

const sha256 = crypto.createHash("sha256").update(lockContents).digest("hex");
process.stdout.write(`Root lockfile verified: sha256:${sha256}\n`);
