import type { EventEmitter } from "node:events";

export type CleanupTask = () => Promise<unknown> | unknown;

export function acquireWithLocalCleanup<Result>(
  acquire: (
    registerCleanup: (cleanup: CleanupTask) => void,
  ) => Promise<Result> | Result,
): Promise<Result>;

export function acquireReadyElectronApplication<
  Application extends { close(): Promise<unknown> | unknown },
>(options: {
  launch(): Promise<Application> | Application;
  ready(application: Application): Promise<unknown> | unknown;
}): Promise<Application>;

export function waitForResourceAcquisition(
  resource: EventEmitter,
  start: () => unknown,
): Promise<void>;

export function runIndependentCleanupTasks(
  cleanupTasks: readonly CleanupTask[],
): Promise<void>;

export function runWithFinalizer<OperationResult, FinalizerResult>(
  operation: () => Promise<OperationResult> | OperationResult,
  finalizer: () => Promise<FinalizerResult> | FinalizerResult,
  combinedFailureMessage?: string,
): Promise<
  Readonly<{
    finalizerResult: FinalizerResult;
    operationResult: OperationResult;
  }>
>;

export function runWithIndependentCleanup<Result>(
  operation: () => Promise<Result> | Result,
  cleanupTasks: readonly CleanupTask[],
): Promise<Result>;
