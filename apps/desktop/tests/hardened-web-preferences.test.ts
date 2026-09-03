import { describe, expect, it } from "vitest";

import {
  createCalculatorWebPreferences,
  createTrustedShellWebPreferences,
} from "../src/main/hardened-web-preferences.js";

const hardenedSharedPreferences = {
  allowRunningInsecureContent: false,
  contextIsolation: true,
  devTools: false,
  disableDialogs: true,
  enableWebSQL: false,
  experimentalFeatures: false,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  spellcheck: false,
  webSecurity: true,
  webviewTag: false,
};

describe("hardened WebContents preferences", () => {
  it("keeps the shell and calculator on one immutable hardened baseline", () => {
    const shell = createTrustedShellWebPreferences("/app/preload.cjs");
    const calculator = createCalculatorWebPreferences(
      "desmoslock-calculator-1",
    );

    expect(shell).toEqual({
      ...hardenedSharedPreferences,
      preload: "/app/preload.cjs",
    });
    expect(calculator).toEqual({
      ...hardenedSharedPreferences,
      partition: "desmoslock-calculator-1",
    });
    expect("partition" in shell).toBe(false);
    expect("preload" in calculator).toBe(false);
    expect(Object.isFrozen(shell)).toBe(true);
    expect(Object.isFrozen(calculator)).toBe(true);
  });

  it("rejects an empty trusted preload path", () => {
    expect(() => createTrustedShellWebPreferences("")).toThrow(
      "Trusted shell requires a preload path",
    );
  });
});
