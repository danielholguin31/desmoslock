import { describe, expect, it } from "vitest";

import { consumeStaffAuthPkceCallback } from "../src/auth/staff-auth-callback.js";

describe("staff auth PKCE callback", () => {
  it("exchanges an exact code/state callback and returns only a sanitized receipt", async () => {
    const exchanged: string[] = [];
    const authorizationCode = "SENTINEL-authorization-code";
    const state = "SENTINEL-expected-state";

    const receipt = await consumeStaffAuthPkceCallback(
      `https://app.example.test/auth/callback?code=${authorizationCode}&state=${state}`,
      {
        async exchange(code) {
          exchanged.push(code);
        },
        expectedState: state,
      },
    );

    expect(receipt).toEqual({ code: "accepted", status: "accepted" });
    expect(exchanged).toEqual([authorizationCode]);
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
  });

  it.each([
    [
      "https://app.example.test/auth/callback?code=one&state=wrong",
      "state_mismatch",
    ],
    [
      "https://app.example.test/auth/callback?code=one&code=two&state=expected",
      "malformed_callback",
    ],
    [
      "https://app.example.test/auth/callback?code=one&state=expected&state=two",
      "malformed_callback",
    ],
    [
      "https://app.example.test/auth/callback?code=one&state=expected&access_token=SENTINEL",
      "malformed_callback",
    ],
    [
      "https://app.example.test/auth/callback?code=one&state=expected#refresh_token=SENTINEL",
      "malformed_callback",
    ],
    [
      "https://app.example.test/auth/callback?state=expected",
      "invalid_callback",
    ],
    ["not a callback URL", "invalid_callback"],
  ] as const)(
    "rejects a non-exact callback as %s without exchanging it",
    async (callbackUrl, expectedCode) => {
      let exchanges = 0;

      const receipt = await consumeStaffAuthPkceCallback(callbackUrl, {
        async exchange() {
          exchanges += 1;
        },
        expectedState: "expected",
      });

      expect(receipt).toEqual({ code: expectedCode, status: "rejected" });
      expect(exchanges).toBe(0);
      expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
    },
  );

  it("sanitizes an exact provider rejection without exchanging it", async () => {
    let exchanges = 0;

    const receipt = await consumeStaffAuthPkceCallback(
      "https://app.example.test/auth/callback?error=SENTINEL-provider-error&state=expected",
      {
        async exchange() {
          exchanges += 1;
        },
        expectedState: "expected",
      },
    );

    expect(receipt).toEqual({
      code: "provider_rejected",
      status: "rejected",
    });
    expect(exchanges).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
  });

  it("sanitizes an authorization-code exchange failure", async () => {
    const receipt = await consumeStaffAuthPkceCallback(
      "https://app.example.test/auth/callback?code=one&state=expected",
      {
        async exchange() {
          throw new Error("SENTINEL-exchange-detail");
        },
        expectedState: "expected",
      },
    );

    expect(receipt).toEqual({
      code: "exchange_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL");
  });

  it.each([
    "http://app.example.test/auth/callback?code=one&state=expected",
    "javascript:alert(1)?code=one&state=expected",
    "https://user:password@app.example.test/auth/callback?code=one&state=expected",
    "https://app.example.test/auth/callback?code=one&state=",
  ])("rejects an unsafe callback URL", async (callbackUrl) => {
    let exchanges = 0;
    const receipt = await consumeStaffAuthPkceCallback(callbackUrl, {
      async exchange() {
        exchanges += 1;
      },
      expectedState: callbackUrl.endsWith("state=") ? "" : "expected",
    });

    expect(receipt).toEqual({
      code: "invalid_callback",
      status: "rejected",
    });
    expect(exchanges).toBe(0);
  });

  it("allows an exact loopback HTTP callback for local development", async () => {
    let exchanges = 0;
    const receipt = await consumeStaffAuthPkceCallback(
      "http://127.0.0.1:43174/auth/callback?code=one&state=expected",
      {
        async exchange() {
          exchanges += 1;
        },
        expectedState: "expected",
      },
    );

    expect(receipt).toEqual({ code: "accepted", status: "accepted" });
    expect(exchanges).toBe(1);
  });
});
