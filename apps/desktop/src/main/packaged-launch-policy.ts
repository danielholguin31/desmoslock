const diagnosticSwitch =
  /^-{1,2}(?:inspect(?:-brk|-port|-wait)?|remote-debugging-(?:address|pipe|port))(?:=|$)/;
const sandboxDisablingSwitch =
  /^-{1,2}(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/;
const sandboxDisablingSwitchNames = [
  "no-sandbox",
  "disable-setuid-sandbox",
] as const;

function hasSwitch(arguments_: readonly string[], pattern: RegExp): boolean {
  return arguments_.some((argument) => pattern.test(argument.trim()));
}

export interface PackagedLaunchPolicyControls {
  readonly arguments: readonly string[];
  readonly commandLine: {
    hasSwitch(name: string): boolean;
  };
  readonly environment: {
    readonly ELECTRON_DISABLE_SANDBOX?: string;
  };
}

export function assertPackagedLaunchPolicy(
  isPackaged: boolean,
  controls: PackagedLaunchPolicyControls,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isPackaged) return;

  assertPackagedLaunchArguments(isPackaged, controls.arguments, platform);

  if (
    platform === "darwin" &&
    (controls.environment.ELECTRON_DISABLE_SANDBOX !== undefined ||
      sandboxDisablingSwitchNames.some((name) =>
        controls.commandLine.hasSwitch(name),
      ))
  ) {
    throw new Error(
      "Packaged runtime forbids sandbox-disabling launch controls",
    );
  }
}

export function assertPackagedLaunchArguments(
  isPackaged: boolean,
  arguments_: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isPackaged) return;

  if (platform === "darwin" && hasSwitch(arguments_, sandboxDisablingSwitch)) {
    throw new Error(
      "Packaged runtime forbids sandbox-disabling command-line switches",
    );
  }

  if (hasSwitch(arguments_, diagnosticSwitch)) {
    throw new Error(
      "Packaged runtime forbids diagnostic command-line switches",
    );
  }
}
