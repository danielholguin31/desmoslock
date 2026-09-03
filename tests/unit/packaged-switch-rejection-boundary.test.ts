import { describe, expect, it } from "vitest";

import { inspectPackagedLaunchPolicyBoundary } from "../../apps/desktop/src/main/packaged-launch-policy.js";
import { createElectronLaunchProfile } from "../../scripts/electron-launch-profile.mjs";
import { assertPackagedSwitchRejectionBoundary } from "../../scripts/packaged-switch-rejection-boundary.mjs";

function inspectBoundary(
  launchProfile: ReturnType<typeof createElectronLaunchProfile>,
  forbiddenSwitch: string,
) {
  const arguments_ = [...launchProfile.args, forbiddenSwitch];
  const commandLineSwitches = arguments_.map(
    (argument) =>
      argument
        .trim()
        .replace(/^-{1,2}/, "")
        .split("=", 1)[0],
  );
  return inspectPackagedLaunchPolicyBoundary(true, {
    arguments: arguments_,
    commandLine: {
      hasSwitch: (name) => commandLineSwitches.includes(name),
    },
    environment: launchProfile.env,
  });
}

describe("packaged switch rejection boundary", () => {
  it("accepts the exact macOS rejection receipt without sandbox controls", () => {
    const launchProfile = createElectronLaunchProfile({}, "darwin");
    const forbiddenSwitch = "--inspect=0";
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: inspectBoundary(launchProfile, forbiddenSwitch),
        forbiddenSwitch,
        launchProfile,
      }),
    ).not.toThrow();
  });

  it("accepts only the intentional Linux compatibility controls beside the rejected diagnostic switch", () => {
    const launchProfile = createElectronLaunchProfile({}, "linux");
    const forbiddenSwitch = "--remote-debugging-pipe";
    expect(() =>
      assertPackagedSwitchRejectionBoundary({
        boundary: inspectBoundary(launchProfile, forbiddenSwitch),
        forbiddenSwitch,
        launchProfile,
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
