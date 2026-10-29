import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPublicWebCiWorkflow,
  assertStaffAuthCiWorkflow,
  assertUnsignedArtifactCiInvocation,
} from "../scripts/repository-contract/ci-contract.mjs";
import {
  assertNoReleaseWorkflow,
  expectedRootVercelConfiguration,
  removedLegacyPaths,
} from "../scripts/repository-contract/legacy-quarantine-contract.mjs";
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
  expectedToolchain,
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

test("signup confirmation mail uses the versioned inert application fragment", () => {
  const config = readText("supabase/config.toml");
  const template = readText("supabase/templates/confirmation-v1.html");
  assert.match(
    config,
    /\[auth\.email\.template\.confirmation\]\s+subject = "Confirm your DesmosLock email"\s+content_path = "\.\/supabase\/templates\/confirmation-v1\.html"/u,
  );
  assert.deepEqual(
    [...template.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]),
    ["{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=signup"],
  );
  assert.equal(template.includes(".ConfirmationURL"), false);
  assert.equal(template.includes("/auth/v1/verify"), false);
  assert.match(template, /<meta name="referrer" content="no-referrer"/u);
});

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
  assert.equal(
    rootPackage.packageManager,
    `npm@${expectedToolchain.npm}+${expectedToolchain.npmIntegrity}`,
  );
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
        rootPackage: {
          ...manifestContract.rootPackage,
          packageManager: `npm@${expectedToolchain.npm}`,
        },
      }),
    /verified Corepack integrity/u,
  );
  assert.throws(
    () =>
      assertToolchainManifestContract({
        ...manifestContract,
        rootPackage: {
          ...manifestContract.rootPackage,
          packageManager: `npm@${expectedToolchain.npm}+sha512.${"0".repeat(128)}`,
        },
      }),
    /verified Corepack integrity/u,
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
    assert.throws(
      () =>
        assertWorkflowToolchain(
          [
            workflow,
            "  added-node-job:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - run: npm --version",
          ].join("\n"),
          workflowPath,
          expectedJobCount,
        ),
      /Node\.js\/npm job/u,
    );
    assert.throws(
      () =>
        assertWorkflowToolchain(
          workflow.replace(
            "      - uses: actions/setup-node@",
            "      - run: npm --version\n      - uses: actions/setup-node@",
          ),
          workflowPath,
          expectedJobCount,
        ),
      /before Node\.js\/npm use/u,
    );
    for (const jobKey of [
      "  'added-node-job':",
      "  added-node-job: # hidden from a partial parser",
    ]) {
      assert.throws(
        () =>
          assertWorkflowToolchain(
            [
              workflow,
              jobKey,
              "    runs-on: ubuntu-latest",
              "    steps:",
              "      - run: npm --version",
            ].join("\n"),
            workflowPath,
            expectedJobCount,
          ),
        /canonical unquoted form/u,
      );
    }
  }
});

