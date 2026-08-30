import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { spawnIsolatedProcessTree } from "../../scripts/isolated-process-tree.mjs";

const onlyPosix = process.platform === "win32" ? it.skip : it;

async function runIsolatedDriver(source: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}> {
  const driver = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      detached: true,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!Number.isSafeInteger(driver.pid) || driver.pid <= 1) {
    throw new Error("Isolated spawn-failure driver did not receive a safe pid");
  }
  let stderr = "";
  let stdout = "";
  driver.stderr.setEncoding("utf8");
  driver.stdout.setEncoding("utf8");
  driver.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  driver.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      driver.kill("SIGKILL");
      reject(new Error("Isolated spawn-failure driver timed out"));
    }, 2_000);
    driver.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    driver.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  return { ...result, stderr, stdout };
}

async function waitForOutput(
  tree: Awaited<ReturnType<typeof spawnIsolatedProcessTree>>,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!tree.output().includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(tree.output()).toContain(marker);
}

async function waitForLeaderStop(
  tree: Awaited<ReturnType<typeof spawnIsolatedProcessTree>>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (tree.targetIsRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(tree.targetIsRunning()).toBe(false);
}

function forceKillProcessIfAlive(processId: number): void {
  try {
    process.kill(processId, "SIGKILL");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

describe("isolated process tree", () => {
  onlyPosix(
    "returns bounded spawn failures without signaling its parent session group",
    async () => {
      const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "desmoslock-spawn-failure-"),
      );
      const missingExecutable = path.join(temporaryDirectory, "never-existed");
      const vanishedExecutable = path.join(
        temporaryDirectory,
        "vanished-after-access",
      );
      await fs.writeFile(vanishedExecutable, "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      await fs.access(vanishedExecutable, fs.constants.X_OK);

      try {
        const moduleUrl = new URL(
          "../../scripts/isolated-process-tree.mjs",
          import.meta.url,
        ).href;
        const source = [
          'import fs from "node:fs/promises";',
          `import { spawnIsolatedProcessTree } from ${JSON.stringify(moduleUrl)};`,
          `const paths = ${JSON.stringify([missingExecutable, vanishedExecutable])};`,
          "const failures = [];",
          "for (const [index, command] of paths.entries()) {",
          "  if (index === 1) {",
          "    await fs.access(command, fs.constants.X_OK);",
          "    await fs.rm(command);",
          "  }",
          "  try {",
          "    const tree = await spawnIsolatedProcessTree({",
          '      arguments: [], cwd: "/", environment: {}, command,',
          "    });",
          "    await tree.terminate();",
          '    failures.push({ code: "UNEXPECTED_SUCCESS" });',
          "  } catch (error) {",
          "    failures.push({",
          "      code: error?.code ?? error?.cause?.code ?? null,",
          "      message: String(error?.message ?? error),",
          "    });",
          "  }",
          "}",
          "process.stdout.write(JSON.stringify(failures));",
        ].join("\n");

        const driver = await runIsolatedDriver(source);

        expect(driver).toMatchObject({ code: 0, signal: null, stderr: "" });
        expect(JSON.parse(driver.stdout)).toEqual([
          expect.objectContaining({ code: "ENOENT" }),
          expect.objectContaining({ code: "ENOENT" }),
        ]);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
  );

  onlyPosix(
    "waits for both output pipes to reach EOF after the leader exits",
    async () => {
      const marker = "Debugger listening after leader exit";
      const delayedWriter = [
        "setTimeout(() => {",
        `  process.stderr.write(${JSON.stringify(`${marker}\n`)});`,
        "}, 150);",
      ].join("\n");
      const leader = [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(delayedWriter)}], {` +
          ' stdio: ["ignore", "ignore", "inherit"] });',
        "process.exit(78);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", leader],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });

      try {
        const receipt = await tree.waitForClose(3_000);

        expect(receipt).toMatchObject({
          exitCode: 78,
          signal: null,
          stderrEof: true,
          stdoutEof: true,
        });
        expect(receipt?.output).toContain(marker);
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(tree.targetIsRunning()).toBe(false);
        expect(tree.isRetired()).toBe(false);
      } finally {
        await tree.terminate({
          forceMilliseconds: 3_000,
          graceMilliseconds: 50,
        });
      }
    },
  );

  onlyPosix(
    "force-terminates a surviving descendant and retires recorded identities",
    async () => {
      const helper = [
        "process.stdout.write(`helper-ready:${process.pid}\\n`);",
        'process.on("SIGTERM", () => {',
        '  process.stdout.write("helper-ignored-term\\n");',
        "});",
        "setTimeout(() => process.exit(70), 10_000);",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const leader = [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(helper)}], {` +
          ' stdio: ["ignore", "inherit", "inherit"] });',
        'process.stdout.write("leader-ready\\n");',
        "process.exit(0);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", leader],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });

      try {
        await waitForOutput(tree, "leader-ready");
        await waitForOutput(tree, "helper-ready");
        await waitForLeaderStop(tree);
        const helperPid = Number(
          tree.output().match(/helper-ready:(\d+)/)?.[1],
        );
        expect(Number.isSafeInteger(helperPid)).toBe(true);
        expect(helperPid).toBeGreaterThan(1);
        expect(() => process.kill(helperPid, 0)).not.toThrow();
        expect(tree.isRetired()).toBe(false);
        expect(await tree.waitForClose(25)).toBeNull();

        const receipt = await tree.terminate({
          forceMilliseconds: 3_000,
          graceMilliseconds: 50,
        });

        expect(receipt).toMatchObject({
          forceSignalSent: true,
          gracefulSignalSent: true,
          recordedProcessIdentitiesGone: true,
        });
        expect(receipt.close).toMatchObject({
          exitCode: 0,
          signal: null,
          stderrEof: true,
          stdoutEof: true,
        });
        expect(receipt.close?.output).toContain("helper-ignored-term");
        expect(tree.isRetired()).toBe(true);
        expect(() => process.kill(helperPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        await tree
          .terminate({ forceMilliseconds: 3_000, graceMilliseconds: 50 })
          .catch(() => undefined);
      }
    },
  );

  onlyPosix(
    "retires containment before later calls can reach a reused group id",
    async () => {
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", "setInterval(() => {}, 1_000)"],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("retired containment touched a reused process group");
      });

      try {
        const firstTermination = tree.terminate({
          forceMilliseconds: 3_000,
          graceMilliseconds: 50,
        });
        const secondTermination = tree.terminate();
        expect(secondTermination).toBe(firstTermination);
        const termination = await firstTermination;
        expect(tree.isRetired()).toBe(true);
        expect(await tree.terminate()).toBe(termination);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    },
  );

  onlyPosix(
    "reports an unobserved target close only after forced identity cleanup",
    async () => {
      const target = [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("force-only-target-ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", target],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });
      await waitForOutput(tree, "force-only-target-ready");

      const receipt = await tree.terminate({
        forceMilliseconds: 3_000,
        graceMilliseconds: 50,
      });

      expect(receipt.close).toBeNull();
      expect(receipt.targetOutcome).toEqual({
        kind: "unobserved-before-final-kill",
      });
      expect(receipt.output).toMatchObject({
        stderrEof: true,
        stdoutEof: true,
      });
      expect(receipt.output.output).toContain("force-only-target-ready");
      expect(tree.targetIsRunning()).toBe(false);
      expect(tree.isRetired()).toBe(true);
    },
  );

  onlyPosix(
    "delivers graceful-signal evidence before a zero-grace final kill",
    async () => {
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", "setInterval(() => {}, 1_000)"],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });

      await expect(
        tree.terminate({ forceMilliseconds: 3_000, graceMilliseconds: 0 }),
      ).resolves.toMatchObject({
        forceSignalSent: true,
        gracefulSignalSent: true,
        recordedProcessIdentitiesGone: true,
      });
      expect(tree.isRetired()).toBe(true);
      expect(tree.targetIsRunning()).toBe(false);
    },
  );

  onlyPosix(
    "kills TERM-resistant same-group descendants forked after the termination snapshot",
    async () => {
      const grandchild = [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("late-grandchild-ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const helper = [
        'const { spawn } = require("node:child_process");',
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("late-helper-ready\\n");',
        "setTimeout(() => {",
        '  spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(grandchild)}], {` +
          ' stdio: ["ignore", "inherit", "inherit"] });',
        "}, 100);",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const target = [
        'const { spawn } = require("node:child_process");',
        'process.stdout.write("fork-target-ready\\n");',
        'process.on("SIGTERM", () => {',
        "  setTimeout(() => {",
        '    spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(helper)}], {` +
          ' stdio: ["ignore", "inherit", "inherit"] });',
        "    setTimeout(() => process.exit(0), 20);",
        "  }, 10);",
        "});",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", target],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });

      await waitForOutput(tree, "fork-target-ready");
      const receipt = await tree.terminate({
        forceMilliseconds: 3_000,
        graceMilliseconds: 750,
      });

      expect(receipt).toMatchObject({
        recordedProcessIdentitiesGone: true,
        targetOutcome: { exitCode: 0, kind: "observed", signal: null },
      });
      expect(receipt.output.output).toContain("late-helper-ready");
      expect(receipt.output.output).toContain("late-grandchild-ready");
      expect(tree.isRetired()).toBe(true);
    },
  );

  onlyPosix(
    "marks an unexpected sentinel crash LOST without signaling from the parent",
    async () => {
      const target = [
        "const sentinel = process.ppid;",
        'process.stdout.write("sentinel-crash-armed\\n");',
        'setTimeout(() => process.kill(sentinel, "SIGKILL"), 20);',
        'setTimeout(() => process.kill(0, "SIGKILL"), 400);',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", target],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("LOST containment reached the parent signal boundary");
      });

      try {
        await waitForOutput(tree, "sentinel-crash-armed");
        await new Promise((resolve) => setTimeout(resolve, 75));
        await expect(
          tree.terminate({
            forceMilliseconds: 500,
            graceMilliseconds: 50,
          }),
        ).rejects.toThrow(/containment was lost.*sentinel closed/i);
        expect(tree.isRetired()).toBe(false);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  );

  onlyPosix(
    "retains an escaped descendant identity after its direct parent exits",
    async () => {
      const escapedChild = [
        "setTimeout(() => process.exit(0), 800);",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const target = [
        'const { spawn } = require("node:child_process");',
        'const escaped = spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(escapedChild)}], {` +
          ' detached: true, stdio: ["ignore", "ignore", "ignore"] });',
        "process.stdout.write(`escaped-ready:${escaped.pid}\\n`);",
        "setTimeout(() => process.exit(0), 150);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", target],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });
      await waitForOutput(tree, "escaped-ready:");
      const escapedPid = Number(
        tree.output().match(/escaped-ready:(\d+)/)?.[1],
      );
      expect(Number.isSafeInteger(escapedPid)).toBe(true);
      expect(escapedPid).toBeGreaterThan(1);
      await expect(tree.waitForClose(1_000)).resolves.toMatchObject({
        exitCode: 0,
        signal: null,
      });
      expect(tree.targetIsRunning()).toBe(false);

      await expect(
        tree.terminate({ forceMilliseconds: 150, graceMilliseconds: 50 }),
      ).rejects.toThrow(/recorded process identities survived/i);
      expect(tree.isRetired()).toBe(false);
      expect(() => process.kill(escapedPid, 0)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(() => process.kill(escapedPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
  );

  onlyPosix(
    "does not claim an empty tree after an immediate leader exit hides a setsid child",
    async () => {
      const escapedChild = [
        'const fs = require("node:fs");',
        "fs.closeSync(1);",
        "fs.closeSync(2);",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const target = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const escaped = spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(escapedChild)}], {` +
          ' detached: true, stdio: ["ignore", "inherit", "inherit"] });',
        "escaped.unref();",
        "fs.writeSync(1, `escaped-ready:${escaped.pid}\\n`);",
        "process.exit(0);",
      ].join("\n");
      const tree = await spawnIsolatedProcessTree({
        arguments: ["-e", target],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {},
      });
      let escapedPid: number | null = null;

      try {
        await waitForOutput(tree, "escaped-ready:");
        escapedPid = Number(tree.output().match(/escaped-ready:(\d+)/)?.[1]);
        expect(Number.isSafeInteger(escapedPid)).toBe(true);
        expect(escapedPid).toBeGreaterThan(1);
        await expect(tree.waitForClose(1_000)).resolves.toMatchObject({
          exitCode: 0,
          signal: null,
          stderrEof: true,
          stdoutEof: true,
        });

        const receipt = await tree.terminate({
          forceMilliseconds: 150,
          graceMilliseconds: 50,
        });

        expect(() => process.kill(escapedPid, 0)).not.toThrow();
        expect(receipt).toMatchObject({
          recordedProcessIdentitiesGone: true,
        });
        expect(receipt).not.toHaveProperty("treeEmpty");
        expect(tree.isRetired()).toBe(true);
      } finally {
        await tree
          .terminate({ forceMilliseconds: 150, graceMilliseconds: 50 })
          .catch(() => undefined);
        if (escapedPid !== null && escapedPid > 1) {
          forceKillProcessIfAlive(escapedPid);
        }
      }
    },
  );
});
