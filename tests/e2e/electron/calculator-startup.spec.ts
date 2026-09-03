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

test("closing the parent during calculator startup leaves no orphaned renderer", async () => {
  const cleanupTasks: (() => Promise<void>)[] = [];
  await runWithIndependentCleanup(async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "desmoslock-calculator-startup-"),
    );
    cleanupTasks.unshift(() =>
      fs.rm(temporaryRoot, { force: true, recursive: true }),
    );
    const outputDirectory = path.join(temporaryRoot, "output");
    const calculatorDirectory = path.join(outputDirectory, "calculator");
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    await fs.mkdir(calculatorDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(calculatorDirectory, "index.html"),
        '<!doctype html><script type="module" src="./host.js"></script>',
      ),
      fs.writeFile(
        path.join(calculatorDirectory, "host.js"),
        "globalThis.calculatorStartupFixtureLoaded = true;",
      ),
      fs.writeFile(path.join(calculatorDirectory, "styles.css"), ""),
    ]);

    const fixturePath = path.join(temporaryRoot, "calculator-startup.mjs");
    const resultPath = path.join(temporaryRoot, "startup-result.json");
    await build({
      bundle: true,
      entryPoints: [
        path.resolve("tests/e2e/electron/fixtures/calculator-startup.ts"),
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
          outputDirectory,
          resultPath,
        ],
        env: launchProfile.env,
        ...(launchProfile.chromiumSandbox === undefined
          ? {}
          : { chromiumSandbox: launchProfile.chromiumSandbox }),
      });
      const cleanup = () =>
        closeElectronApplicationCooperatively(acquiredApplication);
      registerCleanup(cleanup);
      await trackElectronApplicationForCooperativeCleanup(acquiredApplication);
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
        calculatorWebContents: 0,
        outcome: "rejected",
        parentDestroyed: true,
        status: "complete",
      });
  }, cleanupTasks);
});
