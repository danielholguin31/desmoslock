import fs from "node:fs";
import path from "node:path";

import { fail, readJson, readText, requireEqual } from "./shared.mjs";

// Legacy v1 source, release material and personal tooling were removed from
// main. The historical tree remains reachable only at the v1.0.0 tag.
export const removedLegacyPaths = Object.freeze([
  ".github/workflows/release.yml",
  ".mcp.json",
  "desktop",
  "docs/MACOS_RELEASE.md",
  "docs/OPERATIONS.md",
  "docs/SUPABASE.md",
  "scripts/ignore-legacy-vercel-build.mjs",
  "scripts/refuse-legacy-packaging.mjs",
  "scripts/refuse-legacy-vercel-build.mjs",
  "scripts/release-tombstone-contract.mjs",
  "server",
  "supabase/enterprise.sql",
  "supabase/schema.sql",
  "web",
]);

// The repository-root Vercel configuration applies only to a project rooted at
// the repository root, which is the retired v1 deployment. The v2 Staff web app
// (apps/web/vercel.json) and the project site (site/vercel.json) use their own
// root directories and are unaffected by this file.
export const expectedRootVercelConfiguration = Object.freeze({
  $schema: "https://openapi.vercel.sh/vercel.json",
  ignoreCommand: "exit 0",
  buildCommand: "exit 1",
});

const forbiddenWorkflowPatterns = [
  ["tag trigger", /^\s+tags(?:-ignore)?:/mu],
  [
    "release, schedule, or external dispatch trigger",
    /^\s+(?:release|schedule|repository_dispatch|workflow_run):/mu,
  ],
  ["deployment environment", /^\s+environment:/mu],
  [
    "release or publish behavior",
    /(?:gh\s+release|npm\s+publish|action-gh-release)/iu,
  ],
  [
    "packaging or deploy behavior",
    /(?:electron-builder|wrangler\s+deploy|vercel\s+deploy)/iu,
  ],
];

export function assertNoReleaseWorkflow(filename, contents) {
  if (/^release/iu.test(filename)) {
    fail(`Workflow ${filename} restores a release pipeline outside review`);
  }
  for (const [label, pattern] of forbiddenWorkflowPatterns) {
    if (pattern.test(contents)) {
      fail(`Workflow ${filename} contains forbidden ${label}`);
    }
  }
}

export function verifyLegacyQuarantineContract(repositoryRoot, draftRelease) {
  for (const legacyPath of removedLegacyPaths) {
    if (fs.existsSync(path.join(repositoryRoot, legacyPath))) {
      fail(
        `Removed legacy v1 path was restored: ${legacyPath}; v1 history lives at tag v1.0.0`,
      );
    }
  }

  const workflowsRoot = path.join(repositoryRoot, ".github", "workflows");
  for (const filename of fs.readdirSync(workflowsRoot).sort()) {
    if (!/\.ya?ml$/u.test(filename)) continue;
    assertNoReleaseWorkflow(
      filename,
      readText(repositoryRoot, path.join(".github", "workflows", filename)),
    );
  }

  requireEqual(
    readJson(repositoryRoot, "vercel.json"),
    expectedRootVercelConfiguration,
    "Root Vercel configuration (the legacy project must skip and refuse every build)",
  );

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
