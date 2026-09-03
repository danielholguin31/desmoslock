import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertLegacyReleaseTombstone,
  expectedLegacyReleaseTombstone,
} from "../scripts/release-tombstone-contract.mjs";
import {
  assertPublicWebCiWorkflow,
  assertStaffAuthCiWorkflow,
} from "../scripts/repository-contract/ci-contract.mjs";
import {
  assertMigrationSetAttestation,
  assertSupabaseAuthConfiguration,
  expectedMigrationAttestations,
  expectedMigrationFiles,
  expectedMigrationSetSha256,
} from "../scripts/repository-contract/supabase-contract.mjs";
import {
  assertToolchainManifestContract,
  assertWorkflowToolchain,
} from "../scripts/repository-contract/toolchain-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function gitIsAncestor(ancestor, descendant) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
    }).status === 0
  );
}

test("v2 uses one typed npm workspace beside legacy v1", () => {
  const rootPackage = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const knownInternalPackages = new Set([
    "@desmoslock/contracts",
    "@desmoslock/desktop",
    "@desmoslock/domain",
    "@desmoslock/test-support",
    "@desmoslock/web",
  ]);

  assert.deepEqual(rootPackage.workspaces, ["apps/*", "packages/*"]);
  assert.equal(rootPackage.private, true);
  assert.match(
    rootPackage.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
  assert.match(rootPackage.packageManager, /^npm@\d+\.\d+\.\d+/);
  assert.equal(lockfile.packages[""].version, rootPackage.version);
  for (const dependencySection of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [dependency, version] of Object.entries(
      rootPackage[dependencySection] ?? {},
    )) {
      if (!dependency.startsWith("@desmoslock/")) continue;
      assert.equal(knownInternalPackages.has(dependency), true);
      assert.equal(version, rootPackage.version);
      assert.equal(
        lockfile.packages[""][dependencySection]?.[dependency],
        version,
      );
    }
  }

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
      workspacePackage.version,
      rootPackage.version,
      `${workspace} version must equal the root version`,
    );
    assert.equal(
      lockfile.packages[workspace].version,
      rootPackage.version,
      `${workspace} lockfile version must equal the root version`,
    );
    assert.equal(
      lockfile.packages[workspace].name,
      workspacePackage.name,
      `${workspace} lockfile name must equal its manifest`,
    );
    assert.deepEqual(
      lockfile.packages[`node_modules/${workspacePackage.name}`],
      { resolved: workspace, link: true },
      `${workspacePackage.name} must be a workspace link`,
    );
    for (const dependencySection of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [dependency, version] of Object.entries(
        workspacePackage[dependencySection] ?? {},
      )) {
        if (!dependency.startsWith("@desmoslock/")) continue;
        assert.equal(
          knownInternalPackages.has(dependency),
          true,
          `${workspace} references unknown internal package ${dependency}`,
        );
        assert.equal(
          version,
          rootPackage.version,
          `${workspace} ${dependency} must use the exact root version`,
        );
      }
    }
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

test("repository pins the exact Node.js, npm, type, and web client toolchain", () => {
  const workspacePackages = Object.fromEntries(
    [
      "apps/desktop",
      "apps/web",
      "packages/contracts",
      "packages/domain",
      "packages/test-support",
    ].map((workspace) => [workspace, readJson(`${workspace}/package.json`)]),
  );
  const manifestContract = {
    lockfile: readJson("package-lock.json"),
    nodeVersion: readText(".node-version"),
    rootPackage: readJson("package.json"),
    workspacePackages,
  };

  assert.doesNotThrow(() => assertToolchainManifestContract(manifestContract));
  assert.throws(
    () =>
      assertToolchainManifestContract({
        ...manifestContract,
        rootPackage: {
          ...manifestContract.rootPackage,
          engines: { node: ">=24" },
        },
      }),
    /engine must pin 24\.20\.0/u,
  );
  assert.throws(
    () =>
      assertToolchainManifestContract({
        ...manifestContract,
        workspacePackages: {
          ...workspacePackages,
          "apps/web": {
            ...workspacePackages["apps/web"],
            dependencies: {
              ...workspacePackages["apps/web"].dependencies,
              "@supabase/supabase-js": "^2.115.0",
            },
          },
        },
      }),
    /Only apps\/web may depend directly/u,
  );

  for (const [workflowPath, expectedJobCount] of [
    [".github/workflows/ci.yml", 9],
    [".github/workflows/security.yml", 1],
  ]) {
    const workflow = readText(workflowPath);
    assert.doesNotThrow(() =>
      assertWorkflowToolchain(workflow, workflowPath, expectedJobCount),
    );
    assert.throws(
      () =>
        assertWorkflowToolchain(
          workflow.replace("node-version: 24.20.0", "node-version: 24"),
          workflowPath,
          expectedJobCount,
        ),
      /exact Node\.js\/npm setup/u,
    );
    assert.throws(
      () =>
        assertWorkflowToolchain(
          workflow.replace(
            'test "$(npm --version)" = "11.12.1"',
            'test "$(npm --version)" = "11"',
          ),
          workflowPath,
          expectedJobCount,
        ),
      /exact Node\.js\/npm setup/u,
    );
  }
});

