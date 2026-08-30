import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { waitForProcessIdentitiesToDisappear } from "./process-identity-table.mjs";

const protocolVersion = 1;
const sentinelPath = fileURLToPath(
  new URL("./isolated-process-sentinel.mjs", import.meta.url),
);
const states = Object.freeze({
  active: "ACTIVE",
  lost: "LOST",
  retired: "RETIRED",
  starting: "STARTING",
  terminating: "TERMINATING",
});

function validateTimeout(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 1;
}

function deserializeError(message, fallback) {
  const error = new Error(
    typeof message?.message === "string" ? message.message : fallback,
  );
  if (typeof message?.code === "string") {
    Object.defineProperty(error, "code", {
      configurable: true,
      enumerable: true,
      value: message.code,
    });
  }
  return error;
}

function validateRetirementIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !isSafePid(identity.processId) ||
    typeof identity.startedAt !== "string" ||
    identity.startedAt.length === 0
  ) {
    throw new Error("Sentinel supplied an invalid retirement identity");
  }
  return Object.freeze({
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

function waitForLifecycleValue({
  emitter,
  eventName,
  failure,
  failureEventName = "failure",
  read,
  timeoutMilliseconds,
  timeoutName,
}) {
  validateTimeout(timeoutMilliseconds, timeoutName);
  const current = read();
  if (current !== null) return Promise.resolve(current);
  const currentFailure = failure();
  if (currentFailure !== null) return Promise.reject(currentFailure);

  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      emitter.removeListener(eventName, handleValue);
      emitter.removeListener(failureEventName, handleFailure);
    };
    const handleValue = (value) => {
      cleanup();
      resolve(value);
    };
    const handleFailure = (error) => {
      cleanup();
      reject(error);
    };

    emitter.once(eventName, handleValue);
    emitter.once(failureEventName, handleFailure);
    timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMilliseconds);
  });
}

