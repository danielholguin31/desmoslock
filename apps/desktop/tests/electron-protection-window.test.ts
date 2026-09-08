import { EventEmitter } from "node:events";
import type {
  BrowserWindow,
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  getApplicationMenu: vi.fn(),
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn(),
}));
vi.mock("electron", () => ({ Menu: electron }));
import { createElectronProtectionWindow } from "../src/main/electron-protection-window.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function windowFixture(factor = 1) {
  const contentsEvents = new EventEmitter();
  const windowEvents = new EventEmitter();
  const state = {
    destroyed: false,
    contentsDestroyed: false,
    visible: true,
    fullscreen: false,
    factor,
    width: 1000,
    height: 700,
    trusted: true,
  };
  const frame = {
    processId: 11,
    routingId: 12,
    url: "desmoslock-app://shell/index.html",
    isDestroyed: () => false,
  };
  const contents = Object.assign(contentsEvents, {
    mainFrame: frame,
    isDestroyed: () => state.contentsDestroyed,
    getZoomFactor: vi.fn(() => state.factor),
    setZoomFactor: vi.fn((next: number) => {
      state.factor = next;
    }),
    setVisualZoomLevelLimits: vi.fn(async (): Promise<void> => undefined),
  });
  const window = Object.assign(windowEvents, {
    webContents: contents,
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isFullScreen: () => state.fullscreen,
    getContentBounds: () => ({
      x: 100,
      y: 100,
      width: state.width,
      height: state.height,
    }),
    setFullScreen: vi.fn<(fullscreen: boolean) => void>(),
    show: vi.fn(() => {
      state.visible = true;
    }),
  });
  const nativeWindow = window as unknown as BrowserWindow;
  let current = nativeWindow;
  const onInvalidated = vi.fn();
  const port = createElectronProtectionWindow({
    getWindow: () => current,
    isTrusted: () => state.trusted,
    onInvalidated,
  });
  const observe = (fullscreen: boolean) => {
    state.fullscreen = fullscreen;
    window.emit(fullscreen ? "enter-full-screen" : "leave-full-screen");
  };
  const prepared = async () => {
    const promise = port.prepare();
    await Promise.resolve();
    observe(true);
    await promise;
  };
  return {
    state,
    frame,
    contents,
    window,
    nativeWindow,
    port,
    onInvalidated,
    observe,
    prepared,
    replace: (next: BrowserWindow) => {
      current = next;
    },
  };
}

function menuItem(options: MenuItemConstructorOptions): MenuItem {
  return Object.assign(
    {
      accelerator: null,
      userAccelerator: null,
      accessibilityLabel: "",
      checked: false,
      enabled: true,
      id: "",
      label: "",
      registerAccelerator: true,
      sharingItem: {},
      sublabel: "",
      toolTip: "",
      type: "normal",
      visible: true,
      click: vi.fn(),
    },
    options,
  ) as unknown as MenuItem;
}

