import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

import { createElectronLaunchProfile } from "./electron-launch-profile.mjs";

const electronBinary = createRequire(import.meta.url)("electron");
if (typeof electronBinary !== "string" || !fs.existsSync(electronBinary)) {
  throw new Error(`Electron binary is missing: ${String(electronBinary)}`);
}

const launchProfile = createElectronLaunchProfile();
const result = spawnSync(electronBinary, [...launchProfile.args, "--version"], {
  encoding: "utf8",
  env: launchProfile.env,
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0) {
  throw new Error(`Electron runtime check failed:\n${output}`);
}

process.stdout.write(output);
