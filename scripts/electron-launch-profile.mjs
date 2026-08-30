import os from "node:os";

const commonEnvironmentKeys = Object.freeze(["HOME", "TMPDIR"]);

const linuxEnvironmentKeys = Object.freeze([
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
]);

const windowsEnvironmentKeys = Object.freeze([
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
]);

function readEnvironmentValue(sourceEnvironment, key, platform) {
  if (platform !== "win32") return sourceEnvironment[key];

  const normalizedKey = key.toLowerCase();
  for (const [candidate, value] of Object.entries(sourceEnvironment)) {
    if (
      candidate.toLowerCase() === normalizedKey &&
      typeof value === "string"
    ) {
      return value;
    }
  }
  return undefined;
}

function pickEnvironment(sourceEnvironment, keys, platform) {
  const environment = {};

  for (const key of keys) {
    const value = readEnvironmentValue(sourceEnvironment, key, platform);
    if (typeof value === "string") {
      environment[key] = value;
    }
  }

  return environment;
}

/**
 * Returns the complete, intentionally small process boundary for Electron test
 * launches. Ambient execution controls and credentials never cross this
 * boundary merely because they exist in the parent process. The Linux branch is
 * an explicitly non-release compatibility profile: it disables Chromium's OS
 * sandbox, so callers may assert requested renderer preferences but must not
 * present the launch as active-sandbox evidence.
 */
export function createElectronLaunchProfile(
  sourceEnvironment = process.env,
  platform = process.platform,
) {
  const platformKeys =
    platform === "linux"
      ? linuxEnvironmentKeys
      : platform === "win32"
        ? windowsEnvironmentKeys
        : [];
  const environment = pickEnvironment(
    sourceEnvironment,
    [...commonEnvironmentKeys, ...platformKeys],
    platform,
  );

  if (platform === "win32") {
    environment.USERPROFILE ??= os.homedir();
    environment.TEMP ??= os.tmpdir();
    environment.TMP ??= environment.TEMP;
    environment.SystemRoot ??= readEnvironmentValue(
      sourceEnvironment,
      "WINDIR",
      platform,
    );
    delete environment.HOME;
    delete environment.TMPDIR;
  } else {
    environment.HOME ??= os.homedir();
    environment.TMPDIR ??= os.tmpdir();
  }

  if (platform === "linux") {
    return {
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
      chromiumSandbox: false,
      env: {
        ...environment,
        DBUS_SESSION_BUS_ADDRESS: "disabled:",
        ELECTRON_DISABLE_SANDBOX: "1",
      },
    };
  }

  return { args: [], env: environment };
}
