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
  const expectedArgumentSwitches = [
    ...new Set(
      [...launchProfile.args, forbiddenSwitch]
        .map(normalizedSwitchName)
        .filter(
          (name) =>
            diagnosticSwitchNames.has(name) ||
            sandboxWeakeningOrInliningSwitchNames.has(name),
        ),
    ),
  ].sort();
  assert.equal(boundary.isPackaged, true);
  assert.equal(
    boundary.environmentSandboxControlPresent,
    launchProfile.env.ELECTRON_DISABLE_SANDBOX !== undefined,
  );
  assert.deepEqual(boundary.argumentSwitches, expectedArgumentSwitches);
  assert.ok(Array.isArray(boundary.commandLineSwitches));
  if (forbiddenSwitch.startsWith("--")) {
    assert.ok(
      boundary.commandLineSwitches.includes(normalizedName),
      `Electron app.commandLine did not expose ${forbiddenSwitch} in the exact packaged application`,
    );
  }
}
