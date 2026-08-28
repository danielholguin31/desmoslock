import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePath = "tests/evidence/release-1.0-evidence.fixture.json";
const expectedFixtureSha256 =
  "b9f97ee0e1a844c6d68cbbc2a80e670dd4077ac1c6a1151d35eb87e8be0fd44b";
const historicalSource = {
  ref: "refs/heads/release/1.0",
  commit: "ddcfce456f3cf015ab77d207310140a311c945ab",
  tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
  executableDependency: false,
};
const redContract = {
  path: "tests/evidence/audited-release.contract.test.ts",
  sha256: "7b823ab28322f8aeea7e85f654d4ff6615675732fe84d1dd5c99cd894ca93054",
  policy: "all-listed-contracts-must-remain-red",
};
const expectedSuites = [
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
];

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function expectedContractIds(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
  );
}

const fixtureContents = fs.readFileSync(
  path.join(repositoryRoot, fixturePath),
  "utf8",
);
if (sha256(fixtureContents) !== expectedFixtureSha256) {
  fail("Frozen release evidence fixture digest changed");
}

const fixture = JSON.parse(fixtureContents);
if (
  fixture.schemaVersion !== 1 ||
  fixture.kind !== "frozen-historical-evidence-index" ||
  !isDeepStrictEqual(fixture.historicalSource, historicalSource) ||
  !isDeepStrictEqual(fixture.canonicalExpectedRedContract, redContract)
) {
  fail("Frozen release evidence identity changed");
}
if (!Array.isArray(fixture.suites) || fixture.suites.length !== 3) {
  fail("Frozen release evidence must contain exactly three suites");
}

const fixtureContractIds = [];
for (const [index, expectedSuite] of expectedSuites.entries()) {
  const suite = fixture.suites[index];
  const expectedIds = expectedContractIds(
    expectedSuite.prefix,
    expectedSuite.expectedCount,
  );
  if (
    suite.name !== expectedSuite.name ||
    suite.prefix !== expectedSuite.prefix ||
    suite.expectedCount !== expectedSuite.expectedCount ||
    !isDeepStrictEqual(
      suite.historicalTestFile,
      expectedSuite.historicalTestFile,
    ) ||
    !isDeepStrictEqual(suite.contractIds, expectedIds)
  ) {
    fail(`Frozen ${expectedSuite.name} evidence identity or count changed`);
  }
  fixtureContractIds.push(...suite.contractIds);
}

const redContractContents = fs.readFileSync(
  path.join(repositoryRoot, redContract.path),
  "utf8",
);
if (sha256(redContractContents) !== redContract.sha256) {
  fail("Canonical expected-red contract source changed without reconciliation");
}
if (/\bit\.todo\s*\(/u.test(redContractContents)) {
  fail("Canonical expected-red contracts must remain executable");
}
const sourceContractIds = [
  ...redContractContents.matchAll(/id:\s*["']((?:REC|PROV|GK)-\d{2})["']/gu),
].map((match) => match[1]);
if (!isDeepStrictEqual(sourceContractIds, fixtureContractIds)) {
  fail("Canonical expected-red IDs differ from the frozen evidence fixture");
}
if (new Set(sourceContractIds).size !== 37) {
  fail("Canonical expected-red contract IDs must be 37 unique values");
}

const vitestPath = path.join(
  repositoryRoot,
  "node_modules",
  "vitest",
  "vitest.mjs",
);
const result = spawnSync(
  process.execPath,
  [vitestPath, "run", redContract.path, "--reporter=verbose"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0 || !/1 passed/u.test(output)) {
  fail("Canonical expected-red evidence execution failed");
}

process.stdout.write(
  `Verified tracked evidence fixture ${historicalSource.commit} (${historicalSource.tree}) and executed 9 recovery, 13 provenance, and 15 Gatekeeper expected-red contracts without an off-main Git object.\n`,
);
