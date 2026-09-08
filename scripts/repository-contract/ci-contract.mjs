import { fail, readJson, readText } from "./shared.mjs";

const syntheticPublicWebOrigin = "http://localhost:43174";
const syntheticSupabasePublishableKey =
  "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readCiJob(workflow, jobName) {
  const matches = [
    ...workflow.matchAll(
      new RegExp(`^ {2}${escapeRegExp(jobName)}:\\s*$`, "gmu"),
    ),
  ];
  if (matches.length !== 1) {
    fail(`Required CI job must appear exactly once: ${jobName}`);
  }

  const match = matches[0];
  const bodyStart = match.index + match[0].length;
  const remainder = workflow.slice(bodyStart);
  const nextJob = /^ {2}[a-zA-Z0-9_-]+:\s*$/mu.exec(remainder);
  return remainder.slice(0, nextJob?.index);
}

function readCiJobSection(job, sectionName) {
  const matches = [
    ...job.matchAll(
      new RegExp(`^ {4}${escapeRegExp(sectionName)}:\\s*$`, "gmu"),
    ),
  ];
  if (matches.length !== 1) {
    fail(`Required CI job section must appear exactly once: ${sectionName}`);
  }

  const match = matches[0];
  const bodyStart = match.index + match[0].length;
  const remainder = job.slice(bodyStart);
  const nextSection = /^ {4}[a-zA-Z0-9_-]+:\s*$/mu.exec(remainder);
  return remainder.slice(0, nextSection?.index);
}

export function assertStaffAuthCiWorkflow(ciWorkflow) {
  const lifecycleJob = readCiJob(ciWorkflow, "staff-auth-lifecycle");
  if (
    !/^ {4}name: Staff Auth schema and composed local journeys$/mu.test(
      lifecycleJob,
    )
  ) {
    fail(
      "Required staff Auth CI must identify itself as schema and composed local journey verification",
    );
  }
  if (
    !/^ {6}- run: npx playwright install --with-deps chromium$/mu.test(
      lifecycleJob,
    )
  ) {
    fail("Required staff Auth live-backend browser CI must provision Chromium");
  }
  if (
    !/- run: npm run test:backup:roundtrip\s+[\s\S]*?- if: always\(\)\s+run: npm run db:stop/u.test(
      lifecycleJob,
    )
  ) {
    fail(
      "Required staff Auth schema and composed journey CI must restore and test a full disposable local stack with unconditional cleanup",
    );
  }

  const requiredJob = readCiJob(ciWorkflow, "required");
  const requiredNeeds = readCiJobSection(requiredJob, "needs");
  if (!/^ {6}- staff-auth-lifecycle\s*$/mu.test(requiredNeeds)) {
    fail("Required CI aggregate does not depend on staff-auth-lifecycle");
  }
}

export function assertPublicWebCiWorkflow(ciWorkflow, securityWorkflow) {
  const configuredAggregateBuild = [
    "      - run: npm run build",
    "        env:",
    "          DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: local",
    "          DESMOSLOCK_PUBLIC_BACKEND_URL: http://127.0.0.1:54321",
    `          DESMOSLOCK_PUBLIC_WEB_ORIGIN: ${syntheticPublicWebOrigin}`,
    `          DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${syntheticSupabasePublishableKey}`,
  ].join("\n");
  for (const [label, workflow, expectedBuildCount] of [
    ["Required CI workflow", ciWorkflow, 2],
    ["Required security workflow", securityWorkflow, 1],
  ]) {
    const configuredBuildCount = workflow
      .split(configuredAggregateBuild)
      .slice(1).length;
    if (configuredBuildCount !== expectedBuildCount) {
      fail(
        `${label} must configure every aggregate build with the exact synthetic public web origin and publishable key`,
      );
    }
  }

  const webJob = readCiJob(ciWorkflow, "web");
  const configuredWebTest = [
    "      - run: npm run test:web",
    "        env:",
    `          DESMOSLOCK_PUBLIC_WEB_ORIGIN: ${syntheticPublicWebOrigin}`,
    `          DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${syntheticSupabasePublishableKey}`,
  ].join("\n");
  if (!webJob.includes(configuredWebTest)) {
    fail(
      "Required web CI must provide the exact synthetic public origin and publishable key",
    );
  }

  const electronJob = readCiJob(ciWorkflow, "electron");
  if (
    /DESMOSLOCK_PUBLIC_(?:WEB_ORIGIN|SUPABASE_PUBLISHABLE_KEY)/u.test(
      electronJob,
    )
  ) {
    fail("Desktop-specific CI must not receive public web configuration");
  }
}