test("v2 data plane is migration-owned and clean-start only", () => {
  for (const relativePath of [
    "supabase/config.toml",
    "supabase/migrations/20260824000100_v2_foundation.sql",
    "supabase/migrations/20260828000100_internal_release_backend.sql",
    "supabase/migrations/20260903000100_staff_auth_lifecycle.sql",
    "supabase/migrations/20260903000200_staff_auth_generation_4.sql",
    "supabase/seed.sql",
    "supabase/tests/database/internal_release_backend.test.sql",
    "supabase/tests/database/staff_auth_generation_4.test.sql",
    "supabase/tests/database/staff_auth_lifecycle.test.sql",
    "supabase/tests/database/v2_foundation.test.sql",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, relativePath)),
      true,
      `${relativePath} is required`,
    );
  }

  const buildScript = readText("scripts/build-app.mjs");
  assert.doesNotMatch(
    buildScript,
    /DESMOSLOCK_PUBLIC_BACKEND_(?:ENVIRONMENT|URL)[\s\S]{0,80}\?\?/u,
    "public app builds must not default missing backend configuration",
  );

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

test("generation-4 Supabase configuration is versioned and fails closed", () => {
  const configuration = readText("supabase/config.toml");
  const runbook = readText("docs/product-completion/reproducible-supabase.md");
  const authStart = configuration.indexOf("[auth]\n");
  const nextSection = configuration.indexOf("\n[", authStart + 1);
  const authSection = configuration.slice(
    authStart,
    nextSection === -1 ? undefined : nextSection,
  );

  assert.match(
    configuration,
    /^schemas = \["public", "graphql_public", "desmoslock_v2"\]$/mu,
  );
  assert.match(configuration, /^\[functions\.health\]\nverify_jwt = false$/mu);
  assert.notEqual(authStart, -1);
  assert.match(authSection, /^site_url = "https:\/\/desmoslock\.invalid"$/mu);
  assert.match(authSection, /^additional_redirect_urls = \[\]$/mu);
  assert.match(authSection, /^enable_signup = false$/mu);
  assert.match(authSection, /^enable_anonymous_sign_ins = false$/mu);
  assert.doesNotThrow(() => assertSupabaseAuthConfiguration(configuration));
  for (const [label, unsafeConfiguration] of [
    [
      "site URL made routable",
      configuration.replace(
        'site_url = "https://desmoslock.invalid"',
        'site_url = "https://example.com"',
      ),
    ],
    [
      "redirect added",
      configuration.replace(
        "additional_redirect_urls = []",
        'additional_redirect_urls = ["https://example.com"]',
      ),
    ],
    [
      "global signup enabled",
      configuration.replace("enable_signup = false", "enable_signup = true"),
    ],
    [
      "anonymous sign-in enabled",
      configuration.replace(
        "enable_anonymous_sign_ins = false",
        "enable_anonymous_sign_ins = true",
      ),
    ],
    [
      "email confirmations disabled",
      configuration.replace(
        "enable_confirmations = true",
        "enable_confirmations = false",
      ),
    ],
    [
      "email resend interval reduced",
      configuration.replace('max_frequency = "1m"', 'max_frequency = "1s"'),
    ],
    [
      "email OTP shortened",
      configuration.replace("otp_length = 8", "otp_length = 6"),
    ],
    [
      "TOTP enrollment disabled",
      configuration.replace("enroll_enabled = true", "enroll_enabled = false"),
    ],
    [
      "TOTP verification disabled",
      configuration.replace("verify_enabled = true", "verify_enabled = false"),
    ],
  ]) {
    assert.throws(
      () => assertSupabaseAuthConfiguration(unsafeConfiguration),
      undefined,
      label,
    );
  }
  assert.deepEqual(
    [...runbook.matchAll(/^npm run build(?::[a-z-]+)?$/gmu)].map(
      ([command]) => command,
    ),
    ["npm run build", "npm run build"],
    "both configured app examples use the clean-working aggregate build",
  );
  for (const [workflowPath, expectedBuilds] of [
    [".github/workflows/ci.yml", 2],
    [".github/workflows/security.yml", 1],
  ]) {
    const workflow = readText(workflowPath);
    assert.equal(
      [...workflow.matchAll(/^\s+- run: npm run build$/gmu)].length,
      expectedBuilds,
      `${workflowPath} has the expected app build count`,
    );
    assert.equal(
      [
        ...workflow.matchAll(
          /^\s+- run: npm run build\n\s+env:\n\s+DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: local\n\s+DESMOSLOCK_PUBLIC_BACKEND_URL: http:\/\/127\.0\.0\.1:54321\n\s+DESMOSLOCK_PUBLIC_WEB_ORIGIN: http:\/\/localhost:43174\n\s+DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc$/gmu,
        ),
      ].length,
      expectedBuilds,
      `${workflowPath} configures every app build explicitly`,
    );
  }
});

