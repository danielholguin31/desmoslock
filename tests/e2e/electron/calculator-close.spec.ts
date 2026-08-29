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

test("calculator close is idempotent and settles every cleanup task", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-calculator-close-"),
  );
  const outputDirectory = path.join(temporaryRoot, "output");
  const calculatorDirectory = path.join(outputDirectory, "calculator");
  await fs.mkdir(calculatorDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(calculatorDirectory, "index.html"),
      '<!doctype html><script type="module" src="./host.js"></script>',
    ),
    fs.writeFile(
      path.join(calculatorDirectory, "host.js"),
      "globalThis.calculatorCloseFixtureLoaded = true;",
    ),
    fs.writeFile(path.join(calculatorDirectory, "styles.css"), ""),
  ]);

  const fixturePath = path.join(temporaryRoot, "calculator-close.mjs");
  const resultPath = path.join(temporaryRoot, "close-result.json");
  await build({
    bundle: true,
    entryPoints: [
      path.resolve("tests/e2e/electron/fixtures/calculator-close.ts"),
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
    args: [...linuxLaunchFlags, fixturePath, outputDirectory, resultPath],
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
        calculatorWebContents: 0,
        calls: {
          auth: 1,
          cache: 1,
          connections: 1,
          storage: 1,
          webContentsClose: 1,
        },
        cleanupObservedWebContentsClose: true,
        outcomes: ["fulfilled", "fulfilled"],
        parentDestroyed: false,
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
