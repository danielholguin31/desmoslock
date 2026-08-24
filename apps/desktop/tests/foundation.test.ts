import { describe, expect, it } from "vitest";

import { trustedDesktopBridge } from "../src/preload.js";

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
});
