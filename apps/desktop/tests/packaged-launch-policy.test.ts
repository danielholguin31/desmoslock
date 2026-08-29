import { describe, expect, it } from "vitest";

import { assertPackagedLaunchArguments } from "../src/main/packaged-launch-policy.js";

describe("packaged launch policy", () => {
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