test("generation-4 attests the exact normalized migration history", () => {
  const migrations = expectedMigrationFiles.map((fileName) => [
    fileName,
    readText(`supabase/migrations/${fileName}`),
  ]);

  assert.deepEqual(expectedMigrationAttestations, {
    "20260828000100_internal_release_backend.sql": {
      migrationSetSha256:
        "06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49",
      rawSha256:
        "1a60d2fb308a8e2cfad102f9c218c319bacd95c33a40801d5b0b731119434f2f",
    },
    "20260903000200_staff_auth_generation_4.sql": {
      migrationSetSha256: expectedMigrationSetSha256,
      rawSha256:
        "4e7321c8d9d6d3e4c27e07ab38d75252a8922868842c40c0723c349c251cac44",
    },
  });
  assert.doesNotThrow(() => assertMigrationSetAttestation(migrations));
  assert.throws(
    () => assertMigrationSetAttestation(migrations.slice(0, -1)),
    /migration files/u,
  );
  assert.throws(
    () =>
      assertMigrationSetAttestation(
        migrations.map(([fileName, source]) => [
          fileName,
          fileName === "20260903000100_staff_auth_lifecycle.sql"
            ? `${source}\n-- drift\n`
            : source,
        ]),
      ),
    /normalized migration-set digest changed/u,
  );
  assert.throws(
    () =>
      assertMigrationSetAttestation(
        migrations.map(([fileName, source]) => [
          fileName,
          fileName === "20260828000100_internal_release_backend.sql"
            ? source.replace(
                expectedMigrationAttestations[fileName].migrationSetSha256,
                expectedMigrationSetSha256,
              )
            : source,
        ]),
      ),
    /does not preserve its historical migration-set attestation/u,
  );
  assert.throws(
    () =>
      assertMigrationSetAttestation(
        migrations.map(([fileName, source]) => [
          fileName,
          fileName === "20260828000100_internal_release_backend.sql"
            ? source.replace("-- Generation 3", "-- Generation three")
            : source,
        ]),
      ),
    /raw migration SHA-256 changed/u,
  );
  assert.throws(
    () =>
      assertMigrationSetAttestation(
        migrations.map(([fileName, source]) => [
          fileName,
          fileName === "20260903000200_staff_auth_generation_4.sql"
            ? source.replace(expectedMigrationSetSha256, "0".repeat(64))
            : source,
        ]),
      ),
    /does not attest the current migration set/u,
  );
});

test("the runbook names every runtime-only staff lifecycle backup guard", () => {
  const runbook = readText("docs/product-completion/reproducible-supabase.md");
  const runtimeLifecycleTables = [
    "application_session_revocation_cutoffs",
    "application_session_revocations",
    "staff_audit_events",
    "staff_invitations",
    "staff_password_recovery_operations",
  ];

  assert.match(runbook, /five runtime-only staff lifecycle tables/u);
  assert.doesNotMatch(runbook, /three staff lifecycle tables/u);
  for (const table of runtimeLifecycleTables) {
    assert.equal(
      runbook.includes(`\`${table}\``),
      true,
      `${table} must remain explicit in the operator runbook`,
    );
  }
});

test("staff Auth schema and prerequisites have a required disposable CI lane", () => {
  const rootPackage = readJson("package.json");
  const workflow = readText(".github/workflows/ci.yml");

  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "tests/acceptance/staff-auth-stack.test.mjs"),
    ),
    true,
  );

  assert.equal(
    rootPackage.scripts?.["test:staff-auth"],
    "npm run test:db && npm run test:staff-auth:stack && npm run test:edge && npm run test:unit",
  );
  assert.equal(
    rootPackage.scripts?.["test:edge"],
    "deno lint supabase/functions && deno test supabase/functions && deno check supabase/functions/health/index.ts supabase/functions/account-recovery/index.ts supabase/functions/staff-invitations/index.ts",
    "the Edge suite must lint all sources and explicitly typecheck every deployed entrypoint",
  );
  assert.equal(
    rootPackage.scripts?.["test:staff-auth:stack"],
    "node --test tests/acceptance/staff-auth-stack.test.mjs",
  );
  assert.doesNotThrow(() => assertStaffAuthCiWorkflow(workflow));
  assert.throws(
    () =>
      assertStaffAuthCiWorkflow(
        workflow.replace(
          "name: Staff Auth schema and prerequisite checks",
          "name: Disposable staff Auth lifecycle",
        ),
      ),
    /schema and prerequisite verification/u,
  );

  const lifecycleSteps = [
    "      - run: npm run db:start:full",
    "      - run: npm run db:reset",
    "      - run: npm run test:staff-auth",
    "      - if: always()",
    "        run: npm run db:stop",
    "",
  ].join("\n");
  const relocatedLifecycleSteps = workflow
    .replace(lifecycleSteps, "")
    .replace("  web:\n", `  web:\n${lifecycleSteps}`);
  assert.notEqual(relocatedLifecycleSteps, workflow);
  assert.throws(
    () => assertStaffAuthCiWorkflow(relocatedLifecycleSteps),
    /full disposable local stack/u,
  );

  const relocatedAggregateNeed = workflow
    .replace("      - staff-auth-lifecycle\n", "")
    .replace("  web:\n", "  web:\n    needs:\n      - staff-auth-lifecycle\n");
  assert.notEqual(relocatedAggregateNeed, workflow);
  assert.throws(
    () => assertStaffAuthCiWorkflow(relocatedAggregateNeed),
    /does not depend on staff-auth-lifecycle/u,
  );
});

