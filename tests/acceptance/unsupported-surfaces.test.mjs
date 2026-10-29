import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("repository contract excludes unsupported surfaces from every GA path", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-repository-contract.mjs"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `repository contract failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
});
