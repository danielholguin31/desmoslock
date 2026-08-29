import { describe, expect, it } from "vitest";

import { createCalculatorWebPreferences } from "../src/main/hardened-web-preferences.js";

describe("calculator surface boundary", () => {
  it("builds a sandboxed, preload-free, ephemeral web preferences contract", () => {
    const preferences = createCalculatorWebPreferences(
      "desmoslock-calculator-7b96d41e",
    );

    expect(preferences).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: false,
      disableDialogs: true,
      enableWebSQL: false,
      experimentalFeatures: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      partition: "desmoslock-calculator-7b96d41e",
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    });
    expect("preload" in preferences).toBe(false);
    expect(Object.isFrozen(preferences)).toBe(true);
  });

  it.each(["", "persist:calculator", "persist:desmoslock-calculator-1"])(
    "rejects a persistent or empty partition (%s)",
    (partition) => {
      expect(() => createCalculatorWebPreferences(partition)).toThrow(
        "CalculatorSurface requires an ephemeral partition",
      );
    },
  );
});
