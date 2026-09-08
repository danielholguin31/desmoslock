import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalClientBuildIdentity,
  canonicalClientBuildInputs,
  canonicalClientUniversalBuildInputs,
  parseClientBuildIdentity,
  parseClientBuildInputs,
  parseClientUniversalBuildInputs,
} from "../src/build-identity.js";

const hex = (character: string, length = 64) => character.repeat(length);
const identity = {
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: hex("a", 40),
  sourceTree: hex("b", 40),
  packageLockSha256: hex("c"),
  buildId: hex("d"),
};
const inputs = {
  schemaVersion: 1,
  sourceRepository: identity.sourceRepository,
  sourceCommit: identity.sourceCommit,
  sourceTree: identity.sourceTree,
  packageLockSha256: identity.packageLockSha256,
  packageVersion: "2.0.0",
  platform: "darwin",
  architecture: "arm64",
  backendConfigurationSha256: hex("e"),
  graphingProfile: "internal-graphing-v1",
  tools: {
    node: { version: "24.20.0", sha256: hex("1") },
    npm: { version: "11.12.1", sha256: hex("2") },
    electron: { version: "43.4.1", archiveSha256: hex("3") },
    packager: { version: "19.0.1" },
    fuses: { version: "2.0.0" },
    compiler: {
      version: "Apple clang version 17.0.0 (clang-1700.6.3.2)",
      sha256: hex("4"),
    },
    sdk: { version: "26.2", buildVersion: "25C57", settingsSha256: hex("5") },
    nodeHeadersSha256: hex("6"),
  },
};

describe("client build identity", () => {
  it("copies and freezes exact identity, allowing a null prototype", () => {
    const parsed = parseClientBuildIdentity(
      Object.assign(Object.create(null), identity),
    );
    expect(parsed).toEqual(identity);
    expect(parsed).not.toBe(identity);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    null,
    [],
    { ...identity, extra: 1 },
    { ...identity, buildId: hex("0") },
    { ...identity, sourceCommit: hex("A", 40) },
    { ...identity, schemaVersion: 2 },
    { ...identity, sourceRepository: "other" },
    { ...identity, [Symbol("extra")]: 1 },
  ])("rejects noncanonical identity %#", (value) => {
    expect(parseClientBuildIdentity(value)).toBeNull();
  });
  it("rejects accessors without invoking them and handles exceptional proxies", () => {
    let reads = 0;
    const value = { ...identity };
    Object.defineProperty(value, "buildId", {
      get() {
        reads++;
        return identity.buildId;
      },
      enumerable: true,
    });
    expect(parseClientBuildIdentity(value)).toBeNull();
    expect(reads).toBe(0);
    expect(
      parseClientBuildIdentity(
        new Proxy(identity, {
          ownKeys() {
            throw new Error("synthetic");
          },
        }),
      ),
    ).toBeNull();
  });
  it("canonicalizes key order independently and never includes an artifact digest", () => {
    const reversed = Object.fromEntries(Object.entries(identity).reverse());
    expect(canonicalClientBuildIdentity(reversed)).toBe(
      canonicalClientBuildIdentity(identity),
    );
    expect(canonicalClientBuildIdentity(identity)).toBe(
      `{"buildId":"${identity.buildId}","packageLockSha256":"${identity.packageLockSha256}","schemaVersion":1,"sourceCommit":"${identity.sourceCommit}","sourceRepository":"danielholguin31/desmoslock","sourceTree":"${identity.sourceTree}"}`,
    );
    expect(
      parseClientBuildIdentity({ ...identity, artifactSha256: hex("f") }),
    ).toBeNull();
  });
});

function universalInputs() {
  const { architecture, ...common } = structuredClone(inputs);
  return {
    ...common,
    kind: "desktop-universal",
    hostArchitecture: architecture,
    tools: {
      ...common.tools,
      electron: { version: common.tools.electron.version },
      universal: { version: "3.0.6" },
      lipo: { sha256: hex("7") },
      codesign: { sha256: hex("8") },
    },
    slices: {
      arm64: {
        architecture: "arm64",
        electronArchiveSha256: hex("3"),
        deploymentTarget: "13.0",
        napiVersion: 8,
      },
      x64: {
        architecture: "x64",
        electronArchiveSha256: hex("9"),
        deploymentTarget: "13.0",
        napiVersion: 8,
      },
    },
    composition: { mergeASARs: true, nativeLayout: "fixed-addons-v1" },
  };
}

