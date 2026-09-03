import {
  findProcessIdentity,
  readProcessIdentityTable,
  selectDescendantProcessIdentities,
  selectProcessGroupIdentities,
  waitForProcessIdentitiesToDisappear,
} from "./process-identity-table.mjs";

const electronApplicationCleanupStates = new WeakMap();

function retirementIdentity(identity) {
  return Object.freeze({
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

function processIdentityKey(identity) {
  return `${identity.processId}:${identity.startedAt}`;
}

function captureLiveElectronProcessIdentities(state, identities) {
  if (state.rootIdentity === null) {
    throw new Error("Electron application exited before identity refresh");
  }
  const liveRoot = findProcessIdentity(
    identities,
    state.rootIdentity.processId,
  );
  if (
    liveRoot === null ||
    liveRoot.startedAt !== state.rootIdentity.startedAt ||
    liveRoot.processGroupId !== state.rootIdentity.processGroupId
  ) {
    throw new Error("Electron application root identity changed before close");
  }
  if (liveRoot.processGroupId !== liveRoot.processId) {
    throw new Error(
      "Electron application is not the leader of an isolated process group",
    );
  }

  const snapshotIdentities = new Map();
  for (const identity of [
    ...selectDescendantProcessIdentities(identities, liveRoot),
    ...selectProcessGroupIdentities(identities, liveRoot.processGroupId),
  ]) {
    snapshotIdentities.set(processIdentityKey(identity), identity);
    state.recordedIdentities.set(
      processIdentityKey(identity),
      retirementIdentity(identity),
    );
  }
  return Object.freeze({
    processGroupId: liveRoot.processGroupId,
    processIdentities: Object.freeze(
      [...snapshotIdentities.values()].map(retirementIdentity),
    ),
    rootIdentity: retirementIdentity(liveRoot),
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
  const state = {
    child,
    cleanupPromise: null,
    recordedIdentities: new Map(),
    rootIdentity: Object.freeze({
      processGroupId: rootIdentity.processGroupId,
      processId: rootIdentity.processId,
      startedAt: rootIdentity.startedAt,
    }),
  };
  captureLiveElectronProcessIdentities(state, identities);
  electronApplicationCleanupStates.set(application, state);
}

export async function refreshElectronApplicationProcessIdentities(application) {
  await trackElectronApplicationForCooperativeCleanup(application);
  const state = electronApplicationCleanupStates.get(application);
  return captureLiveElectronProcessIdentities(
    state,
    await readProcessIdentityTable(),
  );
}

export async function closeElectronApplicationCooperatively(application) {
  await trackElectronApplicationForCooperativeCleanup(application);
  const state = electronApplicationCleanupStates.get(application);
  if (state.cleanupPromise !== null) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    const failures = [];
    if (
      state.rootIdentity !== null &&
      state.child.exitCode === null &&
      state.child.signalCode === null
    ) {
      try {
        await refreshElectronApplicationProcessIdentities(application);
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
    let identityTrackingSucceeded = false;
    registerCleanup(() =>
      identityTrackingSucceeded
        ? closeElectronApplicationCooperatively(application)
        : application.close(),
    );
    await trackElectronApplicationForCooperativeCleanup(application);
    identityTrackingSucceeded = true;
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
