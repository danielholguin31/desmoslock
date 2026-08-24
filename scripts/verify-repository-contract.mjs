import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedWorkspaces = [
  "apps/desktop",
  "apps/web",
  "packages/contracts",
  "packages/domain",
  "packages/test-support",
];
const productionWorkspaces = expectedWorkspaces.filter(
  (workspace) => workspace !== "packages/test-support",
);
const forbiddenProductionPatterns = [
  ["arbitrary backend URL", /\bserverUrl\b|\ballowServer\b/],
  ["legacy LAN origin", /localhost:4000|127\.0\.0\.1:4000/],
  ["Linux package", /\bAppImage\b|--linux\b/],
  ["manual licensing", /manual[- ]licen[sc]/i],
  ["quote intake", /\bquote_requests\b|\bquote form\b/i],
  ["test support import", /@desmoslock\/test-support/],
];

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function countMatches(contents, pattern) {
  return [...contents.matchAll(pattern)].length;
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...walkFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

const rootPackage = readJson("package.json");
if (
  JSON.stringify(rootPackage.workspaces) !==
  JSON.stringify(["apps/*", "packages/*"])
) {
  fail("Root workspaces must include only apps/* and packages/*");
}
for (const legacyDirectory of ["desktop", "server", "web"]) {
  if (
    rootPackage.workspaces.some((workspace) =>
      workspace.includes(legacyDirectory),
    )
  ) {
    fail(`Legacy ${legacyDirectory} must not be an npm workspace`);
  }
}

const workspacePaths = expectedWorkspaces.filter((workspace) =>
  fs.existsSync(path.join(repositoryRoot, workspace, "package.json")),
);
if (JSON.stringify(workspacePaths) !== JSON.stringify(expectedWorkspaces)) {
  fail(`Workspace inventory differs: ${workspacePaths.join(", ")}`);
}

for (const workspace of expectedWorkspaces) {
  const manifest = readJson(`${workspace}/package.json`);
  if (manifest.private !== true) fail(`${workspace} must remain private`);
  if (
    manifest.scripts?.publish !== undefined ||
    manifest.scripts?.prepublishOnly !== undefined
  ) {
    fail(`${workspace} must not expose a publication script`);
  }
}

for (const workspace of productionWorkspaces) {
  const manifest = readJson(`${workspace}/package.json`);
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  if (dependencies["@desmoslock/test-support"] !== undefined) {
    fail(`${workspace} depends on test-only support`);
  }

  for (const sourceRoot of ["src", "dist"]) {
    const absoluteRoot = path.join(repositoryRoot, workspace, sourceRoot);
    if (!fs.existsSync(absoluteRoot)) {
      continue;
    }
    for (const file of walkFiles(absoluteRoot)) {
      const contents = fs.readFileSync(file, "utf8");
      for (const [label, pattern] of forbiddenProductionPatterns) {
        if (pattern.test(contents)) {
          fail(
            `${path.relative(repositoryRoot, file)} contains forbidden ${label}`,
          );
        }
      }
    }
  }
}

const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, ".github/workflows/release.yml"),
  "utf8",
);
if (
  !releaseWorkflow.includes("Legacy v1 release is disabled during v2 expansion")
) {
  fail("Legacy release workflow is not explicitly disabled");
}
if (/^\s+tags:\s*$/m.test(releaseWorkflow)) {
  fail("Legacy release workflow still reacts to tag pushes");
}

const vercel = readJson("vercel.json");
if (vercel.ignoreCommand !== "node scripts/ignore-legacy-vercel-build.mjs") {
  fail("Legacy Vercel project does not ignore every build");
}
if (vercel.buildCommand !== "node scripts/refuse-legacy-vercel-build.mjs") {
  fail("Direct legacy Vercel builds are not blocked");
}

const testSupport = readJson("packages/test-support/package.json");
if (
  testSupport.exports?.["."]?.["desmoslock-test"] !== "./dist/index.js" ||
  testSupport.exports?.["."]?.default !== "./dist/blocked.js"
) {
  fail("Test support must expose implementation only through desmoslock-test");
}