test("CI supplies synthetic web configuration without desktop-job leakage", () => {
  const ciWorkflow = readText(".github/workflows/ci.yml");
  const securityWorkflow = readText(".github/workflows/security.yml");

  assert.doesNotThrow(() =>
    assertPublicWebCiWorkflow(ciWorkflow, securityWorkflow),
  );
  assert.throws(
    () =>
      assertPublicWebCiWorkflow(
        ciWorkflow.replace(
          "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc",
          "sb_publishable_invalid",
        ),
        securityWorkflow,
      ),
    /exact synthetic public web origin and publishable key/u,
  );
  assert.throws(
    () =>
      assertPublicWebCiWorkflow(
        ciWorkflow.replace(
          "      - run: xvfb-run -a npm run test:electron",
          [
            "      - run: xvfb-run -a npm run test:electron",
            "        env:",
            "          DESMOSLOCK_PUBLIC_WEB_ORIGIN: http://localhost:43174",
          ].join("\n"),
        ),
        securityWorkflow,
      ),
    /Desktop-specific CI/u,
  );
});

test("synthetic operator reports scoped completion rather than external verification", () => {
  const backupRunner = readText("scripts/synthetic-backup/run.mjs");

  assert.match(backupRunner, /receipt, status: "succeeded"/u);
  assert.doesNotMatch(backupRunner, /receipt, status: "verified"/u);
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
  assert.equal(releaseWorkflow, expectedLegacyReleaseTombstone);
  assert.doesNotThrow(() => assertLegacyReleaseTombstone(releaseWorkflow));
});

test("Electron CI acceptance includes internal isolation and external package policy verification", () => {
  const rootPackage = readJson("package.json");
  const ciWorkflow = readText(".github/workflows/ci.yml");
  const productionVerifier = readText("scripts/verify-production-desktop.mjs");

  assert.equal(
    rootPackage.scripts?.["test:electron:production"],
    "node scripts/verify-production-desktop.mjs",
  );
  assert.match(
    rootPackage.scripts?.["test:electron"] ?? "",
    /(?:^|&& )npm run test:electron:production$/,
  );
  assert.match(ciWorkflow, /xvfb-run -a npm run test:electron/);
  assert.match(
    productionVerifier,
    /capabilities: \["auth", "database", "rest"\],[\s\S]*fixtureDigest:\s*"f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",[\s\S]*fixtureVersion: "internal-baseline-v2",[\s\S]*schemaGeneration: 4,/u,
    "the packaged desktop probe must serve the exact generation-4 health fixture",
  );
  assert.doesNotMatch(
    productionVerifier,
    /internal-baseline-v1|7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca|schemaGeneration: 3/u,
    "the packaged desktop probe must not silently fall back to generation 3",
  );
});

test("the production desktop command cannot bypass observed application retirement", () => {
  const verifier = readText("scripts/verify-production-desktop.mjs");
  const launches = [
    ...verifier.matchAll(
      /application = await launchInternalProductionBuild\(userDataDirectory\);/g,
    ),
  ];
  const observedCloses = [
    ...verifier.matchAll(
      /await closeElectronApplicationCooperatively\(application\);/g,
    ),
  ];

  assert.equal(launches.length, 2);
  assert.equal(
    observedCloses.length,
    launches.length + 1,
    "each acquired application and the command finalizer must await observed retirement",
  );
  assert.doesNotMatch(
    verifier,
    /\bapplication\.close\s*\(/,
    "the production command must not close a tracked application outside the retirement observer",
  );
  assert.match(
    verifier,
    /if \(application !== null\) \{\s*await closeElectronApplicationCooperatively\(application\);\s*\}/,
    "the command finalizer must turn retirement-observer failures into a failing command status",
  );
});

test("legacy release tombstone rejects every alternate execution path", () => {
  const mutations = [
    [
      "tag trigger",
      expectedLegacyReleaseTombstone.replace(
        "  workflow_dispatch:",
        "  push:\n    tags:\n      - v*",
      ),
    ],
    [
      "write permission",
      expectedLegacyReleaseTombstone.replace(
        "permissions: {}",
        "permissions:\n  contents: write",
      ),
    ],
    [
      "environment",
      expectedLegacyReleaseTombstone.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: ubuntu-latest\n    environment: production",
      ),
    ],
    [
      "third-party action",
      expectedLegacyReleaseTombstone.replace(
        "    steps:",
        "    steps:\n      - uses: actions/checkout@deadbeef",
      ),
    ],
    [
      "secret expression",
      expectedLegacyReleaseTombstone.replace(
        "        shell: bash",
        "        env:\n          TOKEN: ${{ secrets.TOKEN }}\n        shell: bash",
      ),
    ],
    [
      "artifact transfer",
      expectedLegacyReleaseTombstone.replace(
        "        shell: bash",
        "        uses: actions/upload-artifact@deadbeef\n        shell: bash",
      ),
    ],
    [
      "successful exit",
      expectedLegacyReleaseTombstone.replace(
        "          exit 1",
        "          exit 0",
      ),
    ],
    [
      "second job",
      `${expectedLegacyReleaseTombstone}  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n`,
    ],
  ];

  for (const [label, mutation] of mutations) {
    assert.notEqual(
      mutation,
      expectedLegacyReleaseTombstone,
      `${label} mutates`,
    );
    assert.throws(
      () => assertLegacyReleaseTombstone(mutation),
      Error,
      `${label} must fail closed`,
    );
  }
});

