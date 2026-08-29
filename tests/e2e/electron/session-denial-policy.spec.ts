import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

function launchEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") {
      environment[key] = value;
    }
  }
  if (process.platform === "linux") environment.ELECTRON_DISABLE_SANDBOX = "1";
  return environment;
}

test("default-deny policy returns false to Electron before external-protocol observers run", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-session-denial-"),
  );
  const fixturePath = path.join(temporaryRoot, "session-denial-policy.mjs");
  const resultPath = path.join(temporaryRoot, "session-denial-result.json");
  await build({
    bundle: true,
    entryPoints: [
      path.resolve("tests/e2e/electron/fixtures/session-denial-policy.ts"),
    ],
    external: ["electron"],
    format: "esm",
    outfile: fixturePath,
    platform: "node",
    target: "node24",
  });

  const linuxLaunchFlags =
    process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
      : [];
  const application = await electron.launch({
    args: [...linuxLaunchFlags, fixturePath, resultPath],
    env: launchEnvironment(),
    ...(process.platform === "linux" ? { chromiumSandbox: false } : {}),
  });

  try {
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(resultPath, "utf8"));
        } catch {
          return null;
        }
      })
      .toEqual({
        externalPermission: {
          callbackInvocations: 1,
          deniedBeforeObservers: true,
          observerAttempts: 2,
          observerFailures: 1,
          observerSuccesses: 1,
          permission: "openExternal",
          scheme: "desmoslock-unregistered:",
        },
        locationUnchanged: true,
        observedDownloadDefaultPrevented: true,
        permission: "denied",
      });
  } finally {
    const child = application.process();
    const exited =
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
});