function ownedZoomItem(label: string): MenuItemConstructorOptions {
  const template = electron.buildFromTemplate.mock
    .lastCall?.[0] as MenuItemConstructorOptions[];
  const submenu = template.find((item) => item.label === "View")?.submenu;
  if (!Array.isArray(submenu)) throw new Error("missing owned View menu");
  const item = submenu.find((item) => item.label === label);
  if (item === undefined) throw new Error("missing owned zoom item");
  return item;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  let current: Menu | null = null;
  electron.getApplicationMenu.mockImplementation(() => current);
  electron.setApplicationMenu.mockImplementation((menu: Menu | null) => {
    current = menu;
  });
  electron.buildFromTemplate.mockImplementation(
    (items: Array<MenuItem | MenuItemConstructorOptions>) => ({
      items: [...items],
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

describe("main-owned protection window", () => {
  it.each([1, 1.25, 2])(
    "uses actual factor %s and observed fullscreen without resetting page zoom",
    async (factor) => {
      const f = windowFixture(factor);
      const ready = f.port.prepare();
      expect(f.port.isReady()).toBe(false);
      await Promise.resolve();
      expect(f.window.setFullScreen).toHaveBeenCalledExactlyOnceWith(true);
      expect(
        f.contents.setVisualZoomLevelLimits,
      ).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
      f.observe(true);
      await ready;
      expect(f.port.isReady()).toBe(true);
      expect(f.port.calculatorBounds()).toEqual({
        x: 0,
        y: Math.ceil(96 * factor),
        width: 1000,
        height: 700 - Math.ceil(96 * factor),
      });
      expect(f.onInvalidated).not.toHaveBeenCalled();
    },
  );

  it("accepts an already-fullscreen trusted parent and restores only its captured state", async () => {
    const f = windowFixture(1.25);
    f.state.fullscreen = true;
    await f.port.prepare();
    await f.port.restore();
    expect(f.window.setFullScreen).not.toHaveBeenCalled();
    expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
    expect(f.port.isReady()).toBe(false);
    await f.port.prepare();
    expect(f.port.isReady()).toBe(true);
  });

  it.each([0, 0.49, 3.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "denies invalid factor %s without requesting fullscreen",
    async (factor) => {
      const f = windowFixture(factor);
      await expect(f.port.prepare()).rejects.toThrow();
      expect(f.window.setFullScreen).not.toHaveBeenCalled();
      expect(() => f.port.calculatorBounds()).toThrow();
    },
  );

  it.each([0, 96, 95, Number.NaN])(
    "fails closed when content height %s cannot fit the toolbar",
    async (height) => {
      const f = windowFixture();
      f.state.height = height;
      await expect(f.port.prepare()).rejects.toThrow();
      expect(f.window.setFullScreen).not.toHaveBeenCalled();
    },
  );

  it("detects changed zoom during loading, fences late prepare, and permits the next start after restoration", async () => {
    const f = windowFixture();
    const held = deferred();
    f.contents.setVisualZoomLevelLimits.mockReturnValueOnce(held.promise);
    const pending = f.port.prepare();
    const outcome = expect(pending).rejects.toThrow();
    f.state.factor = 1.25;
    expect(f.port.isReady()).toBe(false);
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
    await f.port.restore();
    held.resolve();
    await outcome;
    expect(f.window.setFullScreen).not.toHaveBeenCalled();
    await f.prepared();
    expect(f.port.calculatorBounds().y).toBe(120);
  });

  it("invalidates locked geometry synchronously when a programmatic factor change is observed", async () => {
    const f = windowFixture();
    await f.prepared();
    f.onInvalidated.mockImplementation(() => {
      expect(f.port.isReady()).toBe(false);
    });
    f.state.factor = 2;
    expect(() => f.port.calculatorBounds()).toThrow();
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
    f.state.factor = 1;
    expect(f.port.isReady()).toBe(false);
  });

  it("waits for the actual leave event and blocks new prepares during restore", async () => {
    const f = windowFixture();
    await f.prepared();
    const restoration = f.port.restore();
    expect(f.window.setFullScreen).toHaveBeenLastCalledWith(false);
    await expect(f.port.prepare()).rejects.toThrow();
    expect(f.port.restore()).toBe(restoration);
    f.observe(false);
    await restoration;
    expect(f.window.listenerCount("enter-full-screen")).toBe(0);
    expect(f.window.listenerCount("leave-full-screen")).toBe(0);
    await f.prepared();
    expect(f.port.isReady()).toBe(true);
  });

  it("retains an unobserved fullscreen request after timeout until restoration is observed", async () => {
    const f = windowFixture();
    const pending = f.port.prepare();
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.port.isReady()).toBe(false);
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
    const restoring = f.port.restore();
    const failedRestore = expect(restoring).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await failedRestore;
    await expect(f.port.prepare()).rejects.toThrow();
    f.observe(true);
    f.observe(false);
    await f.port.restore();
    await f.prepared();
    expect(f.port.isReady()).toBe(true);
  });

  it.each([
    "closed",
    "hidden",
    "untrusted",
    "replaced",
    "frame",
    "contents-gone",
  ])("fences %s parent loss during fullscreen preparation", async (cause) => {
    const f = windowFixture();
    const ready = f.port.prepare();
    const rejected = expect(ready).rejects.toThrow();
    await Promise.resolve();
    if (cause === "closed") {
      f.state.destroyed = true;
      f.window.emit("closed");
    }
    if (cause === "hidden") {
      f.state.visible = false;
      f.window.emit("hide");
    }
    if (cause === "untrusted") f.state.trusted = false;
    if (cause === "replaced") f.replace(windowFixture().nativeWindow);
    if (cause === "frame") f.frame.routingId = 99;
    if (cause === "contents-gone") {
      f.state.contentsDestroyed = true;
      f.contents.emit("destroyed");
    }
    f.observe(true);
    await rejected;
    expect(f.port.isReady()).toBe(false);
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
    f.port.showRecovery();
    expect(f.window.show).toHaveBeenCalledTimes(cause === "hidden" ? 1 : 0);
  });

  it("cleans a destroyed owned window without mutating its replacement", async () => {
    const f = windowFixture();
    await f.prepared();
    const replacement = windowFixture();
    f.state.destroyed = true;
    f.window.emit("closed");
    f.replace(replacement.nativeWindow);
    await f.port.restore();
    expect(replacement.window.setFullScreen).not.toHaveBeenCalled();
    expect(f.window.listenerCount("enter-full-screen")).toBe(0);
    expect(f.contents.listenerCount("destroyed")).toBe(0);
  });

  it("restores an initially fullscreen window only after observing its new enter event", async () => {
    const f = windowFixture();
    f.state.fullscreen = true;
    await f.port.prepare();
    f.observe(false);
    const restoring = f.port.restore();
    expect(f.window.setFullScreen).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.port.isReady()).toBe(false);
    f.observe(true);
    await restoring;
    expect(f.window.listenerCount("enter-full-screen")).toBe(0);
  });

  it("rejects a failed fullscreen invocation and fences its eventual late event", async () => {
    const f = windowFixture();
    f.window.setFullScreen.mockImplementationOnce(() => {
      throw new Error("fullscreen invocation failed");
    });
    await expect(f.port.prepare()).rejects.toThrow();
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
    f.observe(true);
    expect(f.port.isReady()).toBe(false);
    const restoring = f.port.restore();
    f.observe(false);
    await restoring;
  });

  it("bounds a stalled visual-zoom call and never lets its late completion mutate a new attempt", async () => {
    const f = windowFixture();
    const held = deferred();
    f.contents.setVisualZoomLevelLimits.mockReturnValueOnce(held.promise);
    const preparation = f.port.prepare();
    const rejected = expect(preparation).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await f.port.restore();
    await f.prepared();
    const invocations = f.window.setFullScreen.mock.calls.length;
    held.resolve();
    await Promise.resolve();
    expect(f.window.setFullScreen).toHaveBeenCalledTimes(invocations);
    expect(f.port.isReady()).toBe(true);
  });

  it("does not let a canceled preparation abort restoration started inside invalidation", async () => {
    const f = windowFixture();
    const preparation = f.port.prepare();
    const rejected = expect(preparation).rejects.toThrow();
    await Promise.resolve();
    let restoring: Promise<void> | undefined;
    f.onInvalidated.mockImplementation(() => {
      restoring = f.port.restore();
    });
    f.window.emit("hide");
    await rejected;
    await Promise.resolve();
    f.observe(false);
    await restoring;
    await f.prepared();
    expect(f.port.isReady()).toBe(true);
  });

  it.each(["zoom", "invalid-factor", "setter-throw"])(
    "does not let %s cancel an in-progress fullscreen restoration",
    async (change) => {
      const f = windowFixture();
      f.port.installZoomControls(f.nativeWindow);
      await f.prepared();
      const restoring = f.port.restore();
      if (change === "invalid-factor") f.state.factor = Number.NaN;
      if (change === "setter-throw") {
        f.contents.setZoomFactor.mockImplementationOnce(() => {
          throw new Error("zoom setter failed");
        });
      }
      f.contents.emit("zoom-changed", { preventDefault: vi.fn() }, "out");
      await Promise.resolve();
      f.observe(false);
      await restoring;
      expect(f.window.listenerCount("leave-full-screen")).toBe(0);
      expect(f.port.isReady()).toBe(false);
    },
  );
});

describe("owned accessibility zoom ingress", () => {
  it.each(["keyboard", "wheel", "menu"])(
    "invalidates before %s changes actual page zoom",
    async (ingress) => {
      const f = windowFixture();
      const zoom = menuItem({ role: "zoomIn", label: "Zoom In" });
      electron.setApplicationMenu({ items: [zoom] });
      const stop = f.port.installZoomControls(f.nativeWindow);
      await f.prepared();
      const order: string[] = [];
      f.onInvalidated.mockImplementation(() => {
        order.push("invalidate");
        expect(f.port.isReady()).toBe(false);
      });
      f.contents.setZoomFactor.mockImplementation((factor) => {
        order.push("zoom");
        f.state.factor = factor;
      });
      const event = { preventDefault: vi.fn() };
      if (ingress === "keyboard")
        f.contents.emit("before-input-event", event, {
          type: "keyDown",
          key: "+",
          code: "Equal",
          control: true,
          meta: false,
          alt: false,
          isComposing: false,
        });
      if (ingress === "wheel") f.contents.emit("zoom-changed", event, "in");
      if (ingress === "menu") {
        const item = ownedZoomItem("Zoom In");
        expect(item?.role).toBeUndefined();
        item?.click?.(zoom, f.nativeWindow, {} as Electron.KeyboardEvent);
      } else expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["invalidate", "zoom"]);
      expect(f.state.factor).toBe(1.2);
      expect(f.port.isReady()).toBe(false);
      stop();
    },
  );

  it("installs only app-owned standard roles and guarded View items without traversing the inherited menu", () => {
    const f = windowFixture();
    const original = new Proxy({} as Menu, {
      get() {
        throw new Error("inherited menu must not be read");
      },
    });
    electron.setApplicationMenu(original);
    const dispose = f.port.installZoomControls(f.nativeWindow);
    expect(electron.getApplicationMenu() === original).toBe(false);
    const template = electron.buildFromTemplate.mock
      .lastCall?.[0] as MenuItemConstructorOptions[];
    expect(template.map((item) => item.role ?? item.label)).toEqual([
      ...(process.platform === "darwin" ? ["appMenu"] : []),
      "editMenu",
      "View",
      "windowMenu",
    ]);
    expect(ownedZoomItem("Actual Size")).toEqual({
      label: "Actual Size",
      accelerator: "CommandOrControl+0",
      click: expect.any(Function),
    });
    expect(ownedZoomItem("Zoom In")).toEqual({
      label: "Zoom In",
      accelerator: "CommandOrControl+Plus",
      click: expect.any(Function),
    });
    expect(ownedZoomItem("Zoom Out")).toEqual({
      label: "Zoom Out",
      accelerator: "CommandOrControl+-",
      click: expect.any(Function),
    });
    dispose();
    expect(electron.getApplicationMenu() === original).toBe(true);
    expect(f.contents.listenerCount("before-input-event")).toBe(0);
    expect(f.contents.listenerCount("zoom-changed")).toBe(0);
  });

  it("restores an absent prior menu and removes only owned handlers", () => {
    const f = windowFixture();
    const unrelated = vi.fn();
    f.contents.on("zoom-changed", unrelated);
    const stop = f.port.installZoomControls(f.nativeWindow);
    expect(electron.getApplicationMenu()).not.toBeNull();
    stop();
    stop();
    expect(f.contents.listenerCount("zoom-changed")).toBe(1);
    expect(f.contents.listenerCount("before-input-event")).toBe(0);
    expect(electron.getApplicationMenu()).toBeNull();
    expect(electron.setApplicationMenu).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "replace", "dispose"])(
    "does not mutate zoom if invalidation causes %s",
    async (effect) => {
      const f = windowFixture();
      const dispose = f.port.installZoomControls(f.nativeWindow);
      await f.prepared();
      f.onInvalidated.mockImplementation(() => {
        expect(f.port.isReady()).toBe(false);
        if (effect === "throw") throw new Error("containment failed");
        if (effect === "replace") f.replace(windowFixture().nativeWindow);
        if (effect === "dispose") dispose();
      });
      f.contents.emit("zoom-changed", { preventDefault: vi.fn() }, "out");
      expect(f.onInvalidated).toHaveBeenCalledTimes(1);
      expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
    },
  );

  it("ignores zoom menu callbacks for another window and for disposed controls", () => {
    const f = windowFixture();
    const original = menuItem({ role: "zoomIn" });
    electron.setApplicationMenu({ items: [original] });
    const dispose = f.port.installZoomControls(f.nativeWindow);
    const click = ownedZoomItem("Zoom In").click;
    click?.(
      original,
      windowFixture().nativeWindow,
      {} as Electron.KeyboardEvent,
    );
    dispose();
    click?.(original, f.nativeWindow, {} as Electron.KeyboardEvent);
    expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
    expect(f.onInvalidated).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer menu or leak handlers when a later window owns controls", () => {
    const f = windowFixture();
    electron.setApplicationMenu({ items: [menuItem({ role: "zoomIn" })] });
    const firstStop = f.port.installZoomControls(f.nativeWindow);
    const replacement = windowFixture();
    f.replace(replacement.nativeWindow);
    const secondStop = f.port.installZoomControls(replacement.nativeWindow);
    firstStop();
    expect(f.contents.listenerCount("zoom-changed")).toBe(0);
    expect(replacement.contents.listenerCount("zoom-changed")).toBe(1);
    const newer = { items: [] };
    electron.setApplicationMenu(newer);
    secondStop();
    expect(electron.getApplicationMenu()).toBe(newer);
  });

  it.each(["dispose", "install"])(
    "preserves controls installed reentrantly during predecessor %s",
    async (operation) => {
      const f = windowFixture();
      const firstStop = f.port.installZoomControls(f.nativeWindow);
      await f.prepared();
      let replacementStop: (() => void) | undefined;
      f.onInvalidated.mockImplementationOnce(() => {
        replacementStop = f.port.installZoomControls(f.nativeWindow);
      });
      if (operation === "dispose") firstStop();
      else expect(() => f.port.installZoomControls(f.nativeWindow)).toThrow();
      const installed = electron.getApplicationMenu();
      expect(installed).not.toBeNull();
      expect(f.contents.listenerCount("zoom-changed")).toBe(1);
      const order: string[] = [];
      f.onInvalidated.mockImplementation(() => {
        order.push("invalidate");
      });
      f.contents.setZoomFactor.mockImplementation(() => {
        order.push("zoom");
      });
      ownedZoomItem("Zoom In").click?.(
        menuItem({}),
        f.nativeWindow,
        {} as Electron.KeyboardEvent,
      );
      expect(order).toEqual(["invalidate", "zoom"]);
      expect(electron.getApplicationMenu()).toBe(installed);
      replacementStop?.();
      expect(f.contents.listenerCount("zoom-changed")).toBe(0);
      expect(electron.getApplicationMenu()).toBeNull();
    },
  );

  it("bounds zoom, supports reset, and ignores unrelated keys", () => {
    const f = windowFixture(3);
    f.port.installZoomControls(f.nativeWindow);
    const event = { preventDefault: vi.fn() };
    const key = (key: string, type = "keyDown") =>
      f.contents.emit("before-input-event", event, {
        type,
        key,
        code: "",
        control: true,
        alt: false,
        isComposing: false,
      });
    key("+");
    expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
    key("x");
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    key("0", "keyUp");
    expect(f.contents.setZoomFactor).not.toHaveBeenCalled();
    key("0");
    expect(f.state.factor).toBe(1);
    key("-");
    expect(f.state.factor).toBeCloseTo(1 / 1.2);
  });
});
