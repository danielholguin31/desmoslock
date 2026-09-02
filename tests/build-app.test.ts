import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const buildScript = fileURLToPath(
  new URL("../scripts/build-app.mjs", import.meta.url),
);
const safeProcessEnvironment = {
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH ?? "",
};

describe("app build backend configuration", () => {
  it.each([
    ["missing", {}],
    ["missing URL", { DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "staging" }],
    [
      "missing environment",
      { DESMOSLOCK_PUBLIC_BACKEND_URL: "https://staging.example.test" },
    ],
  ])("fails closed when public configuration is %s", (_label, environment) => {
    const result = spawnSync(process.execPath, [buildScript, "web"], {
      encoding: "utf8",
      env: { ...safeProcessEnvironment, ...environment },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Public backend build configuration is invalid",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "http://127.0.0.1",
    );
  });
});
