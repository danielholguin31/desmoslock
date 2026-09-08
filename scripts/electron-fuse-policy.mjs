import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

const requiredDisabledFuses = Object.freeze([
  FuseV1Options.RunAsNode,
  FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  FuseV1Options.EnableNodeCliInspectArguments,
]);

export function createElectronFusePolicy(platform, architecture) {
  return {
    version: FuseVersion.V1,
    ...(platform === "darwin" && ["arm64", "universal"].includes(architecture)
      ? { resetAdHocDarwinSignature: true }
      : {}),
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  };
}

export async function hardenPackagedElectron(
  executablePath,
  platform = process.platform,
  architecture = process.arch,
) {
  await flipFuses(
    executablePath,
    createElectronFusePolicy(platform, architecture),
  );
}

export async function verifyPackagedElectronFuses(executablePath) {
  const current = await getCurrentFuseWire(executablePath);
  const observed = {};

  for (const option of requiredDisabledFuses) {
    const name = FuseV1Options[option];
    const state = current[option];
    observed[name] = FuseState[state];
    if (state !== FuseState.DISABLE) {
      throw new Error(`Packaged Electron fuse ${name} is not disabled`);
    }
  }

  return observed;
}
