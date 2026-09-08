import {
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

import { assessmentToolbarHeight } from "../assessment-protection-view-state.js";
import type { CalculatorSurfaceBounds } from "./calculator-surface.js";

const windowTransitionTimeoutMs = 5_000;
const minimumZoomFactor = 0.5;
const maximumZoomFactor = 3;

type ZoomAction = "in" | "out" | "reset";
interface WindowOwner {
  readonly window: BrowserWindow;
  readonly contents: WebContents;
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
  readonly previousFullscreen: boolean;
  readonly factor: number;
  live: boolean;
  ready: boolean;
  restoring: boolean;
  pendingFullscreen: boolean | null;
  abortPrepare: (() => void) | null;
  abortFullscreen: (() => void) | null;
  releaseListeners: () => void;
}

export interface ElectronProtectionWindowOptions {
  readonly getWindow: () => BrowserWindow | null;
  readonly isTrusted: (window: BrowserWindow) => boolean;
  readonly onInvalidated: () => void;
}

function unavailable(): Error {
  return new Error("Protection window unavailable");
}

function validFactor(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= minimumZoomFactor &&
    value <= maximumZoomFactor
  );
}

export function createElectronProtectionWindow(
  options: ElectronProtectionWindowOptions,
) {
  let owner: WindowOwner | null = null;
  let restoration: Promise<void> | null = null;
  let zoomControls: { readonly dispose: () => void } | null = null;

  function closeLocalGate(target: WindowOwner): boolean {
    const notify = target.live;
    target.live = false;
    target.ready = false;
    target.abortPrepare?.();
    target.abortFullscreen?.();
    return notify;
  }

  function invalidate(target: WindowOwner): void {
    const notify = closeLocalGate(target);
    if (notify) {
      try {
        options.onInvalidated();
      } catch {
        /* The local gate remains closed. */
      }
    }
  }

  function sameWindow(target: WindowOwner, visible: boolean): boolean {
    try {
      const window = target.window;
      if (
        owner !== target ||
        options.getWindow() !== window ||
        window.isDestroyed() ||
        window.webContents !== target.contents ||
        target.contents.isDestroyed() ||
        !options.isTrusted(window) ||
        (visible && !window.isVisible())
      )
        return false;
      const frame = target.contents.mainFrame;
      return (
        !frame.isDestroyed() &&
        frame.processId === target.processId &&
        frame.routingId === target.routingId &&
        frame.url === target.url
      );
    } catch {
      return false;
    }
  }

  function bounds(target: WindowOwner): CalculatorSurfaceBounds {
    if (
      !sameWindow(target, true) ||
      target.contents.getZoomFactor() !== target.factor ||
      !validFactor(target.factor)
    )
      throw unavailable();
    const { width, height } = target.window.getContentBounds();
    const y = Math.ceil(assessmentToolbarHeight * target.factor);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      y >= height
    )
      throw unavailable();
    if (
      !sameWindow(target, true) ||
      target.contents.getZoomFactor() !== target.factor
    )
      throw unavailable();
    return { x: 0, y, width, height: height - y };
  }

  function isReady(): boolean {
    const target = owner;
    if (target === null || !target.live || target.restoring) return false;
    try {
      bounds(target);
      if (!target.ready) return false;
      if (!target.window.isFullScreen()) throw unavailable();
      return true;
    } catch {
      invalidate(target);
      return false;
    }
  }

  function requirePreparation(target: WindowOwner): void {
    if (owner !== target || !target.live || target.restoring)
      throw unavailable();
    bounds(target);
  }

  function installOwnerListeners(target: WindowOwner): void {
    const lost = () => invalidate(target);
    const hidden = () => {
      if (!target.restoring) invalidate(target);
    };
    const entered = () => {
      if (target.pendingFullscreen === true) target.pendingFullscreen = null;
    };
    const left = () => {
      if (target.pendingFullscreen === false) target.pendingFullscreen = null;
      if (!target.restoring) invalidate(target);
    };
    target.window.on("closed", lost);
    target.window.on("hide", hidden);
    target.window.on("minimize", hidden);
    target.window.on("enter-full-screen", entered);
    target.window.on("leave-full-screen", left);
    target.contents.on("destroyed", lost);
    target.contents.on("render-process-gone", lost);
    target.releaseListeners = () => {
      target.window.removeListener("closed", lost);
      target.window.removeListener("hide", hidden);
      target.window.removeListener("minimize", hidden);
      target.window.removeListener("enter-full-screen", entered);
      target.window.removeListener("leave-full-screen", left);
      target.contents.removeListener("destroyed", lost);
      target.contents.removeListener("render-process-gone", lost);
    };
  }

  function observeFullscreen(
    target: WindowOwner,
    fullscreen: boolean,
  ): Promise<void> {
    if (!sameWindow(target, false)) return Promise.reject(unavailable());
    if (
      target.pendingFullscreen === null &&
      target.window.isFullScreen() === fullscreen
    )
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (fullscreen)
          target.window.removeListener("enter-full-screen", observed);
        else target.window.removeListener("leave-full-screen", observed);
        if (target.abortFullscreen === abort) target.abortFullscreen = null;
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = () => finish(unavailable());
      const observed = () => {
        if (
          !sameWindow(target, false) ||
          target.window.isFullScreen() !== fullscreen
        )
          finish(unavailable());
        else finish();
      };
      target.abortFullscreen = abort;
      if (fullscreen) target.window.on("enter-full-screen", observed);
      else target.window.on("leave-full-screen", observed);
      try {
        if (target.pendingFullscreen !== fullscreen) {
          // Acknowledgment of setFullScreen is never the observation gate.
          target.pendingFullscreen = fullscreen;
          target.window.setFullScreen(fullscreen);
        }
      } catch {
        finish(unavailable());
      }
    });
  }

  function prepare(): Promise<void> {
    if (owner !== null || restoration !== null)
      return Promise.reject(unavailable());
    let target: WindowOwner;
    try {
      const window = options.getWindow();
      if (
        window === null ||
        window.isDestroyed() ||
        !window.isVisible() ||
        !options.isTrusted(window) ||
        window.webContents.isDestroyed()
      )
        throw unavailable();
      const contents = window.webContents;
      const frame = contents.mainFrame;
      if (frame.isDestroyed()) throw unavailable();
      target = {
        window,
        contents,
        processId: frame.processId,
        routingId: frame.routingId,
        url: frame.url,
        previousFullscreen: window.isFullScreen(),
        factor: contents.getZoomFactor(),
        live: true,
        ready: false,
        restoring: false,
        pendingFullscreen: null,
        abortPrepare: null,
        abortFullscreen: null,
        releaseListeners: () => undefined,
      };
      owner = target;
      bounds(target);
      installOwnerListeners(target);
    } catch {
      // No window mutation has happened before these initial checks.
      owner = null;
      return Promise.reject(unavailable());
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.abortPrepare = null;
        if (error === undefined) resolve();
        else reject(error);
      };
      target.abortPrepare = () => finish(unavailable());
      const timer = setTimeout(
        () => invalidate(target),
        windowTransitionTimeoutMs,
      );
      void (async () => {
        // Preserve Electron's disabled pinch default; never reset accessibility page zoom.
        await target.contents.setVisualZoomLevelLimits(1, 1);
        requirePreparation(target);
        await observeFullscreen(target, true);
        requirePreparation(target);
        if (!target.window.isFullScreen()) throw unavailable();
        target.ready = true;
      })().then(
        () => finish(),
        () => {
          // A canceled preparation cannot abort a newer restoration observer.
          if (target.live && !target.restoring) invalidate(target);
          finish(unavailable());
        },
      );
    });
  }

  function release(target: WindowOwner): void {
    target.live = false;
    target.ready = false;
    target.abortPrepare?.();
    target.abortFullscreen?.();
    target.releaseListeners();
    if (owner === target) owner = null;
  }

  function restore(): Promise<void> {
    if (restoration !== null) return restoration;
    const target = owner;
    if (target === null) return Promise.resolve();
    target.live = false;
    target.ready = false;
    target.restoring = true;
    target.abortPrepare?.();
    target.abortFullscreen?.();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const result = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    restoration = result;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.abortFullscreen?.();
      target.restoring = false;
      if (restoration === result) restoration = null;
      if (error === undefined) {
        release(target);
        resolve();
      } else reject(error);
    };
    const timer = setTimeout(
      () => finish(unavailable()),
      windowTransitionTimeoutMs,
    );
    void (async () => {
      if (target.window.isDestroyed()) return;
      if (!sameWindow(target, false)) throw unavailable();
      await observeFullscreen(target, target.previousFullscreen);
      if (target.window.isDestroyed()) return;
      if (
        !sameWindow(target, false) ||
        target.window.isFullScreen() !== target.previousFullscreen
      )
        throw unavailable();
    })().then(
      () => finish(),
      () => {
        if (target.window.isDestroyed()) finish();
        else finish(unavailable());
      },
    );
    return result;
  }

  function installZoomControls(window: BrowserWindow): () => void {
    zoomControls?.dispose();
    // The predecessor callback may already have installed a newer owner.
    if (zoomControls !== null) throw unavailable();
    const contents = window.webContents;
    const previousMenu = Menu.getApplicationMenu();
    let installedMenu: Menu | null = null;
    let active = true;
    let changing = false;
    const controls = { dispose };
    zoomControls = controls;
    const trusted = () =>
      active &&
      zoomControls === controls &&
      options.getWindow() === window &&
      !window.isDestroyed() &&
      !contents.isDestroyed() &&
      window.webContents === contents &&
      options.isTrusted(window);

    function change(action: ZoomAction): void {
      if (changing) return;
      changing = true;
      try {
        if (!trusted()) return;
        const factor = contents.getZoomFactor();
        if (!validFactor(factor)) {
          if (owner?.window === window && owner.live) invalidate(owner);
          else options.onInvalidated();
          return;
        }
        const next = Math.max(
          minimumZoomFactor,
          Math.min(
            maximumZoomFactor,
            action === "reset"
              ? 1
              : action === "in"
                ? factor * 1.2
                : factor / 1.2,
          ),
        );
        if (next === factor) return;
        const frame = contents.mainFrame;
        const processId = frame.processId;
        const routingId = frame.routingId;
        const url = frame.url;
        // Close this attempt before invoking external invalidation and before any
        // owned zoom mutation. A throwing invalidation prevents the mutation.
        if (owner?.window === window && owner.live) {
          owner.live = false;
          owner.ready = false;
          owner.abortPrepare?.();
          owner.abortFullscreen?.();
        }
        options.onInvalidated();
        if (
          !trusted() ||
          contents.mainFrame.isDestroyed() ||
          contents.mainFrame.processId !== processId ||
          contents.mainFrame.routingId !== routingId ||
          contents.mainFrame.url !== url ||
          contents.getZoomFactor() !== factor
        )
          return;
        contents.setZoomFactor(next);
      } catch {
        if (owner?.window === window && owner.live) invalidate(owner);
      } finally {
        changing = false;
      }
    }

    function beforeInput(event: Electron.Event, input: Electron.Input): void {
      if ((!input.control && !input.meta) || input.alt || input.isComposing)
        return;
      const action =
        input.key === "+" || input.key === "=" || input.code === "NumpadAdd"
          ? "in"
          : input.key === "-" ||
              input.key === "_" ||
              input.code === "NumpadSubtract"
            ? "out"
            : input.key === "0" || input.code === "Numpad0"
              ? "reset"
              : null;
      if (
        action === null ||
        (input.type !== "keyDown" && input.type !== "keyUp")
      )
        return;
      event.preventDefault(); // Also suppresses the matching native menu shortcut.
      if (input.type === "keyDown") change(action);
    }
    function wheel(event: Electron.Event, direction: "in" | "out"): void {
      event.preventDefault();
      if (direction === "in" || direction === "out") change(direction);
    }

    // The application owns these constructor options. Never traverse or clone
    // inherited live MenuItems: their native ownership is not a template contract.
    const zoomItem = (
      label: string,
      accelerator: string,
      action: ZoomAction,
    ): MenuItemConstructorOptions => ({
      label,
      accelerator,
      click: (_item, focusedWindow) => {
        if (focusedWindow === window) change(action);
      },
    });
    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          zoomItem("Actual Size", "CommandOrControl+0", "reset"),
          zoomItem("Zoom In", "CommandOrControl+Plus", "in"),
          zoomItem("Zoom Out", "CommandOrControl+-", "out"),
        ],
      },
      { role: "windowMenu" },
    ];

    function dispose(): void {
      if (!active) return;
      active = false;
      const notify =
        owner?.window === window && owner.live && closeLocalGate(owner);
      try {
        contents.removeListener("before-input-event", beforeInput);
        contents.removeListener("zoom-changed", wheel);
        window.removeListener("closed", dispose);
        if (zoomControls === controls) zoomControls = null;
        if (
          installedMenu !== null &&
          Menu.getApplicationMenu() === installedMenu
        )
          Menu.setApplicationMenu(previousMenu);
      } finally {
        // Finish teardown before callbacks can install replacement controls.
        if (notify) {
          try {
            options.onInvalidated();
          } catch {
            /* The local gate remains closed. */
          }
        }
      }
    }
    try {
      contents.on("before-input-event", beforeInput);
      contents.on("zoom-changed", wheel);
      window.on("closed", dispose);
      installedMenu = Menu.buildFromTemplate(template);
      Menu.setApplicationMenu(installedMenu);
    } catch {
      dispose();
      throw unavailable();
    }
    return dispose;
  }

  return {
    prepare,
    isReady,
    restore,
    installZoomControls,
    calculatorBounds(): CalculatorSurfaceBounds {
      if (!isReady() || owner === null) throw unavailable();
      try {
        return bounds(owner);
      } catch {
        invalidate(owner);
        throw unavailable();
      }
    },
    showRecovery(): void {
      if (owner !== null && sameWindow(owner, false)) owner.window.show();
    },
  };
}
