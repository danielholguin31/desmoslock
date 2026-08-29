import { describe, expect, it } from "vitest";

import { spawnIsolatedProcessTree } from "../../scripts/isolated-process-tree.mjs";

const onlyPosix = process.platform === "win32" ? it.skip : it;

async function waitForOutput(
  tree: ReturnType<typeof spawnIsolatedProcessTree>,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!tree.output().includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(tree.output()).toContain(marker);
}

async function waitForLeaderStop(
  tree: ReturnType<typeof spawnIsolatedProcessTree>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (tree.leaderIsRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(tree.leaderIsRunning()).toBe(false);
}

describe("isolated process tree", () => {
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
      const tree = spawnIsolatedProcessTree({
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
        expect(tree.leaderIsRunning()).toBe(false);
        expect(tree.isEmpty()).toBe(true);
      } finally {
        await tree.terminate({
          forceMilliseconds: 3_000,
          graceMilliseconds: 50,
        });
      }
    },
  );

  onlyPosix(
    "force-terminates a surviving descendant and positively empties the group",
    async () => {
      const helper = [
        "process.stdout.write(`helper-ready:${process.pid}\\n`);",
        'process.on("SIGTERM", () => {',
        '  process.stdout.write("helper-ignored-term\\n");',
        "});",
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
      const tree = spawnIsolatedProcessTree({
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
        expect(() => process.kill(helperPid, 0)).not.toThrow();
        expect(tree.isEmpty()).toBe(false);
        expect(await tree.waitForClose(25)).toBeNull();

        const receipt = await tree.terminate({
          forceMilliseconds: 3_000,
          graceMilliseconds: 50,
        });

        expect(receipt).toMatchObject({
          forceSignalSent: true,
          gracefulSignalSent: true,
          treeEmpty: true,
        });
        expect(receipt.close).toMatchObject({
          exitCode: 0,
          signal: null,
          stderrEof: true,
          stdoutEof: true,
        });
        expect(receipt.close.output).toContain("helper-ignored-term");
        expect(tree.isEmpty()).toBe(true);
        expect(() => process.kill(helperPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        await tree
          .terminate({ forceMilliseconds: 3_000, graceMilliseconds: 50 })
          .catch(() => undefined);
        if (!tree.isEmpty()) {
          try {
            process.kill(-tree.pid, "SIGKILL");
          } catch {
            // The exact test-owned process group is already empty.
          }
        }
      }
    },
  );
});
