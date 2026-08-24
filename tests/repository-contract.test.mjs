import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

test("v2 uses one typed npm workspace beside legacy v1", () => {
  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.workspaces, ["apps/*", "packages/*"]);
  assert.equal(rootPackage.private, true);
  assert.match(rootPackage.packageManager, /^npm@\d+\.\d+\.\d+/);

  for (const relativePath of [
    "package-lock.json",
    "tsconfig.base.json",
    "eslint.config.js",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/domain/package.json",
    "packages/contracts/package.json",
    "packages/test-support/package.json",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, relativePath)),
      true,
      `${relativePath} is required`,
    );
  }

  for (const workspace of [
    "apps/desktop",
    "apps/web",
    "packages/domain",
    "packages/contracts",
    "packages/test-support",
  ]) {
    const workspacePackage = readJson(`${workspace}/package.json`);
    assert.equal(
      workspacePackage.private,
      true,
      `${workspace} must not be publishable`,
    );
    assert.equal(
      typeof workspacePackage.scripts?.build,
      "string",
      `${workspace} must expose build`,
    );
    assert.equal(
      typeof workspacePackage.scripts?.typecheck,
      "string",
      `${workspace} must expose typecheck`,
    );
  }
});

test("v2 data plane is migration-owned and clean-start only", () => {
  for (const relativePath of [
    "supabase/config.toml",
    "supabase/migrations/20260824000100_v2_foundation.sql",
    "supabase/seed.sql",
    "supabase/tests/database/v2_foundation.test.sql",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, relativePath)),
      true,
      `${relativePath} is required`,
    );
  }

  const migration = fs.readFileSync(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260824000100_v2_foundation.sql",
    ),
    "utf8",
  );
  const seed = fs.readFileSync(
    path.join(repositoryRoot, "supabase/seed.sql"),
    "utf8",
  );
  const legacyProductTables = [
    "alerts",
    "invites",
    "quote_requests",
    "schools",
    "students",
    "teachers",
  ];

  assert.match(migration, /create schema if not exists desmoslock_v2/i);
  assert.match(migration, /enable row level security/i);
  assert.doesNotMatch(
    `${migration}\n${seed}`,
    /\b(insert|copy)\s+into\s+(?:public\.)?(?:teachers|students|schools|invites|quote_requests|alerts)\b/i,
  );
  for (const table of legacyProductTables) {
    assert.doesNotMatch(seed, new RegExp(`\\b${table}\\b`, "i"));
  }
});

test("legacy v1 and test-only support cannot enter a v2 release path", () => {
  const rootPackage = readJson("package.json");
  const desktopPackage = readJson("apps/desktop/package.json");
  const testSupportPackage = readJson("packages/test-support/package.json");
  const webPackage = readJson("apps/web/package.json");
  const vercel = readJson("vercel.json");
  const releaseWorkflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );

  assert.equal(
    rootPackage.scripts?.["verify:repository"],
    "node scripts/verify-repository-contract.mjs",
  );
  assert.equal(
    vercel.ignoreCommand,
    "node scripts/ignore-legacy-vercel-build.mjs",
  );
  assert.equal(
    vercel.buildCommand,
    "node scripts/refuse-legacy-vercel-build.mjs",
  );
  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "scripts/verify-repository-contract.mjs"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "scripts/ignore-legacy-vercel-build.mjs"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "scripts/refuse-legacy-vercel-build.mjs"),
    ),
    true,
  );
  assert.equal(
    desktopPackage.dependencies?.["@desmoslock/test-support"],
    undefined,
  );
  assert.equal(
    webPackage.dependencies?.["@desmoslock/test-support"],
    undefined,
  );
  assert.equal(
    testSupportPackage.exports?.["."]?.["desmoslock-test"],
    "./dist/index.js",
  );
  assert.equal(testSupportPackage.exports?.["."]?.default, "./dist/blocked.js");
  assert.match(
    releaseWorkflow,
    /Legacy v1 release is disabled during v2 expansion/,
  );
  assert.doesNotMatch(releaseWorkflow, /^\s+tags:\s*$/m);
});