for (const workspaceRoot of ["apps", "packages"]) {
  const nestedLockfiles = walkFiles(
    path.join(repositoryRoot, workspaceRoot),
  ).filter((file) => path.basename(file) === "package-lock.json");
  if (nestedLockfiles.length > 0) {
    fail(
      `v2 workspaces must use only the root lockfile: ${nestedLockfiles
        .map((file) => path.relative(repositoryRoot, file))
        .join(", ")}`,
    );
  }
}

const evidenceContracts = readText(
  "tests/evidence/audited-release.contract.test.ts",
);
if (!evidenceContracts.includes("ddcfce456f3cf015ab77d207310140a311c945ab")) {
  fail("v2 evidence contracts are not bound to the audited release commit");
}
for (const [prefix, expectedCount] of [
  ["REC", 9],
  ["PROV", 13],
  ["GK", 15],
]) {
  const actualCount = countMatches(
    evidenceContracts,
    new RegExp(`it\\.todo\\(\\s*["']${prefix}-`, "gu"),
  );
  if (actualCount !== expectedCount) {
    fail(
      `${prefix} v2 evidence contract count differs: expected ${expectedCount}, received ${actualCount}`,
    );
  }
}

const ciWorkflow = readText(".github/workflows/ci.yml");
const securityWorkflow = readText(".github/workflows/security.yml");
for (const command of [
  "npm ci",
  "npm run format:check",
  "npm run lint",
  "npm run typecheck",
  "npm run test:unit",
  "npm run test:evidence",
  "npm run db:reset",
  "npm run test:db",
  "npm run test:edge",
  "npm run test:web",
  "npm run test:electron",
  "npm run test:dependencies",
  "npm run test:secrets",
  "npm run test:workflows",
  "npm run verify:locks",
  "npm run sbom",
  "npm run verify:licenses",
  "npm run verify:packages",
  "npx playwright install --with-deps chromium",
]) {
  if (!ciWorkflow.includes(command)) {
    fail(`Required CI command is missing: ${command}`);
  }
}
if (
  !ciWorkflow.includes("DESMOSLOCK_FORCE_REQUIRED_CHECK_FAILURE") ||
  !ciWorkflow.includes("- required-check-probe") ||
  !ciWorkflow.includes("name: Required v2 verification")
) {
  fail(
    "Required CI aggregate is not wired through the deliberate failure probe",
  );
}
if (!securityWorkflow.includes("name: Security required")) {
  fail("Security workflow does not expose its required aggregate");
}
for (const workflow of [ciWorkflow, securityWorkflow]) {
  for (const match of workflow.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gmu)) {
    if (!/@[0-9a-f]{40}$/u.test(match[1])) {
      fail(`Required workflow action is not pinned by commit: ${match[1]}`);
    }
  }
}

const codeowners = readText(".github/CODEOWNERS");
if (
  !codeowners.includes("/.github/workflows/ @danielholguin31 @nicolasdmolina")
) {
  fail("Required workflows do not have a CODEOWNER");
}
for (const forbiddenScript of [
  "app",
  "dev",
  "dist",
  "publish:installers",
  "server",
]) {
  if (rootPackage.scripts?.[forbiddenScript] !== undefined) {
    fail(`Root manifest restores forbidden legacy script: ${forbiddenScript}`);
  }
}

const lockfile = readJson("package-lock.json");
const lockWorkspaces = Object.keys(lockfile.packages)
  .filter((entry) => entry !== "" && lockfile.packages[entry]?.link !== true)
  .filter((entry) => expectedWorkspaces.includes(entry))
  .sort();
if (
  JSON.stringify(lockWorkspaces) !==
  JSON.stringify([...expectedWorkspaces].sort())
) {
  fail(`Lockfile workspace inventory differs: ${lockWorkspaces.join(", ")}`);
}

process.stdout.write(
  "Repository contract verified: v2-only workspaces and release paths are guarded.\n",
);
