import crypto from "node:crypto";

import { fail, readText, requireEqual } from "./shared.mjs";

const frozenHistoricalSource = {
  ref: "refs/heads/release/1.0",
  commit: "ddcfce456f3cf015ab77d207310140a311c945ab",
  tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
  executableDependency: false,
};

const frozenEvidenceFixture = {
  path: "tests/evidence/release-1.0-evidence.fixture.json",
  sha256: "b9f97ee0e1a844c6d68cbbc2a80e670dd4077ac1c6a1151d35eb87e8be0fd44b",
  expectedRedContract: {
    path: "tests/evidence/audited-release.contract.test.ts",
    sha256: "7b823ab28322f8aeea7e85f654d4ff6615675732fe84d1dd5c99cd894ca93054",
  },
  requiresHistoricalGitObject: false,
};

const frozenEvidenceSuites = [
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

function expectedContractIds(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
  );
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

export function verifyEvidenceContract(repositoryRoot, retainedEvidence) {
  requireEqual(
    retainedEvidence,
    {
      historicalSource: {
        commit: frozenHistoricalSource.commit,
        tree: frozenHistoricalSource.tree,
        executableDependency: false,
      },
      trackedFixture: frozenEvidenceFixture,
      suites: frozenEvidenceSuites.map(
        ({ prefix, expectedCount, historicalTestFile }) => ({
          prefix,
          count: expectedCount,
          source: historicalTestFile.path,
        }),
      ),
    },
    "Retained release evidence",
  );

  const evidenceFixtureContents = readText(
    repositoryRoot,
    frozenEvidenceFixture.path,
  );
  if (sha256(evidenceFixtureContents) !== frozenEvidenceFixture.sha256) {
    fail("Frozen historical evidence fixture digest changed");
  }
  const evidenceFixture = JSON.parse(evidenceFixtureContents);
  const expectedEvidenceIds = frozenEvidenceSuites.flatMap(
    ({ prefix, expectedCount }) => expectedContractIds(prefix, expectedCount),
  );
  requireEqual(
    evidenceFixture,
    {
      schemaVersion: 1,
      kind: "frozen-historical-evidence-index",
      historicalSource: frozenHistoricalSource,
      canonicalExpectedRedContract: {
        path: frozenEvidenceFixture.expectedRedContract.path,
        sha256: frozenEvidenceFixture.expectedRedContract.sha256,
        policy: "all-listed-contracts-must-remain-red",
      },
      suites: frozenEvidenceSuites.map((suite) => ({
        ...suite,
        contractIds: expectedContractIds(suite.prefix, suite.expectedCount),
      })),
    },
    "Frozen historical evidence fixture",
  );

  const evidenceContracts = readText(
    repositoryRoot,
    frozenEvidenceFixture.expectedRedContract.path,
  );
  if (
    sha256(evidenceContracts) !==
    frozenEvidenceFixture.expectedRedContract.sha256
  ) {
    fail("Canonical expected-red evidence source digest changed");
  }
  if (/\bit\.todo\s*\(/.test(evidenceContracts)) {
    fail(
      "v2 evidence contracts must be executable expected-failure tests, not todos",
    );
  }
  if (!evidenceContracts.includes(frozenHistoricalSource.commit)) {
    fail("v2 evidence contracts are not bound to the audited release commit");
  }
  const actualEvidenceIds = [
    ...evidenceContracts.matchAll(/id:\s*["']((?:REC|PROV|GK)-\d{2})["']/gu),
  ].map((match) => match[1]);
  requireEqual(
    actualEvidenceIds,
    expectedEvidenceIds,
    "v2 evidence contract IDs",
  );
  if (new Set(actualEvidenceIds).size !== 37) {
    fail("v2 evidence contract IDs must be unique");
  }

  const evidenceRunner = readText(
    repositoryRoot,
    "scripts/run-release-evidence.mjs",
  );
  for (const identity of [
    frozenHistoricalSource.commit,
    frozenHistoricalSource.tree,
    frozenEvidenceFixture.sha256,
    frozenEvidenceFixture.expectedRedContract.sha256,
  ]) {
    if (!evidenceRunner.includes(identity)) {
      fail(`Tracked evidence runner is not bound to ${identity}`);
    }
  }
  if (
    /(?:execFileSync|spawnSync)\(\s*["']git["']/u.test(evidenceRunner) ||
    /\bgit\s+(?:show|rev-parse|rev-list|merge-base)\b/u.test(evidenceRunner)
  ) {
    fail("Tracked evidence runner must not resolve off-main Git objects");
  }
}
