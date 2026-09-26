import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

import {
  createSuppressionLinter,
  suppressionFindings,
} from "../../scripts/lint-suppressions.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const eslint = new ESLint({ cwd: repositoryRoot });

async function lint(relativePath, source) {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(repositoryRoot, relativePath),
  });
  return result.messages.map(({ ruleId, message }) => ({
    ruleId,
    message,
  }));
}

function ruleIds(messages) {
  return messages.map(({ ruleId }) => ruleId);
}

const directiveProbe = [
  "/* eslint-disable */",
  "export const blanket = 1;",
  "// eslint-disable-next-line no-debugger",
  "debugger;",
  "// eslint-disable-next-line no-console -- stale suppression",
  "export const unused = 2;",
  "// eslint-disable-next-line no-debugger -- probe keeps a real reason",
  "debugger;",
  "",
].join("\n");

test("disable directives must name rules and give a reason", async () => {
  const results = await createSuppressionLinter(repositoryRoot).lintText(
    directiveProbe,
    { filePath: path.join(repositoryRoot, "scripts/lint-guard-probe.mjs") },
  );
  assert.deepEqual(
    suppressionFindings(results).map(({ line, messageId }) => ({
      line,
      messageId,
    })),
    [
      { line: 1, messageId: "unlimited" },
      { line: 3, messageId: "undescribed" },
    ],
  );
});

test("unused disable directives fail lint", async () => {
  const messages = await lint(
    "scripts/lint-guard-probe.mjs",
    [
      "// eslint-disable-next-line no-console -- stale suppression",
      "export const unused = 2;",
      "",
    ].join("\n"),
  );
  assert.deepEqual(messages, [
    {
      ruleId: null,
      message:
        "Unused eslint-disable directive (no problems were reported from 'no-console').",
    },
  ]);
});

test("shared packages cannot import Node, Electron, or applications", async () => {
  const messages = await lint(
    "packages/contracts/src/lint-guard-probe.ts",
    [
      'import fs from "node:fs";',
      'import { app } from "electron";',
      'import { publicConfig } from "../../../apps/web/src/public-config.js";',
      "export const probe = [fs, app, publicConfig];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(ruleIds(messages), [
    "no-restricted-imports",
    "no-restricted-imports",
    "no-restricted-imports",
  ]);
});

test("the web app cannot import Node built-ins or desktop code", async () => {
  const messages = await lint(
    "apps/web/src/lint-guard-probe.ts",
    [
      'import path from "path";',
      'import { status } from "../../desktop/src/backend-status.js";',
      "export const probe = [path, status];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(ruleIds(messages), [
    "no-restricted-imports",
    "no-restricted-imports",
  ]);
});

test("desktop code cannot import web code", async () => {
  const messages = await lint(
    "apps/desktop/src/main/lint-guard-probe.ts",
    [
      'import { publicConfig } from "../../../web/src/public-config.js";',
      "export const probe = [publicConfig];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(ruleIds(messages), ["no-restricted-imports"]);
});

test("renderer bundles cannot import Electron or main-process modules", async () => {
  const messages = await lint(
    "apps/desktop/src/calculator/lint-guard-probe.ts",
    [
      'import { ipcRenderer } from "electron";',
      'import { createStudentSessionStore } from "../main/student-session-store.js";',
      'import { parseLocalEndCause } from "../main/assessment-protection-types.js";',
      "export const probe = [ipcRenderer, createStudentSessionStore, parseLocalEndCause];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(ruleIds(messages), [
    "no-restricted-imports",
    "no-restricted-imports",
  ]);
});

test("the Electron main process keeps its Node and Electron imports", async () => {
  const messages = await lint(
    "apps/desktop/src/main/lint-guard-probe.ts",
    [
      'import fs from "node:fs/promises";',
      'import { app } from "electron";',
      "export const probe = [fs, app];",
      "",
    ].join("\n"),
  );
  assert.deepEqual(messages, []);
});
