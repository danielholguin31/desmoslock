import {
  findProcessIdentity,
  readProcessIdentityTable,
  selectDescendantProcessIdentities,
  selectProcessGroupIdentities,
} from "./process-identity-table.mjs";

const electronApplicationCleanupStates = new WeakMap();
const electronRetirementObservationMilliseconds = 2_000;
const electronRetirementPollMilliseconds = 10;

function retirementIdentity(identity) {
  return Object.freeze({
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

function processIdentityKey(identity) {
  return `${identity.processId}:${identity.startedAt}`;
}

function trackedProcessIdentity(identity) {
  return Object.freeze({
    processGroupId: identity.processGroupId,
    processId: identity.processId,
    startedAt: identity.startedAt,
  });
}

function rememberProcessIdentity(state, identity) {
  const key = processIdentityKey(identity);
  const recorded = state.recordedIdentities.get(key);
  if (
    recorded !== undefined &&
    recorded.processGroupId !== identity.processGroupId
  ) {
    throw new Error(
      `Electron process identity became ambiguous: ${key} changed process groups`,
    );
  }
  state.recordedIdentities.set(key, trackedProcessIdentity(identity));
}

function findLiveRecordedIdentities(state, identities) {
  const live = [];
  for (const identity of identities) {
    const recorded = state.recordedIdentities.get(processIdentityKey(identity));
    if (recorded === undefined) continue;
    if (recorded.processGroupId !== identity.processGroupId) {
      throw new Error(
        `Electron process identity became ambiguous: ${processIdentityKey(identity)} changed process groups`,
      );
    }
    live.push(identity);
  }
  return live;
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
    rememberProcessIdentity(state, identity);
  }
  return Object.freeze({
    processGroupId: liveRoot.processGroupId,
    processIdentities: Object.freeze(
      [...snapshotIdentities.values()].map(retirementIdentity),
    ),
    rootIdentity: retirementIdentity(liveRoot),
  });
}

async function observeElectronProcessRetirement(state, closeLifecycle) {
  while (true) {
    const sampledAfterCloseSettled = closeLifecycle.settled;
    const identities = await readProcessIdentityTable();
    let liveRecordedIdentities = findLiveRecordedIdentities(state, identities);
    const processGroupIdentities = selectProcessGroupIdentities(
      identities,
      state.rootIdentity.processGroupId,
    );

    if (processGroupIdentities.length > 0) {
      const continuityAnchorPresent = processGroupIdentities.some(
        (identity) => {
          const recorded = state.recordedIdentities.get(
            processIdentityKey(identity),
          );
          return (
            recorded !== undefined &&
            recorded.processGroupId === state.rootIdentity.processGroupId
          );
        },
      );
      if (!continuityAnchorPresent) {
        throw new Error(
          "Electron process group identity became ambiguous after application close",
        );
      }
      for (const identity of processGroupIdentities) {
        rememberProcessIdentity(state, identity);
      }
      liveRecordedIdentities = findLiveRecordedIdentities(state, identities);
    }

    for (const liveIdentity of liveRecordedIdentities) {
      for (const descendant of selectDescendantProcessIdentities(
        identities,
        liveIdentity,
      )) {
        rememberProcessIdentity(state, descendant);
      }
    }
    liveRecordedIdentities = findLiveRecordedIdentities(state, identities);

    if (sampledAfterCloseSettled && closeLifecycle.settled) {
      if (
        processGroupIdentities.length === 0 &&
        liveRecordedIdentities.length === 0
      ) {
        return;
      }
      if (Date.now() >= closeLifecycle.retirementDeadline) {
        throw new Error(
          `Electron cooperative close left recorded process identities alive: ${liveRecordedIdentities
            .map(({ processId, startedAt }) => `${processId}:${startedAt}`)
            .join(", ")}`,
        );
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, electronRetirementPollMilliseconds),
    );
  }
}

export async function trackElectronApplicationForCooperativeCleanup(
  application,
) {
  if (electronApplicationCleanupStates.has(application)) return;
  const child = application.process();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("Electron application did not expose a safe process id");
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      "Electron application exited before its initial process identity capture",
    );
  }
  const identities = await readProcessIdentityTable();
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      "Electron application exited during its initial process identity capture",
    );
  }
  const rootIdentity = findProcessIdentity(identities, child.pid);
  if (rootIdentity === null) {
    throw new Error(
      "Electron application process identity is unavailable for initial capture",
    );
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
  try {
    await trackElectronApplicationForCooperativeCleanup(application);
  } catch (trackingFailure) {
    try {
      await application.close();
    } catch (closeFailure) {
      throw new AggregateError(
        [trackingFailure, closeFailure],
        "Electron identity tracking and application close both failed",
        { cause: closeFailure },
      );
    }
    throw trackingFailure;
  }
  const state = electronApplicationCleanupStates.get(application);
  if (state.cleanupPromise !== null) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    const failures = [];
    if (state.child.exitCode === null && state.child.signalCode === null) {
      try {
        await refreshElectronApplicationProcessIdentities(application);
      } catch (error) {
        failures.push(error);
      }
    }

    const closeLifecycle = {
      retirementDeadline: Number.POSITIVE_INFINITY,
      settled: false,
    };
    let retirementObservationFailure = null;
    const retirementObservation =
      state.recordedIdentities.size === 0
        ? Promise.resolve()
        : observeElectronProcessRetirement(state, closeLifecycle).catch(
            (error) => {
              retirementObservationFailure = error;
            },
          );

    try {
      if (state.child.exitCode === null && state.child.signalCode === null) {
        await application.close();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      closeLifecycle.retirementDeadline =
        Date.now() + electronRetirementObservationMilliseconds;
      closeLifecycle.settled = true;
    }

    await retirementObservation;
    if (retirementObservationFailure !== null) {
      failures.push(retirementObservationFailure);
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
    registerCleanup(() => closeElectronApplicationCooperatively(application));
    await trackElectronApplicationForCooperativeCleanup(application);
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