test("source-reconciliation ledger exactly covers both evidence inputs", () => {
  const ledger = readJson("docs/product-completion/source-reconciliation.json");
  const baseline = "388170e94418d20ad205812553e1c9fdf5de9139";
  const baselineTree = "95a00a77f84962248523f38a8c554216270cc23d";
  const mergeBase = "3883f4234923c0bc250dc41649ba3801144c3f58";
  const mergeBaseTree = "ebb86934567790048bdb3f04ae8e57ac4968a34c";
  const releaseHead = "ddcfce456f3cf015ab77d207310140a311c945ab";
  const releaseTree = "ab352dea9a5cdde409d2ff93d61dd62283005cbe";
  const expectedReleaseCommits = [
    {
      commit: "f2cfb93b4f674d1a523cbef9cece2ff1c76f0f27",
      parents: [mergeBase],
      tree: "d3f5fe233e603aaf0af11fa7419a33d709c67182",
      subject: "Fix macOS release signing pipeline",
    },
    {
      commit: "ee2857eab57e0e4d5fe3e466db805fd65f99f534",
      parents: ["f2cfb93b4f674d1a523cbef9cece2ff1c76f0f27"],
      tree: "6125e6f3e78a9cc3e4a13b025b4e8f65616ef39b",
      subject: "Restore complete package lock",
    },
    {
      commit: "0c8a65f9ae1e0d769646cb092807eb3c48dfd86f",
      parents: ["ee2857eab57e0e4d5fe3e466db805fd65f99f534"],
      tree: "9fbfa85e83a944b1ac1c959959a45f975f588d0d",
      subject: "Harden release trust and promotion gates",
    },
    {
      commit: "31c4768a7804f5d7f80d32af3d4c921ce0fc9a69",
      parents: ["0c8a65f9ae1e0d769646cb092807eb3c48dfd86f"],
      tree: "0615bac9c736c35a674afff05cfa77c315fb8673",
      subject: "Clarify Apple enrollment decision",
    },
    {
      commit: "b0910d1a815c56b9036da6f0df4ff1cc648fe1ae",
      parents: [mergeBase, "31c4768a7804f5d7f80d32af3d4c921ce0fc9a69"],
      tree: "0615bac9c736c35a674afff05cfa77c315fb8673",
      subject:
        "Merge pull request #2 from danielholguin31/hotfix/macos-signing-v1.0.1",
    },
    {
      commit: "64dcbb5cd555c861190ce0159f282f17489344be",
      parents: ["b0910d1a815c56b9036da6f0df4ff1cc648fe1ae"],
      tree: "5f029533907b4c6559a176281d517ce6b85f1741",
      subject: "Prepare zero-cost v1.0.1 recovery release",
      retainedEvidenceContractIds: ["REC-01..REC-09"],
    },
    {
      commit: "454a3b316d75fd03888b27d52b95676fddd50a0c",
      parents: ["64dcbb5cd555c861190ce0159f282f17489344be"],
      tree: "6da40413e466c02f8d6da1bc70ce044044d3b780",
      subject: "Bind recovery provenance to actual builders",
      retainedEvidenceContractIds: ["PROV-03..PROV-13"],
    },
    {
      commit: "1e6f156b50002fb6096510db962577a2d793296b",
      parents: ["454a3b316d75fd03888b27d52b95676fddd50a0c"],
      tree: "baad4b0f4d5553fe3a6fb0790c249a8161ef6c48",
      subject: "Document Daniel preview checkpoint",
    },
    {
      commit: "aee038212b96dacc46abd686f8e260e10f127160",
      parents: ["1e6f156b50002fb6096510db962577a2d793296b"],
      tree: "58c1afd3b5dadfa4fbd6af8b006446d39a88dd24",
      subject: "Harden local release acceptance",
      retainedEvidenceContractIds: [
        "PROV-01",
        "GK-04",
        "GK-09",
        "GK-10",
        "GK-12",
        "GK-15",
      ],
    },
    {
      commit: "3ef19f63fe12b07a0f9fc7babd49d5f9fdbb35fe",
      parents: ["aee038212b96dacc46abd686f8e260e10f127160"],
      tree: "5c90bca66926341a2824c6959dabf8c5ebfb57af",
      subject: "Require two-host Gatekeeper acceptance",
      retainedEvidenceContractIds: ["GK-01..GK-04", "GK-09..GK-15"],
    },
    {
      commit: "096bc9bc68301a4e343b15632d2f8de8d7622692",
      parents: [
        "b0910d1a815c56b9036da6f0df4ff1cc648fe1ae",
        "3ef19f63fe12b07a0f9fc7babd49d5f9fdbb35fe",
      ],
      tree: "5c90bca66926341a2824c6959dabf8c5ebfb57af",
      subject: "Merge PR #4: v1.0.1 zero-cost recovery",
      retainedEvidenceContractIds: [
        "REC-01..REC-09",
        "PROV-01",
        "PROV-03..PROV-13",
        "GK-01..GK-15",
      ],
    },
    {
      commit: "69441a9b7bffce7b2abb48e14c0f1cf04bc6603d",
      parents: ["096bc9bc68301a4e343b15632d2f8de8d7622692"],
      tree: "68b1f51a0fda6249677c84e244fd59f1a06e18b3",
      subject: "Fix Windows vendor reproducibility gate",
      retainedEvidenceContractIds: ["PROV-02"],
    },
    {
      commit: "56cd979f2b9fa292ede481099b042f0ef74fbe88",
      parents: [
        "096bc9bc68301a4e343b15632d2f8de8d7622692",
        "69441a9b7bffce7b2abb48e14c0f1cf04bc6603d",
      ],
      tree: "68b1f51a0fda6249677c84e244fd59f1a06e18b3",
      subject: "Merge PR #6: fix Windows vendor reproducibility gate",
      retainedEvidenceContractIds: ["PROV-02"],
    },
    {
      commit: "4ca74ba36e7f9c158b8c55658d151ff735b7245a",
      parents: ["56cd979f2b9fa292ede481099b042f0ef74fbe88"],
      tree: "2ca48c115f2e80bfad1bd7ad3524b7661a47106b",
      subject: "Bind Gatekeeper tests to GitHub draft assets",
      retainedEvidenceContractIds: [
        "GK-04",
        "GK-05",
        "GK-07",
        "GK-08",
        "GK-14",
      ],
    },
    {
      commit: "a17f962b41bfd08640ed7b7e858c7594da47dae4",
      parents: ["4ca74ba36e7f9c158b8c55658d151ff735b7245a"],
      tree: "780423ea42d80a3b1493cb77869215187665ed14",
      subject: "Harden draft release identity checks",
      retainedEvidenceContractIds: ["GK-06", "GK-08"],
    },
    {
      commit: "371a4afa540a1f7d5bf88e8b18d4ba420008e74d",
      parents: ["a17f962b41bfd08640ed7b7e858c7594da47dae4"],
      tree: releaseTree,
      subject: "Reject quarantine bypass advice",
      retainedEvidenceContractIds: ["GK-06", "GK-15"],
    },
    {
      commit: releaseHead,
      parents: [
        "56cd979f2b9fa292ede481099b042f0ef74fbe88",
        "371a4afa540a1f7d5bf88e8b18d4ba420008e74d",
      ],
      tree: releaseTree,
      subject: "Merge PR #8: bind acceptance to GitHub draft assets",
      retainedEvidenceContractIds: [
        "REC-01..REC-09",
        "PROV-01..PROV-13",
        "GK-01..GK-15",
      ],
    },
  ];

  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.issue, 29);
  assert.equal(ledger.canonicalSource.repository, "danielholguin31/desmoslock");
  assert.equal(ledger.canonicalSource.branch, "main");
  assert.equal(ledger.canonicalSource.onlyIntegrationAndReleaseSource, true);
  assert.deepEqual(ledger.canonicalSource.canonicalPaths, {
    product: [
      "apps",
      "packages",
      "supabase/config.toml",
      "supabase/functions",
      "supabase/migrations",
      "supabase/seed.sql",
      "supabase/tests/database",
    ],
    operations: ["scripts/synthetic-backup"],
  });
  assert.equal(
    ledger.canonicalSource.canonicalPaths.product.includes(
      "supabase/enterprise.sql",
    ),
    false,
  );
  for (const edgeSource of [
    "supabase/functions/_shared/http.ts",
    "supabase/functions/_shared/supabase-http.ts",
    "supabase/functions/account-recovery/index.ts",
    "supabase/functions/health/index.ts",
    "supabase/functions/staff-invitations/index.ts",
  ]) {
    assert.equal(
      ledger.canonicalSource.canonicalPaths.product.some(
        (sourceRoot) =>
          edgeSource === sourceRoot || edgeSource.startsWith(`${sourceRoot}/`),
      ),
      true,
      `${edgeSource} must remain inside the canonical product source`,
    );
  }
  assert.deepEqual(ledger.canonicalSource.integrationBaseline, {
    commit: baseline,
    tree: baselineTree,
  });
  assert.equal(
    ledger.canonicalSource.releasePolicy.publicReleaseEnabled,
    false,
  );
  assert.equal(git("rev-parse", `${baseline}^{tree}`), baselineTree);
  assert.equal(gitIsAncestor(baseline, "HEAD"), true);
  assert.deepEqual(ledger.divergentReleaseLine.mergeBase, {
    commit: mergeBase,
    tree: mergeBaseTree,
  });
  assert.deepEqual(ledger.divergentReleaseLine.head, {
    commit: releaseHead,
    tree: releaseTree,
  });
  assert.equal(ledger.divergentReleaseLine.uniqueCommitCount, 17);
  assert.deepEqual(ledger.divergentReleaseLine.dispositionCounts, {
    integrated: 0,
    rejected: 17,
  });
  assert.equal(
    Object.hasOwn(
      ledger.divergentReleaseLine.dispositionCounts,
      "evidence-only",
    ),
    false,
  );

  const recordsWithoutReasons = ledger.divergentReleaseLine.commits.map(
    ({ reason, ...record }) => {
      assert.match(reason, /reject/i);
      return record;
    },
  );
  assert.deepEqual(
    recordsWithoutReasons,
    expectedReleaseCommits.map((record) => ({
      ...record,
      disposition: "rejected",
    })),
  );
  assert.equal(
    ledger.divergentReleaseLine.commits.filter(
      ({ retainedEvidenceContractIds }) =>
        retainedEvidenceContractIds !== undefined,
    ).length,
    11,
  );
  for (const record of ledger.divergentReleaseLine.commits) {
    assert.equal(record.disposition, "rejected");
    assert.equal(record.contracts, undefined);
  }

  assert.deepEqual(ledger.retainedEvidence, {
    historicalSource: {
      commit: releaseHead,
      tree: releaseTree,
      executableDependency: false,
    },
    trackedFixture: {
      path: "tests/evidence/release-1.0-evidence.fixture.json",
      sha256:
        "b9f97ee0e1a844c6d68cbbc2a80e670dd4077ac1c6a1151d35eb87e8be0fd44b",
      expectedRedContract: {
        path: "tests/evidence/audited-release.contract.test.ts",
        sha256:
          "7b823ab28322f8aeea7e85f654d4ff6615675732fe84d1dd5c99cd894ca93054",
      },
      requiresHistoricalGitObject: false,
    },
    suites: [
      {
        prefix: "REC",
        count: 9,
        source: "desktop/test/force-quit-recovery.test.js",
      },
      {
        prefix: "PROV",
        count: 13,
        source: "desktop/test/release-provenance.test.js",
      },
      {
        prefix: "GK",
        count: 15,
        source: "desktop/test/gatekeeper-acceptance.test.js",
      },
    ],
  });
  assert.equal(ledger.draftRelease.releaseId, 370225506);
  assert.equal(ledger.draftRelease.state, "draft-unpublished");
  assert.equal(ledger.draftRelease.policy, "never-publish");

  const recovery = ledger.sanitizedRecoveryArchive;
  assert.equal(
    recovery.repository,
    "nicolasdmolina/desmoslock-recovery-20260827-1835-sanitized",
  );
  assert.equal(
    recovery.ref,
    "recovery/macbook-20260827-1835/sanitized-evidence",
  );
  assert.equal(recovery.commit, "c523743601ce75cfab4edcc6e4fd040d60730446");
  assert.equal(recovery.mode, "sanitized-orphan");
  assert.equal(recovery.evidenceOnly, true);
  assert.equal(recovery.mergeable, false);
  assert.equal(recovery.originalCommitObjectsTransferred, false);
  assert.equal(
    recovery.sha256.patchInventory,
    "648a0d3651b313f12b5ef23cc8bb7f55a0dcfaa4255b61eb83e84320c9b6f5c0",
  );
  assert.equal(
    recovery.sha256.environmentExclusions,
    "4aa34d5bf0dfbdbff50befaf07dcc0f5be938be082fbee4bc7d90ccad2cc4fd8",
  );
  assert.equal(
    recovery.reconstructionDecisions.ticket04.verdict,
    "rejected-incomplete-negative-evidence",
  );
  assert.equal(
    recovery.reconstructionDecisions.ticket11a.verdict,
    "selective-salvage-only",
  );
  assert.equal(
    recovery.reconstructionDecisions.ticket11a.salvagePatchSha256,
    "084d6075c04cc0deedce9ff3cc6cd949ed4b4e5b5dc7ba0ba2cafb5ed408a8c9",
  );
  assert.equal(recovery.reconstructionDecisions.overlayAllowed, false);
  assert.equal(recovery.reconstructionDecisions.cherryPickAllowed, false);
  assert.match(recovery.residualLoss, /All `\.env\*` bytes/);
  assert.deepEqual(ledger.completion, {
    issue29Complete: false,
    state: "local-reconciliation-only",
    openGates: [
      "downstream-v2-behavior",
      "exact-head-ci",
      "remote-pr-and-branch-cleanup",
      "branch-protection",
      "artifact-provenance",
    ],
  });
});

