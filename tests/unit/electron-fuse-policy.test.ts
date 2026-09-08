import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it } from "vitest";

import { createElectronFusePolicy } from "../../scripts/electron-fuse-policy.mjs";

describe("packaged Electron fuse policy", () => {
  it("disables runtime-as-Node and both Node diagnostic inputs", () => {
    expect(createElectronFusePolicy("linux", "x64")).toEqual({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    });
  });

  it("requests a fresh ad-hoc signature after changing an Apple Silicon binary", () => {
    expect(createElectronFusePolicy("darwin", "arm64")).toEqual({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    });
  });

  it("does not alter signing metadata on Intel macOS", () => {
    expect(createElectronFusePolicy("darwin", "x64")).not.toHaveProperty(
      "resetAdHocDarwinSignature",
    );
  });

  it("requests local ad-hoc repair for both slices of a universal app", () => {
    expect(createElectronFusePolicy("darwin", "universal")).toEqual(
      createElectronFusePolicy("darwin", "arm64"),
    );
  });
});
