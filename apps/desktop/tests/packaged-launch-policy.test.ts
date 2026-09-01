import { describe, expect, it } from "vitest";

import {
  assertPackagedLaunchArguments,
  assertPackagedLaunchPolicy,
  sandboxWeakeningOrInliningSwitchNames,
} from "../src/main/packaged-launch-policy.js";

describe("packaged launch policy", () => {
  it.each(["1", "0", "false", ""])(
    "rejects Electron's sandbox-disabling environment control value %j in a packaged macOS executable",
    (value) => {
      expect(() =>
        assertPackagedLaunchPolicy(
          true,
          {
            arguments: ["DesmosLock"],
            commandLine: { hasSwitch: () => false },
            environment: { ELECTRON_DISABLE_SANDBOX: value },
          },
          "darwin",
        ),
      ).toThrow(
        "Packaged runtime forbids sandbox-weakening or process-inlining launch controls",
      );
    },
  );

  it.each(sandboxWeakeningOrInliningSwitchNames)(
    "rejects effective %s command-line state in a packaged macOS executable",
    (sandboxDisablingSwitch) => {
      expect(() =>
        assertPackagedLaunchPolicy(
          true,
          {
            arguments: ["DesmosLock"],
            commandLine: {
              hasSwitch: (name) => name === sandboxDisablingSwitch,
            },
            environment: {},
          },
          "darwin",
        ),
      ).toThrow(
        "Packaged runtime forbids sandbox-weakening or process-inlining launch controls",
      );
    },
  );

  it("allows the non-release Linux compatibility profile to disable Chromium's sandbox", () => {
    expect(() =>
      assertPackagedLaunchPolicy(
        true,
        {
          arguments: ["DesmosLock", "--no-sandbox"],
          commandLine: {
            hasSwitch: (name) =>
              sandboxWeakeningOrInliningSwitchNames.includes(
                name as (typeof sandboxWeakeningOrInliningSwitchNames)[number],
              ),
          },
          environment: { ELECTRON_DISABLE_SANDBOX: "1" },
        },
        "linux",
      ),
    ).not.toThrow();
  });

  it("allows development launches to carry sandbox-disabling controls", () => {
    expect(() =>
      assertPackagedLaunchPolicy(
        false,
        {
          arguments: ["Electron", "--no-sandbox"],
          commandLine: { hasSwitch: () => true },
          environment: { ELECTRON_DISABLE_SANDBOX: "1" },
        },
        "darwin",
      ),
    ).not.toThrow();
  });

  it.each(sandboxWeakeningOrInliningSwitchNames)(
    "rejects --%s in a packaged macOS executable",
    (name) => {
      expect(() =>
        assertPackagedLaunchArguments(
          true,
          ["DesmosLock", `--${name}`],
          "darwin",
        ),
      ).toThrow(
        "Packaged runtime forbids sandbox-weakening or process-inlining command-line switches",
      );
    },
  );

  it.each([
    "--no-sandbox=true",
    "--disable-setuid-sandbox=true",
    "-no-sandbox",
    "-disable-setuid-sandbox",
    " --no-sandbox",
    "\t--disable-setuid-sandbox ",
  ])(
    "rejects valued sandbox-disabling switch %s in a packaged macOS executable",
    (argument) => {
      expect(() =>
        assertPackagedLaunchArguments(true, ["DesmosLock", argument], "darwin"),
      ).toThrow(
        "Packaged runtime forbids sandbox-weakening or process-inlining command-line switches",
      );
    },
  );

  it.each([
    "--no-sandbox",
    "--no-sandbox=true",
    "-no-sandbox",
    " --no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-setuid-sandbox=true",
    "-disable-setuid-sandbox",
    " --disable-setuid-sandbox",
  ])(
    "allows %s for the explicitly non-release Linux CI harness",
    (argument) => {
      expect(() =>
        assertPackagedLaunchArguments(true, ["DesmosLock", argument], "linux"),
      ).not.toThrow();
    },
  );

  it.each([
    "--inspect",
    "--inspect=0",
    "--inspect-brk=127.0.0.1:9229",
    "--inspect-wait=9229",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-pipe",
    "--remote-debugging-port=0",
  ])("rejects diagnostic switch %s in a packaged executable", (argument) => {
    expect(() =>
      assertPackagedLaunchArguments(true, ["DesmosLock", argument]),
    ).toThrow("Packaged runtime forbids diagnostic command-line switches");
  });

  it("allows ordinary packaged arguments and exact diagnostic lookalikes", () => {
    expect(() =>
      assertPackagedLaunchArguments(true, [
        "DesmosLock",
        "--inspectable=true",
        "--remote-debugging-portability=enabled",
      ]),
    ).not.toThrow();
  });

  it("allows development automation to use diagnostic switches", () => {
    expect(() =>
      assertPackagedLaunchArguments(false, [
        "Electron",
        "--inspect=0",
        "--remote-debugging-port=0",
      ]),
    ).not.toThrow();
  });
});
