import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  findProcessIdentity,
  readProcessIdentityTable,
  selectDescendantProcessIdentities,
  selectProcessGroupIdentities,
} from "./process-identity-table.mjs";

const targetStdoutFileDescriptor = 4;
const targetStderrFileDescriptor = 5;
const protocolVersion = 1;
const terminationProtocolTimeoutMilliseconds = 2_000;
const states = Object.freeze({
  active: "ACTIVE",
  starting: "STARTING",
  terminating: "TERMINATING",
});
const targetStates = Object.freeze({
  idle: "IDLE",
  running: "RUNNING",
  starting: "STARTING",
  terminal: "TERMINAL",
});

let canary = null;
let finalKillArmed = false;
let finalKillDeadline = null;
let finalKillTimer = null;
const observedTargetIdentities = new Map();
let outputFileDescriptorsClosed = false;
let sendQueue = Promise.resolve();
let state = states.starting;
let startupCanaryIdentity = null;
let startupSentinelIdentity = null;
let target = null;
let targetObservationEnabled = false;
let targetObservationFailure = null;
let targetObservationPromise = Promise.resolve();
let targetObservationTimer = null;
let targetState = targetStates.idle;

process.on("SIGTERM", () => {
  // The sentinel must remain alive until its already-armed group SIGKILL fires.
});

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 1;
}

function validateSentinelTopology(sentinelIdentity, canaryIdentity) {
  if (
    sentinelIdentity.processId !== process.pid ||
    sentinelIdentity.processGroupId !== process.pid ||
    canaryIdentity.parentPid !== process.pid ||
    canaryIdentity.processGroupId !== process.pid
  ) {
    throw new Error("Sentinel process-group topology attestation failed");
  }
}

function closeTargetOutputFileDescriptors() {
  if (outputFileDescriptorsClosed) return;
  outputFileDescriptorsClosed = true;
  for (const fileDescriptor of [
    targetStdoutFileDescriptor,
    targetStderrFileDescriptor,
  ]) {
    try {
      fs.closeSync(fileDescriptor);
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EBADF"
      ) {
        throw error;
      }
    }
  }
}

