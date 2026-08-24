import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deliberatelyFail =
  process.argv.slice(2).includes("--fail") ||
  process.env.DESMOSLOCK_FORCE_REQUIRED_CHECK_FAILURE === "true";

if (deliberatelyFail) {
  process.stderr.write("Deliberate required-check failure requested.\n");
  process.exitCode = 1;
} else {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const probe = spawnSync(
    process.execPath,
    ["--test", "tests/probes/required-check-failure.test.mjs"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;

  if (probe.status === 0) {
    throw new Error("Required-check probe unexpectedly passed");
  }
  if (!output.includes("DESMOSLOCK_REQUIRED_CHECK_PROBE")) {
    throw new Error("Required-check probe failed for an unexpected reason");
  }

  process.stdout.write(
    "Required-check probe produced the expected non-zero test result.\n",
  );
}