test("operator docs enumerate the exact toolchain and all public web build inputs", () => {
  const documents = [
    {
      exactToolchain:
        "Use exactly Node.js 24.20.0 and npm 11.12.1 from the repository root.",
      text: readText("README.md"),
    },
    {
      exactToolchain:
        "Use exactly Node.js 24.20.0 and npm 11.12.1 from the repository root.",
      text: readText("docs/maintainers.md"),
    },
    {
      exactToolchain:
        "Use exactly Node.js 24.20.0, npm 11.12.1, Docker, and the repository-pinned\nSupabase CLI.",
      text: readText("docs/product-completion/reproducible-supabase.md"),
    },
    {
      exactToolchain:
        "Use exactly Node.js 24.20.0 and npm 11.12.1 from the repository root.",
      text: readText("docs/product-completion/v2-foundation.md"),
    },
  ];
  for (const document of documents) {
    assert.equal(document.text.includes(document.exactToolchain), true);
    assert.doesNotMatch(
      document.text,
      /Node(?:\.js)? 24(?:\.20\.0)?\s+(?:or newer|and newer|or later|\+)/iu,
    );
    for (const field of [
      "DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT",
      "DESMOSLOCK_PUBLIC_BACKEND_URL",
      "DESMOSLOCK_PUBLIC_WEB_ORIGIN",
      "DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ]) {
      assert.equal(
        document.text.includes(field),
        true,
        `${field} is undocumented`,
      );
    }
    assert.doesNotMatch(
      document.text,
      /exactly two fields|two public backend/u,
    );
  }
  assert.match(
    documents[2].text,
    /publishable key is intentionally browser-public/u,
  );
  assert.match(documents[2].text, /no database URL,[\s\S]*service-role key/u);
  assert.match(documents[2].text, /desktop renderer never receives/u);

  const rootPackage = readJson("package.json");
  assert.equal(
    rootPackage.scripts?.["test:web"],
    "npm run build:packages && DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=local DESMOSLOCK_PUBLIC_BACKEND_URL=http://127.0.0.1:43174 DESMOSLOCK_PUBLIC_WEB_ORIGIN=http://127.0.0.1:43173 DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc npm run build --workspace @desmoslock/web && vitest run apps/web && npm run test:web:e2e",
  );
});

test("v2 data plane is migration-owned and clean-start only", () => {
  for (const relativePath of [
    "supabase/config.toml",
    "supabase/migrations/20260824000100_v2_foundation.sql",
    "supabase/migrations/20260828000100_internal_release_backend.sql",
    "supabase/migrations/20260903000100_staff_auth_lifecycle.sql",
    "supabase/migrations/20260903000200_staff_auth_generation_4.sql",
    "supabase/migrations/20260907000100_staff_auth_callback_completion.sql",
    "supabase/migrations/20260907000200_runtime_owner_bootstrap.sql",
    "supabase/migrations/20260907000300_membership_revocation_authority.sql",
    "supabase/migrations/20260907000400_membership_administration.sql",
    "supabase/migrations/20260908000100_school_display_name.sql",
    "supabase/migrations/20260908000200_test_workspace.sql",
    "supabase/tests/database/school_display_name.test.sql",
    "supabase/tests/database/test_workspace.test.sql",
    "supabase/seed.sql",
    "supabase/tests/database/internal_release_backend.test.sql",
    "supabase/tests/database/staff_auth_generation_4.test.sql",
    "supabase/tests/database/staff_auth_callback_completion.test.sql",
    "supabase/tests/database/runtime_owner_bootstrap.test.sql",
    "supabase/tests/database/membership_revocation_authority.test.sql",
    "supabase/tests/database/membership_administration.test.sql",
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
      migrationSetSha256:
        "ce79427901195258897e0b75c80acfb7b50699eb223af5289cf5d5d59958f2b7",
      rawSha256:
        "4e7321c8d9d6d3e4c27e07ab38d75252a8922868842c40c0723c349c251cac44",
    },
    "20260907000100_staff_auth_callback_completion.sql": {
      migrationSetSha256:
        "1b499b73aca1ff812cbc244f9eb9908e8dad839ecc6befbcb1a496865a2d5f52",
      rawSha256:
        "79ab31e822b4f04f4148c50bb98446210a37d975a646119b42d78fe1349a8862",
    },
    "20260907000200_runtime_owner_bootstrap.sql": {
      migrationSetSha256:
        "8d5fd99304ce8bbf9524dfb788080f890ab84565c096a8e6d4faf437a9b734dc",
      rawSha256:
        "43527d889ae0823057bba8ab7b4ed97eb9603220658c59c56cfda70889af75c9",
    },
    "20260907000300_membership_revocation_authority.sql": {
      migrationSetSha256:
        "e1a9a879948a685a263f24fad98e7fc9a30817fe6ce9461e32fc121080d00a4a",
      rawSha256:
        "9c59c0192b4f960f925db8c64be1c7b2aa6843591d6214a98b29c2bac5a326ad",
    },
    "20260907000400_membership_administration.sql": {
      migrationSetSha256:
        "7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56",
      rawSha256:
        "078a886cc923b0d9349eca992ebf1d74b06e4bbd302ee165828b4003ca3326a5",
    },
    "20260908000100_school_display_name.sql": {
      migrationSetSha256:
        "9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538",
      rawSha256:
        "96febd78bbec6859771cb26ae095458553e19ddd75dbc438e99b54ee86549e18",
    },
    "20260908000200_test_workspace.sql": {
      migrationSetSha256:
        "5cf17174bf44e491a6bd78fe540326d8bdee169518d75c8082e5bd9b833f3f62",
      rawSha256:
        "233123dd9038740ef724432715cc17e32a5adc2be68160466fa11f5b2dfb865c",
    },
    "20260908000300_student_session_admission.sql": {
      migrationSetSha256:
        "aa32ed754c87e7987199dbd6c5f685ae65236ba3f94921157fc6cb07ce67b308",
      rawSha256:
        "448d7697885eae07f04cc3b89531b7b3711e71fa67d56d80ac891df63458fb06",
    },
    "20260908000400_student_protection_evidence.sql": {
      migrationSetSha256:
        "80c2720ff352c721298e5814715374bf9e2a9c1152bbf2d2761ad781265f8701",
      rawSha256:
        "1543ee8cf236c4c43aa9331ec228eac9f99c68d4460d3023f68ce3a196fa2633",
    },
    "20260908000500_student_preflight_evidence.sql": {
      migrationSetSha256: expectedMigrationSetSha256,
      rawSha256:
        "62ab37ff1ba85f475a64994645cfe9aaf17617e2f418400cd94d2161fc442d36",
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
  for (const historicalFile of [
    "20260828000100_internal_release_backend.sql",
    "20260903000200_staff_auth_generation_4.sql",
    "20260907000100_staff_auth_callback_completion.sql",
    "20260907000200_runtime_owner_bootstrap.sql",
    "20260907000300_membership_revocation_authority.sql",
    "20260907000400_membership_administration.sql",
    "20260908000100_school_display_name.sql",
    "20260908000200_test_workspace.sql",
    "20260908000300_student_session_admission.sql",
  ]) {
    assert.throws(
      () =>
        assertMigrationSetAttestation(
          migrations.map(([fileName, source]) => [
            fileName,
            fileName === historicalFile
              ? source.replace(
                  expectedMigrationAttestations[fileName].migrationSetSha256,
                  expectedMigrationSetSha256,
                )
              : source,
          ]),
        ),
      /does not preserve its historical migration-set attestation/u,
      historicalFile,
    );
  }
  for (const attestedFile of Object.keys(expectedMigrationAttestations)) {
    assert.throws(
      () =>
        assertMigrationSetAttestation(
          migrations.map(([fileName, source]) => [
            fileName,
            fileName === attestedFile ? `${source}\n-- drift\n` : source,
          ]),
        ),
      /raw migration SHA-256 changed/u,
      attestedFile,
    );
  }
  assert.throws(
    () =>
      assertMigrationSetAttestation(
        migrations.map(([fileName, source]) => [
          fileName,
          fileName === "20260908000500_student_preflight_evidence.sql"
            ? source.replace(expectedMigrationSetSha256, "0".repeat(64))
            : source,
        ]),
      ),
    /does not attest the current migration set/u,
  );
});

test("the runbook names every runtime-only staff and Student backup guard", () => {
  const runbook = readText("docs/product-completion/reproducible-supabase.md");
  const runtimeLifecycleTables = [
    "student_join_materials",
    "student_device_bindings",
    "student_bootstrap_challenges",
    "student_bootstrap_limits",
    "student_device_proof_state",
    "student_protection_events",
    "application_session_revocation_cutoffs",
    "application_session_revocations",
    "staff_audit_events",
    "staff_invitations",
    "staff_password_recovery_operations",
  ];

  assert.match(runbook, /eleven runtime-only staff and Student tables/u);
  assert.doesNotMatch(runbook, /nine runtime-only staff and Student tables/u);
  assert.doesNotMatch(runbook, /three staff lifecycle tables/u);
  for (const table of runtimeLifecycleTables) {
    assert.equal(
      runbook.includes(`\`${table}\``),
      true,
      `${table} must remain explicit in the operator runbook`,
    );
  }
});

test("unsigned, universal, and signed artifact Node suites remain invoked by required static CI", () => {
  const rootPackage = readJson("package.json");
  const workflow = readText(".github/workflows/ci.yml");
  assert.doesNotThrow(() =>
    assertUnsignedArtifactCiInvocation(rootPackage, workflow),
  );
  const required = [
    "tests/acceptance/unsigned-artifact-collector.test.mjs",
    "tests/acceptance/unsigned-artifact-evidence.test.mjs",
    "tests/acceptance/unsigned-artifact-cli.test.mjs",
    "tests/acceptance/desktop-native-build-targets.test.mjs",
    "tests/acceptance/universal-artifact-composition.test.mjs",
    "tests/acceptance/universal-artifact-cli.test.mjs",
    "tests/acceptance/signed-artifact-custody.test.mjs",
    "tests/acceptance/signed-artifact-evidence.test.mjs",
    "tests/acceptance/signed-artifact-cli.test.mjs",
  ];
  for (const file of required) {
    const command = rootPackage.scripts["test:repository"];
    const removed = command.replace(` ${file}`, "");
    assert.notEqual(
      removed,
      command,
      `Required suite must be present: ${file}`,
    );
    assert.throws(
      () =>
        assertUnsignedArtifactCiInvocation(
          {
            ...rootPackage,
            scripts: {
              ...rootPackage.scripts,
              "test:repository": removed,
            },
          },
          workflow,
        ),
      /must execute all required unsigned and universal artifact Node suites/u,
      file,
    );
  }
  for (const command of [
    rootPackage.scripts["test:repository"].replace("node --test", "echo"),
    `${rootPackage.scripts["test:repository"]} || true`,
    `${rootPackage.scripts["test:repository"]} ${required[3]}`,
  ]) {
    assert.throws(
      () =>
        assertUnsignedArtifactCiInvocation(
          { ...rootPackage, scripts: { "test:repository": command } },
          workflow,
        ),
      /must execute all required unsigned and universal artifact Node suites/u,
    );
  }
  assert.throws(
    () =>
      assertUnsignedArtifactCiInvocation(
        rootPackage,
        workflow.replace("      - run: npm run test:repository\n", ""),
      ),
    /must execute all required unsigned and universal artifact Node suites/u,
  );
  for (const option of ["if: false", "continue-on-error: true"]) {
    for (const altered of [
      workflow.replace(
        "      - run: npm run test:repository\n",
        `      - run: npm run test:repository\n        ${option}\n`,
      ),
      workflow.replace("  static:\n", `  static:\n    ${option}\n`),
    ]) {
      assert.throws(
        () => assertUnsignedArtifactCiInvocation(rootPackage, altered),
        /must execute all required unsigned and universal artifact Node suites/u,
        `Repository invocation cannot be disabled or ignored: ${option}`,
      );
    }
  }
});

test("staff Auth schema and composed journeys have a required disposable CI lane", () => {
  const rootPackage = readJson("package.json");
  const workflow = readText(".github/workflows/ci.yml");

  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "tests/acceptance/staff-auth-stack.test.mjs"),
    ),
    true,
  );

  assert.equal(
    rootPackage.scripts?.["test:staff-auth:composed"],
    "node --test tests/acceptance/staff-auth-composed.test.mjs",
  );
  assert.equal(
    rootPackage.scripts?.["test:staff-auth:locks"],
    "node --test tests/acceptance/revoke-membership-lock.test.mjs",
  );
  assert.equal(
    fs.existsSync(
      path.join(
        repositoryRoot,
        "tests/acceptance/revoke-membership-lock.test.mjs",
      ),
    ),
    true,
  );
  assert.equal(
    rootPackage.scripts?.["db:start:full"],
    "node scripts/run-local-supabase.mjs start-full",
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "scripts/run-local-supabase.mjs")),
    true,
  );

  assert.equal(
    rootPackage.scripts?.["test:staff-auth"],
    "npm run test:db && npm run test:staff-auth:stack && npm run test:staff-auth:locks && npm run test:edge && npm run test:unit && npm run test:staff-auth:composed",
  );
  assert.equal(
    rootPackage.scripts?.["test:edge"],
    "deno lint supabase/functions && deno test supabase/functions && deno check supabase/functions/health/index.ts supabase/functions/account-recovery/index.ts supabase/functions/staff-invitations/index.ts supabase/functions/student-session-challenge/index.ts supabase/functions/student-session-join/index.ts supabase/functions/student-session-read/index.ts supabase/functions/student-session-reconnect/index.ts supabase/functions/student-session-forfeit/index.ts supabase/functions/student-session-evidence/index.ts",
    "the Edge suite must lint all sources and explicitly typecheck every deployed entrypoint",
  );
  assert.equal(
    rootPackage.scripts?.["test:staff-auth:stack"],
    "node --test tests/acceptance/staff-auth-stack.test.mjs",
  );
  assert.equal(
    rootPackage.scripts?.["test:backup:roundtrip"],
    "node --test tests/acceptance/synthetic-backup-roundtrip.test.mjs",
  );
  assert.doesNotThrow(() => assertStaffAuthCiWorkflow(workflow));
  const lifecycleHeader = "  staff-auth-lifecycle:\n";
  const lifecycleBody = workflow
    .split(lifecycleHeader)[1]
    .split("\n  web:\n")[0];
  const withoutLifecycleChromium = workflow.replace(
    `${lifecycleHeader}${lifecycleBody}`,
    `${lifecycleHeader}${lifecycleBody.replace(
      "      - run: npx playwright install --with-deps chromium\n",
      "",
    )}`,
  );
  assert.notEqual(withoutLifecycleChromium, workflow);
  assert.equal(
    withoutLifecycleChromium.split("\n  web:\n")[1],
    workflow.split("\n  web:\n")[1],
    "the web job keeps its own Chromium installation",
  );
  assert.throws(
    () => assertStaffAuthCiWorkflow(withoutLifecycleChromium),
    /live-backend browser CI must provision Chromium/u,
  );
  assert.throws(
    () =>
      assertStaffAuthCiWorkflow(
        workflow.replace(
          "name: Staff Auth schema and composed local journeys",
          "name: Disposable staff Auth lifecycle",
        ),
      ),
    /schema and composed local journey verification/u,
  );

  const lifecycleSteps = [
    "      - run: npm run test:backup:roundtrip",
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

  assert.equal(
    rootPackage.scripts?.["verify:repository"],
    "node scripts/verify-repository-contract.mjs",
  );
  assert.deepEqual(vercel, { ...expectedRootVercelConfiguration });
  assert.equal(
    fs.existsSync(
      path.join(repositoryRoot, "scripts/verify-repository-contract.mjs"),
    ),
    true,
  );
  for (const legacyPath of removedLegacyPaths) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, legacyPath)),
      false,
      `${legacyPath} must stay removed from main`,
    );
  }
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
  for (const workflow of fs
    .readdirSync(path.join(repositoryRoot, ".github/workflows"))
    .filter((filename) => /\.ya?ml$/u.test(filename))) {
    assert.doesNotThrow(() =>
      assertNoReleaseWorkflow(
        workflow,
        readText(path.join(".github/workflows", workflow)),
      ),
    );
  }
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
  const productionLaunches = [
    ...verifier.matchAll(
      /application = await launchInternalProductionBuild\(userDataDirectory\);/g,
    ),
  ];
  const syntheticLaunches = [
    ...verifier.matchAll(
      /application = await launchSyntheticCalculatorBuild\(\s*calculatorUserDataDirectory,\s*fixturePath,?\s*\);/g,
    ),
  ];
  const observedCloses = [
    ...verifier.matchAll(
      /await closeElectronApplicationCooperatively\(application\);/g,
    ),
  ];

  assert.equal(productionLaunches.length, 2);
  assert.equal(syntheticLaunches.length, 2);
  assert.equal(
    observedCloses.length,
    productionLaunches.length + syntheticLaunches.length + 1,
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

test("no workflow can restore a legacy release or publication path", () => {
  const baseline = `name: Synthetic verification

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
  assert.doesNotThrow(() => assertNoReleaseWorkflow("ci.yml", baseline));

  const mutations = [
    ["release filename", "release.yml", baseline],
    [
      "tag trigger",
      "ci.yml",
      baseline.replace("    branches:\n      - main", "    tags:\n      - v*"),
    ],
    [
      "release trigger",
      "ci.yml",
      baseline.replace(
        "  workflow_dispatch:",
        "  workflow_dispatch:\n  release:\n    types: [published]",
      ),
    ],
    [
      "schedule trigger",
      "ci.yml",
      baseline.replace(
        "  workflow_dispatch:",
        "  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'",
      ),
    ],
    [
      "environment",
      "ci.yml",
      baseline.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: ubuntu-latest\n    environment: production",
      ),
    ],
    [
      "GitHub release",
      "ci.yml",
      baseline.replace("npm test", "gh release create v2.0.0"),
    ],
    ["npm publish", "ci.yml", baseline.replace("npm test", "npm publish")],
    [
      "release action",
      "ci.yml",
      baseline.replace(
        "      - run: npm test",
        "      - uses: softprops/action-gh-release@deadbeef",
      ),
    ],
    [
      "legacy packaging",
      "ci.yml",
      baseline.replace("npm test", "npx electron-builder --mac"),
    ],
    [
      "deployment",
      "ci.yml",
      baseline.replace("npm test", "npx vercel deploy --prod"),
    ],
  ];

  for (const [label, filename, mutation] of mutations) {
    assert.throws(
      () => assertNoReleaseWorkflow(filename, mutation),
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
      "supabase/templates",
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
    "supabase/templates/recovery-v1.html",
    "supabase/templates/confirmation-v1.html",
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

test("README and maintainer guide present only the internal v2 source as current truth", () => {
  const readme = readText("README.md");
  assert.match(readme, /pre-release/);
  assert.match(readme, /no supported download/);
  assert.match(readme, /\(docs\/maintainers\.md\)/);
  assert.doesNotMatch(readme, /daniel-handoff\.md/);
  assert.doesNotMatch(readme, /`(?:desktop|server|web)\/`/);

  const maintainers = readText("docs/maintainers.md");
  assert.match(maintainers, /internal, pre-release/);
  assert.match(
    maintainers,
    /only development,\s*integration, and future release source/,
  );
  assert.match(maintainers, /no supported public download, deployment, price/);
  assert.match(
    maintainers,
    /v1\.0\.1 draft release.*must never be\s*published/s,
  );
  assert.match(
    maintainers,
    /does not require the historical Git\s*object or branch/,
  );
  assert.match(
    maintainers,
    /This local reconciliation does not complete issue 29/,
  );

  for (const document of [readme, maintainers]) {
    assert.doesNotMatch(document, /suites are run in\s*a temporary directory/);
    assert.doesNotMatch(document, /^## Pricing and licensing$/m);
    assert.doesNotMatch(document, /^## desmoslock\.vercel\.app$/m);
    assert.doesNotMatch(document, /\*\*Status: live\.\*\*/);
  }

  for (const legacyDocument of [
    "docs/MACOS_RELEASE.md",
    "docs/OPERATIONS.md",
    "docs/SUPABASE.md",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, legacyDocument)),
      false,
      `${legacyDocument} must stay removed; v1 history lives at tag v1.0.0`,
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
