import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const electronBinary = createRequire(import.meta.url)("electron");
if (typeof electronBinary !== "string" || !fs.existsSync(electronBinary)) {
  throw new Error(`Electron binary is missing: ${String(electronBinary)}`);
}

const result = spawnSync(electronBinary, ["--no-sandbox", "--version"], {
  encoding: "utf8",
  env: {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: "1",
  },
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0) {
  throw new Error(`Electron runtime check failed:\n${output}`);
}

process.stdout.write(output);
