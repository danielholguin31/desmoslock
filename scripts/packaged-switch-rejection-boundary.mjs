import assert from "node:assert/strict";

const diagnosticSwitchNames = new Set([
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-wait",
  "remote-debugging-address",
  "remote-debugging-pipe",
  "remote-debugging-port",
]);
const sandboxWeakeningOrInliningSwitchNames = new Set([
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
]);

const connectionAllowlistDisablingSwitchName = "disable-features";
const disableFeaturesSwitch = /^-{1,2}disable-features(?:=(.*))?$/i;

function namesConnectionAllowlistFeature(featureList) {
  return featureList.toLowerCase().includes("connectionallowlist");
}

function argumentsDisableConnectionAllowlists(arguments_) {
  return arguments_.some((argument, index) => {
    const match = disableFeaturesSwitch.exec(argument.trim());
    if (match === null) return false;
    const inlineValue = match[1] ?? "";
    return (
      namesConnectionAllowlistFeature(inlineValue) ||
      (inlineValue.trim() === "" &&
        namesConnectionAllowlistFeature(arguments_[index + 1] ?? ""))
    );
  });
}

function normalizedSwitchName(argument) {
  return argument
    .trim()
    .replace(/^-{1,2}/, "")
    .split("=", 1)[0];
}

export function assertPackagedSwitchRejectionBoundary({
  boundary,
  forbiddenSwitch,
  launchProfile,
}) {
  const normalizedName = normalizedSwitchName(forbiddenSwitch);
  const launchArguments = [...launchProfile.args, forbiddenSwitch];
  const expectedArgumentSwitches = [
    ...new Set([
      ...launchArguments
        .map(normalizedSwitchName)
        .filter(
          (name) =>
            diagnosticSwitchNames.has(name) ||
            sandboxWeakeningOrInliningSwitchNames.has(name),
        ),
      ...(argumentsDisableConnectionAllowlists(launchArguments)
        ? [connectionAllowlistDisablingSwitchName]
        : []),
    ]),
  ].sort();
  assert.equal(boundary.isPackaged, true);
  assert.equal(
    boundary.environmentSandboxControlPresent,
    launchProfile.env.ELECTRON_DISABLE_SANDBOX !== undefined,
  );
  assert.deepEqual(boundary.argumentSwitches, expectedArgumentSwitches);
  assert.ok(Array.isArray(boundary.commandLineSwitches));
  const allowedCommandLineSwitches = new Set(expectedArgumentSwitches);
  if (launchProfile.env.ELECTRON_DISABLE_SANDBOX !== undefined) {
    allowedCommandLineSwitches.add("no-sandbox");
  }
  assert.ok(
    boundary.commandLineSwitches.every((name) =>
      allowedCommandLineSwitches.has(name),
    ),
    "Electron app.commandLine exposed a launch control outside the curated rejection probe",
  );
  if (forbiddenSwitch.startsWith("--")) {
    assert.ok(
      boundary.commandLineSwitches.includes(normalizedName),
      `Electron app.commandLine did not expose ${forbiddenSwitch} in the exact packaged application`,
    );
  }
}
