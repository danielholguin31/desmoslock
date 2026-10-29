import { describe, expect, it } from "vitest";

import {
  assertPackagedLaunchArguments,
  assertPackagedLaunchPolicy,
  inspectPackagedLaunchPolicyBoundary,
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
            commandLine: { getSwitchValue: () => "", hasSwitch: () => false },
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
              getSwitchValue: () => "",
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
            getSwitchValue: () => "",
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
          commandLine: { getSwitchValue: () => "", hasSwitch: () => true },
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

  const connectionAllowlistRejection =
    "Packaged runtime forbids disabling Connection-Allowlist enforcement";
  const connectionAllowlistDisablingArguments: readonly (readonly string[])[] =
    [
      ["--disable-features=ConnectionAllowlists"],
      ["-disable-features=ConnectionAllowlists"],
      [" --disable-features=ConnectionAllowlists"],
      ["--disable-features=Foo,ConnectionAllowlists"],
      ["--disable-features=ConnectionAllowlists,Foo"],
      ["--disable-features=Foo, ConnectionAllowlists"],
      ["--disable-features=ConnectionAllowlists<Study"],
      ["--disable-features=ConnectionAllowlists:param/value"],
      ["--disable-features=ConnectionAllowlistEmbeddedEnforcement"],
      ["--disable-features=connectionallowlists"],
      ["--DISABLE-FEATURES=ConnectionAllowlists"],
      ["--disable-features", "ConnectionAllowlists"],
      ["--disable-features", "Foo,ConnectionAllowlists"],
      ["--disable-features=", "ConnectionAllowlists"],
      ["--disable-features=ConnectionAllowlists", "--disable-features=Foo"],
    ];

  it.each(["darwin", "linux", "win32"] as const)(
    "rejects every Connection-Allowlist-disabling argument form on %s",
    (platform) => {
      for (const disablingArguments of connectionAllowlistDisablingArguments) {
        expect(() =>
          assertPackagedLaunchArguments(
            true,
            ["DesmosLock", ...disablingArguments],
            platform,
          ),
        ).toThrow(connectionAllowlistRejection);
        expect(() =>
          assertPackagedLaunchPolicy(
            true,
            {
              arguments: ["DesmosLock", ...disablingArguments],
              commandLine: { getSwitchValue: () => "", hasSwitch: () => false },
              environment: {},
            },
            platform,
          ),
        ).toThrow(connectionAllowlistRejection);
      }
    },
  );

  it.each([
    "ConnectionAllowlists",
    "Foo,ConnectionAllowlists",
    "connectionallowlists",
  ])(
    "rejects effective disable-features state %j even when no argument shows it",
    (value) => {
      const commandLine = {
        getSwitchValue: (name: string) =>
          name === "disable-features" ? value : "",
        hasSwitch: (name: string) => name === "disable-features",
      };
      expect(() =>
        assertPackagedLaunchPolicy(
          true,
          { arguments: ["DesmosLock"], commandLine, environment: {} },
          "darwin",
        ),
      ).toThrow(connectionAllowlistRejection);
      expect(
        inspectPackagedLaunchPolicyBoundary(true, {
          arguments: ["DesmosLock"],
          commandLine,
          environment: {},
        }).commandLineSwitches,
      ).toEqual(["disable-features"]);
    },
  );

  it("records the Connection-Allowlist control in the rejection receipt", () => {
    expect(
      inspectPackagedLaunchPolicyBoundary(true, {
        arguments: ["DesmosLock", "--disable-features", "ConnectionAllowlists"],
        commandLine: { getSwitchValue: () => "", hasSwitch: () => false },
        environment: {},
      }),
    ).toEqual({
      argumentSwitches: ["disable-features"],
      commandLineSwitches: [],
      environmentSandboxControlPresent: false,
      isPackaged: true,
    });
  });

  it.each([
    ["--disable-features=SomethingElse"],
    ["--disable-features=Foo,Bar"],
    ["--disable-features", "SomethingElse"],
    ["--enable-features=ConnectionAllowlists"],
    ["--disable-features=SomethingElse", "ConnectionAllowlists"],
  ])(
    "allows packaged arguments %j that leave Connection-Allowlist enabled",
    (...benignArguments) => {
      expect(() =>
        assertPackagedLaunchArguments(
          true,
          ["DesmosLock", ...benignArguments],
          "darwin",
        ),
      ).not.toThrow();
      expect(() =>
        assertPackagedLaunchPolicy(
          true,
          {
            arguments: ["DesmosLock", ...benignArguments],
            commandLine: {
              getSwitchValue: (name) =>
                name === "disable-features" ? "SomethingElse" : "",
              hasSwitch: (name) => name === "disable-features",
            },
            environment: {},
          },
          "darwin",
        ),
      ).not.toThrow();
    },
  );

  it("allows development launches to disable Connection-Allowlist enforcement", () => {
    expect(() =>
      assertPackagedLaunchArguments(false, [
        "Electron",
        "--disable-features=ConnectionAllowlists",
      ]),
    ).not.toThrow();
    expect(() =>
      assertPackagedLaunchPolicy(false, {
        arguments: ["Electron", "--disable-features=ConnectionAllowlists"],
        commandLine: {
          getSwitchValue: () => "ConnectionAllowlists",
          hasSwitch: () => true,
        },
        environment: {},
      }),
    ).not.toThrow();
  });
});
