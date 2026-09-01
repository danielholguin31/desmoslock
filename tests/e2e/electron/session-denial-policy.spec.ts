import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

import { createElectronLaunchProfile } from "../../../scripts/electron-launch-profile.mjs";
import {
  acquireWithLocalCleanup,
  closeElectronApplicationCooperatively,
  runWithIndependentCleanup,
  trackElectronApplicationForCooperativeCleanup,
} from "../../../scripts/production-desktop-resource-safety.mjs";

test("default-deny policy returns false to Electron before external-protocol observers run", async () => {
  const cleanupTasks: (() => Promise<void>)[] = [];
  await runWithIndependentCleanup(async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "desmoslock-session-denial-"),
    );
    cleanupTasks.unshift(() =>
      fs.rm(temporaryRoot, { force: true, recursive: true }),
    );
    const userDataDirectory = path.join(temporaryRoot, "user-data");
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
    await acquireWithLocalCleanup(async (registerCleanup) => {
      const acquiredApplication = await electron.launch({
        args: [
          ...launchProfile.args,
          `--user-data-dir=${userDataDirectory}`,
          fixturePath,
          resultPath,
        ],
        env: launchProfile.env,
        ...(launchProfile.chromiumSandbox === undefined
          ? {}
          : { chromiumSandbox: launchProfile.chromiumSandbox }),
      });
      const child = acquiredApplication.process();
      registerCleanup(() =>
        child.exitCode === null && child.signalCode === null
          ? acquiredApplication.close()
          : undefined,
      );
      await trackElectronApplicationForCooperativeCleanup(acquiredApplication);
      const cleanup = () =>
        closeElectronApplicationCooperatively(acquiredApplication);
      registerCleanup(cleanup);
      cleanupTasks.unshift(cleanup);
      return acquiredApplication;
    });

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
  }, cleanupTasks);
});
