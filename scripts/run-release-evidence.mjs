import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auditedCommit = "ddcfce456f3cf015ab77d207310140a311c945ab";
const auditedTree = "ab352dea9a5cdde409d2ff93d61dd62283005cbe";
const evidenceFiles = [
  ".github/workflows/release.yml",
  "desktop/package.json",
  "desktop/renderer/app.js",
  "desktop/renderer/backend.js",
  "desktop/scripts/provenance-contract.js",
  "desktop/scripts/record-gatekeeper-acceptance.js",
  "desktop/scripts/verify-gatekeeper-acceptance.js",
  "desktop/test/force-quit-recovery.test.js",
  "desktop/test/gatekeeper-acceptance.test.js",
  "desktop/test/release-provenance.test.js",
];
const suites = [
  ["recovery", "desktop/test/force-quit-recovery.test.js", 9],
  ["provenance", "desktop/test/release-provenance.test.js", 13],
  ["Gatekeeper", "desktop/test/gatekeeper-acceptance.test.js", 15],
];

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

const actualTree = git("rev-parse", `${auditedCommit}^{tree}`);
if (actualTree !== auditedTree) {
  throw new Error(
    `Audited release tree changed: expected ${auditedTree}, received ${actualTree}`,
  );
}

const evidenceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "desmoslock-release-evidence."),
);

try {
  for (const relativePath of evidenceFiles) {
    const destination = path.join(evidenceRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      execFileSync("git", ["show", `${auditedCommit}:${relativePath}`]),
    );
  }

  for (const [name, relativePath, expectedTests] of suites) {
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", path.join(evidenceRoot, relativePath)],
      {
        cwd: evidenceRoot,
        encoding: "utf8",
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);

    if (result.status !== 0) {
      throw new Error(`${name} evidence suite failed`);
    }
    if (
      !output.includes(`# tests ${expectedTests}`) ||
      !output.includes(`# pass ${expectedTests}`)
    ) {
      throw new Error(
        `${name} evidence suite did not preserve the expected ${expectedTests} tests`,
      );
    }
    if (!output.includes("# fail 0")) {
      throw new Error(`${name} evidence suite reported a failure`);
    }
  }
} finally {
  fs.rmSync(evidenceRoot, { force: true, recursive: true });
}

process.stdout.write(
  `Verified release evidence ${auditedCommit} (${auditedTree}): 9 recovery, 13 provenance, 15 Gatekeeper tests.\n`,
);
