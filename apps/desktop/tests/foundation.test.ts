import { describe, expect, it } from "vitest";

import {
  createTrustedDesktopBridge,
  trustedAssessmentLockChannel,
} from "../src/trusted-bridge.js";

describe("desktop v2 foundation", () => {
  it("exposes a fixed lock-intent method rather than raw IPC", async () => {
    const invocations: Array<{ channel: string; request: unknown }> = [];
    const bridge = createTrustedDesktopBridge(async (channel, request) => {
      invocations.push({ channel, request });
      return { ok: true };
    });

    expect(bridge).toEqual({
      requestAssessmentLock: expect.any(Function),
      version: "2.0.0",
    });
    await expect(bridge.requestAssessmentLock()).resolves.toEqual({ ok: true });
    expect(invocations).toEqual([
      {
        channel: trustedAssessmentLockChannel,
        request: { intent: "engage" },
      },
    ]);
    expect(trustedAssessmentLockChannel).toBe(
      "desmoslock:assessment:request-lock",
    );
    expect(Object.isFrozen(bridge)).toBe(true);
    expect("channels" in bridge).toBe(false);
    expect("releaseLock" in bridge).toBe(false);
    expect("store" in bridge).toBe(false);
  });

  it("fails closed when the main-process response is not exact", async () => {
    for (const response of [
      null,
      { ok: true, extra: "unexpected" },
      { ok: false },
      { ok: false, reason: 7 },
    ]) {
      const bridge = createTrustedDesktopBridge(async () => response);

      await expect(bridge.requestAssessmentLock()).resolves.toEqual({
        ok: false,
        reason: "invalid-response",
      });
    }
  });
});
