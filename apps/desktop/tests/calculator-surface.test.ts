import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronBoundary = vi.hoisted(() => ({
  constructWebContentsView: vi.fn(),
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  session: { fromPartition: electronBoundary.fromPartition },
  WebContentsView: electronBoundary.constructWebContentsView,
}));

import { createElectronCalculatorSurface } from "../src/main/electron-calculator-surface.js";
import { createCalculatorWebPreferences } from "../src/main/hardened-web-preferences.js";

function createElectronSurfaceHarness(
  cleanupFailures: {
    readonly auth: Error;
    readonly cache: Error;
    readonly connections: Error;
    readonly storage: Error;
  },
  options: {
    readonly closeParentDuringLoad?: boolean;
    readonly loadUrlFailure?: Error;
    readonly reenterCloseDuringRemove?: boolean;
    readonly removeChildFailure?: Error;
    readonly requestResetFailure?: Error;
    readonly webContentsCloseFailure?: Error;
  } = {},
) {
  let webContentsDestroyed = false;
  let parentClosedHandler: (() => void) | null = null;
  let parentDestroyed = false;
  let reentrantClose: (() => Promise<void>) | null = null;
  let reentrantClosePromise: Promise<void> | null = null;
  const onCleanupFailure = vi.fn();
  const closeParent = () => {
    parentDestroyed = true;
    const listener = parentClosedHandler;
    parentClosedHandler = null;
    listener?.();
  };
  const webContents = {
    close: vi.fn(() => {
      webContentsDestroyed = true;
      if (options.webContentsCloseFailure !== undefined) {
        throw options.webContentsCloseFailure;
      }
    }),
    id: 17,
    isDestroyed: vi.fn(() => webContentsDestroyed),
    loadURL: vi.fn(async () => {
      if (options.closeParentDuringLoad === true) closeParent();
      if (options.loadUrlFailure !== undefined) throw options.loadUrlFailure;
    }),
    on: vi.fn(),
    setAudioMuted: vi.fn(),
    setVisualZoomLevelLimits: vi.fn().mockResolvedValue(undefined),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const view = {
    setBounds: vi.fn(),
    webContents,
  };
  const cleanup = {
    clearAuthCache: vi.fn().mockRejectedValue(cleanupFailures.auth),
    clearCache: vi.fn().mockRejectedValue(cleanupFailures.cache),
    clearStorageData: vi.fn().mockRejectedValue(cleanupFailures.storage),
    closeAllConnections: vi.fn().mockRejectedValue(cleanupFailures.connections),
  };
  const calculatorSession = {
    ...cleanup,
    getStoragePath: vi.fn(() => null),
    isPersistent: vi.fn(() => false),
    on: vi.fn(),
    protocol: {
      handle: vi.fn(),
      unhandle: vi.fn(),
    },
    removeListener: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setProxy: vi.fn().mockResolvedValue(undefined),
    setSpellCheckerEnabled: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn((filter: unknown) => {
        if (filter === null && options.requestResetFailure !== undefined) {
          throw options.requestResetFailure;
        }
      }),
    },
  };
  const parent = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(() => {
        if (
          options.reenterCloseDuringRemove === true &&
          reentrantClose !== null
        ) {
          reentrantClosePromise = reentrantClose();
        }
        if (options.removeChildFailure !== undefined) {
          throw options.removeChildFailure;
        }
      }),
    },
    isDestroyed: vi.fn(() => parentDestroyed),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") parentClosedHandler = listener;
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === "closed" && parentClosedHandler === listener) {
        parentClosedHandler = null;
      }
    }),
  };

  electronBoundary.fromPartition.mockReturnValue(calculatorSession);
  electronBoundary.constructWebContentsView.mockImplementation(
    function FakeWebContentsView() {
      return view;
    },
  );

  return {
    closeParent,
    cleanup,
    onCleanupFailure,
    parent: parent as unknown as BrowserWindow,
    rendererTeardown: {
      close: webContents.close,
      removeChildView: parent.contentView.removeChildView,
    },
    reentrantClosePromise: () => reentrantClosePromise,
    setReentrantClose(close: () => Promise<void>) {
      reentrantClose = close;
    },
  };
}

