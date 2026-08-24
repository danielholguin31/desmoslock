import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLinter } from "actionlint";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflowsRoot = path.join(repositoryRoot, ".github", "workflows");
const workflowFiles = fs
  .readdirSync(workflowsRoot)
  .filter((filename) => /\.ya?ml$/u.test(filename))
  .sort();
const lint = await createLinter();
let findingCount = 0;

for (const filename of workflowFiles) {
  const relativePath = path.join(".github", "workflows", filename);
  const findings = lint(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
    relativePath,
  );

  for (const finding of findings) {
    findingCount += 1;
    process.stderr.write(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.message} [${finding.kind}]\n`,
    );
  }
}

if (findingCount > 0) {
  throw new Error(`actionlint reported ${findingCount} workflow finding(s)`);
}

process.stdout.write(
  `actionlint passed for ${workflowFiles.length} workflow file(s).\n`,
);