function createSentinelLifecycle(sentinel) {
  const stdout = sentinel.stdio[4];
  const stderr = sentinel.stdio[5];
  if (stdout === null || stderr === null) {
    throw new Error("Sentinel requires dedicated target output pipes");
  }
  const lifecycle = new EventEmitter();
  let failure = null;
  let outputFailure = null;
  let outputReceipt = null;
  let readyReceipt = null;
  let sentinelClose = null;
  let stderrOutput = "";
  let stderrEof = false;
  let stdoutOutput = "";
  let stdoutEof = false;
  let targetClose = null;
  let targetReceipt = null;
  let targetSpawn = null;
  let terminationArmed = false;
  let terminationFailure = null;
  let terminationSignaled = false;
  let terminationSnapshot = null;

  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");

  const fail = (error) => {
    if (failure !== null || targetReceipt !== null) return;
    failure = error;
    lifecycle.emit("failure", error);
  };
  const completeOutputIfReady = () => {
    if (
      outputFailure !== null ||
      outputReceipt !== null ||
      !stdoutEof ||
      !stderrEof
    ) {
      return;
    }
    outputReceipt = Object.freeze({
      output: `${stdoutOutput}${stderrOutput}`,
      stderr: stderrOutput,
      stderrEof: true,
      stdout: stdoutOutput,
      stdoutEof: true,
    });
    lifecycle.emit("output-complete", outputReceipt);
    completeTargetIfReady();
  };
  function completeTargetIfReady() {
    if (
      targetReceipt !== null ||
      targetClose === null ||
      outputReceipt === null
    ) {
      return;
    }
    targetReceipt = Object.freeze({
      ...outputReceipt,
      exitCode: targetClose.exitCode,
      signal: targetClose.signal,
    });
    lifecycle.emit("target-complete", targetReceipt);
  }
  const handleMessage = (message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      message.protocolVersion !== protocolVersion
    ) {
      return;
    }
    switch (message.type) {
      case "sentinel-ready": {
        readyReceipt = Object.freeze({ ready: true });
        lifecycle.emit("ready", readyReceipt);
        break;
      }
      case "sentinel-error":
        fail(deserializeError(message, "Sentinel failed during startup"));
        break;
      case "target-spawn":
        if (!isSafePid(message.processId)) {
          fail(new Error("Target did not provide a safe positive pid"));
          break;
        }
        targetSpawn = Object.freeze({ processId: message.processId });
        lifecycle.emit("target-spawn", targetSpawn);
        break;
      case "target-error":
        fail(deserializeError(message, "Target failed during spawn"));
        break;
      case "target-close":
        targetClose = Object.freeze({
          exitCode:
            Number.isInteger(message.exitCode) || message.exitCode === null
              ? message.exitCode
              : null,
          signal:
            typeof message.signal === "string" || message.signal === null
              ? message.signal
              : null,
        });
        completeTargetIfReady();
        break;
      case "termination-snapshot":
        try {
          if (!Array.isArray(message.recordedIdentities)) {
            throw new Error("Sentinel termination snapshot is invalid");
          }
          terminationSnapshot = Object.freeze(
            message.recordedIdentities.map(validateRetirementIdentity),
          );
          lifecycle.emit("termination-snapshot", terminationSnapshot);
        } catch (error) {
          terminationFailure = error;
          lifecycle.emit("termination-failure", error);
        }
        break;
      case "termination-armed":
        terminationArmed = true;
        lifecycle.emit("termination-armed", true);
        break;
      case "termination-signaled":
        terminationSignaled = true;
        lifecycle.emit("termination-signaled", true);
        break;
      case "termination-error":
        terminationFailure = deserializeError(
          message,
          "Sentinel termination failed",
        );
        lifecycle.emit("termination-failure", terminationFailure);
        break;
      default:
        break;
    }
  };
  const handleSentinelError = (error) => {
    fail(error);
  };
  const handleOutputError = (error) => {
    if (outputFailure !== null || outputReceipt !== null) return;
    outputFailure = error;
    fail(error);
    lifecycle.emit("output-failure", error);
  };
  const handleSentinelClose = (exitCode, signal) => {
    sentinelClose = Object.freeze({ exitCode, signal });
    if (readyReceipt === null || targetSpawn === null) {
      fail(new Error("Sentinel closed before target startup completed"));
    }
    lifecycle.emit("sentinel-close", sentinelClose);
  };

  sentinel.on("message", handleMessage);
  sentinel.once("error", handleSentinelError);
  sentinel.once("close", handleSentinelClose);
  stderr.on("data", (chunk) => {
    stderrOutput += chunk;
  });
  stderr.once("error", handleOutputError);
  stderr.once("end", () => {
    stderrEof = true;
    completeOutputIfReady();
  });
  stdout.on("data", (chunk) => {
    stdoutOutput += chunk;
  });
  stdout.once("error", handleOutputError);
  stdout.once("end", () => {
    stdoutEof = true;
    completeOutputIfReady();
  });

  const noFailure = () => null;
  return Object.freeze({
    controlConnected: () => sentinel.connected,
    failure: () => failure,
    output: () => outputReceipt?.output ?? `${stdoutOutput}${stderrOutput}`,
    send(message) {
      return new Promise((resolve, reject) => {
        if (!sentinel.connected) {
          reject(createLostError("sentinel control channel disconnected"));
          return;
        }
        try {
          sentinel.send({ protocolVersion, ...message }, (error) => {
            if (error === null || error === undefined) resolve();
            else
              reject(
                createLostError(
                  `sentinel control channel failed: ${error.message}`,
                ),
              );
          });
        } catch (error) {
          reject(
            createLostError(
              `sentinel control channel failed: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            ),
          );
        }
      });
    },
    sentinelClose: () => sentinelClose,
    targetIsRunning: () => targetSpawn !== null && targetClose === null,
    targetReceipt: () => targetReceipt,
    terminationFailure: () => terminationFailure,
    waitForClose(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "target-complete",
        failure: () => failure,
        read: () => targetReceipt,
        timeoutMilliseconds,
        timeoutName: "Target-close timeout",
      });
    },
    waitForOutput(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "output-complete",
        failure: () => outputFailure,
        failureEventName: "output-failure",
        read: () => outputReceipt,
        timeoutMilliseconds,
        timeoutName: "Target-output timeout",
      });
    },
    waitForReady(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "ready",
        failure: () => failure,
        read: () => readyReceipt,
        timeoutMilliseconds,
        timeoutName: "Sentinel-ready timeout",
      });
    },
    waitForSentinelClose(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "sentinel-close",
        failure: noFailure,
        read: () => sentinelClose,
        timeoutMilliseconds,
        timeoutName: "Sentinel-close timeout",
      });
    },
    waitForTargetSpawn(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "target-spawn",
        failure: () => failure,
        read: () => targetSpawn,
        timeoutMilliseconds,
        timeoutName: "Target-spawn timeout",
      });
    },
    waitForTerminationArmed(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "termination-armed",
        failure: () => terminationFailure,
        failureEventName: "termination-failure",
        read: () => (terminationArmed ? true : null),
        timeoutMilliseconds,
        timeoutName: "Sentinel termination-arm timeout",
      });
    },
    waitForTerminationSnapshot(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "termination-snapshot",
        failure: () => terminationFailure,
        failureEventName: "termination-failure",
        read: () => terminationSnapshot,
        timeoutMilliseconds,
        timeoutName: "Sentinel termination-snapshot timeout",
      });
    },
    waitForTerminationSignaled(timeoutMilliseconds) {
      return waitForLifecycleValue({
        emitter: lifecycle,
        eventName: "termination-signaled",
        failure: () => terminationFailure,
        failureEventName: "termination-failure",
        read: () => (terminationSignaled ? true : null),
        timeoutMilliseconds,
        timeoutName: "Sentinel termination-signal timeout",
      });
    },
  });
}

function createLostError(reason) {
  return new Error(`Isolated process containment was lost: ${reason}`);
}

function throwCombinedErrors(errors, message) {
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length === 1) throw uniqueErrors[0];
  if (uniqueErrors.length > 1) {
    throw new AggregateError(uniqueErrors, message, {
      cause: uniqueErrors[0],
    });
  }
}

export async function spawnIsolatedProcessTree(options) {
  if (process.platform === "win32") {
    throw new Error(
      "Isolated packaged-process verification requires a Windows Job Object adapter",
    );
  }

  const sentinel = spawn(process.execPath, [sentinelPath], {
    detached: true,
    env: options.environment,
    stdio: ["ignore", "ignore", "ignore", "ipc", "pipe", "pipe"],
  });
  const lifecycle = createSentinelLifecycle(sentinel);
  let state = states.starting;
  let terminationPromise = null;

  const refreshLostState = () => {
    if (
      (state === states.active || state === states.starting) &&
      (!lifecycle.controlConnected() || lifecycle.sentinelClose() !== null)
    ) {
      state = states.lost;
    }
    return state;
  };

  const retire = (terminationOptions = {}) => {
    const graceMilliseconds = terminationOptions.graceMilliseconds ?? 1_000;
    const forceMilliseconds = terminationOptions.forceMilliseconds ?? 3_000;
    validateTimeout(graceMilliseconds, "Graceful termination timeout");
    validateTimeout(forceMilliseconds, "Forced termination timeout");
    terminationPromise ??= (async () => {
      if (refreshLostState() === states.lost) {
        throw createLostError("sentinel closed before termination");
      }
      if (state !== states.active && state !== states.starting) {
        throw createLostError(`invalid state ${state}`);
      }
      state = states.terminating;
      try {
        await lifecycle.send({ graceMilliseconds, type: "terminate" });
        const observationTimeout =
          graceMilliseconds + forceMilliseconds + 2_000;
        let terminationWaitFailure = null;
        const captureTerminationFailure = (error) => {
          terminationWaitFailure ??= error;
          return null;
        };
        const [snapshot, armed, signaled, sentinelClose] = await Promise.all([
          lifecycle
            .waitForTerminationSnapshot(observationTimeout)
            .catch(captureTerminationFailure),
          lifecycle
            .waitForTerminationArmed(observationTimeout)
            .catch(captureTerminationFailure),
          lifecycle
            .waitForTerminationSignaled(observationTimeout)
            .catch(captureTerminationFailure),
          lifecycle.waitForSentinelClose(observationTimeout),
        ]);
        const retirementErrors = [];
        if (terminationWaitFailure !== null) {
          retirementErrors.push(terminationWaitFailure);
        }
        if (
          snapshot === null ||
          armed === null ||
          signaled === null ||
          sentinelClose === null
        ) {
          retirementErrors.push(
            createLostError("sentinel retirement evidence timed out"),
          );
        }
        if (
          sentinelClose !== null &&
          (sentinelClose.exitCode !== null ||
            sentinelClose.signal !== "SIGKILL")
        ) {
          retirementErrors.push(
            createLostError(
              "sentinel did not close by its armed group SIGKILL",
            ),
          );
        }
        if (lifecycle.terminationFailure() !== null) {
          retirementErrors.push(lifecycle.terminationFailure());
        }
        let identityFailure = null;
        let outputFailure = null;
        const [remainingIdentities, output] = await Promise.all([
          snapshot === null
            ? Promise.resolve(null)
            : waitForProcessIdentitiesToDisappear(
                snapshot,
                forceMilliseconds,
              ).catch((error) => {
                identityFailure = error;
                return null;
              }),
          lifecycle.waitForOutput(forceMilliseconds).catch((error) => {
            outputFailure = error;
            return null;
          }),
        ]);
        if (identityFailure !== null) {
          retirementErrors.push(identityFailure);
        }
        if (outputFailure !== null) {
          retirementErrors.push(outputFailure);
        }
        if (remainingIdentities !== null && remainingIdentities.length !== 0) {
          retirementErrors.push(
            createLostError(
              `recorded process identities survived: ${remainingIdentities
                .map((identity) => identity.processId)
                .join(",")}`,
            ),
          );
        }
        if (output === null) {
          retirementErrors.push(
            createLostError("target output pipes did not reach EOF"),
          );
        }
        throwCombinedErrors(
          retirementErrors,
          "Isolated process containment retirement could not be verified",
        );
        const close = lifecycle.targetReceipt();
        state = states.retired;
        return Object.freeze({
          close,
          forceSignalSent: true,
          gracefulSignalSent: true,
          output,
          targetOutcome:
            close === null
              ? Object.freeze({ kind: "unobserved-before-final-kill" })
              : Object.freeze({
                  exitCode: close.exitCode,
                  kind: "observed",
                  signal: close.signal,
                }),
          treeEmpty: true,
        });
      } catch (error) {
        state = states.lost;
        throw error;
      }
    })();
    return terminationPromise;
  };

  try {
    const ready = await lifecycle.waitForReady(5_000);
    if (ready === null) throw new Error("Sentinel did not become ready");
    await lifecycle.send({
      arguments: options.arguments,
      command: options.command,
      cwd: options.cwd,
      environment: options.environment,
      type: "start-target",
    });
    const targetSpawn = await lifecycle.waitForTargetSpawn(5_000);
    if (targetSpawn === null) throw new Error("Target did not finish spawning");
    state = states.active;
  } catch (error) {
    let retirementFailure = null;
    if (lifecycle.sentinelClose() === null) {
      state = states.active;
      await retire({ forceMilliseconds: 3_000, graceMilliseconds: 50 }).catch(
        (cleanupError) => {
          retirementFailure = cleanupError;
        },
      );
    } else {
      state = states.lost;
      retirementFailure = createLostError(
        "sentinel closed before startup-failure retirement",
      );
    }
    if (retirementFailure !== null) {
      throw new AggregateError(
        [error, retirementFailure],
        "Target launch failed and process containment retirement could not be verified",
        { cause: error },
      );
    }
    throw error;
  }

  return Object.freeze({
    isEmpty: () => refreshLostState() === states.retired,
    output: lifecycle.output,
    targetIsRunning: () => {
      if (refreshLostState() === states.retired) return false;
      return lifecycle.targetIsRunning();
    },
    terminate: retire,
    waitForClose: lifecycle.waitForClose,
  });
}
