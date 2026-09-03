import { describe, expect, it } from "vitest";

import { createAssessmentSessionPolicy } from "../src/main/assessment-session-policy.js";
import { calculatorDocumentUrl } from "../src/main/calculator-assets.js";

describe("assessment session policy", () => {
  const policy = createAssessmentSessionPolicy({
    allowedResources: [
      { resourceType: "mainFrame", url: calculatorDocumentUrl },
      {
        resourceType: "script",
        url: "desmoslock-calculator://host/host.js",
      },
      {
        resourceType: "stylesheet",
        url: "desmoslock-calculator://host/styles.css",
      },
    ],
    webContentsId: 21,
  });

  it("allows only the exact controlled calculator document as the initial load", () => {
    expect(policy.allowsInitialDocument(calculatorDocumentUrl)).toBe(true);

    for (const url of [
      "desmoslock-calculator://host/",
      "desmoslock-calculator://host/index.html?next=https://attacker.invalid",
      "desmoslock-calculator://host.attacker.invalid/index.html",
      "desmoslock-calculator://host@attacker.invalid/index.html",
      "https://host/index.html",
      "file:///tmp/index.html",
      "not a URL",
    ]) {
      expect(policy.allowsInitialDocument(url)).toBe(false);
    }
  });

  it("allows only exact local resources for the owned calculator main frame", () => {
    for (const [url, resourceType] of [
      [calculatorDocumentUrl, "mainFrame"],
      ["desmoslock-calculator://host/host.js", "script"],
      ["desmoslock-calculator://host/styles.css", "stylesheet"],
    ] as const) {
      expect(
        policy.allowsNetworkRequest({
          method: "GET",
          resourceType,
          url,
          webContentsId: 21,
        }),
      ).toBe(true);
    }
  });

  it.each([
    [
      "a remote request",
      "GET",
      "https://api.desmos.com/api/v1.11/calculator.js",
      21,
      "script",
    ],
    ["a websocket", "GET", "wss://attacker.invalid/socket", 21, "webSocket"],
    [
      "an exact-origin unlisted path",
      "GET",
      "desmoslock-calculator://host/private",
      21,
      "xhr",
    ],
    [
      "a query variation",
      "GET",
      "desmoslock-calculator://host/host.js?v=2",
      21,
      "script",
    ],
    ["a mutation method", "POST", calculatorDocumentUrl, 21, "mainFrame"],
    ["another renderer", "GET", calculatorDocumentUrl, 22, "mainFrame"],
    [
      "a missing renderer id",
      "GET",
      calculatorDocumentUrl,
      undefined,
      "mainFrame",
    ],
    [
      "a wrong resource type",
      "GET",
      "desmoslock-calculator://host/host.js",
      21,
      "xhr",
    ],
    ["an invalid URL", "GET", "not a URL", 21, "mainFrame"],
  ] as const)(
    "denies %s",
    (_label, method, url, webContentsId, resourceType) => {
      expect(
        policy.allowsNetworkRequest({
          method,
          resourceType,
          url,
          webContentsId,
        }),
      ).toBe(false);
    },
  );

  it.each([
    "https://host/index.html",
    "desmoslock-calculator://other/index.html",
    "desmoslock-calculator://user@host/index.html",
    "desmoslock-calculator://host:8080/index.html",
    "not a URL",
  ])("rejects a non-calculator URL in its configured manifest (%s)", (url) => {
    expect(() =>
      createAssessmentSessionPolicy({
        allowedResources: [{ resourceType: "mainFrame", url }],
        webContentsId: 21,
      }),
    ).toThrow("Assessment resource manifest contains an invalid origin");
  });

  it("denies post-load navigation, popups, downloads, permissions, and external protocols", () => {
    for (const url of [
      calculatorDocumentUrl,
      "https://example.com",
      "mailto:teacher@example.com",
      "javascript:alert(1)",
      "data:text/html,hello",
    ]) {
      expect(policy.allowsNavigation(url)).toBe(false);
      expect(policy.allowsPopup(url)).toBe(false);
      expect(policy.allowsExternalProtocol(url)).toBe(false);
    }

    expect(policy.allowsDownload()).toBe(false);
    expect(policy.allowsPermission("clipboard-read")).toBe(false);
    expect(policy.allowsPermission("media")).toBe(false);
  });
});
