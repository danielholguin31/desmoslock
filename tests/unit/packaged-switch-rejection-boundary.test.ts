import { describe, expect, it } from "vitest";

import { createElectronLaunchProfile } from "../../scripts/electron-launch-profile.mjs";
import { assertPackagedSwitchRejectionBoundary } from "../../scripts/packaged-switch-rejection-boundary.mjs";

describe("packaged switch rejection boundary", () => {
  it("accepts the exact macOS rejection receipt without sandbox controls", () => {
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: {
          argumentSwitches: ["inspect"],
          commandLineSwitches: ["inspect"],
          environmentSandboxControlPresent: false,
          isPackaged: true,
        },
        forbiddenSwitch: "--inspect=0",
        launchProfile: createElectronLaunchProfile({}, "darwin"),
      }),
    ).not.toThrow();
  });

  it("accepts only the intentional Linux compatibility controls beside the rejected diagnostic switch", () => {
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: {
          argumentSwitches: [
            "no-sandbox",
            "disable-setuid-sandbox",
            "remote-debugging-pipe",
          ],
          commandLineSwitches: [
            "disable-setuid-sandbox",
            "no-sandbox",
            "remote-debugging-pipe",
          ],
          environmentSandboxControlPresent: true,
          isPackaged: true,
        },
        forbiddenSwitch: "--remote-debugging-pipe",
        launchProfile: createElectronLaunchProfile({}, "linux"),
      }),
    ).not.toThrow();
  });

  it("rejects argument controls that were not present in the curated launch", () => {
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: {
          argumentSwitches: ["inspect", "single-process"],
          commandLineSwitches: ["inspect", "single-process"],
          environmentSandboxControlPresent: false,
          isPackaged: true,
        },
        forbiddenSwitch: "--inspect=0",
        launchProfile: createElectronLaunchProfile({}, "darwin"),
      }),
    ).toThrow();
  });

  it("rejects a sandbox environment receipt that disagrees with the curated launch", () => {
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: {
          argumentSwitches: ["remote-debugging-pipe"],
          commandLineSwitches: ["remote-debugging-pipe"],
          environmentSandboxControlPresent: true,
          isPackaged: true,
        },
        forbiddenSwitch: "--remote-debugging-pipe",
        launchProfile: createElectronLaunchProfile({}, "darwin"),
      }),
    ).toThrow();
  });
});
