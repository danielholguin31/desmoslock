import { describe, expect, it } from "vitest";

import {
  createTrustedDesktopBridge,
  trustedRequestLockChannel,
} from "../src/trusted-bridge.js";

describe("desktop v2 foundation", () => {
  it("exposes a fixed lock-intent method rather than raw IPC", async () => {
    const invocations: Array<{ channel: string; request: unknown }> = [];
    const bridge = createTrustedDesktopBridge(async (channel, request) => {
      invocations.push({ channel, request });
      return { ok: true };
    });

    expect(bridge).toEqual({
      requestLock: expect.any(Function),
      version: "2.0.0",
    });
    await expect(bridge.requestLock()).resolves.toEqual({ ok: true });
    expect(invocations).toEqual([
      {
        channel: trustedRequestLockChannel,
        request: { intent: "engage" },
      },
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect("channels" in bridge).toBe(false);
    expect("releaseLock" in bridge).toBe(false);
    expect("store" in bridge).toBe(false);
  });
});
