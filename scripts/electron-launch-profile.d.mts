export interface ElectronLaunchProfile {
  args: string[];
  /** Present only for the non-release Linux compatibility profile. */
  chromiumSandbox?: false;
  env: Record<string, string>;
}

export function createElectronLaunchProfile(
  sourceEnvironment?: Readonly<Record<string, string | undefined>>,
  platform?: NodeJS.Platform,
): ElectronLaunchProfile;
