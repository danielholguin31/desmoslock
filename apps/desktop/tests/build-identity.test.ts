import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock(
  "@desmoslock/contracts",
  async () => import("../../../packages/contracts/src/build-identity.js"),
);
import { readClientBuildIdentity } from "../src/main/build-identity.js";

afterEach(() => vi.unstubAllGlobals());
describe("main private build identity", () => {
  it("ordinary source execution has no canonical provenance", () => {
    expect(readClientBuildIdentity()).toBeNull();
  });
  it("returns a copied immutable known identity and fails closed for extra keys", () => {
    const identity = {
      schemaVersion: 1,
      sourceRepository: "danielholguin31/desmoslock",
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      packageLockSha256: "c".repeat(64),
      buildId: "d".repeat(64),
    };
    vi.stubGlobal("__DESMOSLOCK_CLIENT_BUILD_IDENTITY__", identity);
    const result = readClientBuildIdentity();
    expect(result).toEqual(identity);
    expect(result).not.toBe(identity);
    expect(Object.isFrozen(result)).toBe(true);
    vi.stubGlobal("__DESMOSLOCK_CLIENT_BUILD_IDENTITY__", {
      ...identity,
      admission: true,
    });
    expect(readClientBuildIdentity()).toBeNull();
  });
});
