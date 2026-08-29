import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

function validateTimeout(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function groupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw error;
  }
}

function signalGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function waitForGroupToEmpty(processGroupId, timeoutMilliseconds) {
  validateTimeout(timeoutMilliseconds, "Process-group timeout");
  const deadline = Date.now() + timeoutMilliseconds;
  while (groupExists(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !groupExists(processGroupId);
}

function createCapturedLifecycle(child) {
  if (child.stdout === null || child.stderr === null) {
    throw new Error("Isolated process tree requires piped stdout and stderr");
  }

  const lifecycle = new EventEmitter();
  let closeResult = null;
  let failure = null;
  let receipt = null;
  let stderr = "";
  let stderrEof = false;
  let stdout = "";
  let stdoutEof = false;

  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");

  const cleanupCaptureListeners = () => {
    child.removeListener("close", handleClose);
    child.removeListener("error", handleFailure);
    child.stderr.removeListener("data", handleStderr);
    child.stderr.removeListener("end", handleStderrEof);
    child.stderr.removeListener("error", handleFailure);
    child.stdout.removeListener("data", handleStdout);
    child.stdout.removeListener("end", handleStdoutEof);
    child.stdout.removeListener("error", handleFailure);
  };
  const completeIfReady = () => {
    if (
      receipt !== null ||
      failure !== null ||
      closeResult === null ||
      !stderrEof ||
      !stdoutEof
    ) {
      return;
    }
    receipt = Object.freeze({
      exitCode: closeResult.exitCode,
      output: `${stdout}${stderr}`,
      signal: closeResult.signal,
      stderr,
      stderrEof,
      stdout,
      stdoutEof,
    });
    cleanupCaptureListeners();
    lifecycle.emit("complete", receipt);
  };
  function handleClose(exitCode, signal) {
    closeResult = { exitCode, signal };
    completeIfReady();
  }
  function handleFailure(error) {
    if (receipt !== null || failure !== null) return;
    failure = error;
    cleanupCaptureListeners();
    lifecycle.emit("failure", error);
  }
  function handleStderr(chunk) {
    stderr += chunk;
  }
  function handleStderrEof() {
    stderrEof = true;
    completeIfReady();
  }
  function handleStdout(chunk) {
    stdout += chunk;
  }
  function handleStdoutEof() {
    stdoutEof = true;
    completeIfReady();
  }

  child.once("close", handleClose);
  child.once("error", handleFailure);
  child.stderr.on("data", handleStderr);
  child.stderr.once("end", handleStderrEof);
  child.stderr.once("error", handleFailure);
  child.stdout.on("data", handleStdout);
  child.stdout.once("end", handleStdoutEof);
  child.stdout.once("error", handleFailure);

  return Object.freeze({
    output() {
      return receipt?.output ?? `${stdout}${stderr}`;
    },
    waitForClose(timeoutMilliseconds) {
      validateTimeout(timeoutMilliseconds, "Process-close timeout");
      if (receipt !== null) return Promise.resolve(receipt);
      if (failure !== null) return Promise.reject(failure);

      return new Promise((resolve, reject) => {
        let timeout;
        const cleanupWaitListeners = () => {
          clearTimeout(timeout);
          lifecycle.removeListener("complete", handleComplete);
          lifecycle.removeListener("failure", handleWaitFailure);
        };
        const handleComplete = (result) => {
          cleanupWaitListeners();
          resolve(result);
        };
        const handleWaitFailure = (error) => {
          cleanupWaitListeners();
          reject(error);
        };

        lifecycle.once("complete", handleComplete);
        lifecycle.once("failure", handleWaitFailure);
        timeout = setTimeout(() => {
          cleanupWaitListeners();
          resolve(null);
        }, timeoutMilliseconds);
      });
    },
  });
}

export function spawnIsolatedProcessTree(options) {
  if (process.platform === "win32") {
    throw new Error(
      "Isolated packaged-process verification requires a Windows Job Object adapter",
    );
  }

  const child = spawn(options.command, options.arguments, {
    cwd: options.cwd,
    detached: true,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    child.kill("SIGKILL");
    throw new Error("Isolated process tree did not receive a safe group id");
  }

  const processGroupId = child.pid;
  const captured = createCapturedLifecycle(child);
  let terminationPromise = null;

  const terminate = (terminationOptions = {}) => {
    const graceMilliseconds = terminationOptions.graceMilliseconds ?? 1_000;
    const forceMilliseconds = terminationOptions.forceMilliseconds ?? 3_000;
    validateTimeout(graceMilliseconds, "Graceful termination timeout");
    validateTimeout(forceMilliseconds, "Forced termination timeout");

    terminationPromise ??= (async () => {
      let forceSignalSent = false;
      let gracefulSignalSent = false;

      if (groupExists(processGroupId)) {
        gracefulSignalSent = signalGroup(processGroupId, "SIGTERM");
      }
      let treeEmpty = await waitForGroupToEmpty(
        processGroupId,
        graceMilliseconds,
      );
      if (!treeEmpty) {
        forceSignalSent = signalGroup(processGroupId, "SIGKILL");
        treeEmpty = await waitForGroupToEmpty(
          processGroupId,
          forceMilliseconds,
        );
      }

      const close = await captured.waitForClose(forceMilliseconds);
      treeEmpty &&= !groupExists(processGroupId);
      if (!treeEmpty || close === null) {
        throw new Error(
          `Isolated process tree ${processGroupId} did not fully close`,
        );
      }

      return Object.freeze({
        close,
        forceSignalSent,
        gracefulSignalSent,
        treeEmpty,
      });
    })();
    return terminationPromise;
  };

  return Object.freeze({
    isEmpty: () => !groupExists(processGroupId),
    leaderIsRunning: () => child.exitCode === null && child.signalCode === null,
    output: captured.output,
    pid: processGroupId,
    terminate,
    waitForClose: captured.waitForClose,
  });
}
