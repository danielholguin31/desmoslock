const diagnosticSwitch =
  /^-{1,2}(?:inspect(?:-brk|-port|-wait)?|remote-debugging-(?:address|pipe|port))(?:=|$)/;
const diagnosticSwitchNames = [
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-wait",
  "remote-debugging-address",
  "remote-debugging-pipe",
  "remote-debugging-port",
] as const;
export const sandboxWeakeningOrInliningSwitchNames = [
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-namespace-sandbox",
  "disable-sandbox",
  "disable-seccomp-filter-sandbox",
  "disable-seccomp-sandbox",
  "disable-setuid-sandbox",
  "in-process-gpu",
  "no-zygote",
  "single-process",
] as const;
const sandboxWeakeningOrInliningSwitch = new RegExp(
  `^-{1,2}(?:${sandboxWeakeningOrInliningSwitchNames.join("|")})(?:=|$)`,
);

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

export interface PackagedLaunchPolicyBoundaryReceipt {
  readonly argumentSwitches: readonly string[];
  readonly commandLineSwitches: readonly string[];
  readonly environmentSandboxControlPresent: boolean;
  readonly isPackaged: boolean;
}

function observedArgumentSwitches(
  arguments_: readonly string[],
): readonly string[] {
  const observed = new Set<string>();
  for (const argument of arguments_) {
    const trimmed = argument.trim();
    if (
      !diagnosticSwitch.test(trimmed) &&
      !sandboxWeakeningOrInliningSwitch.test(trimmed)
    ) {
      continue;
    }
    observed.add(trimmed.replace(/^-{1,2}/, "").split("=", 1)[0] ?? trimmed);
  }
  return Object.freeze([...observed].sort());
}

export function inspectPackagedLaunchPolicyBoundary(
  isPackaged: boolean,
  controls: PackagedLaunchPolicyControls,
): PackagedLaunchPolicyBoundaryReceipt {
  const commandLineSwitches = [
    ...diagnosticSwitchNames,
    ...sandboxWeakeningOrInliningSwitchNames,
  ].filter((name) => controls.commandLine.hasSwitch(name));
  return Object.freeze({
    argumentSwitches: observedArgumentSwitches(controls.arguments),
    commandLineSwitches: Object.freeze(commandLineSwitches.sort()),
    environmentSandboxControlPresent:
      controls.environment.ELECTRON_DISABLE_SANDBOX !== undefined,
    isPackaged,
  });
}

export function assertPackagedLaunchPolicy(
  isPackaged: boolean,
  controls: PackagedLaunchPolicyControls,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isPackaged) return;

  const boundary = inspectPackagedLaunchPolicyBoundary(isPackaged, controls);

  if (
    platform === "darwin" &&
    (boundary.environmentSandboxControlPresent ||
      boundary.argumentSwitches.some((name) =>
        sandboxWeakeningOrInliningSwitchNames.includes(
          name as (typeof sandboxWeakeningOrInliningSwitchNames)[number],
        ),
      ) ||
      boundary.commandLineSwitches.some((name) =>
        sandboxWeakeningOrInliningSwitchNames.includes(
          name as (typeof sandboxWeakeningOrInliningSwitchNames)[number],
        ),
      ))
  ) {
    throw new Error(
      "Packaged runtime forbids sandbox-weakening or process-inlining launch controls",
    );
  }

  if (
    boundary.argumentSwitches.some((name) =>
      diagnosticSwitchNames.includes(
        name as (typeof diagnosticSwitchNames)[number],
      ),
    ) ||
    boundary.commandLineSwitches.some((name) =>
      diagnosticSwitchNames.includes(
        name as (typeof diagnosticSwitchNames)[number],
      ),
    )
  ) {
    throw new Error(
      "Packaged runtime forbids diagnostic command-line switches",
    );
  }
}

export function assertPackagedLaunchArguments(
  isPackaged: boolean,
  arguments_: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isPackaged) return;

  if (
    platform === "darwin" &&
    hasSwitch(arguments_, sandboxWeakeningOrInliningSwitch)
  ) {
    throw new Error(
      "Packaged runtime forbids sandbox-weakening or process-inlining command-line switches",
    );
  }

  if (hasSwitch(arguments_, diagnosticSwitch)) {
    throw new Error(
      "Packaged runtime forbids diagnostic command-line switches",
    );
  }
}
