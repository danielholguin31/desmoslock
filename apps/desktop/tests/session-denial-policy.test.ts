import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  denyByDefaultCapabilityPolicy,
  installWebContentsEscapeDenial,
  installSessionDenialPolicy,
} from "../src/main/session-denial-policy.js";

describe("session denial policy", () => {
  it("attempts every uninstall reset and aggregates all reset failures", () => {
    const permissionCheckFailure = new Error("permission check reset failed");
    const deviceFailure = new Error("device reset failed");
    const downloadFailure = new Error("download listener reset failed");
    const resetCalls: string[] = [];
    const targetSession = {
      on: vi.fn(),
      removeListener: vi.fn((event: string) => {
        resetCalls.push(`remove:${event}`);
        if (event === "will-download") throw downloadFailure;
      }),
      setDevicePermissionHandler: vi.fn((handler: unknown) => {
        if (handler === null) {
          resetCalls.push("device");
          throw deviceFailure;
        }
      }),
      setDisplayMediaRequestHandler: vi.fn((handler: unknown) => {
        if (handler === null) resetCalls.push("display");
      }),
      setPermissionCheckHandler: vi.fn((handler: unknown) => {
        if (handler === null) {
          resetCalls.push("check");
          throw permissionCheckFailure;
        }
      }),
      setPermissionRequestHandler: vi.fn((handler: unknown) => {
        if (handler === null) resetCalls.push("request");
      }),
      setSpellCheckerEnabled: vi.fn(),
    } as unknown as Session;

    const uninstall = installSessionDenialPolicy(
      targetSession,
      denyByDefaultCapabilityPolicy,
    );

    expect(uninstall).toThrow(
      expect.objectContaining({
        errors: [permissionCheckFailure, deviceFailure, downloadFailure],
        message: "Electron session denial-policy uninstall failed",
      }),
    );
    expect(resetCalls).toEqual([
      "check",
      "request",
      "device",
      "display",
      "remove:select-hid-device",
      "remove:select-usb-device",
      "remove:select-serial-port",
      "remove:will-download",
    ]);
  });
});

describe("WebContents escape denial", () => {
  it("installs one shared fail-closed popup, navigation, and webview boundary", () => {
    const listeners = new Map<string, (...arguments_: never[]) => void>();
    let windowOpenHandler:
      ((details: { url: string }) => { action: "allow" | "deny" }) | undefined;
    const webContents = {
      on: vi.fn((event: string, listener: (...arguments_: never[]) => void) => {
        listeners.set(event, listener);
      }),
      setWindowOpenHandler: vi.fn(
        (handler: typeof windowOpenHandler) => (windowOpenHandler = handler),
      ),
    } as unknown as WebContents;

    installWebContentsEscapeDenial(
      webContents,
      "desmoslock-calculator:",
      denyByDefaultCapabilityPolicy,
    );

    expect([...listeners.keys()].sort()).toEqual([
      "will-attach-webview",
      "will-frame-navigate",
      "will-navigate",
      "will-redirect",
    ]);
    expect(windowOpenHandler?.({ url: "https://attacker.invalid" })).toEqual({
      action: "deny",
    });

    for (const event of [
      "will-navigate",
      "will-frame-navigate",
      "will-redirect",
    ]) {
      const preventDefault = vi.fn();
      const details = { preventDefault, url: "https://attacker.invalid" };
      if (event === "will-frame-navigate") {
        listeners.get(event)?.(details as never);
      } else {
        listeners.get(event)?.(
          { preventDefault } as never,
          "https://attacker.invalid" as never,
        );
      }
      expect(preventDefault).toHaveBeenCalledOnce();
    }

    const preventWebview = vi.fn();
    listeners.get("will-attach-webview")?.({
      preventDefault: preventWebview,
    } as never);
    expect(preventWebview).toHaveBeenCalledOnce();
  });
});
