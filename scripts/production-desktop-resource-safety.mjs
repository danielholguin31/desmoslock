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