async function createCalculatorOutputDirectory(): Promise<{
  readonly outputDirectory: string;
  readonly temporaryRoot: string;
}> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-calculator-surface-"),
  );
  try {
    const outputDirectory = path.join(temporaryRoot, "output");
    const calculatorDirectory = path.join(outputDirectory, "calculator");
    await fs.mkdir(calculatorDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(calculatorDirectory, "index.html"),
        "<!doctype html>",
      ),
      fs.writeFile(path.join(calculatorDirectory, "host.js"), ""),
      fs.writeFile(path.join(calculatorDirectory, "styles.css"), ""),
    ]);
    return { outputDirectory, temporaryRoot };
  } catch (error) {
    try {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "CalculatorSurface fixture acquisition and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

describe("calculator surface boundary", () => {
  beforeEach(() => {
    electronBoundary.constructWebContentsView.mockReset();
    electronBoundary.fromPartition.mockReset();
  });

  it("requests Electron's sandbox preference in a preload-free ephemeral contract", () => {
    const preferences = createCalculatorWebPreferences(
      "desmoslock-calculator-7b96d41e",
    );

    expect(preferences).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      disableDialogs: true,
      enableWebSQL: false,
      experimentalFeatures: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      partition: "desmoslock-calculator-7b96d41e",
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    });
    expect("preload" in preferences).toBe(false);
    expect(Object.isFrozen(preferences)).toBe(true);
  });

  it.each(["", "persist:calculator", "persist:desmoslock-calculator-1"])(
    "rejects a persistent or empty partition (%s)",
    (partition) => {
      expect(() => createCalculatorWebPreferences(partition)).toThrow(
        "CalculatorSurface requires an ephemeral partition",
      );
    },
  );

  it("caches every idempotent close before synchronous renderer and reset failures and still attempts all cleanup", async () => {
    const removeChildFailure = new Error("calculator detach failed");
    const requestResetFailure = new Error("request policy reset failed");
    const webContentsCloseFailure = new Error("calculator close failed");
    const failures = {
      auth: new Error("auth cleanup failed"),
      cache: new Error("cache cleanup failed"),
      connections: new Error("connection cleanup failed"),
      storage: new Error("storage cleanup failed"),
    };
    const harness = createElectronSurfaceHarness(failures, {
      reenterCloseDuringRemove: true,
      removeChildFailure,
      requestResetFailure,
      webContentsCloseFailure,
    });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();

    try {
      const surface = await createElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      harness.setReentrantClose(surface.close);

      const firstClose = surface.close();
      const secondClose = surface.close();
      expect(secondClose).toBe(firstClose);
      expect(harness.reentrantClosePromise()).toBe(firstClose);
      const concurrentOutcomes = await Promise.allSettled([
        firstClose,
        secondClose,
      ]);
      expect(concurrentOutcomes).toHaveLength(2);
      const rejectionReasons: unknown[] = [];
      for (const outcome of concurrentOutcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          rejectionReasons.push(outcome.reason);
          expect(outcome.reason).toBeInstanceOf(AggregateError);
          expect(outcome.reason).toEqual(
            expect.objectContaining({
              errors: [
                removeChildFailure,
                webContentsCloseFailure,
                requestResetFailure,
                failures.storage,
                failures.cache,
                failures.auth,
                failures.connections,
              ],
              message: "CalculatorSurface session cleanup failed",
            }),
          );
        }
      }
      expect(rejectionReasons[1]).toBe(rejectionReasons[0]);

      const settledOutcome = await Promise.allSettled([surface.close()]);
      expect(settledOutcome).toEqual([
        expect.objectContaining({ status: "rejected" }),
      ]);
      if (settledOutcome[0]?.status === "rejected") {
        expect(settledOutcome[0].reason).toBe(rejectionReasons[0]);
      }
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
      expect(harness.onCleanupFailure).not.toHaveBeenCalled();
      expect(harness.rendererTeardown.removeChildView).toHaveBeenCalledOnce();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("reports an implicit parent-close cleanup failure through its required supervisor", async () => {
    const failures = {
      auth: new Error("auth cleanup failed"),
      cache: new Error("cache cleanup failed"),
      connections: new Error("connection cleanup failed"),
      storage: new Error("storage cleanup failed"),
    };
    const harness = createElectronSurfaceHarness(failures);
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();

    try {
      const surface = await createElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });

      harness.closeParent();
      await vi.waitFor(() => {
        expect(harness.onCleanupFailure).toHaveBeenCalledOnce();
      });
      const reportedFailure = harness.onCleanupFailure.mock.calls[0]?.[0];
      expect(reportedFailure).toEqual(
        expect.objectContaining({
          errors: [
            failures.storage,
            failures.cache,
            failures.auth,
            failures.connections,
          ],
          message: "CalculatorSurface session cleanup failed",
        }),
      );
      await expect(surface.close()).rejects.toBe(reportedFailure);
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("preserves an initialization-time parent-close renderer failure in the creation rejection", async () => {
    const webContentsCloseFailure = new Error(
      "calculator close failed during initialization",
    );
    const failures = {
      auth: new Error("auth cleanup failed"),
      cache: new Error("cache cleanup failed"),
      connections: new Error("connection cleanup failed"),
      storage: new Error("storage cleanup failed"),
    };
    const harness = createElectronSurfaceHarness(failures, {
      closeParentDuringLoad: true,
      webContentsCloseFailure,
    });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();

    try {
      await expect(
        createElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: "CalculatorSurface parent closed during initialization",
            }),
            webContentsCloseFailure,
            failures.storage,
            failures.cache,
            failures.auth,
            failures.connections,
          ],
          message: "CalculatorSurface initialization and cleanup both failed",
        }),
      );
      expect(harness.onCleanupFailure).not.toHaveBeenCalled();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("preserves an initialization failure when required cleanup also rejects", async () => {
    const initializationFailure = new Error(
      "calculator document failed to load",
    );
    const failures = {
      auth: new Error("auth cleanup failed"),
      cache: new Error("cache cleanup failed"),
      connections: new Error("connection cleanup failed"),
      storage: new Error("storage cleanup failed"),
    };
    const harness = createElectronSurfaceHarness(failures, {
      loadUrlFailure: initializationFailure,
    });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();

    try {
      await expect(
        createElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          errors: [
            initializationFailure,
            failures.storage,
            failures.cache,
            failures.auth,
            failures.connections,
          ],
          message: "CalculatorSurface initialization and cleanup both failed",
        }),
      );
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
