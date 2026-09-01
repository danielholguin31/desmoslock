import {
  findProcessIdentity,
  readProcessIdentityTable,
  selectDescendantProcessIdentities,
  waitForProcessIdentitiesToDisappear,
} from "./process-identity-table.mjs";

const electronApplicationCleanupStates = new WeakMap();

function retirementIdentity(identity) {
  return Object.freeze({
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

export async function trackElectronApplicationForCooperativeCleanup(
  application,
) {
  if (electronApplicationCleanupStates.has(application)) return;
  const child = application.process();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("Electron application did not expose a safe process id");
  }
  const identities = await readProcessIdentityTable();
  const rootIdentity = findProcessIdentity(identities, child.pid);
  if (rootIdentity === null) {
    if (child.exitCode !== null || child.signalCode !== null) {
      electronApplicationCleanupStates.set(application, {
        child,
        cleanupPromise: null,
        recordedIdentities: new Map(),
        rootIdentity: null,
      });
      return;
    }
    throw new Error("Electron application process identity is unavailable");
  }
  const recordedIdentities = new Map();
  for (const identity of selectDescendantProcessIdentities(
    identities,
    rootIdentity,
  )) {
    recordedIdentities.set(
      `${identity.processId}:${identity.startedAt}`,
      retirementIdentity(identity),
    );
  }
  electronApplicationCleanupStates.set(application, {
    child,
    cleanupPromise: null,
    recordedIdentities,
    rootIdentity: retirementIdentity(rootIdentity),
  });
}

export async function closeElectronApplicationCooperatively(application) {
  await trackElectronApplicationForCooperativeCleanup(application);
  const state = electronApplicationCleanupStates.get(application);
  if (state.cleanupPromise !== null) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    const failures = [];
    if (state.rootIdentity !== null) {
      try {
        const identities = await readProcessIdentityTable();
        for (const identity of selectDescendantProcessIdentities(
          identities,
          state.rootIdentity,
        )) {
          state.recordedIdentities.set(
            `${identity.processId}:${identity.startedAt}`,
            retirementIdentity(identity),
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (state.child.exitCode === null && state.child.signalCode === null) {
      try {
        await application.close();
      } catch (error) {
        failures.push(error);
      }
    }

    if (state.recordedIdentities.size > 0) {
      try {
        const remaining = await waitForProcessIdentitiesToDisappear(
          [...state.recordedIdentities.values()],
          2_000,
        );
        if (remaining.length > 0) {
          throw new Error(
            `Electron cooperative close left recorded process identities alive: ${remaining
              .map(({ processId, startedAt }) => `${processId}:${startedAt}`)
              .join(", ")}`,
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Electron application cooperative cleanup failed",
      );
    }
  })();
  return state.cleanupPromise;
}

export async function acquireWithLocalCleanup(acquire) {
  const cleanupTasks = [];
  try {
    return await acquire((cleanup) => cleanupTasks.push(cleanup));
  } catch (error) {
    try {
      await runIndependentCleanupTasks([...cleanupTasks].reverse());
    } catch (cleanupError) {
      const cleanupErrors =
        cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Resource acquisition and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function acquireReadyElectronApplication({ launch, ready }) {
  return acquireWithLocalCleanup(async (registerCleanup) => {
    const application = await launch();
    registerCleanup(() => application.close());
    await ready(application);
    return application;
  });
}

export function waitForResourceAcquisition(resource, start) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      resource.removeListener("error", handleError);
      resource.removeListener("listening", handleListening);
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const handleListening = () => {
      cleanup();
      resolve();
    };

    resource.once("error", handleError);
    resource.once("listening", handleListening);
    try {
      start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function runIndependentCleanupTasks(cleanupTasks) {
  const errors = [];
  for (const cleanup of cleanupTasks) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Production desktop cleanup failed");
  }
}

export async function runWithFinalizer(
  operation,
  finalizer,
  combinedFailureMessage = "Operation and finalizer both failed",
) {
  let operationFailed = false;
  let operationFailure;
  let operationResult;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  let finalizerResult;
  try {
    finalizerResult = await finalizer();
  } catch (finalizerFailure) {
    if (!operationFailed) throw finalizerFailure;
    const finalizerErrors =
      finalizerFailure instanceof AggregateError
        ? finalizerFailure.errors
        : [finalizerFailure];
    throw new AggregateError(
      [operationFailure, ...finalizerErrors],
      combinedFailureMessage,
      { cause: finalizerFailure },
    );
  }

  if (operationFailed) throw operationFailure;
  return Object.freeze({ finalizerResult, operationResult });
}

export async function runWithIndependentCleanup(operation, cleanupTasks) {
  const { operationResult } = await runWithFinalizer(
    operation,
    () => runIndependentCleanupTasks(cleanupTasks),
    "Production desktop verification and cleanup both failed",
  );
  return operationResult;
}
