import { parsePublicBackendConfiguration } from "@desmoslock/contracts";
import { describe, expect, it } from "vitest";

import {
  observeDesktopBackend,
  publicDesktopBackendConfiguration,
  updateDesktopBackendStatus,
} from "../src/backend-status.js";
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

  it("has no implicit loopback backend when build configuration is absent", () => {
    expect(
      parsePublicBackendConfiguration(publicDesktopBackendConfiguration),
    ).toBeNull();
  });

  it("renders configuration_invalid without fetching when build configuration is absent", async () => {
    const status = {
      dataset: {},
      textContent: "",
    } as unknown as HTMLElement;
    let fetches = 0;
    const observation = await updateDesktopBackendStatus(status, async () => {
      fetches += 1;
      throw new Error("missing configuration must not reach the network");
    });

    expect(observation).toEqual({
      reason: "configuration_invalid",
      status: "unavailable",
    });
    expect(fetches).toBe(0);
    expect(status.dataset.backendStatus).toBe("unavailable");
    expect(status.textContent).toContain("configuration_invalid");
  });

  it("observes the same public backend contract without adding an IPC channel", async () => {
    const observation = await observeDesktopBackend(
      {
        environment: "local",
        url: "http://127.0.0.1:54321",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth", "database", "rest"],
              fixtureDigest:
                "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v2",
              schemaGeneration: 4,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toMatchObject({
      environment: "local",
      schemaGeneration: 4,
      status: "ready",
    });
    const bridge = createTrustedDesktopBridge(async () => ({ ok: true }));
    expect(Object.keys(bridge).sort()).toEqual([
      "requestAssessmentLock",
      "version",
    ]);
    expect("readBackendHealth" in bridge).toBe(false);
  });
});
