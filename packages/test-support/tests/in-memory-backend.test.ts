import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { createInMemoryBackend } from "../src/index.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("createInMemoryBackend", () => {
  it("replays deterministic seeded state and monotonic versions", () => {
    const backend = createInMemoryBackend([
      { id: "workspace-b", value: { name: "Beta" }, version: 4 },
      { id: "workspace-a", value: { name: "Alpha" }, version: 2 },
    ]);

    expect(backend.list()).toEqual([
      { id: "workspace-a", value: { name: "Alpha" }, version: 2 },
      { id: "workspace-b", value: { name: "Beta" }, version: 4 },
    ]);
    expect(backend.write("workspace-a", { name: "Updated" })).toEqual({
      id: "workspace-a",
      value: { name: "Updated" },
      version: 3,
    });
    expect(backend.reset()).toEqual([
      { id: "workspace-a", value: { name: "Alpha" }, version: 2 },
      { id: "workspace-b", value: { name: "Beta" }, version: 4 },
    ]);
  });

  it("refuses to initialize outside a test runtime", () => {
    process.env.NODE_ENV = "production";

    expect(() => createInMemoryBackend()).toThrow(/test runtime/);
  });

  it("refuses a package import without the test-only export condition", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import('@desmoslock/test-support')",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/test-only/);
  });

  it("allows a package import only with the test condition and test runtime", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=desmoslock-test",
        "--input-type=module",
        "--eval",
        "process.env.NODE_ENV='test'; const module = await import('@desmoslock/test-support'); module.createInMemoryBackend()",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
  });
});
