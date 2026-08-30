import { describe, expect, it } from "vitest";

import { assertPackagedLaunchArguments } from "../src/main/packaged-launch-policy.js";

describe("packaged launch policy", () => {
  it("rejects --no-sandbox in a packaged macOS executable", () => {
    expect(() =>
      assertPackagedLaunchArguments(
        true,
        ["DesmosLock", "--no-sandbox"],
        "darwin",
      ),
    ).toThrow(
      "Packaged runtime forbids sandbox-disabling command-line switches",
    );
  });

  it("rejects --disable-setuid-sandbox in a packaged macOS executable", () => {
    expect(() =>
      assertPackagedLaunchArguments(
        true,
        ["DesmosLock", "--disable-setuid-sandbox"],
        "darwin",
      ),
    ).toThrow(
      "Packaged runtime forbids sandbox-disabling command-line switches",
    );
  });

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
        "Packaged runtime forbids sandbox-disabling command-line switches",
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
