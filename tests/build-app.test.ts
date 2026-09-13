import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(async (options: Record<string, unknown>) => {
    void options;
    return { errors: [], warnings: [] };
  }),
  durable: vi.fn(),
  aac: vi.fn(),
}));
vi.mock("esbuild", () => ({ build: mocks.build }));
vi.mock("../scripts/build-desktop-durable-record.mjs", () => ({
  buildDesktopDurableRecord: mocks.durable,
}));
vi.mock("../scripts/build-desktop-aac-protection.mjs", () => ({
  buildDesktopAACProtection: mocks.aac,
}));

import {
  createAppBrowserDefine,
  createDesktopBuildContext,
  createUniversalDesktopBuildContext,
  buildDesktopCommon,
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
      electron: { version: "43.7.0", archiveSha256: hash },
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
  const universal = () => {
    const { architecture, ...common } = inputs;
    return {
      ...common,
      kind: "desktop-universal",
      hostArchitecture: architecture,
      tools: {
        ...inputs.tools,
        electron: { version: inputs.tools.electron.version },
        universal: { version: "3.0.6" },
        lipo: { sha256: hash },
        codesign: { sha256: hash },
      },
      slices: {
        arm64: {
          architecture: "arm64",
          electronArchiveSha256: hash,
          deploymentTarget: "13.0",
          napiVersion: 8,
        },
        x64: {
          architecture: "x64",
          electronArchiveSha256: "b".repeat(64),
          deploymentTarget: "13.0",
          napiVersion: 8,
        },
      },
      composition: { mergeASARs: true, nativeLayout: "fixed-addons-v1" },
    };
  };
  it("universal context uses the NUL-domain hash and rejects native/backend substitution", () => {
    const value = universal();
    const context = createUniversalDesktopBuildContext(value, backend);
    const canonical = (item: unknown): string =>
      typeof item !== "object" || item === null
        ? JSON.stringify(item)
        : `{${Object.entries(item)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(
              ([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`,
            )
            .join(",")}}`;
    expect(context.identity?.buildId).toBe(
      createHash("sha256")
        .update("desmoslock:universal-build:v1\0")
        .update(canonical(value))
        .digest("hex"),
    );
    expect(context.identity?.buildId).not.toBe(
      createHash("sha256").update(canonical(value)).digest("hex"),
    );
    expect(() => createUniversalDesktopBuildContext(inputs, backend)).toThrow();
    expect(() => createUniversalDesktopBuildContext(null, backend)).toThrow();
    expect(() => createDesktopBuildContext(value, backend)).toThrow();
    expect(() =>
      createUniversalDesktopBuildContext(value, {
        ...backend,
        url: "http://127.0.0.1:43176",
      }),
    ).toThrow();
  });

  describe("common build with strict compiler mocks", () => {
    const ownedRoots: string[] = [];
    afterEach(async () => {
      for (const root of ownedRoots.splice(0))
        await fs.rm(root, { recursive: true, force: true });
      mocks.build.mockClear();
      mocks.aac.mockClear();
      mocks.durable.mockClear();
    });
    async function ownedCommon() {
      const repository = fileURLToPath(new URL("../", import.meta.url));
      let current = repository;
      for (const component of ["artifacts", "universal-artifact-runs"]) {
        current = path.join(current, component);
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const stat = await fs.lstat(current);
        expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
        expect(stat.uid).toBe(process.getuid!());
        expect(stat.mode & 0o022).toBe(0);
      }
      const root = path.join(current, randomUUID());
      await fs.mkdir(root, { mode: 0o700 });
      ownedRoots.push(root);
      const outputRoot = path.join(root, "common");
      await fs.mkdir(outputRoot, { mode: 0o700 });
      return outputRoot;
    }
    it("builds three common bundles once with identity only in main and no native calls", async () => {
      const outputRoot = await ownedCommon();
      const value = universal();
      const result = await buildDesktopCommon({
        outputRoot,
        productionMode: true,
        publicBackend: backend,
        buildInputs: value,
      });
      expect(result).toEqual({
        outputRoot,
        identity: createUniversalDesktopBuildContext(value, backend).identity,
      });
      expect(mocks.build).toHaveBeenCalledTimes(3);
      expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({
        outdir: outputRoot,
        sourcemap: false,
        define: {
          __DESMOSLOCK_CLIENT_BUILD_IDENTITY__: JSON.stringify(result.identity),
        },
      });
      for (const call of mocks.build.mock.calls.slice(1))
        expect(call[0]).toMatchObject({
          define: createAppBrowserDefine("desktop", backend),
        });
      expect(mocks.durable).not.toHaveBeenCalled();
      expect(mocks.aac).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(outputRoot, "build-identity.json"),
            "utf8",
          ),
        ),
      ).toEqual(result.identity);
      await expect(
        fs.lstat(path.join(outputRoot, "native")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // No build outputs are fabricated by the mock; only actual static copies and identity exist.
      expect((await fs.readdir(outputRoot)).sort()).toEqual([
        "build-identity.json",
        "calculator",
        "index.html",
        "styles.css",
      ]);
      await expect(
        buildDesktopCommon({
          outputRoot,
          productionMode: true,
          publicBackend: backend,
          buildInputs: value,
        }),
      ).rejects.toThrow("empty");
      expect(mocks.build).toHaveBeenCalledTimes(3);
    });
    it("rejects arbitrary or linked output and getter options before compiling", async () => {
      const outputRoot = await ownedCommon();
      const options = {
        outputRoot,
        productionMode: true,
        publicBackend: backend,
        buildInputs: universal(),
      };
      await expect(
        buildDesktopCommon({ ...options, productionMode: false }),
      ).rejects.toThrow("require production mode");
      await expect(
        buildDesktopCommon({
          ...options,
          outputRoot: path.dirname(outputRoot),
        }),
      ).rejects.toThrow("owned run path");
      const linked = `${outputRoot}-retained`;
      await fs.rename(outputRoot, linked);
      await fs.symlink(linked, outputRoot);
      await expect(buildDesktopCommon(options)).rejects.toThrow("ancestor");
      const getter = { ...options };
      Object.defineProperty(getter, "buildInputs", {
        get() {
          throw new Error("must not call");
        },
        enumerable: true,
      });
      await expect(buildDesktopCommon(getter)).rejects.toThrow("options");
      expect(mocks.build).not.toHaveBeenCalled();
    });
    it.each(["directory", "symlink"])(
      "stops after a common %s is substituted during the first build",
      async (substitution) => {
        const outputRoot = await ownedCommon();
        const retained = `${outputRoot}-original`;
        const replacement = `${outputRoot}-replacement`;
        mocks.build.mockImplementationOnce(async () => {
          await fs.writeFile(
            path.join(outputRoot, "main.js"),
            "synthetic first build",
            { flag: "wx" },
          );
          await fs.rename(outputRoot, retained);
          if (substitution === "symlink") {
            await fs.mkdir(replacement, { mode: 0o700 });
            await fs.symlink(replacement, outputRoot);
          } else await fs.mkdir(outputRoot, { mode: 0o700 });
          return { errors: [], warnings: [] };
        });
        await expect(
          buildDesktopCommon({
            outputRoot,
            productionMode: true,
            publicBackend: backend,
            buildInputs: universal(),
          }),
        ).rejects.toThrow("ownership changed");
        expect(mocks.build).toHaveBeenCalledTimes(1);
        expect(await fs.readdir(outputRoot)).toEqual([]);
        expect(await fs.readdir(retained)).toEqual(["main.js"]);
        expect(await fs.readFile(path.join(retained, "main.js"), "utf8")).toBe(
          "synthetic first build",
        );
        expect(mocks.durable).not.toHaveBeenCalled();
        expect(mocks.aac).not.toHaveBeenCalled();
      },
    );
    it.each(["calculator", "index.html"])(
      "refuses a nested %s redirect introduced by the third build",
      async (name) => {
        const outputRoot = await ownedCommon();
        const target = `${outputRoot}-redirect-target`;
        if (name === "calculator") await fs.mkdir(target, { mode: 0o700 });
        else await fs.writeFile(target, "preserve target", { flag: "wx" });
        mocks.build.mockImplementationOnce(async () => ({
          errors: [],
          warnings: [],
        }));
        mocks.build.mockImplementationOnce(async () => ({
          errors: [],
          warnings: [],
        }));
        mocks.build.mockImplementationOnce(async () => {
          await fs.symlink(target, path.join(outputRoot, name));
          return { errors: [], warnings: [] };
        });
        await expect(
          buildDesktopCommon({
            outputRoot,
            productionMode: true,
            publicBackend: backend,
            buildInputs: universal(),
          }),
        ).rejects.toThrow("ownership changed");
        expect(mocks.build).toHaveBeenCalledTimes(3);
        await expect(
          fs.lstat(path.join(outputRoot, "build-identity.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        if (name === "calculator") expect(await fs.readdir(target)).toEqual([]);
        else expect(await fs.readFile(target, "utf8")).toBe("preserve target");
      },
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
