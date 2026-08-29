export interface ElectronLaunchProfile {
  args: string[];
  chromiumSandbox?: false;
  env: Record<string, string>;
}

export function createElectronLaunchProfile(
  sourceEnvironment?: Readonly<Record<string, string | undefined>>,
  platform?: NodeJS.Platform,
): ElectronLaunchProfile;
