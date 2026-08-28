import { assertLegacyReleaseTombstone } from "../release-tombstone-contract.mjs";

import { fail, readJson, readText, requireEqual } from "./shared.mjs";

export function verifyLegacyQuarantineContract(repositoryRoot, draftRelease) {
  const releaseWorkflow = readText(
    repositoryRoot,
    ".github/workflows/release.yml",
  );
  assertLegacyReleaseTombstone(releaseWorkflow);

  for (const legacyDocument of [
    "docs/MACOS_RELEASE.md",
    "docs/OPERATIONS.md",
    "docs/SUPABASE.md",
  ]) {
    if (
      !readText(repositoryRoot, legacyDocument).includes(
        "**Historical v1 evidence only.**",
      )
    ) {
      fail(
        `${legacyDocument} presents historical instructions as current truth`,
      );
    }
  }

  const vercel = readJson(repositoryRoot, "vercel.json");
  if (vercel.ignoreCommand !== "node scripts/ignore-legacy-vercel-build.mjs") {
    fail("Legacy Vercel project does not ignore every build");
  }
  if (vercel.buildCommand !== "node scripts/refuse-legacy-vercel-build.mjs") {
    fail("Direct legacy Vercel builds are not blocked");
  }

  const legacyDesktop = readJson(repositoryRoot, "desktop/package.json");
  for (const script of ["dist", "dist:mac", "dist:win", "dist:linux"]) {
    if (
      !String(legacyDesktop.scripts?.[script] ?? "").includes(
        "refuse-legacy-packaging.mjs",
      )
    ) {
      fail(`Legacy ${script} is not fail-closed`);
    }
  }

  requireEqual(
    draftRelease,
    {
      repository: "desmoslock/desmoslock-releases",
      releaseId: 370225506,
      version: "v1.0.1",
      assetCount: 6,
      state: "draft-unpublished",
      policy: "never-publish",
    },
    "Quarantined v1.0.1 draft release",
  );
}
