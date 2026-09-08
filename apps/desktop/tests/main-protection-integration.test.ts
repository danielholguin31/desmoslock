import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssessmentProtectionCoordinatorOptions } from "../src/main/assessment-protection-coordinator.js";
import type { ElectronProtectionWindowOptions } from "../src/main/electron-protection-window.js";

const boundary = vi.hoisted(() => ({
  configured: true,
  electron: {} as Record<string, unknown>,
  student: {
    initialize: vi.fn(),
    dispose: vi.fn(),
    refresh: vi.fn(),
    flushEvidence: vi.fn(),
  },
  readBuildIdentity: vi.fn(),
  protection: {
    refresh: vi.fn(),
    requestLocalEnd: vi.fn(),
    shutdown: vi.fn(),
    readView: vi.fn(),
    subscribe: vi.fn(),
    hasRetainedAttempt: vi.fn(),
  },
  createStudent: vi.fn(),
  createProtection: vi.fn(),
  createNative: vi.fn(),
  createWindowPort: vi.fn(),
  prepareCalculator: vi.fn(),
  createIpc: vi.fn(),
  windowPort: {
    prepare: vi.fn(),
    isReady: vi.fn(),
    showRecovery: vi.fn(),
    restore: vi.fn(),
    calculatorBounds: vi.fn(),
    installZoomControls: vi.fn(),
  },
  ipc: {
    request: vi.fn(),
    register: vi.fn(),
    revoke: vi.fn(),
    mayPublish: vi.fn(),
  },
}));

vi.mock("electron", () => boundary.electron);
vi.mock("node:fs/promises", () => ({
  default: { readFile: vi.fn(async () => Buffer.from("synthetic shell")) },
}));
vi.mock("../src/backend-status.js", () => ({
  publicDesktopBackendConfiguration: boundary.configured
    ? { environment: "local", url: "http://127.0.0.1:54321" }
    : null,
}));
vi.mock("../src/main/student-session-coordinator.js", () => ({
  createStudentSessionCoordinator: boundary.createStudent,
}));
vi.mock("../src/main/assessment-protection-coordinator.js", () => ({
  createAssessmentProtectionCoordinator: boundary.createProtection,
}));
vi.mock("../src/main/native-protection-adapter.js", () => ({
  createNativeProtectionAdapter: boundary.createNative,
}));
vi.mock("../src/main/electron-protection-window.js", () => ({
  createElectronProtectionWindow: boundary.createWindowPort,
}));
vi.mock("../src/main/electron-calculator-surface.js", () => ({
  prepareElectronCalculatorSurface: boundary.prepareCalculator,
}));
vi.mock("../src/main/student-session-ipc.js", () => ({
  createStudentSessionIpc: boundary.createIpc,
}));
vi.mock("../src/main/student-session-crypto.js", () => ({
  createStudentSessionCrypto: vi.fn(() => ({})),
}));
vi.mock("../src/main/build-identity.js", () => ({
  readClientBuildIdentity: boundary.readBuildIdentity,
}));
vi.mock("../src/main/student-session-transport.js", () => ({
  createStudentSessionTransport: vi.fn(() => ({})),
}));
vi.mock("../src/main/student-session-store.js", () => ({
  createStudentSessionStore: vi.fn(() => ({})),
  openNativeStudentRecordStore: vi.fn(),
}));
vi.mock("../src/main/session-denial-policy.js", () => ({
  denyByDefaultCapabilityPolicy: {},
  installSessionDenialPolicy: vi.fn(),
  installWebContentsEscapeDenial: vi.fn(),
}));

class Shell extends EventEmitter {
  visible = false;
  minimized = false;
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    id: 17,
    mainFrame: {
      processId: 5,
      routingId: 8,
      url: "desmoslock-app://shell/index.html",
      isDestroyed: () => false,
    },
    isDestroyed: () => this.destroyed,
    send: vi.fn(),
  });
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  isMinimized = () => this.minimized;
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  restore = vi.fn(() => {
    this.minimized = false;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });
  loadURL = vi.fn(async (url: string) => {
    this.webContents.emit("did-navigate", {}, url);
  });
}

let app: EventEmitter & { exit: ReturnType<typeof vi.fn> };
let shell: Shell;
let handlers: Map<string, (...args: unknown[]) => unknown>;
let power: EventEmitter;
let displays: EventEmitter;
let options: AssessmentProtectionCoordinatorOptions;
let windowOptions: ElectronProtectionWindowOptions;

