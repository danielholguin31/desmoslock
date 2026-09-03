import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  fail,
  requireEqual,
  requireObjectKeys,
  requireSha,
} from "./shared.mjs";

const expectedCanonicalBaseline = {
  commit: "388170e94418d20ad205812553e1c9fdf5de9139",
  tree: "95a00a77f84962248523f38a8c554216270cc23d",
};
const expectedReleaseMergeBase = {
  commit: "3883f4234923c0bc250dc41649ba3801144c3f58",
  tree: "ebb86934567790048bdb3f04ae8e57ac4968a34c",
};
const expectedReleaseHead = {
  commit: "ddcfce456f3cf015ab77d207310140a311c945ab",
  tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
};
const expectedReleaseCommits = [
  {
    commit: "f2cfb93b4f674d1a523cbef9cece2ff1c76f0f27",
    parents: ["3883f4234923c0bc250dc41649ba3801144c3f58"],
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
    parents: [
      "3883f4234923c0bc250dc41649ba3801144c3f58",
      "31c4768a7804f5d7f80d32af3d4c921ce0fc9a69",
    ],
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
    retainedEvidenceContractIds: ["GK-04", "GK-05", "GK-07", "GK-08", "GK-14"],
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
    tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
    subject: "Reject quarantine bypass advice",
    retainedEvidenceContractIds: ["GK-06", "GK-15"],
  },
  {
    commit: "ddcfce456f3cf015ab77d207310140a311c945ab",
    parents: [
      "56cd979f2b9fa292ede481099b042f0ef74fbe88",
      "371a4afa540a1f7d5bf88e8b18d4ba420008e74d",
    ],
    tree: "ab352dea9a5cdde409d2ff93d61dd62283005cbe",
    subject: "Merge PR #8: bind acceptance to GitHub draft assets",
    retainedEvidenceContractIds: [
      "REC-01..REC-09",
      "PROV-01..PROV-13",
      "GK-01..GK-15",
    ],
  },
];
const expectedRecoveryIdentity = {
  repository: "nicolasdmolina/desmoslock-recovery-20260827-1835-sanitized",
  ref: "recovery/macbook-20260827-1835/sanitized-evidence",
  commit: "c523743601ce75cfab4edcc6e4fd040d60730446",
  tree: "d2a11a84a54a0185890020fba684dbe2bf1e47c6",
  mode: "sanitized-orphan",
  patchInventorySha256:
    "648a0d3651b313f12b5ef23cc8bb7f55a0dcfaa4255b61eb83e84320c9b6f5c0",
  environmentExclusionsSha256:
    "4aa34d5bf0dfbdbff50befaf07dcc0f5be938be082fbee4bc7d90ccad2cc4fd8",
  ticket11aSalvagePatchSha256:
    "084d6075c04cc0deedce9ff3cc6cd949ed4b4e5b5dc7ba0ba2cafb5ed408a8c9",
};

