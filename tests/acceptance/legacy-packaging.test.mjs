import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const desktopRoot = path.join(repositoryRoot, "desktop");

function runLegacyPackaging(script, extraArguments = []) {
  return spawnSync("npm", ["run", script, "--", ...extraArguments], {
    cwd: desktopRoot,
    encoding: "utf8",
  });
}

function assertFailClosed(result, command) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(
    result.status,
    0,
    `${command} must fail closed, received:\n${output}`,
  );
  assert.match(
    output,
    /legacy v1 packaging is disabled/i,
    `${command} must fail with an explicit packaging disablement, received:\n${output}`,
  );
  assert.doesNotMatch(
    output,
    /missing script|Cannot find module|electron-builder/,
    `${command} must not fail because tooling is absent:\n${output}`,
  );
}

test("legacy desktop dist fails closed", () => {
  assertFailClosed(runLegacyPackaging("dist"), "npm run dist");
});

test("legacy desktop dist:mac fails closed", () => {
  assertFailClosed(runLegacyPackaging("dist:mac"), "npm run dist:mac");
});

test("legacy desktop dist:win fails closed", () => {
  assertFailClosed(runLegacyPackaging("dist:win"), "npm run dist:win");
});

test("legacy Linux AppImage production fails closed", () => {
  assertFailClosed(runLegacyPackaging("dist:linux"), "npm run dist:linux");
  assertFailClosed(
    runLegacyPackaging("dist", ["--linux"]),
    "npm run dist -- --linux",
  );
});