async function boot(configured = true): Promise<void> {
  boundary.configured = configured;
  vi.doMock("electron", () => boundary.electron);
  vi.doMock("../src/backend-status.js", () => ({
    publicDesktopBackendConfiguration: configured
      ? { environment: "local", url: "http://127.0.0.1:54321" }
      : null,
  }));
  await import("../src/main.js");
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  handlers = new Map();
  shell = new Shell();
  power = new EventEmitter();
  displays = new EventEmitter();
  app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    commandLine: { getSwitchValue: () => "", appendSwitch: vi.fn() },
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    quit: vi.fn(),
    getPath: () => "/synthetic/owned-user-data",
    whenReady: () => Promise.resolve(),
  });
  const BrowserWindow = vi.fn(function () {
    return shell;
  });
  Object.assign(BrowserWindow, { getAllWindows: () => [shell] });
  const registered = new Set<string>();
  boundary.electron = {
    app,
    BrowserWindow,
    powerMonitor: power,
    screen: displays,
    globalShortcut: {
      isRegistered: (key: string) => registered.has(key),
      register: vi.fn((key: string) => {
        registered.add(key);
        return true;
      }),
      unregister: vi.fn((key: string) => {
        registered.delete(key);
      }),
    },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    session: { defaultSession: { protocol: { handle: vi.fn() } } },
    safeStorage: {},
  };
  boundary.student.initialize.mockResolvedValue(undefined);
  boundary.student.flushEvidence.mockResolvedValue(undefined);
  boundary.readBuildIdentity.mockReturnValue(null);
  boundary.createStudent.mockReturnValue(boundary.student);
  boundary.createNative.mockReturnValue({});
  boundary.createProtection.mockImplementation(
    (value: AssessmentProtectionCoordinatorOptions) => {
      options = value;
      return boundary.protection;
    },
  );
  boundary.createWindowPort.mockImplementation(
    (value: ElectronProtectionWindowOptions) => {
      windowOptions = value;
      return boundary.windowPort;
    },
  );
  boundary.windowPort.installZoomControls.mockReturnValue(vi.fn());
  boundary.windowPort.isReady.mockReturnValue(true);
  boundary.windowPort.calculatorBounds.mockReturnValue({
    x: 0,
    y: 120,
    width: 1080,
    height: 600,
  });
  boundary.protection.refresh.mockResolvedValue(undefined);
  boundary.protection.shutdown.mockResolvedValue("retained");
  boundary.protection.readView.mockReturnValue({
    protection: { phase: "idle" },
  });
  boundary.protection.subscribe.mockReturnValue(vi.fn());
  boundary.protection.hasRetainedAttempt.mockReturnValue(false);
  boundary.createIpc.mockReturnValue(boundary.ipc);
  boundary.ipc.mayPublish.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("production main protection composition with synthetic Electron", () => {
  it("keeps unconfigured startup free of Student/native ownership and returns null", async () => {
    await boot(false);
    expect(boundary.createStudent).not.toHaveBeenCalled();
    expect(boundary.createNative).not.toHaveBeenCalled();
    expect(boundary.prepareCalculator).not.toHaveBeenCalled();
    expect(handlers.get("desmoslock:assessment:start")?.({})).toBeNull();
  });

  it("initializes admission before composing the private owner and never auto-attaches", async () => {
    await boot();
    expect(
      boundary.student.initialize.mock.invocationCallOrder[0],
    ).toBeLessThan(boundary.createProtection.mock.invocationCallOrder[0]!);
    expect(boundary.createIpc).toHaveBeenCalledWith(
      boundary.protection,
      expect.any(Function),
    );
    expect(boundary.prepareCalculator).not.toHaveBeenCalled();
    expect(handlers.has("desmoslock:assessment:emergency-confirm")).toBe(true);
    expect(windowOptions.isTrusted(shell as never)).toBe(true);
    const invalidated = boundary.createIpc.mock.calls[0]![1] as () => void;
    invalidated();
    expect(boundary.protection.requestLocalEnd).toHaveBeenCalledWith(
      "renderer_lost",
    );
  });

  it("drains the startup Student owner on quit and fences late initialization", async () => {
    let initialized!: () => void;
    let drained!: (complete: boolean) => void;
    boundary.student.initialize.mockReturnValue(
      new Promise<void>((resolve) => {
        initialized = resolve;
      }),
    );
    boundary.student.dispose.mockReturnValue(
      new Promise<boolean>((resolve) => {
        drained = resolve;
      }),
    );
    await boot();
    expect(boundary.createStudent).toHaveBeenCalledOnce();
    expect(boundary.createProtection).not.toHaveBeenCalled();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    app.emit("before-quit", first);
    app.emit("before-quit", second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(boundary.student.dispose).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
    initialized();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(boundary.createNative).not.toHaveBeenCalled();
    expect(boundary.createProtection).not.toHaveBeenCalled();
    expect(shell.loadURL).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
    drained(true);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the sole composed maintenance pipeline even while retained recovery is hidden", async () => {
    await boot();
    shell.visible = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(boundary.protection.refresh).not.toHaveBeenCalled();
    expect(boundary.student.flushEvidence).toHaveBeenCalledOnce();
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boundary.protection.refresh).toHaveBeenCalledTimes(2);
    expect(boundary.student.flushEvidence).toHaveBeenCalledTimes(3);
    expect(boundary.student.refresh).not.toHaveBeenCalled();
  });

  it.each(["hidden", "closed"] as const)(
    "keeps terminal evidence eligible on the sole timer with a %s window and no retained attempt",
    async (state) => {
      await boot();
      if (state === "hidden") shell.visible = false;
      else shell.destroy();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(boundary.protection.refresh).not.toHaveBeenCalled();
      expect(boundary.student.flushEvidence).toHaveBeenCalledOnce();
      expect(boundary.student.refresh).not.toHaveBeenCalled();
      expect(boundary.prepareCalculator).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("does not begin evidence delivery while quit is draining or after a held refresh settles during quit", async () => {
    await boot();
    let releaseRefresh!: () => void;
    boundary.protection.refresh.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    let releaseShutdown!: () => void;
    boundary.protection.shutdown.mockReturnValueOnce(
      new Promise<"complete">((resolve) => {
        releaseShutdown = () => resolve("complete");
      }),
    );
    app.emit("before-quit", { preventDefault: vi.fn() });
    releaseRefresh();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(boundary.student.flushEvidence).not.toHaveBeenCalled();
    expect(boundary.protection.refresh).toHaveBeenCalledOnce();
    releaseShutdown();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("injects original build identity once and performs due maintenance before evidence on the same timer", async () => {
    const identity = Object.freeze({
      schemaVersion: 1,
      sourceRepository: "danielholguin31/desmoslock",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      packageLockSha256: "c".repeat(64),
      buildId: "d".repeat(64),
    });
    boundary.readBuildIdentity.mockReturnValue(identity);
    await boot();
    expect(boundary.createStudent).toHaveBeenCalledWith(
      expect.objectContaining({ originBuild: { kind: "build", identity } }),
    );
    expect(boundary.readBuildIdentity).toHaveBeenCalledOnce();
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    let release!: () => void;
    boundary.protection.refresh.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(boundary.student.flushEvidence).not.toHaveBeenCalled();
    release();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(boundary.student.flushEvidence).toHaveBeenCalledOnce();
    expect(boundary.student.refresh).not.toHaveBeenCalled();
  });

  it("does not upload after a failed maintenance cycle or treat successful queue handling as native authority", async () => {
    await boot();
    expect(boundary.createStudent).toHaveBeenCalledWith(
      expect.objectContaining({ originBuild: { kind: "unverified_build" } }),
    );
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    boundary.protection.refresh.mockRejectedValueOnce(
      new Error("synthetic refresh unavailable"),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(boundary.student.flushEvidence).not.toHaveBeenCalled();
    expect(boundary.protection.requestLocalEnd).toHaveBeenCalledExactlyOnceWith(
      "backend_unavailable",
    );
    boundary.protection.requestLocalEnd.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(boundary.student.flushEvidence).toHaveBeenCalledOnce();
    expect(boundary.protection.requestLocalEnd).not.toHaveBeenCalled();
    expect(boundary.prepareCalculator).not.toHaveBeenCalled();
  });

  it("captures the trusted parent and private scaled bounds only for explicit preparation", async () => {
    await boot();
    await options.prepareCalculator();
    expect(boundary.prepareCalculator).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: shell,
        bounds: { x: 0, y: 120, width: 1080, height: 600 },
      }),
    );
    boundary.ipc.mayPublish.mockReturnValue(false);
    await expect(options.prepareCalculator()).rejects.toThrow(
      "Trusted calculator window unavailable",
    );
    expect(boundary.prepareCalculator).toHaveBeenCalledTimes(1);
  });

  it("owns only the fixed emergency shortcut and independently verifies registration", async () => {
    await boot();
    const shortcut = boundary.electron.globalShortcut as {
      register: ReturnType<typeof vi.fn>;
      unregister: ReturnType<typeof vi.fn>;
    };
    const review = vi.fn();
    expect(options.shortcuts.register(review)).toBe(true);
    expect(shortcut.register).toHaveBeenCalledWith(
      "Control+Alt+Shift+E",
      review,
    );
    expect(options.shortcuts.isRegistered()).toBe(true);
    expect(options.shortcuts.register(review)).toBe(false);
    options.shortcuts.unregister();
    expect(shortcut.unregister).toHaveBeenCalledWith("Control+Alt+Shift+E");
    expect(options.shortcuts.isRegistered()).toBe(false);
    options.shortcuts.unregister();
    expect(shortcut.unregister).toHaveBeenCalledOnce();
  });

  it("keeps retained native ownership if recreating a lost trusted shell fails", async () => {
    await boot();
    const windows = boundary.electron.BrowserWindow as {
      getAllWindows: () => Shell[];
    };
    windows.getAllWindows = () => [];
    shell.loadURL.mockRejectedValueOnce(new Error("synthetic load failure"));
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    app.emit("activate");
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(boundary.protection.requestLocalEnd).toHaveBeenCalledWith(
      "window_lost",
    );
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("cannot redisplay retained calculator content through a second launch while teardown is unconfirmed", async () => {
    await boot();
    shell.show.mockClear();
    shell.visible = false;
    shell.minimized = true;
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    boundary.protection.readView.mockReturnValue({
      protection: { phase: "recovery_required" },
    });
    app.emit("second-instance");
    expect(boundary.protection.requestLocalEnd).toHaveBeenCalledWith(
      "window_lost",
    );
    expect(shell.restore).not.toHaveBeenCalled();
    expect(shell.show).not.toHaveBeenCalled();
    expect(shell.focus).not.toHaveBeenCalled();
    boundary.protection.hasRetainedAttempt.mockReturnValue(false);
    app.emit("second-instance");
    expect(shell.restore).toHaveBeenCalledOnce();
    expect(shell.show).toHaveBeenCalledOnce();
    expect(shell.focus).toHaveBeenCalledOnce();
  });

  it("closes immediately on suspend/resume/display/window loss and preserves restoration", async () => {
    await boot();
    boundary.protection.readView.mockReturnValue({
      protection: { phase: "locked" },
    });
    power.emit("suspend");
    power.emit("resume");
    displays.emit("display-metrics-changed");
    shell.emit("hide");
    expect(
      boundary.protection.requestLocalEnd.mock.calls.map(([cause]) => cause),
    ).toEqual(["suspend", "suspend", "display_changed", "window_lost"]);
    boundary.protection.readView.mockReturnValue({
      protection: { phase: "ending" },
    });
    shell.emit("leave-full-screen");
    expect(boundary.protection.requestLocalEnd).toHaveBeenCalledTimes(4);
    boundary.protection.hasRetainedAttempt.mockReturnValue(true);
    const close = { preventDefault: vi.fn() };
    shell.emit("close", close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(boundary.protection.requestLocalEnd).toHaveBeenLastCalledWith(
      "window_lost",
    );
  });

  it("does not bypass held shutdown with another quit and never disposes Student twice", async () => {
    await boot();
    let settle!: (value: string) => void;
    boundary.protection.shutdown.mockReturnValue(
      new Promise<string>((resolve) => {
        settle = resolve;
      }),
    );
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    app.emit("before-quit", first);
    app.emit("before-quit", second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(boundary.protection.shutdown).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
    settle("retained");
    await Promise.resolve();
    expect(app.exit).not.toHaveBeenCalled();
    boundary.protection.shutdown.mockResolvedValue("complete");
    app.emit("before-quit", { preventDefault: vi.fn() });
    await Promise.resolve();
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(boundary.student.dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