test("README presents only the internal v2 source as current truth", () => {
  const readme = readText("README.md");
  assert.match(readme, /internal, pre-release/);
  assert.match(
    readme,
    /only development,\s*integration, and future release source/,
  );
  assert.match(readme, /no supported public download, deployment, price/);
  assert.match(readme, /v1\.0\.1 draft release.*must never be\s*published/s);
  assert.match(
    readme,
    /does not require the historical Git\s*object or branch/,
  );
  assert.match(readme, /This local reconciliation does not complete issue 29/);
  assert.doesNotMatch(readme, /suites are run in\s*a temporary directory/);
  assert.doesNotMatch(readme, /^## Pricing and licensing$/m);
  assert.doesNotMatch(readme, /^## desmoslock\.vercel\.app$/m);
  assert.doesNotMatch(readme, /\*\*Status: live\.\*\*/);

  for (const legacyDocument of [
    "docs/MACOS_RELEASE.md",
    "docs/OPERATIONS.md",
    "docs/SUPABASE.md",
  ]) {
    assert.match(
      readText(legacyDocument),
      /\*\*Historical v1 evidence only\.\*\*/,
      `${legacyDocument} must not present historical instructions as current`,
    );
  }
});

test("v2 evidence contract IDs remain exact and contiguous", () => {
  const fixturePath = "tests/evidence/release-1.0-evidence.fixture.json";
  const fixtureContents = readText(fixturePath);
  const fixture = JSON.parse(fixtureContents);
  const evidenceContracts = readText(
    "tests/evidence/audited-release.contract.test.ts",
  );
  const expectedIds = [
    ...Array.from(
      { length: 9 },
      (_, index) => `REC-${String(index + 1).padStart(2, "0")}`,
    ),
    ...Array.from(
      { length: 13 },
      (_, index) => `PROV-${String(index + 1).padStart(2, "0")}`,
    ),
    ...Array.from(
      { length: 15 },
      (_, index) => `GK-${String(index + 1).padStart(2, "0")}`,
    ),
  ];
  const actualIds = [
    ...evidenceContracts.matchAll(/id:\s*["']((?:REC|PROV|GK)-\d{2})["']/gu),
  ].map((match) => match[1]);

  assert.equal(
    sha256(fixtureContents),
    "b9f97ee0e1a844c6d68cbbc2a80e670dd4077ac1c6a1151d35eb87e8be0fd44b",
  );
  assert.equal(
    sha256(evidenceContracts),
    "7b823ab28322f8aeea7e85f654d4ff6615675732fe84d1dd5c99cd894ca93054",
  );
  assert.deepEqual(fixture.historicalSource, {
    ref: "refs/heads/release/1.0",
    commit: "ddcfce456f3cf015ab77d207310140a311c945ab",
    tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
    executableDependency: false,
  });
  assert.deepEqual(
    fixture.suites.map(
      ({ name, prefix, expectedCount, historicalTestFile }) => ({
        name,
        prefix,
        expectedCount,
        historicalTestFile,
      }),
    ),
    [
      {
        name: "recovery",
        prefix: "REC",
        expectedCount: 9,
        historicalTestFile: {
          path: "desktop/test/force-quit-recovery.test.js",
          blob: "56b68bad0e0de08f4bfa8e6b3bb104feec5f7cac",
          size: 9059,
          sha256:
            "8c8d9d76723a700a09e7722ec873a27b3c9ef01a465fc501fd0c676d08c126e6",
        },
      },
      {
        name: "provenance",
        prefix: "PROV",
        expectedCount: 13,
        historicalTestFile: {
          path: "desktop/test/release-provenance.test.js",
          blob: "79d9ac1df904b8698fb51ece97126071f5c53666",
          size: 9584,
          sha256:
            "4547cd882cc919d7119ca763f18c867c51d72c328972dd07d5a5b56213641db0",
        },
      },
      {
        name: "gatekeeper",
        prefix: "GK",
        expectedCount: 15,
        historicalTestFile: {
          path: "desktop/test/gatekeeper-acceptance.test.js",
          blob: "2ab5863e17a70bb5c07b12b2cb3e704c1c70aafa",
          size: 17881,
          sha256:
            "f4f5c2b351c0c71dcb9068085ceab2b5ef7189b6dc7171c616bc79e3a701eaf8",
        },
      },
    ],
  );
  assert.deepEqual(
    fixture.suites.flatMap(({ contractIds }) => contractIds),
    expectedIds,
  );
  assert.deepEqual(actualIds, expectedIds);
  assert.equal(new Set(actualIds).size, 37);

  const evidenceRunner = readText("scripts/run-release-evidence.mjs");
  assert.doesNotMatch(
    evidenceRunner,
    /(?:execFileSync|spawnSync)\(\s*["']git["']/,
  );
  assert.match(evidenceRunner, new RegExp(fixturePath.replace(".", "\\.")));
  assert.match(
    readText(".github/workflows/ci.yml"),
    /- run: npm run test:evidence\s+env:\s+GIT_DIR: \/nonexistent/,
  );
});
