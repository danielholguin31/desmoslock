import { parsePublicBackendConfiguration } from "@desmoslock/contracts";
import { describe, expect, it } from "vitest";

import {
  observeWebBackend,
  publicWebBackendConfiguration,
  updateWebBackendStatus,
} from "../src/backend-status.js";
import { internalWorkspacePreview } from "../src/main.js";

describe("web v2 foundation", () => {
  it("starts with no imported legacy product rows", () => {
    expect(internalWorkspacePreview).toEqual([]);
  });

  it("has no implicit loopback backend when build configuration is absent", () => {
    expect(
      parsePublicBackendConfiguration(publicWebBackendConfiguration),
    ).toBeNull();
  });

  it("renders configuration_invalid without fetching when build configuration is absent", async () => {
    const status = {
      dataset: {},
      textContent: "",
    } as unknown as HTMLElement;
    let fetches = 0;
    const observation = await updateWebBackendStatus(status, async () => {
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

  it("observes the configured backend through the public health contract", async () => {
    const observation = await observeWebBackend(
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
  });
});
