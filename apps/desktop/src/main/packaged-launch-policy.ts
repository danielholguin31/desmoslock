const diagnosticSwitch =
  /^--(?:inspect(?:-brk|-port|-wait)?|remote-debugging-(?:address|pipe|port))(?:=|$)/;

export function assertPackagedLaunchArguments(
  isPackaged: boolean,
  arguments_: readonly string[],
): void {
  if (!isPackaged) return;

  if (arguments_.some((argument) => diagnosticSwitch.test(argument))) {
    throw new Error(
      "Packaged runtime forbids diagnostic command-line switches",
    );
  }
}
