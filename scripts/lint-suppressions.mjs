import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const ruleId = "desmoslock/described-directives";

// A blanket `/* eslint-disable */` would also silence the rule that forbids it,
// so this pass ignores inline configuration and runs only that rule.
export function createSuppressionLinter(cwd) {
  return new ESLint({
    cwd,
    overrideConfig: {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: "off",
        reportUnusedInlineConfigs: "off",
      },
    },
    ruleFilter: (rule) => rule.ruleId === ruleId,
  });
}

export function suppressionFindings(results) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === ruleId)
      .map((message) => ({ ...message, filePath: result.filePath })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const findings = suppressionFindings(
    await createSuppressionLinter(cwd).lintFiles(["."]),
  );
  for (const { filePath, line, column, message } of findings)
    process.stderr.write(
      `${path.relative(cwd, filePath)}:${line}:${column} ${message}\n`,
    );
  if (findings.length > 0) process.exitCode = 1;
}
