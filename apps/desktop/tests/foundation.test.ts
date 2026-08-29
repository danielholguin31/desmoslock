import { parsePublicBackendConfiguration } from "@desmoslock/contracts";
import { describe, expect, it } from "vitest";

import { trustedDesktopBridge } from "../src/preload.js";
import {
  observeDesktopBackend,
  publicDesktopBackendConfiguration,
  updateDesktopBackendStatus,
} from "../src/backend-status.js";

describe("desktop v2 foundation", () => {
  it("exposes only named intent channels", () => {
    expect(trustedDesktopBridge).toEqual({
      channels: [
        "auth.start",
        "diagnostics.exportWithConsent",
        "test.lockIntent",
        "view.subscribe",
        "workspace.select",
      ],
      version: "2.0.0",
    });
    expect(trustedDesktopBridge.channels).not.toContain("releaseLock");
    expect(trustedDesktopBridge.channels).not.toContain("store.get");
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
                "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v1",
              schemaGeneration: 3,
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
      schemaGeneration: 3,
      status: "ready",
    });
    expect(trustedDesktopBridge.channels).not.toContain("backend.health");
  });
});
