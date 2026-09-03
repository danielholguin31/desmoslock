import type { ElectronLaunchProfile } from "./electron-launch-profile.mjs";

export interface PackagedSwitchRejectionBoundary {
  readonly argumentSwitches: readonly string[];
  readonly commandLineSwitches: readonly string[];
  readonly environmentSandboxControlPresent: boolean;
  readonly isPackaged: boolean;
}

export function assertPackagedSwitchRejectionBoundary(options: {
  readonly boundary: PackagedSwitchRejectionBoundary;
  readonly forbiddenSwitch: string;
  readonly launchProfile: ElectronLaunchProfile;
}): void;