describe("universal build input canonical grammar", () => {
  it("copies every branch and retains two exact target identities", () => {
    const original = universalInputs();
    const parsed = parseClientUniversalBuildInputs(original)!;
    expect(parsed).toEqual(original);
    expect(parsed.slices.x64).not.toBe(original.slices.x64);
    expect(Object.isFrozen(parsed.tools.codesign)).toBe(true);
    expect(Object.isFrozen(parsed.slices.arm64)).toBe(true);
    expect(Object.isFrozen(parsed.composition)).toBe(true);
    original.slices.x64.electronArchiveSha256 = hex("a");
    expect(parsed.slices.x64.electronArchiveSha256).toBe(hex("9"));
    expect(parseClientBuildInputs(parsed)).toBeNull();
    expect(parseClientUniversalBuildInputs(inputs)).toBeNull();
  });

  it("uses recursively sorted compact JSON and a separate domain hash", () => {
    const original = universalInputs();
    const canonical = canonicalClientUniversalBuildInputs(original)!;
    const reversed = {
      ...Object.fromEntries(Object.entries(original).reverse()),
      tools: Object.fromEntries(Object.entries(original.tools).reverse()),
      slices: { x64: original.slices.x64, arm64: original.slices.arm64 },
    };
    expect(canonicalClientUniversalBuildInputs(reversed)).toBe(canonical);
    expect(canonical.endsWith("\n")).toBe(false);
    // Independently reproduced with Python sorted-key compact JSON and one NUL.
    expect(
      createHash("sha256")
        .update("desmoslock:universal-build:v1\0")
        .update(canonical)
        .digest("hex"),
    ).toBe("0889c7ae2aafa83beeb0159fa790881fa435b25076c6c05df4ab38d4d22d45c3");
    expect(canonical).not.toContain("buildId");
    expect(canonical).not.toContain("artifactSha256");
  });

  it.each([
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      architecture: "universal",
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      kind: "desktop-native",
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      hostArchitecture: "universal",
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      composition: { ...value.composition, mergeASARs: false },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      composition: { ...value.composition, singleArchFiles: "*.bin" },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      tools: { ...value.tools, electron: inputs.tools.electron },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      tools: { ...value.tools, lipo: { sha256: hex("0") } },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      tools: { ...value.tools, codesign: { sha256: hex("A") } },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      slices: { arm64: value.slices.arm64 },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      slices: { arm64: value.slices.x64, x64: value.slices.arm64 },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      slices: { ...value.slices, x64: { ...value.slices.x64, napiVersion: 9 } },
    }),
    (value: ReturnType<typeof universalInputs>) => ({
      ...value,
      slices: {
        ...value.slices,
        arm64: { ...value.slices.arm64, deploymentTarget: "14.0" },
      },
    }),
  ])("rejects noncanonical composition or target grammar %#", (change) => {
    expect(
      parseClientUniversalBuildInputs(change(universalInputs())),
    ).toBeNull();
  });

  it("does not call nested getters or permit symbols, sparse arrays and throwing proxies", () => {
    const value = universalInputs();
    Object.defineProperty(value.slices, "x64", {
      enumerable: true,
      get() {
        throw new Error("must not call");
      },
    });
    expect(parseClientUniversalBuildInputs(value)).toBeNull();
    expect(
      parseClientUniversalBuildInputs({
        ...universalInputs(),
        [Symbol("extra")]: 1,
      }),
    ).toBeNull();
    expect(
      parseClientUniversalBuildInputs({
        ...universalInputs(),
        slices: new Array(2),
      }),
    ).toBeNull();
    expect(
      parseClientUniversalBuildInputs(
        new Proxy(universalInputs(), {
          getOwnPropertyDescriptor() {
            throw new Error("synthetic");
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("client build input canonical grammar", () => {
  it("deep-copies/freeze inputs and hashes a deterministic UTF8 serialization", () => {
    const parsed = parseClientBuildInputs(inputs);
    expect(parsed).toEqual(inputs);
    expect(Object.isFrozen(parsed?.tools.sdk)).toBe(true);
    expect(parsed?.tools.node).not.toBe(inputs.tools.node);
    const reordered = {
      ...inputs,
      tools: Object.fromEntries(Object.entries(inputs.tools).reverse()),
    };
    expect(canonicalClientBuildInputs(reordered)).toBe(
      canonicalClientBuildInputs(inputs),
    );
    const canonical = canonicalClientBuildInputs(inputs)!;
    expect(canonical.endsWith("\n")).toBe(false);
    // Independently reproduced with Python sorted-key compact UTF-8 JSON.
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "2392d03253a7e0564798707b7801dd9f987af2ccc07125211f505c403580650a",
    );
    expect(createHash("sha256").update(canonical).digest("hex")).not.toBe(
      createHash("sha256")
        .update(canonicalClientBuildInputs({ ...inputs, architecture: "x64" })!)
        .digest("hex"),
    );
  });
  it.each([
    { ...inputs, architecture: "universal" },
    { ...inputs, packageVersion: "02.0.0" },
    { ...inputs, graphingProfile: "other" },
    {
      ...inputs,
      tools: {
        ...inputs.tools,
        node: { ...inputs.tools.node, version: "v24.20.0" },
      },
    },
    {
      ...inputs,
      tools: {
        ...inputs.tools,
        compiler: { ...inputs.tools.compiler, version: "clang\nsecret" },
      },
    },
    {
      ...inputs,
      tools: {
        ...inputs.tools,
        sdk: { ...inputs.tools.sdk, settingsSha256: hex("0") },
      },
    },
    { ...inputs, tools: { ...inputs.tools, extra: 1 } },
    { ...inputs, buildId: identity.buildId },
  ])("rejects changed or malformed grammar %#", (value) =>
    expect(parseClientBuildInputs(value)).toBeNull(),
  );
  it("rejects nested accessor and sparse/array tools", () => {
    const tools = { ...inputs.tools };
    Object.defineProperty(tools, "node", {
      get() {
        throw new Error("must not call");
      },
      enumerable: true,
    });
    expect(parseClientBuildInputs({ ...inputs, tools })).toBeNull();
    expect(
      parseClientBuildInputs({ ...inputs, tools: [inputs.tools] }),
    ).toBeNull();
  });
});
