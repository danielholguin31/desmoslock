import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createAppBrowserDefine,
  createDesktopBuildContext,
} from "../scripts/build-app.mjs";

describe("candidate build identity (pure)", () => {
  const backend = { environment: "local", url: "http://127.0.0.1:43175" };
  const hash = "a".repeat(64);
  const inputs = {
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    packageLockSha256: hash,
    packageVersion: "2.0.0",
    platform: "darwin",
    architecture: "arm64",
    graphingProfile: "internal-graphing-v1",
    backendConfigurationSha256: createHash("sha256")
      .update(JSON.stringify(backend))
      .digest("hex"),
    tools: {
      node: { version: "24.20.0", sha256: hash },
      npm: { version: "11.12.1", sha256: hash },
      electron: { version: "43.4.1", archiveSha256: hash },
      packager: { version: "20.3.0" },
      fuses: { version: "2.1.3" },
      compiler: { version: "Apple clang 17.0.0", sha256: hash },
      sdk: { version: "26.2", buildVersion: "25C57", settingsSha256: hash },
      nodeHeadersSha256: hash,
    },
  };
  it("ordinary production context is explicitly null", () => {
    const context = createDesktopBuildContext(null, backend);
    expect(context.identity).toBeNull();
    expect(context.identityJson).toBe("null");
    expect(context.mainDefine.__DESMOSLOCK_CLIENT_BUILD_IDENTITY__).toBe(
      "null",
    );
  });
  it("binds deterministic inputs and backend only into main define", () => {
    const context = createDesktopBuildContext(inputs, backend);
    expect(JSON.parse(context.identityJson)).toEqual(context.identity);
    expect(context.identity?.sourceCommit).toBe(inputs.sourceCommit);
    expect(context.identity?.buildId).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      createDesktopBuildContext({ ...inputs, architecture: "x64" }, backend)
        .identity?.buildId,
    ).not.toBe(context.identity?.buildId);
    expect(createAppBrowserDefine("desktop", backend)).not.toHaveProperty(
      "__DESMOSLOCK_CLIENT_BUILD_IDENTITY__",
    );
    expect(Object.isFrozen(context.mainDefine)).toBe(true);
  });
  it("rejects malformed/extra provenance and different public backend", () => {
    expect(() =>
      createDesktopBuildContext({ ...inputs, buildId: hash }, backend),
    ).toThrow("Candidate build inputs are invalid");
    expect(() =>
      createDesktopBuildContext(inputs, {
        ...backend,
        url: "http://127.0.0.1:43176",
      }),
    ).toThrow("Candidate build inputs are invalid");
    expect(() => createDesktopBuildContext(undefined, backend)).toThrow(
      "Candidate build inputs are invalid",
    );
  });
});

const buildScript = fileURLToPath(
  new URL("../scripts/build-app.mjs", import.meta.url),
);
const safeProcessEnvironment = {
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH ?? "",
};
const localBackendEnvironment = {
  DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
  DESMOSLOCK_PUBLIC_BACKEND_URL: "http://127.0.0.1:43175",
};
const syntheticPublishableKey = `sb_publishable_${"r".repeat(22)}_${"c".repeat(8)}`;
const webEnvironment = {
  ...localBackendEnvironment,
  DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: syntheticPublishableKey,
  DESMOSLOCK_PUBLIC_WEB_ORIGIN: "http://localhost:43174",
};

function readArtifactContents(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const entryPath = path.join(root, entry.name);
      return entry.isDirectory()
        ? readArtifactContents(entryPath)
        : readFileSync(entryPath).toString("utf8");
    })
    .join("\n");
}

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

describe("web-only build configuration", () => {
  it.each([
    [
      "missing publishable key",
      {
        ...localBackendEnvironment,
        DESMOSLOCK_PUBLIC_WEB_ORIGIN: "http://localhost:43174",
      },
    ],
    [
      "missing application origin",
      {
        ...localBackendEnvironment,
        DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: syntheticPublishableKey,
      },
    ],
    [
      "malformed publishable key",
      {
        ...localBackendEnvironment,
        DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-invalid",
        DESMOSLOCK_PUBLIC_WEB_ORIGIN: "http://localhost:43174",
      },
    ],
    [
      "non-canonical application origin",
      {
        ...localBackendEnvironment,
        DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY: syntheticPublishableKey,
        DESMOSLOCK_PUBLIC_WEB_ORIGIN: "http://localhost:43174/path",
      },
    ],
  ])("fails closed for a %s", (_label, environment) => {
    const result = spawnSync(process.execPath, [buildScript, "web"], {
      encoding: "utf8",
      env: { ...safeProcessEnvironment, ...environment },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Public web build configuration is invalid",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      syntheticPublishableKey,
    );
  });

  it("uses an exact web-only define set", () => {
    const backend = {
      environment: "local" as const,
      url: "http://127.0.0.1:43175",
    };
    const web = {
      ...backend,
      origin: "http://localhost:43174",
      publishableKey: syntheticPublishableKey,
    };

    expect(createAppBrowserDefine("desktop", backend)).toEqual({
      __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: '"local"',
      __DESMOSLOCK_PUBLIC_BACKEND_URL__: '"http://127.0.0.1:43175"',
    });
    expect(() => createAppBrowserDefine("desktop", web)).toThrow(
      "Public backend build configuration is invalid",
    );
    expect(createAppBrowserDefine("web", web)).toEqual({
      __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: '"local"',
      __DESMOSLOCK_PUBLIC_BACKEND_URL__: '"http://127.0.0.1:43175"',
      __DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
        syntheticPublishableKey,
      ),
      __DESMOSLOCK_PUBLIC_WEB_ORIGIN__: '"http://localhost:43174"',
    });
  });

  it("does not require or embed web-only configuration in desktop artifacts", () => {
    const result = spawnSync(
      process.execPath,
      [buildScript, "desktop", "--production"],
      {
        encoding: "utf8",
        env: { ...safeProcessEnvironment, ...webEnvironment },
      },
    );

    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);

    const desktopArtifacts = readArtifactContents(
      fileURLToPath(new URL("../apps/desktop/dist", import.meta.url)),
    );
    expect(desktopArtifacts).not.toContain(syntheticPublishableKey);
    expect(desktopArtifacts).not.toContain(
      "__DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__",
    );
    expect(desktopArtifacts).not.toContain(
      "DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  });
});