export function verifySourceReconciliationContract(
  repositoryRoot,
  reconciliation,
) {
  function git(...arguments_) {
    return execFileSync("git", arguments_, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  }

  function gitIsAncestor(ancestor, descendant) {
    const result = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    if (result.status !== 0 && result.status !== 1) {
      fail(
        `Could not compare Git ancestry for ${ancestor} and ${descendant}: ${result.stderr}`,
      );
    }
    return result.status === 0;
  }

  requireObjectKeys(
    reconciliation,
    [
      "schemaVersion",
      "issue",
      "recordedAtUtc",
      "canonicalSource",
      "divergentReleaseLine",
      "retainedEvidence",
      "draftRelease",
      "sanitizedRecoveryArchive",
      "completion",
      "externalGates",
    ],
    "Source-reconciliation ledger",
  );
  if (
    reconciliation.schemaVersion !== 1 ||
    reconciliation.issue !== 29 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
      reconciliation.recordedAtUtc,
    )
  ) {
    fail("Source-reconciliation ledger header is invalid");
  }

  requireObjectKeys(
    reconciliation.canonicalSource,
    [
      "repository",
      "branch",
      "onlyIntegrationAndReleaseSource",
      "canonicalPaths",
      "integrationBaseline",
      "preservedLegacyEvidence",
      "releasePolicy",
    ],
    "Canonical-source ledger",
  );
  if (
    reconciliation.canonicalSource.repository !==
      "danielholguin31/desmoslock" ||
    reconciliation.canonicalSource.branch !== "main" ||
    reconciliation.canonicalSource.onlyIntegrationAndReleaseSource !== true
  ) {
    fail("Ledger must name main as the sole canonical source");
  }
  requireEqual(
    reconciliation.canonicalSource.canonicalPaths,
    {
      product: [
        "apps",
        "packages",
        "supabase/config.toml",
        "supabase/functions/deno.json",
        "supabase/functions/health",
        "supabase/migrations",
        "supabase/seed.sql",
        "supabase/tests/database",
      ],
      operations: ["scripts/synthetic-backup"],
    },
    "Canonical v2 source paths",
  );
  for (const sourcePath of [
    ...reconciliation.canonicalSource.canonicalPaths.product,
    ...reconciliation.canonicalSource.canonicalPaths.operations,
  ]) {
    if (!fs.existsSync(path.join(repositoryRoot, sourcePath))) {
      fail(`Canonical v2 source path is missing: ${sourcePath}`);
    }
  }
  requireEqual(
    reconciliation.canonicalSource.integrationBaseline,
    expectedCanonicalBaseline,
    "Canonical integration baseline",
  );
  requireEqual(
    reconciliation.canonicalSource.preservedLegacyEvidence,
    {
      enterpriseAdministration: {
        paths: ["web/admin", "supabase/enterprise.sql", "docs/OPERATIONS.md"],
        status: "historical-evidence-only",
        releaseable: false,
      },
    },
    "Canonical enterprise-administration evidence",
  );
  for (const evidencePath of reconciliation.canonicalSource
    .preservedLegacyEvidence.enterpriseAdministration.paths) {
    if (!fs.existsSync(path.join(repositoryRoot, evidencePath))) {
      fail(`Canonical legacy evidence path is missing: ${evidencePath}`);
    }
  }
  requireEqual(
    reconciliation.canonicalSource.releasePolicy,
    {
      reviewedCanonicalCommitRequired: true,
      versionAuthority: "package.json",
      lockfileAuthority: "package-lock.json",
      workspaceVersionPolicy: "exact-root",
      publicReleaseEnabled: false,
    },
    "Canonical release policy",
  );

  const releaseLedger = reconciliation.divergentReleaseLine;
  requireObjectKeys(
    releaseLedger,
    [
      "ref",
      "mergeBase",
      "head",
      "uniqueCommitCount",
      "dispositionCounts",
      "commits",
    ],
    "Divergent release-line ledger",
  );
  if (releaseLedger.ref !== "refs/heads/release/1.0") {
    fail("Divergent release-line ref identity changed");
  }
  requireEqual(
    releaseLedger.mergeBase,
    expectedReleaseMergeBase,
    "Release-line merge base",
  );
  requireEqual(releaseLedger.head, expectedReleaseHead, "Release-line head");
  for (const [identity, value] of [
    ["canonical commit", expectedCanonicalBaseline.commit],
    ["canonical tree", expectedCanonicalBaseline.tree],
    ["release merge-base commit", expectedReleaseMergeBase.commit],
    ["release merge-base tree", expectedReleaseMergeBase.tree],
    ["release head commit", expectedReleaseHead.commit],
    ["release head tree", expectedReleaseHead.tree],
  ]) {
    requireSha(value, identity);
  }

  if (
    git("rev-parse", `${expectedCanonicalBaseline.commit}^{tree}`) !==
    expectedCanonicalBaseline.tree
  ) {
    fail("Canonical baseline Git tree differs from the ledger");
  }
  if (!gitIsAncestor(expectedCanonicalBaseline.commit, "HEAD")) {
    fail(
      "Current source does not descend from the canonical reconciliation baseline",
    );
  }
  const expectedCommitIds = expectedReleaseCommits.map(({ commit }) => commit);
  if (
    releaseLedger.uniqueCommitCount !== expectedCommitIds.length ||
    !Array.isArray(releaseLedger.commits) ||
    releaseLedger.commits.length !== expectedCommitIds.length
  ) {
    fail("Divergent release ledger must account for exactly 17 commits");
  }

  const actualDispositionCounts = {
    integrated: 0,
    rejected: 0,
  };
  for (const [index, expectedCommit] of expectedReleaseCommits.entries()) {
    const record = releaseLedger.commits[index];
    const hasRetainedEvidence =
      expectedCommit.retainedEvidenceContractIds !== undefined;
    requireObjectKeys(
      record,
      hasRetainedEvidence
        ? [
            "commit",
            "parents",
            "tree",
            "subject",
            "disposition",
            "retainedEvidenceContractIds",
            "reason",
          ]
        : ["commit", "parents", "tree", "subject", "disposition", "reason"],
      `Release commit record ${index + 1}`,
    );
    const expectedRecord = {
      ...expectedCommit,
      disposition: "rejected",
    };
    const actualRecord = {
      commit: record.commit,
      parents: record.parents,
      tree: record.tree,
      subject: record.subject,
      disposition: record.disposition,
      ...(hasRetainedEvidence
        ? { retainedEvidenceContractIds: record.retainedEvidenceContractIds }
        : {}),
    };
    requireEqual(
      actualRecord,
      expectedRecord,
      `Release commit record ${index + 1}`,
    );
    requireSha(record.commit, `Release commit ${index + 1}`);
    requireSha(record.tree, `Release commit ${index + 1} tree`);
    for (const [parentIndex, parent] of record.parents.entries()) {
      requireSha(
        parent,
        `Release commit ${index + 1} parent ${parentIndex + 1}`,
      );
    }
    if (
      typeof record.reason !== "string" ||
      record.reason.trim().length < 20 ||
      !/reject/iu.test(record.reason)
    ) {
      fail(`Release commit ${record.commit} needs a specific recorded reason`);
    }
    if (
      hasRetainedEvidence &&
      (!Array.isArray(record.retainedEvidenceContractIds) ||
        record.retainedEvidenceContractIds.length === 0)
    ) {
      fail(`Release commit ${record.commit} needs retained evidence IDs`);
    }
    actualDispositionCounts[record.disposition] += 1;
  }
  requireEqual(
    releaseLedger.dispositionCounts,
    actualDispositionCounts,
    "Release disposition counts",
  );

  const recovery = reconciliation.sanitizedRecoveryArchive;
  requireObjectKeys(
    recovery,
    [
      "repository",
      "ref",
      "commit",
      "tree",
      "mode",
      "evidenceOnly",
      "mergeable",
      "originalCommitObjectsTransferred",
      "ticket04EnvContentPreserved",
      "counts",
      "sha256",
      "reconstructionDecisions",
      "residualLoss",
    ],
    "Sanitized recovery archive",
  );
  for (const [field, expected] of [
    ["repository", expectedRecoveryIdentity.repository],
    ["ref", expectedRecoveryIdentity.ref],
    ["commit", expectedRecoveryIdentity.commit],
    ["tree", expectedRecoveryIdentity.tree],
    ["mode", expectedRecoveryIdentity.mode],
  ]) {
    if (recovery[field] !== expected) {
      fail(`Sanitized recovery ${field} identity changed`);
    }
  }
  requireSha(recovery.commit, "Sanitized recovery commit");
  requireSha(recovery.tree, "Sanitized recovery tree");
  if (
    recovery.evidenceOnly !== true ||
    recovery.mergeable !== false ||
    recovery.originalCommitObjectsTransferred !== false ||
    recovery.ticket04EnvContentPreserved !== false
  ) {
    fail("Sanitized recovery must remain non-authoritative and non-mergeable");
  }
  requireEqual(
    recovery.counts,
    {
      sourceCommitMetadata: 29,
      sourceTips: 27,
      unpublishedSourceTips: 26,
      legacyCommits: 3,
      sanitizedPatches: 35,
      environmentExclusions: 10,
      originalUnpublishedCommitsAbsent: 32,
      originalTreeOverlap: 0,
    },
    "Sanitized recovery counts",
  );
  requireEqual(
    recovery.sha256,
    {
      patchInventory: expectedRecoveryIdentity.patchInventorySha256,
      ticket04SnapshotManifest:
        "bbf24523273883bcdf94d841738d1869cede9ab42ac3d0118ed6d013de47b412",
      ticket11aSnapshotManifest:
        "56acff0310ee2416d27812ca98a3bd73ee57daab359caee2d2cf0f14e47dd678",
      legacySnapshotManifest:
        "51237ab3872f274dda6326188198cc26a86ff96d30d2bd07f39a72ae5fb6da44",
      trackerEvidenceManifest:
        "5c411ab6cddbdf71d89f3956866418af6bac771b4fec8009560b9d0f329bb5c9",
      environmentExclusions:
        expectedRecoveryIdentity.environmentExclusionsSha256,
    },
    "Sanitized recovery digests",
  );
  for (const [digestName, digest] of Object.entries(recovery.sha256)) {
    requireSha(digest, `Sanitized recovery ${digestName} digest`, 64);
  }
  requireEqual(
    recovery.reconstructionDecisions,
    {
      ticket04: {
        base: "5d4c34cdd4958e5f40ac5c367462ad76fd39355a",
        verdict: "rejected-incomplete-negative-evidence",
        reason:
          "The capability lifecycle work remained incomplete after repeated rework and has no final accepted lifecycle-v4 receipt; it may inform new tests but is not integration input.",
      },
      ticket11a: {
        base: "c5fa74231ba5c645c8dcb8d72e77dbee1a19c269",
        verdict: "selective-salvage-only",
        salvagePatchSha256:
          expectedRecoveryIdentity.ticket11aSalvagePatchSha256,
        reason:
          "The preflight work is based on the rejected cumulative 1038ca4d5bd963e97f5c0c4de31e9234eb54d661 line; only independently reviewed fragments may be reconstructed after their true dependencies are accepted.",
      },
      legacyPlanning: { verdict: "non-authoritative-evidence-only" },
      trackerEvidence: { verdict: "non-authoritative-evidence-only" },
      overlayAllowed: false,
      cherryPickAllowed: false,
    },
    "Sanitized recovery reconstruction decisions",
  );
  requireSha(
    recovery.reconstructionDecisions.ticket11a.salvagePatchSha256,
    "Ticket 11a salvage patch digest",
    64,
  );
  if (
    !recovery.residualLoss.includes("All `.env*` bytes") ||
    !recovery.residualLoss.includes(
      "cannot recreate byte-identical original commits",
    )
  ) {
    fail("Sanitized recovery residual loss is not recorded exactly enough");
  }
  requireEqual(
    reconciliation.completion,
    {
      issue29Complete: false,
      state: "local-reconciliation-only",
      openGates: [
        "downstream-v2-behavior",
        "exact-head-ci",
        "remote-pr-and-branch-cleanup",
        "branch-protection",
        "artifact-provenance",
      ],
    },
    "Issue 29 completion state",
  );
  requireEqual(
    reconciliation.externalGates,
    {
      branchProtection: {
        state: "unresolved-owner-admin-gate",
        reason:
          "The private repository's current plan cannot apply the intended ruleset, and the current operator lacks owner/admin authority.",
        claimedEnforced: false,
      },
    },
    "External enforcement gates",
  );
}
