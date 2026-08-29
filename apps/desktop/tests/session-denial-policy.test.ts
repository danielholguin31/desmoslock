import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  denyByDefaultCapabilityPolicy,
  installWebContentsEscapeDenial,
} from "../src/main/session-denial-policy.js";

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
