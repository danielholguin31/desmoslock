import { fail, readText } from "./shared.mjs";

export function verifyCiContract(repositoryRoot) {
  const ciWorkflow = readText(repositoryRoot, ".github/workflows/ci.yml");
  const securityWorkflow = readText(
    repositoryRoot,
    ".github/workflows/security.yml",
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

  const codeowners = readText(repositoryRoot, ".github/CODEOWNERS");
  if (
    !codeowners.includes("/.github/workflows/ @danielholguin31 @nicolasdmolina")
  ) {
    fail("Required workflows do not have a CODEOWNER");
  }
}
