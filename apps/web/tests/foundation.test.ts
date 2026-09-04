import { parsePublicBackendConfiguration } from "@desmoslock/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  observeWebBackend,
  publicWebBackendConfiguration,
  updateWebBackendStatus,
} from "../src/backend-status.js";
import {
  internalWorkspacePreview,
  registerWebApplicationLifecycle,
} from "../src/main.js";

describe("web v2 foundation", () => {
  it("starts with no imported legacy product rows", () => {
    expect(internalWorkspacePreview).toEqual([]);
  });

  it("preserves the live application for BFCache and disposes on a terminal page hide", () => {
    const handlers: {
      pageHide?: (event: PageTransitionEvent) => void;
    } = {};
    const runtime = {
      addEventListener(_type: string, listener: EventListener) {
        handlers.pageHide = listener as (event: PageTransitionEvent) => void;
      },
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const dispose = vi.fn();
    const unregister = registerWebApplicationLifecycle(runtime, dispose);

    handlers.pageHide?.({ persisted: true } as PageTransitionEvent);
    expect(dispose).not.toHaveBeenCalled();
    handlers.pageHide?.({ persisted: false } as PageTransitionEvent);
    expect(dispose).toHaveBeenCalledOnce();

    unregister();
    expect(runtime.removeEventListener).toHaveBeenCalledWith(
      "pagehide",
      expect.any(Function),
    );
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
  });
});
