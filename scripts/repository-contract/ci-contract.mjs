import { fail, readJson, readText } from "./shared.mjs";

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
    !/- run: npm run db:start:full\s+[\s\S]*?- run: npm run db:reset\s+[\s\S]*?- run: npm run test:staff-auth\s+[\s\S]*?- if: always\(\)\s+run: npm run db:stop/u.test(
      lifecycleJob,
    )
  ) {
    fail(
      "Required staff Auth CI must reset and test a full disposable stack with unconditional cleanup",
    );
  }

  const requiredJob = readCiJob(ciWorkflow, "required");
  const requiredNeeds = readCiJobSection(requiredJob, "needs");
  if (!/^ {6}- staff-auth-lifecycle\s*$/mu.test(requiredNeeds)) {
    fail("Required CI aggregate does not depend on staff-auth-lifecycle");
  }
}

export function verifyCiContract(repositoryRoot) {
  const rootPackage = readJson(repositoryRoot, "package.json");
  const ciWorkflow = readText(repositoryRoot, ".github/workflows/ci.yml");
  const securityWorkflow = readText(
    repositoryRoot,
    ".github/workflows/security.yml",
  );
  if (
    rootPackage.scripts?.["test:staff-auth"] !==
      "npm run test:db && npm run test:staff-auth:stack && npm run test:edge && npm run test:unit" ||
    rootPackage.scripts?.["test:staff-auth:stack"] !==
      "node --test tests/acceptance/staff-auth-stack.test.mjs"
  ) {
    fail("Root package does not expose the exact staff Auth verification lane");
  }
  readText(repositoryRoot, "tests/acceptance/staff-auth-stack.test.mjs");
  for (const command of [
    "npm ci",
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm run test:unit",
    "npm run test:evidence",
    "npm run db:start:full",
    "npm run db:reset",
    "npm run test:db",
    "npm run test:staff-auth",
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