function serializeError(error) {
  return {
    code:
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : null,
    message:
      error instanceof Error ? error.message : "Unknown sentinel process error",
  };
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) {
      reject(new Error("Sentinel control channel is disconnected"));
      return;
    }
    process.send(message, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function queueMessage(message) {
  const delivery = sendQueue.then(() =>
    sendMessage({ protocolVersion, ...message }),
  );
  sendQueue = delivery.catch(() => undefined);
  return delivery;
}

function sendBestEffort(message) {
  void queueMessage(message).catch(() => undefined);
}

function armFinalKill(delayMilliseconds) {
  const deadline = Date.now() + delayMilliseconds;
  if (finalKillDeadline !== null && finalKillDeadline <= deadline) return;
  clearTimeout(finalKillTimer);
  finalKillArmed = true;
  finalKillDeadline = deadline;
  finalKillTimer = setTimeout(() => {
    process.kill(0, "SIGKILL");
  }, delayMilliseconds);
}

function beginFailClosedShutdown() {
  state = states.terminating;
  armFinalKill(0);
  try {
    process.kill(0, "SIGTERM");
  } catch {
    // The armed self-inclusive SIGKILL remains the fail-closed finalizer.
  }
}

function validateTargetStart(message) {
  if (
    message === null ||
    typeof message !== "object" ||
    message.protocolVersion !== protocolVersion ||
    message.type !== "start-target" ||
    typeof message.command !== "string" ||
    !Array.isArray(message.arguments) ||
    !message.arguments.every((argument) => typeof argument === "string") ||
    typeof message.cwd !== "string" ||
    message.environment === null ||
    typeof message.environment !== "object" ||
    Array.isArray(message.environment) ||
    !Object.values(message.environment).every(
      (value) => typeof value === "string",
    )
  ) {
    throw new Error("Sentinel received an invalid target launch request");
  }
  return message;
}

function stopTargetObservation() {
  targetObservationEnabled = false;
  clearTimeout(targetObservationTimer);
  targetObservationTimer = null;
}

function rememberTargetIdentities(identities) {
  for (const identity of identities) {
    observedTargetIdentities.set(
      `${identity.processId}:${identity.startedAt}`,
      identity,
    );
  }
}

async function observeTargetTree() {
  if (target === null || !isSafePid(target.pid)) return;
  const identities = await readProcessIdentityTable();
  rememberTargetIdentities(
    selectDescendantProcessIdentities(identities, target.pid),
  );
}

function scheduleTargetObservation() {
  if (!targetObservationEnabled || targetState !== targetStates.running) return;
  targetObservationPromise = observeTargetTree()
    .catch((error) => {
      targetObservationFailure ??= error;
    })
    .finally(() => {
      if (targetObservationEnabled && targetState === targetStates.running) {
        targetObservationTimer = setTimeout(scheduleTargetObservation, 50);
      }
    });
}

function emitTargetError(error) {
  if (targetState === targetStates.terminal) return;
  targetState = targetStates.terminal;
  stopTargetObservation();
  sendBestEffort({ type: "target-error", ...serializeError(error) });
}

function startTarget(message) {
  if (state !== states.active || targetState !== targetStates.idle) {
    throw new Error("Sentinel accepts exactly one target launch");
  }
  targetState = targetStates.starting;
  let launch;
  try {
    launch = validateTargetStart(message);
  } catch (error) {
    emitTargetError(error);
    return;
  }
  try {
    target = spawn(launch.command, launch.arguments, {
      cwd: launch.cwd,
      detached: false,
      env: launch.environment,
      stdio: ["ignore", targetStdoutFileDescriptor, targetStderrFileDescriptor],
    });
  } catch (error) {
    closeTargetOutputFileDescriptors();
    emitTargetError(error);
    return;
  }
  closeTargetOutputFileDescriptors();
  target.once("spawn", () => {
    if (!isSafePid(target.pid)) {
      emitTargetError(
        Object.assign(new Error("Target spawned without a safe positive pid"), {
          code: "INVALID_PID",
        }),
      );
      return;
    }
    targetState = targetStates.running;
    targetObservationEnabled = true;
    scheduleTargetObservation();
    sendBestEffort({ processId: target.pid, type: "target-spawn" });
  });
  target.once("error", (error) => {
    emitTargetError(error);
  });
  target.once("close", (exitCode, signal) => {
    if (targetState === targetStates.terminal) return;
    targetState = targetStates.terminal;
    stopTargetObservation();
    sendBestEffort({ exitCode, signal, type: "target-close" });
  });
}

function uniqueIdentities(identities) {
  const unique = new Map();
  for (const identity of identities) {
    unique.set(`${identity.processId}:${identity.startedAt}`, identity);
  }
  return [...unique.values()];
}

function toRetirementIdentity(identity) {
  return Object.freeze({
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

async function beginTermination(message) {
  if (state !== states.active) return;
  state = states.terminating;
  const graceMilliseconds = message?.graceMilliseconds;
  if (!Number.isFinite(graceMilliseconds) || graceMilliseconds < 0) {
    throw new Error(
      "Sentinel termination grace must be non-negative and finite",
    );
  }

  stopTargetObservation();
  await targetObservationPromise;
  if (targetObservationFailure !== null) {
    throw targetObservationFailure;
  }

  const identities = await readProcessIdentityTable();
  const sentinelIdentity = findProcessIdentity(identities, process.pid);
  const canaryIdentity = findProcessIdentity(identities, canary.pid);
  if (sentinelIdentity === null || canaryIdentity === null) {
    throw new Error("Sentinel could not attest its own process identities");
  }
  validateSentinelTopology(sentinelIdentity, canaryIdentity);
  if (
    sentinelIdentity.startedAt !== startupSentinelIdentity.startedAt ||
    canaryIdentity.startedAt !== startupCanaryIdentity.startedAt
  ) {
    throw new Error("Sentinel process identities changed before retirement");
  }
  const targetIdentities =
    target !== null && isSafePid(target.pid)
      ? selectDescendantProcessIdentities(identities, target.pid)
      : [];
  const groupIdentities = selectProcessGroupIdentities(identities, process.pid);
  const recordedIdentities = uniqueIdentities([
    sentinelIdentity,
    canaryIdentity,
    ...observedTargetIdentities.values(),
    ...groupIdentities,
    ...targetIdentities,
  ]).map(toRetirementIdentity);

  await queueMessage({ recordedIdentities, type: "termination-snapshot" });
  armFinalKill(graceMilliseconds + terminationProtocolTimeoutMilliseconds);
  const armedDelivery = queueMessage({ type: "termination-armed" });
  process.kill(0, "SIGTERM");
  const signaledDelivery = queueMessage({ type: "termination-signaled" });
  await armedDelivery;
  await signaledDelivery;
  armFinalKill(graceMilliseconds);
}

async function createCanary() {
  const canarySource = [
    'process.on("SIGTERM", () => {});',
    'process.send?.({ type: "canary-ready" });',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", canarySource],
    {
      detached: false,
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Sentinel canary did not become ready"));
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", handleError);
      child.removeListener("message", handleMessage);
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const handleMessage = (message) => {
      if (message?.type !== "canary-ready") return;
      cleanup();
      resolve();
    };
    child.once("error", handleError);
    child.on("message", handleMessage);
  });
  if (!isSafePid(child.pid)) {
    throw new Error("Sentinel canary did not receive a safe positive pid");
  }
  return child;
}

async function startSentinel() {
  canary = await createCanary();
  const identities = await readProcessIdentityTable();
  const sentinelIdentity = findProcessIdentity(identities, process.pid);
  const canaryIdentity = findProcessIdentity(identities, canary.pid);
  if (sentinelIdentity === null || canaryIdentity === null) {
    throw new Error("Sentinel startup identity attestation failed");
  }
  validateSentinelTopology(sentinelIdentity, canaryIdentity);
  startupSentinelIdentity = sentinelIdentity;
  startupCanaryIdentity = canaryIdentity;
  state = states.active;
  process.on("message", (message) => {
    if (message?.protocolVersion !== protocolVersion) return;
    if (message?.type === "start-target") {
      try {
        startTarget(message);
      } catch (error) {
        beginFailClosedShutdown();
        sendBestEffort({ type: "sentinel-error", ...serializeError(error) });
      }
      return;
    }
    if (message?.type === "terminate") {
      void beginTermination(message).catch(async (error) => {
        beginFailClosedShutdown();
        await queueMessage({
          type: "termination-error",
          ...serializeError(error),
        }).catch(() => undefined);
      });
    }
  });
  await queueMessage({ type: "sentinel-ready" });
}

void startSentinel().catch(async (error) => {
  closeTargetOutputFileDescriptors();
  beginFailClosedShutdown();
  await queueMessage({
    type: "sentinel-error",
    ...serializeError(error),
  }).catch(() => undefined);
});

process.once("disconnect", () => {
  if (finalKillArmed) return;
  beginFailClosedShutdown();
});
