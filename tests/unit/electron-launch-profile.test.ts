import { describe, expect, it } from "vitest";

import { createElectronLaunchProfile } from "../../scripts/electron-launch-profile.mjs";

const ambientEnvironment = {
  APPDATA: "C:\\Users\\student\\AppData\\Roaming",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  DISPLAY: ":99",
  ELECTRON_RUN_AS_NODE: "1",
  HOME: "/Users/student",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_CTYPE: "UTF-8",
  LOCALAPPDATA: "C:\\Users\\student\\AppData\\Local",
  NODE_OPTIONS: "--require=untrusted-hook.js",
  PATH: "/usr/bin:/bin",
  PATHEXT: ".COM;.EXE;.BAT",
  PRIVATE_ACCESS_TOKEN: "must-not-cross-process-boundary",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  TMPDIR: "/private/tmp",
  USERPROFILE: "C:\\Users\\student",
  WAYLAND_DISPLAY: "wayland-0",
  WINDIR: "C:\\Windows",
  XAUTHORITY: "/tmp/xauth",
  XDG_RUNTIME_DIR: "/run/user/1000",
  XDG_SESSION_TYPE: "wayland",
};

describe("Electron launch profile", () => {
  it("passes only required macOS runtime variables", () => {
    expect(createElectronLaunchProfile(ambientEnvironment, "darwin")).toEqual({
      args: [],
      env: {
        HOME: "/Users/student",
        TMPDIR: "/private/tmp",
      },
    });
  });

  it("labels the Linux test profile with its non-release sandbox override", () => {
    expect(createElectronLaunchProfile(ambientEnvironment, "linux")).toEqual({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
      chromiumSandbox: false,
      env: {
        DBUS_SESSION_BUS_ADDRESS: "disabled:",
        DISPLAY: ":99",
        ELECTRON_DISABLE_SANDBOX: "1",
        HOME: "/Users/student",
        TMPDIR: "/private/tmp",
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/tmp/xauth",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_SESSION_TYPE: "wayland",
      },
    });
  });

  it("normalizes only Windows profile roots case-insensitively", () => {
    expect(
      createElectronLaunchProfile(
        {
          ...ambientEnvironment,
          APPDATA: undefined,
          ELECTRON_RUN_AS_NODE: undefined,
          SystemRoot: undefined,
          aPpDaTa: "C:\\Users\\student\\AppData\\Roaming",
          eLeCtRoN_rUn_As_NoDe: "1",
          windir: "C:\\Windows",
        },
        "win32",
      ),
    ).toEqual({
      args: [],
      env: {
        APPDATA: "C:\\Users\\student\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\student\\AppData\\Local",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\student",
      },
    });
  });

  it("drops undefined values and never forwards ambient execution or credential controls", () => {
    const profile = createElectronLaunchProfile(
      {
        ELECTRON_RUN_AS_NODE: "1",
        HOME: undefined,
        NODE_OPTIONS: "--inspect",
        PRIVATE_ACCESS_TOKEN: "secret",
      },
      "darwin",
    );

    expect(profile.args).toEqual([]);
    expect(profile.env).toMatchObject({ HOME: expect.any(String) });
    expect(profile.env).toMatchObject({ TMPDIR: expect.any(String) });
    expect(profile.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(profile.env).not.toHaveProperty("NODE_OPTIONS");
    expect(profile.env).not.toHaveProperty("PRIVATE_ACCESS_TOKEN");
  });
});
