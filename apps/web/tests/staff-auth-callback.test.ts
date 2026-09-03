import { describe, expect, it, vi } from "vitest";

import {
  consumeStaffAuthPkceCallback,
  type StaffAuthCallbackFlow,
  type StaffAuthCallbackStateResult,
} from "../src/auth/staff-auth-callback.js";

const route = {
  origin: "https://app.example.test",
  pathname: "/auth/callback",
} as const;

function callbackUrl(
  flow: StaffAuthCallbackFlow = "sign_in",
  query = `code=SENTINEL-code&state=SENTINEL-state&flow=${flow}`,
): string {
  return `${route.origin}${route.pathname}?${query}`;
}

function options(
  input: {
    exchange?: (input: {
      authorizationCode: string;
      flow: StaffAuthCallbackFlow;
    }) => Promise<void>;
    history?: { replaceState(data: null, unused: string, url: string): void };
    stateResult?: StaffAuthCallbackStateResult;
    states?: {
      consume(input: {
        flow: StaffAuthCallbackFlow;
        state: string;
      }): Promise<StaffAuthCallbackStateResult>;
    };
  } = {},
) {
  return {
    exchange: input.exchange ?? (async () => undefined),
    history: input.history ?? { replaceState() {} },
    route,
    states: input.states ?? {
      async consume() {
        return input.stateResult ?? "accepted";
      },
    },
  };
}

describe("staff auth PKCE callback", () => {
  it.each(["sign_in", "email_verification", "password_recovery"] as const)(
    "accepts a trusted exact-key %s callback",
    async (flow) => {
      const exchanged: unknown[] = [];

      const receipt = await consumeStaffAuthPkceCallback(
        callbackUrl(flow),
        options({
          async exchange(input) {
            exchanged.push(input);
          },
        }),
      );

      expect(receipt).toEqual({ code: "accepted", flow, status: "accepted" });
      expect(exchanged).toEqual([{ authorizationCode: "SENTINEL-code", flow }]);
      expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
    },
  );

  it("scrubs callback credentials synchronously before the first await", async () => {
    const order: string[] = [];
    let releaseState:
      ((value: StaffAuthCallbackStateResult) => void) | undefined;
    const pendingState = new Promise<StaffAuthCallbackStateResult>(
      (resolve) => {
        releaseState = resolve;
      },
    );

    const pending = consumeStaffAuthPkceCallback(
      callbackUrl(),
      options({
        async exchange() {
          order.push("exchange");
        },
        history: {
          replaceState(data, title, url) {
            expect(data).toBeNull();
            expect(title).toBe("");
            expect(url).toBe("/auth/callback");
            order.push("scrub");
          },
        },
        states: {
          async consume() {
            order.push("consume");
            return pendingState;
          },
        },
      }),
    );

    expect(order).toEqual(["scrub", "consume"]);
    releaseState?.("accepted");
    await expect(pending).resolves.toMatchObject({ status: "accepted" });
    expect(order).toEqual(["scrub", "consume", "exchange"]);
  });

  it("passes state and flow only to the one-time state store", async () => {
    const consumed: unknown[] = [];
    await consumeStaffAuthPkceCallback(
      callbackUrl("password_recovery"),
      options({
        states: {
          async consume(input) {
            consumed.push(input);
            return "accepted";
          },
        },
      }),
    );

    expect(consumed).toEqual([
      { flow: "password_recovery", state: "SENTINEL-state" },
    ]);
  });

  it.each([
    ["invalid", "state_mismatch"],
    ["replayed", "state_replayed"],
  ] as const)("rejects a %s one-time state", async (stateResult, code) => {
    const exchange = vi.fn();
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl(),
      options({ exchange, stateResult }),
    );

    expect(receipt).toEqual({ code, status: "rejected" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("sanitizes a state-store outage", async () => {
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl(),
      options({
        states: {
          async consume() {
            throw new Error("SENTINEL-state-store-detail");
          },
        },
      }),
    );

    expect(receipt).toEqual({ code: "state_unavailable", status: "rejected" });
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
  });

  it("consumes state and sanitizes a provider rejection", async () => {
    const consume = vi.fn(async () => "accepted" as const);
    const exchange = vi.fn();
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl("sign_in", "error=access_denied&state=opaque&flow=sign_in"),
      options({ exchange, states: { consume } }),
    );

    expect(receipt).toEqual({ code: "provider_rejected", status: "rejected" });
    expect(consume).toHaveBeenCalledWith({ flow: "sign_in", state: "opaque" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("sanitizes an exchange failure", async () => {
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl(),
      options({
        async exchange() {
          throw new Error("SENTINEL-provider-detail");
        },
      }),
    );

    expect(receipt).toEqual({
      code: "exchange_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
  });

  it.each([
    "https://evil.example.test/auth/callback?code=one&state=two&flow=sign_in",
    "https://app.example.test/wrong?code=one&state=two&flow=sign_in",
    "https://user@app.example.test/auth/callback?code=one&state=two&flow=sign_in",
    "https://app.example.test/auth/callback?code=one&state=two&flow=sign_in#token",
  ])("rejects a callback outside the trusted exact route", async (url) => {
    const exchange = vi.fn();
    const receipt = await consumeStaffAuthPkceCallback(
      url,
      options({ exchange }),
    );

    expect(receipt).toEqual({ code: "invalid_callback", status: "rejected" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each(["code=one&state=two&flow=owner", "code=one&state=two&flow="])(
    "rejects an untrusted callback flow",
    async (query) => {
      const receipt = await consumeStaffAuthPkceCallback(
        callbackUrl("sign_in", query),
        options(),
      );
      expect(receipt).toEqual({ code: "invalid_flow", status: "rejected" });
    },
  );

  it.each([
    "code=one&state=two&flow=sign_in&token=SENTINEL",
    "code=one&code=two&state=three&flow=sign_in",
    "code=one&state=two&state=three&flow=sign_in",
    "code=one&state=two&flow=sign_in&flow=password_recovery",
    "code=&state=two&flow=sign_in",
    "error=&state=two&flow=sign_in",
    "code=one&error=denied&state=two&flow=sign_in",
    "state=two&flow=sign_in",
  ])("rejects malformed or non-exact callback keys", async (query) => {
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl("sign_in", query),
      options(),
    );
    expect(receipt).toEqual({
      code: "malformed_callback",
      status: "rejected",
    });
  });

  it("fails closed when browser history cannot scrub the address", async () => {
    const states = { consume: vi.fn(async () => "accepted" as const) };
    const receipt = await consumeStaffAuthPkceCallback(
      callbackUrl(),
      options({
        history: {
          replaceState() {
            throw new Error("history unavailable");
          },
        },
        states,
      }),
    );

    expect(receipt).toEqual({ code: "invalid_callback", status: "rejected" });
    expect(states.consume).not.toHaveBeenCalled();
  });

  it.each([
    { origin: "http://app.example.test", pathname: "/auth/callback" },
    { origin: "https://app.example.test/path", pathname: "/auth/callback" },
    { origin: "https://app.example.test", pathname: "auth/callback" },
    { origin: "https://app.example.test", pathname: "//evil.example.test" },
    { origin: "https://app.example.test", pathname: "/auth/callback?bad=1" },
  ])("rejects unsafe trusted-route configuration", async (unsafeRoute) => {
    const receipt = await consumeStaffAuthPkceCallback(callbackUrl(), {
      ...options(),
      route: unsafeRoute,
    });

    expect(receipt).toEqual({ code: "invalid_callback", status: "rejected" });
  });
});
