import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronBoundary = vi.hoisted(() => ({
  constructWebContentsView: vi.fn(),
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  session: { fromPartition: electronBoundary.fromPartition },
  WebContentsView: electronBoundary.constructWebContentsView,
}));

import { prepareElectronCalculatorSurface } from "../src/main/electron-calculator-surface.js";
import { createCalculatorWebPreferences } from "../src/main/hardened-web-preferences.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createElectronSurfaceHarness(
  cleanupFailures: {
    readonly auth?: Error;
    readonly cache?: Error;
    readonly connections?: Error;
    readonly storage?: Error;
  } = {},
  options: {
    readonly addChildFailure?: Error;
    readonly closeParentDuringLoad?: boolean;
    readonly loadUrl?: () => Promise<void>;
    readonly visualZoom?: () => Promise<void>;
    readonly storageCleanup?: () => Promise<void>;
    readonly loadUrlFailure?: Error;
    readonly reenterCloseDuringRemove?: boolean;
    readonly removeChildFailure?: Error;
    readonly requestResetFailure?: Error;
    readonly webContentsCloseFailure?: Error;
    readonly deferDestroyed?: boolean;
    readonly invalidateViewGetterOnDestroyed?: boolean;
  } = {},
) {
  let webContentsDestroyed = false;
  let parentClosedHandler: (() => void) | null = null;
  let parentDestroyed = false;
  let childAttached = false;
  let duringAttach: (() => void) | null = null;
  let duringRemove: (() => void) | null = null;
  let reentrantClose: (() => Promise<void>) | null = null;
  let reentrantClosePromise: Promise<void> | null = null;
  const webContentsEvents = new EventEmitter();
  const acknowledgeDestroyed = () => {
    webContentsDestroyed = true;
    webContentsEvents.emit("destroyed");
  };
  const onCleanupFailure = vi.fn();
  const closeParent = () => {
    parentDestroyed = true;
    const listener = parentClosedHandler;
    parentClosedHandler = null;
    listener?.();
  };
  const webContents = {
    close: vi.fn(() => {
      if (options.deferDestroyed !== true) acknowledgeDestroyed();
      if (options.webContentsCloseFailure !== undefined) {
        throw options.webContentsCloseFailure;
      }
    }),
    id: 17,
    isDestroyed: vi.fn(() => webContentsDestroyed),
    loadURL: vi.fn(async () => {
      if (options.closeParentDuringLoad === true) closeParent();
      if (options.loadUrlFailure !== undefined) throw options.loadUrlFailure;
      await options.loadUrl?.();
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      webContentsEvents.on(event, listener),
    ),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      webContentsEvents.once(event, listener),
    ),
    removeListener: vi.fn(
      (event: string, listener: (...args: unknown[]) => void) =>
        webContentsEvents.removeListener(event, listener),
    ),
    setAudioMuted: vi.fn(),
    setVisualZoomLevelLimits: vi.fn(async () => options.visualZoom?.()),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const view = {
    setBounds: vi.fn(),
    webContents,
  };
  if (options.invalidateViewGetterOnDestroyed === true) {
    Object.defineProperty(view, "webContents", {
      get: () => (webContentsDestroyed ? undefined : webContents),
    });
  }
  const cleanup = {
    clearAuthCache: vi.fn(async () => {
      if (cleanupFailures.auth !== undefined) throw cleanupFailures.auth;
    }),
    clearCache: vi.fn(async () => {
      if (cleanupFailures.cache !== undefined) throw cleanupFailures.cache;
    }),
    clearStorageData: vi.fn(async () => {
      await options.storageCleanup?.();
      if (cleanupFailures.storage !== undefined) throw cleanupFailures.storage;
    }),
    closeAllConnections: vi.fn(async () => {
      if (cleanupFailures.connections !== undefined)
        throw cleanupFailures.connections;
    }),
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
      addChildView: vi.fn(() => {
        duringAttach?.();
        childAttached = true;
        if (options.addChildFailure !== undefined)
          throw options.addChildFailure;
      }),
      removeChildView: vi.fn(() => {
        duringRemove?.();
        if (
          options.reenterCloseDuringRemove === true &&
          reentrantClose !== null
        ) {
          reentrantClosePromise = reentrantClose();
        }
        if (options.removeChildFailure !== undefined) {
          throw options.removeChildFailure;
        }
        childAttached = false;
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
    acknowledgeDestroyed,
    destroyedListenerCount: () => webContentsEvents.listenerCount("destroyed"),
    closeParent,
    cleanup,
    view,
    webContents,
    calculatorSession,
    addChildView: parent.contentView.addChildView,
    destroyParentWithoutEvent() {
      parentDestroyed = true;
    },
    setDuringAttach(callback: () => void) {
      duringAttach = callback;
    },
    setDuringRemove(callback: () => void) {
      duringRemove = callback;
    },
    isDisplayed: () =>
      childAttached && !webContentsDestroyed && !parentDestroyed,
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
  afterEach(() => vi.useRealTimers());
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

  it("loads and finishes zoom preparation detached, then attaches only on the explicit synchronous call", async () => {
    const load = deferred();
    const zoom = deferred();
    const harness = createElectronSurfaceHarness(
      {},
      {
        loadUrl: () => load.promise,
        visualZoom: () => zoom.promise,
      },
    );
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const preparation = prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      await vi.waitFor(() =>
        expect(harness.webContents.loadURL).toHaveBeenCalledOnce(),
      );
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.isDisplayed()).toBe(false);
      load.resolve();
      await vi.waitFor(() =>
        expect(
          harness.webContents.setVisualZoomLevelLimits,
        ).toHaveBeenCalledOnce(),
      );
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.isDisplayed()).toBe(false);
      zoom.resolve();
      const surface = await preparation;
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.isDisplayed()).toBe(false);
      expect(surface.webContentsId).toBe(17);
      expect(surface.partition).toMatch(/^desmoslock-calculator-/u);
      const nextBounds = { height: 500, width: 700, x: 10, y: 20 };
      surface.setBounds(nextBounds);
      expect(harness.view.setBounds).toHaveBeenLastCalledWith(nextBounds);
      expect(surface.attach()).toBeUndefined();
      expect(harness.isDisplayed()).toBe(true);
      expect(surface.attach()).toBeUndefined();
      expect(harness.addChildView).toHaveBeenCalledExactlyOnceWith(
        harness.view,
      );
      await surface.close();
    } finally {
      load.resolve();
      zoom.resolve();
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("closes a ready detached surface synchronously before held session cleanup and never attaches after close", async () => {
    const storage = deferred();
    const harness = createElectronSurfaceHarness(
      {},
      { storageCleanup: () => storage.promise },
    );
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      const close = surface.close();
      expect(surface.close()).toBe(close);
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.rendererTeardown.removeChildView).not.toHaveBeenCalled();
      expect(harness.rendererTeardown.close).toHaveBeenCalledExactlyOnceWith({
        waitForBeforeUnload: false,
      });
      expect(() => surface.attach()).toThrow(
        "CalculatorSurface is closed or invalidated",
      );
      await vi.waitFor(() =>
        expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce(),
      );
      let settled = false;
      void close.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      storage.resolve();
      await close;
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      storage.resolve();
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "waits for actual destruction before cleanup success and recovery continuation (reentrant close: %s)",
    async (reentrantClose) => {
      const harness = createElectronSurfaceHarness(
        {},
        {
          deferDestroyed: true,
          reenterCloseDuringRemove: reentrantClose,
        },
      );
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        surface.attach();
        harness.setReentrantClose(surface.close);
        const close = surface.close();
        const showRecovery = vi.fn();
        const continuation = close.then(showRecovery);
        expect(harness.isDisplayed()).toBe(false);
        expect(harness.webContents.isDestroyed()).toBe(false);
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
        expect(surface.close()).toBe(close);
        if (reentrantClose) expect(harness.reentrantClosePromise()).toBe(close);
        for (let index = 0; index < 30; index += 1) await Promise.resolve();
        expect(showRecovery).not.toHaveBeenCalled();
        expect(
          harness.calculatorSession.webRequest.onBeforeRequest,
        ).not.toHaveBeenCalledWith(null);
        expect(
          harness.calculatorSession.protocol.unhandle,
        ).not.toHaveBeenCalled();
        expect(harness.destroyedListenerCount()).toBe(1);
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface is closed or invalidated",
        );
        harness.acknowledgeDestroyed();
        await continuation;
        expect(showRecovery).toHaveBeenCalledOnce();
        expect(harness.destroyedListenerCount()).toBe(0);
        expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
      } finally {
        harness.acknowledgeDestroyed();
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("rejects unacknowledged destruction at the bounded deadline and a late event cannot claim recovery", async () => {
    const harness = createElectronSurfaceHarness({}, { deferDestroyed: true });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      vi.useFakeTimers();
      surface.attach();
      harness.closeParent();
      const close = surface.close();
      const showRecovery = vi.fn();
      const rejection = vi.fn();
      const continuation = close.then(showRecovery, rejection);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(showRecovery).not.toHaveBeenCalled();
      expect(rejection).not.toHaveBeenCalled();
      expect(harness.onCleanupFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await continuation;
      expect(showRecovery).not.toHaveBeenCalled();
      expect(rejection).toHaveBeenCalledOnce();
      expect(rejection.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message:
                "CalculatorSurface destruction was not acknowledged within 15000ms",
            }),
          ],
        }),
      );
      expect(harness.onCleanupFailure).toHaveBeenCalledExactlyOnceWith(
        rejection.mock.calls[0]?.[0],
      );
      expect(harness.destroyedListenerCount()).toBe(0);
      expect(
        harness.calculatorSession.webRequest.onBeforeRequest,
      ).not.toHaveBeenCalledWith(null);
      expect(
        harness.calculatorSession.protocol.unhandle,
      ).not.toHaveBeenCalled();
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
      harness.acknowledgeDestroyed();
      expect(surface.close()).toBe(close);
      await expect(surface.close()).rejects.toBe(rejection.mock.calls[0]?.[0]);
      expect(showRecovery).not.toHaveBeenCalled();
      expect(() => surface.attach()).toThrow(
        "CalculatorSurface is closed or invalidated",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.acknowledgeDestroyed();
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(["load", "zoom"] as const)(
    "retains destruction evidence after parent loss during held %s initialization",
    async (stage) => {
      const held = deferred();
      const harness = createElectronSurfaceHarness(
        {},
        {
          deferDestroyed: true,
          ...(stage === "load"
            ? { loadUrl: () => held.promise }
            : { visualZoom: () => held.promise }),
        },
      );
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const preparation = prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        const rejection = vi.fn();
        const outcome = preparation.then(() => {
          throw new Error("Unexpected prepared surface");
        }, rejection);
        await vi.waitFor(() =>
          expect(
            stage === "load"
              ? harness.webContents.loadURL
              : harness.webContents.setVisualZoomLevelLimits,
          ).toHaveBeenCalledOnce(),
        );
        vi.useFakeTimers();
        harness.closeParent();
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
        expect(harness.addChildView).not.toHaveBeenCalled();
        expect(harness.destroyedListenerCount()).toBe(1);
        if (stage === "load") {
          // Timeout before the acquisition Promise resumes must not reject an
          // unobserved internal Promise or discard its eventual cleanup error.
          await vi.advanceTimersByTimeAsync(15_000);
          expect(rejection).not.toHaveBeenCalled();
          held.resolve();
          await outcome;
          expect(rejection.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
              errors: [
                expect.objectContaining({
                  message:
                    "CalculatorSurface parent closed during initialization",
                }),
                expect.objectContaining({
                  message:
                    "CalculatorSurface destruction was not acknowledged within 15000ms",
                }),
              ],
            }),
          );
        } else {
          held.resolve();
          for (let index = 0; index < 30; index += 1) await Promise.resolve();
          expect(rejection).not.toHaveBeenCalled();
          expect(
            harness.calculatorSession.webRequest.onBeforeRequest,
          ).not.toHaveBeenCalledWith(null);
          harness.acknowledgeDestroyed();
          await outcome;
          expect(rejection.mock.calls[0]?.[0]).toMatchObject({
            message: "CalculatorSurface parent closed during initialization",
          });
        }
        expect(harness.destroyedListenerCount()).toBe(0);
        expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
        expect(harness.onCleanupFailure).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        held.resolve();
        harness.acknowledgeDestroyed();
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it.each([false, true])(
    "retains the direct WebContents when Electron invalidates its View getter (deferred destruction: %s)",
    async (deferDestroyed) => {
      const failures = {
        storage: new Error("synthetic storage cleanup failure"),
        cache: new Error("synthetic cache cleanup failure"),
        auth: new Error("synthetic auth cleanup failure"),
        connections: new Error("synthetic connection cleanup failure"),
      };
      const harness = createElectronSurfaceHarness(failures, {
        deferDestroyed,
        invalidateViewGetterOnDestroyed: true,
      });
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        surface.attach();
        const close = surface.close();
        const outcomes = Promise.allSettled([close, surface.close()]);
        if (deferDestroyed) {
          expect(harness.webContents.isDestroyed()).toBe(false);
          harness.acknowledgeDestroyed();
        }
        expect(harness.view.webContents).toBeUndefined();
        const result = await outcomes;
        for (const outcome of result)
          expect(outcome).toEqual({
            status: "rejected",
            reason: expect.objectContaining({
              message: "CalculatorSurface session cleanup failed",
              errors: [
                failures.storage,
                failures.cache,
                failures.auth,
                failures.connections,
              ],
            }),
          });
        if (
          result[0]?.status === "rejected" &&
          result[1]?.status === "rejected"
        )
          expect(result[0].reason).toBe(result[1].reason);
        expect(harness.destroyedListenerCount()).toBe(0);
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
      } finally {
        harness.acknowledgeDestroyed();
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("uses its original renderer after spontaneous destruction clears the View getter before close", async () => {
    const harness = createElectronSurfaceHarness(
      {},
      { invalidateViewGetterOnDestroyed: true },
    );
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      harness.acknowledgeDestroyed();
      expect(harness.view.webContents).toBeUndefined();
      expect(() => surface.attach()).toThrow(
        "CalculatorSurface is closed or invalidated",
      );
      surface.setBounds({ height: 300, width: 500, x: 0, y: 0 });
      await expect(surface.close()).resolves.toBeUndefined();
      expect(harness.rendererTeardown.close).not.toHaveBeenCalled();
      expect(harness.destroyedListenerCount()).toBe(0);
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("does not miss destruction caused by synchronous native child removal", async () => {
    const harness = createElectronSurfaceHarness({}, { deferDestroyed: true });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      surface.attach();
      harness.setDuringRemove(() => {
        expect(harness.destroyedListenerCount()).toBe(1);
        harness.acknowledgeDestroyed();
      });
      await surface.close();
      expect(harness.rendererTeardown.close).not.toHaveBeenCalled();
      expect(harness.destroyedListenerCount()).toBe(0);
    } finally {
      harness.acknowledgeDestroyed();
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(["acknowledged", "timeout"] as const)(
    "preserves close and independent cleanup errors with %s asynchronous destruction",
    async (result) => {
      const closeFailure = new Error(
        "synthetic close threw before destruction",
      );
      const failures = {
        storage: new Error("storage cleanup failed"),
        cache: new Error("cache cleanup failed"),
        auth: new Error("auth cleanup failed"),
        connections: new Error("connections cleanup failed"),
      };
      const harness = createElectronSurfaceHarness(failures, {
        deferDestroyed: true,
        webContentsCloseFailure: closeFailure,
      });
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        vi.useFakeTimers();
        const close = surface.close();
        const outcome = Promise.allSettled([close]);
        if (result === "acknowledged") harness.acknowledgeDestroyed();
        else await vi.advanceTimersByTimeAsync(15_000);
        const [settled] = await outcome;
        expect(settled).toEqual({
          status: "rejected",
          reason: expect.objectContaining({
            errors: [
              closeFailure,
              ...(result === "timeout"
                ? [
                    expect.objectContaining({
                      message:
                        "CalculatorSurface destruction was not acknowledged within 15000ms",
                    }),
                  ]
                : []),
              failures.storage,
              failures.cache,
              failures.auth,
              failures.connections,
            ],
          }),
        });
        expect(harness.destroyedListenerCount()).toBe(0);
        expect(surface.close()).toBe(close);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        harness.acknowledgeDestroyed();
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it.each([false, true])(
    "terminally invalidates on idempotent detach (initially attached: %s)",
    async (initiallyAttached) => {
      const harness = createElectronSurfaceHarness();
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        if (initiallyAttached) surface.attach();
        harness.setDuringRemove(() => {
          expect(() => surface.attach()).toThrow(
            "CalculatorSurface is closed or invalidated",
          );
        });
        surface.detach();
        surface.detach();
        expect(harness.isDisplayed()).toBe(false);
        expect(harness.rendererTeardown.removeChildView).toHaveBeenCalledTimes(
          initiallyAttached ? 1 : 0,
        );
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface is closed or invalidated",
        );
        expect(harness.addChildView).toHaveBeenCalledTimes(
          initiallyAttached ? 1 : 0,
        );
        await surface.close();
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it.each(["parent", "renderer"])(
    "refuses attachment after the prepared %s is destroyed",
    async (target) => {
      const harness = createElectronSurfaceHarness();
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        if (target === "parent") harness.destroyParentWithoutEvent();
        else harness.webContents.close();
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface is closed or invalidated",
        );
        expect(harness.addChildView).not.toHaveBeenCalled();
        expect(harness.isDisplayed()).toBe(false);
        await surface.close();
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("destroys a detached loading renderer immediately on parent loss before the load promise settles", async () => {
    const load = deferred();
    const harness = createElectronSurfaceHarness(
      {},
      { loadUrl: () => load.promise },
    );
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const preparation = prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      void preparation.catch(() => undefined);
      await vi.waitFor(() =>
        expect(harness.webContents.loadURL).toHaveBeenCalledOnce(),
      );
      harness.closeParent();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.isDisplayed()).toBe(false);
      load.resolve();
      await expect(preparation).rejects.toThrow(
        "CalculatorSurface parent closed during initialization",
      );
      expect(harness.addChildView).not.toHaveBeenCalled();
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      load.resolve();
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(["detach", "close", "parent-close"])(
    "cannot return an attached surface after reentrant %s during attachment",
    async (action) => {
      const harness = createElectronSurfaceHarness();
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        harness.setDuringAttach(() => {
          if (action === "detach") surface.detach();
          else if (action === "close") void surface.close();
          else harness.closeParent();
        });
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface invalidated during attachment",
        );
        expect(harness.isDisplayed()).toBe(false);
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface is closed or invalidated",
        );
        expect(harness.addChildView).toHaveBeenCalledOnce();
        await surface.close();
      } finally {
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("invalidates and tears down a partially attached child when addChildView throws", async () => {
    const attachFailure = new Error("synthetic partial attachment failure");
    const harness = createElectronSurfaceHarness(
      {},
      { addChildFailure: attachFailure },
    );
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();
    try {
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      expect(() => surface.attach()).toThrow(attachFailure);
      expect(harness.rendererTeardown.removeChildView).toHaveBeenCalledOnce();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      expect(harness.isDisplayed()).toBe(false);
      expect(() => surface.attach()).toThrow(
        "CalculatorSurface is closed or invalidated",
      );
      await surface.close();
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "preserves a throwing detach while destroying content and completing independent cleanup (reentrant close: %s)",
    async (reentrantClose) => {
      const removeChildFailure = new Error("synthetic explicit detach failure");
      const failures = {
        auth: new Error("auth cleanup failed"),
        cache: new Error("cache cleanup failed"),
        connections: new Error("connection cleanup failed"),
        storage: new Error("storage cleanup failed"),
      };
      const harness = createElectronSurfaceHarness(failures, {
        removeChildFailure,
        reenterCloseDuringRemove: reentrantClose,
      });
      const { outputDirectory, temporaryRoot } =
        await createCalculatorOutputDirectory();
      try {
        const surface = await prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        });
        surface.attach();
        harness.setReentrantClose(surface.close);
        expect(() => surface.detach()).toThrow(removeChildFailure);
        expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
        expect(harness.isDisplayed()).toBe(false);
        expect(() => surface.attach()).toThrow(
          "CalculatorSurface is closed or invalidated",
        );
        const close = surface.close();
        if (reentrantClose) expect(harness.reentrantClosePromise()).toBe(close);
        await expect(close).rejects.toEqual(
          expect.objectContaining({
            errors: [
              removeChildFailure,
              failures.storage,
              failures.cache,
              failures.auth,
              failures.connections,
            ],
            message: "CalculatorSurface session cleanup failed",
          }),
        );
        expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
        expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
        expect(harness.onCleanupFailure).not.toHaveBeenCalled();
      } finally {
        await fs.rm(temporaryRoot, { force: true, recursive: true });
      }
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
      const surface = await prepareElectronCalculatorSurface({
        bounds: { height: 400, width: 600, x: 0, y: 0 },
        onCleanupFailure: harness.onCleanupFailure,
        outputDirectory,
        parent: harness.parent,
      });
      surface.attach();
      harness.setReentrantClose(surface.close);

      const firstClose = surface.close();
      const secondClose = surface.close();
      expect(secondClose).toBe(firstClose);
      expect(harness.rendererTeardown.removeChildView).toHaveBeenCalledOnce();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
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
      const surface = await prepareElectronCalculatorSurface({
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
        prepareElectronCalculatorSurface({
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
    const removeChildFailure = new Error(
      "calculator detach failed during initialization",
    );
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
      loadUrlFailure: initializationFailure,
      removeChildFailure,
      webContentsCloseFailure,
    });
    const { outputDirectory, temporaryRoot } =
      await createCalculatorOutputDirectory();

    try {
      await expect(
        prepareElectronCalculatorSurface({
          bounds: { height: 400, width: 600, x: 0, y: 0 },
          onCleanupFailure: harness.onCleanupFailure,
          outputDirectory,
          parent: harness.parent,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          errors: [
            initializationFailure,
            webContentsCloseFailure,
            failures.storage,
            failures.cache,
            failures.auth,
            failures.connections,
          ],
          message: "CalculatorSurface initialization and cleanup both failed",
        }),
      );
      expect(harness.rendererTeardown.removeChildView).not.toHaveBeenCalled();
      expect(harness.rendererTeardown.close).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.clearAuthCache).toHaveBeenCalledOnce();
      expect(harness.cleanup.closeAllConnections).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
