import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  acquireReadyElectronApplication,
  acquireWithLocalCleanup,
  runIndependentCleanupTasks,
  runWithFinalizer,
  runWithIndependentCleanup,
  trackElectronApplicationForCooperativeCleanup,
  waitForResourceAcquisition,
} from "../../scripts/production-desktop-resource-safety.mjs";
import {
  findProcessIdentity,
  readProcessIdentityTable,
} from "../../scripts/process-identity-table.mjs";

describe("production desktop verifier resource safety", () => {
  it("verifies recorded process retirement when readiness partially succeeds before failing", async () => {
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
        await trackElectronApplicationForCooperativeCleanup(application);
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
});
