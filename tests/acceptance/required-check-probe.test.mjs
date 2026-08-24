import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function runProbe(arguments_ = []) {
  return spawnSync(
    process.execPath,
    ["scripts/verify-required-check-probe.mjs", ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

test("required-check probe has an explicit passing and deliberately failing mode", () => {
  const passing = runProbe();
  assert.equal(
    passing.status,
    0,
    `${passing.stdout ?? ""}${passing.stderr ?? ""}`,
  );

  const failing = runProbe(["--fail"]);
  assert.equal(
    failing.status,
    1,
    "the deliberate probe must return a failing check status",
  );
  assert.match(
    `${failing.stdout ?? ""}${failing.stderr ?? ""}`,
    /deliberate required-check failure/i,
  );
});

test("the merge gate depends on the required-check probe", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );

  assert.match(workflow, /^\s{2}required-check-probe:\s*$/m);
  assert.match(
    workflow,
    /^\s{2}required:\s*$[\s\S]*?^\s{4}needs:\s*$[\s\S]*?^\s{6}- required-check-probe\s*$/m,
  );
  assert.match(workflow, /DESMOSLOCK_FORCE_REQUIRED_CHECK_FAILURE/);
});
