import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectories = [
  "apps/desktop/dist",
  "apps/web/dist",
  "packages/contracts/dist",
  "packages/domain/dist",
  "packages/test-support/dist",
];
const expectedOutputs = [
  "apps/desktop/dist/calculator/host.js",
  "apps/desktop/dist/calculator/index.html",
  "apps/desktop/dist/calculator/styles.css",
  "apps/desktop/dist/index.html",
  "apps/desktop/dist/main.js",
  "apps/desktop/dist/preload.cjs",
  "apps/desktop/dist/renderer.js",
  "apps/desktop/dist/styles.css",
  ...(process.platform === "darwin"
    ? [
        "apps/desktop/dist/native/aac-protection.node",
        "apps/desktop/dist/native/durable-record.node",
      ]
    : []),
  "apps/web/dist/auth/staff-auth.css",
  "apps/web/dist/school-settings/school-settings.css",
  "apps/web/dist/test-workspace/test-workspace.css",
  "apps/web/dist/student-sessions/student-session.css",
  "apps/web/dist/main.js",
  "packages/contracts/dist/index.js",
  "packages/domain/dist/index.js",
  "packages/test-support/dist/index.js",
];

test("the documented aggregate app build succeeds without generated workspace artifacts", async () => {
  const runbook = await fs.readFile(
    path.join(
      repositoryRoot,
      "docs/product-completion/reproducible-supabase.md",
    ),
    "utf8",
  );
  assert.deepEqual(
    [...runbook.matchAll(/^npm run build(?::[a-z-]+)?$/gmu)].map(
      ([command]) => command,
    ),
    ["npm run build", "npm run build"],
  );

  for (const relativePath of generatedDirectories) {
    await fs.rm(path.join(repositoryRoot, relativePath), {
      force: true,
      recursive: true,
    });
  }
  for (const relativePath of generatedDirectories) {
    await assert.rejects(() =>
      fs.access(path.join(repositoryRoot, relativePath)),
    );
  }

  const npmCli = process.env.npm_execpath;
  assert.equal(typeof npmCli, "string", "test must run through npm");
  const isolatedRoot = path.join(
    repositoryRoot,
    "node_modules/.cache/clean-build",
  );
  await fs.mkdir(isolatedRoot, { recursive: true });
  const emptyGlobalConfig = path.join(isolatedRoot, "empty-global-npmrc");
  await fs.writeFile(emptyGlobalConfig, "", { mode: 0o600 });
  const temporaryDirectory =
    process.env.TMPDIR ?? path.join(isolatedRoot, "tmp");
  await fs.mkdir(temporaryDirectory, { recursive: true });
  // Keep the documented build independent of private home npm configuration.
  // Only these selected compiler/SDK paths cross into the child environment.
  const nativeEnvironment = Object.fromEntries(
    [
      "DESMOSLOCK_NATIVE_CLANG",
      "DESMOSLOCK_NATIVE_SDK",
      "DESMOSLOCK_NATIVE_NODE_HEADERS",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
      DESMOSLOCK_PUBLIC_BACKEND_URL: "http://127.0.0.1:54321",
      DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc",
      DESMOSLOCK_PUBLIC_WEB_ORIGIN: "http://127.0.0.1:43173",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "",
      TMPDIR: temporaryDirectory,
      TMP: temporaryDirectory,
      TEMP: temporaryDirectory,
      NODE_DISABLE_COMPILE_CACHE: "1",
      COREPACK_ENABLE_NETWORK: "0",
      npm_config_cache:
        process.env.npm_config_cache ?? path.join(isolatedRoot, "npm"),
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: emptyGlobalConfig,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      ...nativeEnvironment,
    },
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 60_000,
  });

  assert.equal(
    result.status,
    0,
    "documented aggregate build must succeed from zero generated artifacts",
  );
  for (const relativePath of expectedOutputs) {
    const stat = await fs.stat(path.join(repositoryRoot, relativePath));
    assert.equal(stat.isFile(), true, `${relativePath} must be built`);
  }
  if (process.platform !== "darwin") {
    for (const filename of ["aac-protection.node", "durable-record.node"])
      await assert.rejects(() =>
        fs.access(
          path.join(repositoryRoot, "apps/desktop/dist/native", filename),
        ),
      );
  }
});
