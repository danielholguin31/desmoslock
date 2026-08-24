import { describe, expect, it } from "vitest";

import { trustedIpcChannels } from "../src/index.js";

describe("trusted IPC contract", () => {
  it("contains intents and read-only subscriptions rather than generic capabilities", () => {
    expect(trustedIpcChannels).toEqual([
      "auth.start",
      "diagnostics.exportWithConsent",
      "test.lockIntent",
      "view.subscribe",
      "workspace.select",
    ]);
    expect(trustedIpcChannels.join(" ")).not.toMatch(
      /releaseLock|store|get|set|shell|quit/i,
    );
  });
});
