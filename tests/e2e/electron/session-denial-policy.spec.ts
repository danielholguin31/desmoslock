import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

import { createElectronLaunchProfile } from "../../../scripts/electron-launch-profile.mjs";

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

  const launchProfile = createElectronLaunchProfile();
  const application = await electron.launch({
    args: [...launchProfile.args, fixturePath, resultPath],
    env: launchProfile.env,
    ...(launchProfile.chromiumSandbox === undefined
      ? {}
      : { chromiumSandbox: launchProfile.chromiumSandbox }),
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
