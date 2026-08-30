const diagnosticSwitch =
  /^-{1,2}(?:inspect(?:-brk|-port|-wait)?|remote-debugging-(?:address|pipe|port))(?:=|$)/;
const sandboxDisablingSwitch =
  /^-{1,2}(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/;

function hasSwitch(arguments_: readonly string[], pattern: RegExp): boolean {
  return arguments_.some((argument) => pattern.test(argument.trim()));
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
