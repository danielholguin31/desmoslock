import { describe, expect, it } from "vitest";

import { createStaticProtocolHandler } from "../src/main/static-protocol.js";

describe("exact local protocol handler", () => {
  const handle = createStaticProtocolHandler({
    assets: {
      "desmoslock-calculator://host/host.js": {
        body: "console.log('controlled')",
        contentType: "text/javascript; charset=utf-8",
      },
      "desmoslock-calculator://host/index.html": {
        body: "<!doctype html><title>Controlled Calculator</title>",
        contentType: "text/html; charset=utf-8",
      },
    },
    connectionAllowlist:
      '(response-origin "https://api.example.invalid");webrtc=block',
    contentSecurityPolicy:
      "default-src 'none'; script-src 'self'; style-src 'self'",
  });

  it("serves a declared exact URL with restrictive response headers", async () => {
    const response = await handle({
      method: "GET",
      url: "desmoslock-calculator://host/index.html",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("connection-allowlist")).toBe(
      '(response-origin "https://api.example.invalid");webrtc=block',
    );
    expect(await response.text()).toContain("Controlled Calculator");
  });

  it.each([
    ["POST", "desmoslock-calculator://host/index.html", 405],
    ["GET", "desmoslock-calculator://host/", 404],
    ["GET", "desmoslock-calculator://host/index.html?x=1", 404],
    ["GET", "desmoslock-calculator://host.attacker.invalid/index.html", 404],
    ["GET", "desmoslock-calculator://host/%2e%2e/index.html", 404],
  ])("denies %s %s", async (method, url, expectedStatus) => {
    const response = await handle({ method, url });

    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).toBe("");
  });
});