export function assertUnsignedArtifactCiInvocation(rootPackage, ciWorkflow) {
  const command = rootPackage.scripts?.["test:repository"];
  const prefix = "npm run test:clean-build && node --test ";
  const files =
    typeof command === "string" && command.startsWith(prefix)
      ? command.slice(prefix.length).split(" ")
      : [];
  const required = [
    "tests/acceptance/unsigned-artifact-collector.test.mjs",
    "tests/acceptance/unsigned-artifact-evidence.test.mjs",
    "tests/acceptance/unsigned-artifact-cli.test.mjs",
  ];
  const staticJob = readCiJob(ciWorkflow, "static");
  const invocation = /^ {6}- run: npm run test:repository$/mu.exec(staticJob);
  const afterInvocation =
    invocation === null
      ? ""
      : staticJob.slice(invocation.index + invocation[0].length);
  const nextStep = /^ {6}- /mu.exec(afterInvocation);
  const invocationOptions = afterInvocation.slice(0, nextStep?.index);
  if (
    files.length === 0 ||
    files.some(
      (file) => !/^tests\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.mjs$/u.test(file),
    ) ||
    new Set(files).size !== files.length ||
    required.some((file) => !files.includes(file)) ||
    invocation === null ||
    /^ {4}(?:if|continue-on-error)\s*:/mu.test(staticJob) ||
    /^ {8}(?:if|continue-on-error)\s*:/mu.test(invocationOptions)
  ) {
    fail(
      "Required static CI must execute all three unsigned artifact Node suites through test:repository",
    );
  }
}

export function verifyCiContract(repositoryRoot) {
  const rootPackage = readJson(repositoryRoot, "package.json");
  const ciWorkflow = readText(repositoryRoot, ".github/workflows/ci.yml");
  const securityWorkflow = readText(
    repositoryRoot,
    ".github/workflows/security.yml",
  );
  assertUnsignedArtifactCiInvocation(rootPackage, ciWorkflow);
  if (
    rootPackage.scripts?.["test:backup:roundtrip"] !==
      "node --test tests/acceptance/synthetic-backup-roundtrip.test.mjs" ||
    rootPackage.scripts?.["test:staff-auth"] !==
      "npm run test:db && npm run test:staff-auth:stack && npm run test:staff-auth:locks && npm run test:edge && npm run test:unit && npm run test:staff-auth:composed" ||
    rootPackage.scripts?.["test:staff-auth:composed"] !==
      "node --test tests/acceptance/staff-auth-composed.test.mjs" ||
    rootPackage.scripts?.["test:staff-auth:locks"] !==
      "node --test tests/acceptance/revoke-membership-lock.test.mjs" ||
    rootPackage.scripts?.["db:start:full"] !==
      "node scripts/run-local-supabase.mjs start-full" ||
    rootPackage.scripts?.["test:staff-auth:stack"] !==
      "node --test tests/acceptance/staff-auth-stack.test.mjs" ||
    rootPackage.scripts?.["test:edge"] !==
      "deno lint supabase/functions && deno test supabase/functions && deno check supabase/functions/health/index.ts supabase/functions/account-recovery/index.ts supabase/functions/staff-invitations/index.ts supabase/functions/student-session-challenge/index.ts supabase/functions/student-session-join/index.ts supabase/functions/student-session-read/index.ts supabase/functions/student-session-reconnect/index.ts supabase/functions/student-session-forfeit/index.ts supabase/functions/student-session-evidence/index.ts"
  ) {
    fail(
      "Root package does not expose the exact staff Auth schema and composed acceptance lane",
    );
  }
  readText(repositoryRoot, "tests/acceptance/staff-auth-stack.test.mjs");
  readText(repositoryRoot, "tests/acceptance/revoke-membership-lock.test.mjs");
  readText(repositoryRoot, "tests/acceptance/staff-auth-composed.test.mjs");
  readText(repositoryRoot, "tests/acceptance/staff-auth-loopback.mjs");
  readText(repositoryRoot, "scripts/run-local-supabase.mjs");
  readText(repositoryRoot, "tests/acceptance/synthetic-backup-runtime.mjs");
  readText(
    repositoryRoot,
    "tests/acceptance/synthetic-backup-runtime.test.mjs",
  );
  readText(
    repositoryRoot,
    "tests/acceptance/synthetic-backup-roundtrip.test.mjs",
  );
  for (const command of [
    "npm ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm run test:unit",
    "npm run test:evidence",
    "npm run db:reset",
    "npm run test:db",
    "npm run test:backup:roundtrip",
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
    !/- run: npm run test:evidence\s+env:\s+GIT_DIR: \/nonexistent/u.test(
      ciWorkflow,
    )
  ) {
    fail("CI must prove evidence tests do not depend on off-main Git objects");
  }
  if (
    !ciWorkflow.includes("DESMOSLOCK_FORCE_REQUIRED_CHECK_FAILURE") ||
    !ciWorkflow.includes("- required-check-probe") ||
    !ciWorkflow.includes("- staff-auth-lifecycle") ||
    !ciWorkflow.includes("name: Required v2 verification")
  ) {
    fail(
      "Required CI aggregate is not wired through the deliberate failure probe",
    );
  }
  assertStaffAuthCiWorkflow(ciWorkflow);
  assertPublicWebCiWorkflow(ciWorkflow, securityWorkflow);
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

  const codeowners = readText(repositoryRoot, ".github/CODEOWNERS");
  if (
    !codeowners.includes("/.github/workflows/ @danielholguin31 @nicolasdmolina")
  ) {
    fail("Required workflows do not have a CODEOWNER");
  }
}
