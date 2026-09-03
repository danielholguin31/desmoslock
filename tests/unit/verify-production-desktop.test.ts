import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  acquireReadyElectronApplication,
  acquireWithLocalCleanup,
  closeElectronApplicationCooperatively,
  refreshElectronApplicationProcessIdentities,
  runIndependentCleanupTasks,
  runWithFinalizer,
  runWithIndependentCleanup,
  waitForResourceAcquisition,
} from "../../scripts/production-desktop-resource-safety.mjs";
import {
  findProcessIdentity,
  readProcessIdentityTable,
  waitForProcessIdentitiesToDisappear,
} from "../../scripts/process-identity-table.mjs";

const onlyPosix = process.platform === "win32" ? it.skip : it;

function killIsolatedProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    )) {
      throw error;
    }
  }
}

describe("production desktop verifier resource safety", () => {
  it("retires a descendant that outlives its leader when readiness fails", async () => {
    const readinessFailure = new Error("first window failed");
    const descendantSource = [
      'process.once("SIGTERM", () => {',
      "  setTimeout(() => process.exit(0), 250);",
      "});",
      'process.send?.("ready");',
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const applicationSource = [
      'const { spawn } = require("node:child_process");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {`,
      '  stdio: ["ignore", "ignore", "ignore", "ipc"],',
      "});",
      'descendant.once("message", () => {',
      "  process.stdout.write(`ready:${descendant.pid}\\n`);",
      "});",
      'process.once("SIGTERM", () => {',
      '  descendant.kill("SIGTERM");',
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", applicationSource], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const [readyOutput] = await once(child.stdout, "data");
      const descendantPid = Number(
        String(readyOutput).trim().replace("ready:", ""),
      );
      const descendantIdentity = findProcessIdentity(
        await readProcessIdentityTable(),
        descendantPid,
      );
      expect(descendantIdentity).not.toBeNull();
      const application = {
        close: vi.fn(async () => {
          const exit = once(child, "exit");
          child.kill("SIGTERM");
          await exit;
        }),
        firstWindow: vi.fn().mockRejectedValue(readinessFailure),
        process: () => child,
      };
      const launch = vi.fn().mockResolvedValue(application);
      const ready = vi.fn(async () => {
        await application.firstWindow();
      });

      await expect(
        acquireReadyElectronApplication({
          launch,
          ready,
        }),
      ).rejects.toBe(readinessFailure);

      expect(launch).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith(application);
      expect(application.firstWindow).toHaveBeenCalledOnce();
      expect(application.close).toHaveBeenCalledOnce();
      expect(child.exitCode).toBe(0);
      expect(
        findProcessIdentity(await readProcessIdentityTable(), descendantPid),
      ).not.toEqual(descendantIdentity);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    }
  });

  it("falls back to raw close when application identity tracking fails", async () => {
    const trackingFailure = new Error("application process unavailable");
    const application = {
      close: vi.fn().mockResolvedValue(undefined),
      process: vi.fn(() => {
        throw trackingFailure;
      }),
    };
    const ready = vi.fn();

    await expect(
      acquireReadyElectronApplication({
        launch: vi.fn().mockResolvedValue(application),
        ready,
      }),
    ).rejects.toBe(trackingFailure);

    expect(application.close).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });

  onlyPosix(
    "retains a late same-group descendant after its intermediate parent exits",
    async () => {
      const descendantSource = [
        "setTimeout(() => process.exit(0), 1_000);",
      ].join("\n");
      const intermediateSource = [
        'const { spawn } = require("node:child_process");',
        'const descendant = spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(descendantSource)}], {` +
          ' stdio: ["ignore", "ignore", "ignore"] });',
        'descendant.once("spawn", () => {',
        "  process.stdout.write(String(descendant.pid));",
        "  descendant.unref();",
        "});",
      ].join("\n");
      const applicationSource = [
        'const { spawn } = require("node:child_process");',
        'process.on("message", (message) => {',
        '  if (message === "spawn-late-descendant") {',
        '    const intermediate = spawn(process.execPath, ["-e", ' +
          `${JSON.stringify(intermediateSource)}], {` +
          ' stdio: ["ignore", "pipe", "ignore"] });',
        '    let descendantPid = "";',
        '    intermediate.stdout.on("data", (chunk) => { descendantPid += chunk; });',
        '    intermediate.once("close", () => {',
        '      process.send?.({ processId: Number(descendantPid), type: "late-descendant-ready" });',
        "    });",
        "    return;",
        "  }",
        '  if (message === "exit-root") process.exit(0);',
        "});",
        'process.send?.({ type: "root-ready" });',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const child = spawn(process.execPath, ["-e", applicationSource], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let lateIdentity:
        | Awaited<
            ReturnType<typeof refreshElectronApplicationProcessIdentities>
          >["processIdentities"][number]
        | null = null;

      try {
        const [ready] = await once(child, "message");
        expect(ready).toEqual({ type: "root-ready" });
        const application = {
          close: vi
            .fn()
            .mockRejectedValue(
              new Error("Natural application exit must not require RPC close"),
            ),
          process: () => child,
        };
        await refreshElectronApplicationProcessIdentities(application);

        child.send("spawn-late-descendant");
        const [lateReady] = (await once(child, "message")) as [
          { processId: number; type: string },
        ];
        expect(lateReady.type).toBe("late-descendant-ready");
        const liveLateIdentity = findProcessIdentity(
          await readProcessIdentityTable(),
          lateReady.processId,
        );
        expect(liveLateIdentity).toMatchObject({
          processGroupId: child.pid,
          processId: lateReady.processId,
        });
        expect(liveLateIdentity?.parentPid).not.toBe(child.pid);
        const snapshot =
          await refreshElectronApplicationProcessIdentities(application);
        lateIdentity =
          snapshot.processIdentities.find(
            (identity) => identity.processId === lateReady.processId,
          ) ?? null;
        expect(snapshot.processGroupId).toBe(child.pid);
        expect(snapshot.rootIdentity.processId).toBe(child.pid);
        expect(lateIdentity).not.toBeNull();

        const rootExit = once(child, "exit");
        child.send("exit-root");
        await rootExit;
        await expect(
          closeElectronApplicationCooperatively(application),
        ).resolves.toBeUndefined();
        expect(application.close).not.toHaveBeenCalled();
        expect(
          findProcessIdentity(
            await readProcessIdentityTable(),
            lateReady.processId,
          ),
        ).not.toEqual(lateIdentity);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const rootExit = once(child, "exit");
          process.kill(-(child.pid as number), "SIGKILL");
          await rootExit;
        } else if (lateIdentity !== null) {
          const current = findProcessIdentity(
            await readProcessIdentityTable(),
            lateIdentity.processId,
          );
          if (current?.startedAt === lateIdentity.startedAt) {
            process.kill(-(child.pid as number), "SIGKILL");
          }
        }
      }
    },
  );

  onlyPosix(
    "discovers same-group descendants spawned while cooperative close exits the root",
    async () => {
      const canarySource = [
        'process.send?.({ type: "canary-ready" });',
        'process.once("message", (message) => {',
        '  if (message === "retire") {',
        "    setTimeout(() => process.exit(0), 250);",
        "  }",
        "});",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const lateDescendantSource = [
        'process.send?.({ type: "late-descendant-ready" });',
        "setTimeout(() => process.exit(0), 500);",
      ].join("\n");
      const applicationSource = [
        'const { spawn } = require("node:child_process");',
        `const canary = spawn(process.execPath, ["-e", ${JSON.stringify(canarySource)}], {`,
        '  stdio: ["ignore", "ignore", "ignore", "ipc"],',
        "});",
        'canary.once("message", () => {',
        '  process.send?.({ processId: canary.pid, type: "root-ready" });',
        "});",
        'process.once("message", (message) => {',
        '  if (message !== "close-root") return;',
        `  const late = spawn(process.execPath, ["-e", ${JSON.stringify(lateDescendantSource)}], {`,
        '    stdio: ["ignore", "ignore", "ignore", "ipc"],',
        "  });",
        '  late.once("message", () => {',
        '    process.send?.({ processId: late.pid, type: "late-descendant-ready" });',
        '    canary.send("retire");',
        "    canary.unref();",
        "    late.unref();",
        "    setTimeout(() => process.exit(0), 100);",
        "  });",
        "});",
        "setInterval(() => {}, 1_000);",
      ].join("\n");

      for (let iteration = 0; iteration < 5; iteration += 1) {
        const child = spawn(process.execPath, ["-e", applicationSource], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const processGroupId = child.pid;
        if (processGroupId === undefined) {
          throw new Error("Test application did not expose a process id");
        }
        let lateIdentity:
          | Awaited<
              ReturnType<typeof refreshElectronApplicationProcessIdentities>
            >["processIdentities"][number]
          | null = null;
        let lateDescendantOutlivedRoot = false;
        let recordedIdentities: Awaited<
          ReturnType<typeof refreshElectronApplicationProcessIdentities>
        >["processIdentities"] = [];

        try {
          const [rootReady] = (await once(child, "message")) as [
            { processId: number; type: string },
          ];
          expect(rootReady.type).toBe("root-ready");
          const application = {
            close: vi.fn(async () => {
              const lateReadyPromise = once(child, "message");
              const rootExit = once(child, "exit");
              child.send("close-root");
              const [lateReady] = (await lateReadyPromise) as [
                { processId: number; type: string },
              ];
              expect(lateReady.type).toBe("late-descendant-ready");
              lateIdentity = findProcessIdentity(
                await readProcessIdentityTable(),
                lateReady.processId,
              );
              expect(lateIdentity).toMatchObject({
                processGroupId,
                processId: lateReady.processId,
              });
              expect(recordedIdentities).not.toContainEqual(
                expect.objectContaining({ processId: lateReady.processId }),
              );
              await rootExit;
              lateDescendantOutlivedRoot =
                findProcessIdentity(
                  await readProcessIdentityTable(),
                  lateReady.processId,
                )?.startedAt === lateIdentity?.startedAt;
            }),
            process: () => child,
          };
          const beforeClose =
            await refreshElectronApplicationProcessIdentities(application);
          recordedIdentities = beforeClose.processIdentities;
          expect(beforeClose.processIdentities).toContainEqual(
            expect.objectContaining({ processId: rootReady.processId }),
          );

          await expect(
            closeElectronApplicationCooperatively(application),
          ).resolves.toBeUndefined();

          expect(application.close).toHaveBeenCalledOnce();
          expect(lateDescendantOutlivedRoot).toBe(true);
          expect(lateIdentity).not.toBeNull();
          expect(
            findProcessIdentity(
              await readProcessIdentityTable(),
              lateIdentity!.processId,
            ),
          ).not.toEqual(lateIdentity);
        } finally {
          const cleanupIdentities = [
            ...recordedIdentities,
            ...(lateIdentity === null ? [] : [lateIdentity]),
          ];
          const currentIdentities = await readProcessIdentityTable();
          const exactOwnedIdentityIsLive = cleanupIdentities.some((recorded) =>
            currentIdentities.some(
              (current) =>
                current.processGroupId === processGroupId &&
                current.processId === recorded.processId &&
                current.startedAt === recorded.startedAt,
            ),
          );
          const rootIsLive =
            child.exitCode === null && child.signalCode === null;
          const rootExit = rootIsLive ? once(child, "exit") : null;
          if (rootIsLive || exactOwnedIdentityIsLive) {
            killIsolatedProcessGroup(processGroupId);
            if (rootExit !== null) await rootExit;
            const remaining = await waitForProcessIdentitiesToDisappear(
              cleanupIdentities,
              2_000,
            );
            expect(remaining).toEqual([]);
          }
        }
      }
    },
    15_000,
  );

  it("cleans earlier resources when a later acquisition fails before the caller can retain them", async () => {
    const acquisitionFailure = new Error("TCP sink failed to listen");
    const cleanupFailure = new Error("HTTP sink failed to close");
    const closeHttpSink = vi.fn().mockRejectedValue(cleanupFailure);
    const closeUdpSink = vi.fn().mockResolvedValue(undefined);

    const acquisition = acquireWithLocalCleanup(async (registerCleanup) => {
      registerCleanup(closeHttpSink);
      registerCleanup(closeUdpSink);
      throw acquisitionFailure;
    });

    await expect(acquisition).rejects.toEqual(
      expect.objectContaining({
        errors: [acquisitionFailure, cleanupFailure],
      }),
    );
    await expect(acquisition).rejects.toBeInstanceOf(AggregateError);
    expect(closeHttpSink).toHaveBeenCalledOnce();
    expect(closeUdpSink).toHaveBeenCalledOnce();
  });

  it("attempts later cleanup tasks after the first cleanup rejects", async () => {
    const applicationCloseFailure = new Error("application close failed");
    const closeApplication = vi.fn(() => {
      throw applicationCloseFailure;
    });
    const closeNetworkSinks = vi.fn().mockResolvedValue(undefined);
    const removeTemporaryRoot = vi.fn().mockResolvedValue(undefined);

    const cleanup = runIndependentCleanupTasks([
      closeApplication,
      closeNetworkSinks,
      removeTemporaryRoot,
    ]);

    await expect(cleanup).rejects.toEqual(
      expect.objectContaining({
        errors: [applicationCloseFailure],
      }),
    );
    await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
    expect(closeApplication).toHaveBeenCalledOnce();
    expect(closeNetworkSinks).toHaveBeenCalledOnce();
    expect(removeTemporaryRoot).toHaveBeenCalledOnce();
  });

  it("turns an asynchronous acquisition error into a rejection that triggers local cleanup", async () => {
    const resource = new EventEmitter();
    const acquisitionFailure = new Error("UDP sink failed to bind");
    const closeEarlierSink = vi.fn().mockResolvedValue(undefined);

    const acquisition = acquireWithLocalCleanup(async (registerCleanup) => {
      registerCleanup(closeEarlierSink);
      await waitForResourceAcquisition(resource, () => {
        queueMicrotask(() => resource.emit("error", acquisitionFailure));
      });
    });

    await expect(acquisition).rejects.toBe(acquisitionFailure);
    expect(closeEarlierSink).toHaveBeenCalledOnce();
    expect(resource.listenerCount("error")).toBe(0);
    expect(resource.listenerCount("listening")).toBe(0);
  });

  it("preserves the verification failure while attempting and reporting every cleanup", async () => {
    const verificationFailure = new Error("runtime assertion failed");
    const applicationCloseFailure = new Error("application close failed");
    const closeApplication = vi.fn().mockRejectedValue(applicationCloseFailure);
    const removeTemporaryRoot = vi.fn().mockResolvedValue(undefined);

    const verification = runWithIndependentCleanup(async () => {
      throw verificationFailure;
    }, [closeApplication, removeTemporaryRoot]);

    await expect(verification).rejects.toEqual(
      expect.objectContaining({
        errors: [verificationFailure, applicationCloseFailure],
      }),
    );
    expect(closeApplication).toHaveBeenCalledOnce();
    expect(removeTemporaryRoot).toHaveBeenCalledOnce();
  });

  it("preserves an operation failure when its required finalizer also fails", async () => {
    const operationFailure = new Error("packaged launch assertion failed");
    const finalizerFailure = new Error("process retirement failed");
    const finalizer = vi.fn().mockRejectedValue(finalizerFailure);

    const operation = runWithFinalizer(async () => {
      throw operationFailure;
    }, finalizer);

    await expect(operation).rejects.toEqual(
      expect.objectContaining({ errors: [operationFailure, finalizerFailure] }),
    );
    expect(finalizer).toHaveBeenCalledOnce();
  });

  it("preserves teardown evidence when process cleanup cannot finish after an earlier failure", async () => {
    const verificationFailure = new Error("teardown receipt assertion failed");
    const processCleanupFailure = new Error("process tree remained live");
    const closeApplication = vi.fn().mockRejectedValue(processCleanupFailure);
    const removeReceiptDirectory = vi.fn().mockResolvedValue(undefined);

    const verification = runWithFinalizer(
      async () => {
        throw verificationFailure;
      },
      async () => {
        await closeApplication();
        await removeReceiptDirectory();
      },
      "Teardown receipt verification and process-first cleanup both failed",
    );

    await expect(verification).rejects.toEqual(
      expect.objectContaining({
        errors: [verificationFailure, processCleanupFailure],
      }),
    );
    expect(closeApplication).toHaveBeenCalledOnce();
    expect(removeReceiptDirectory).not.toHaveBeenCalled();
  });
});
