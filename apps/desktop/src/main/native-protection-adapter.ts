import { createRequire } from "node:module";
import { isPromise } from "node:util/types";

export type NativeEventType =
  "did_begin" | "failed_to_begin" | "interrupted" | "did_end";
export type NativeCode =
  | "none"
  | "native_failed_to_begin"
  | "native_interrupted"
  | "content_hide_failed";
export type NativeAssessmentEvent = {
  [T in NativeEventType]: {
    readonly type: T;
    readonly attemptId: string;
    readonly sequence: number;
    readonly code: NativeCode;
  };
}[NativeEventType];
export type ApplicationObservation =
  | { readonly status: "clear"; readonly reason: "policy_clear" }
  | { readonly status: "blocked"; readonly reason: "prohibited_application" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "observation_not_started"
        | "observation_failed"
        | "application_identity_unavailable";
    };
export interface NativeProtectionAdapter {
  inspectSupport(): {
    readonly available: boolean;
    readonly reason:
      "api_available_authorization_unverified" | "api_unavailable";
  };
  subscribe(listener: (event: NativeAssessmentEvent) => void): () => void;
  observeApplicationStatus(
    listener: (value: ApplicationObservation) => void,
  ): () => void;
  readApplicationStatus(): ApplicationObservation;
  begin(attemptId: string): void;
  requestEnd(attemptId: string): void;
  isAttemptActive(attemptId: string, sequence: number): boolean;
  disposeAfterEnd(): void;
}

export class NativeProtectionUnavailableError extends Error {
  readonly code = "NATIVE_PROTECTION_UNAVAILABLE";
  constructor() {
    super("Native protection is unavailable");
    this.name = "NativeProtectionUnavailableError";
  }
}

const methods = [
  "inspectSupport",
  "subscribe",
  "observeApplicationStatus",
  "readApplicationStatus",
  "begin",
  "requestEnd",
  "isAttemptActive",
  "disposeAfterEnd",
] as const;
type Method = (typeof methods)[number];
type NativeMethod = (...args: unknown[]) => unknown;
interface Binding {
  readonly receiver: object;
  readonly methods: Readonly<Record<Method, NativeMethod>>;
}
interface Subscription {
  closed: boolean;
  disposer: NativeMethod | null;
}
interface Attempt {
  readonly id: string;
  cancelled: boolean;
  began: boolean;
  terminal: boolean;
  last: NativeAssessmentEvent | null;
}
const unavailableSupport = Object.freeze({
  available: false,
  reason: "api_unavailable",
} as const);
const unavailableApplications: ApplicationObservation = Object.freeze({
  status: "unavailable",
  reason: "observation_failed",
});
const notObserving: ApplicationObservation = Object.freeze({
  status: "unavailable",
  reason: "observation_not_started",
});
const canonicalAttempt = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const canonicalSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const failure = () => new NativeProtectionUnavailableError();

function ownData(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw failure();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw failure();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw failure();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      throw failure();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function decodeBinding(value: unknown): Binding {
  const fields = ownData(value, methods);
  const captured = Object.create(null) as Record<Method, NativeMethod>;
  for (const method of methods) {
    if (typeof fields[method] !== "function") throw failure();
    captured[method] = fields[method] as NativeMethod;
  }
  return { receiver: value as object, methods: Object.freeze(captured) };
}
function decodeSupport(
  value: unknown,
): ReturnType<NativeProtectionAdapter["inspectSupport"]> {
  const fields = ownData(value, ["available", "reason"]);
  if (fields.available === false && fields.reason === "api_unavailable")
    return unavailableSupport;
  if (
    fields.available === true &&
    fields.reason === "api_available_authorization_unverified"
  )
    return Object.freeze({
      available: true,
      reason: "api_available_authorization_unverified",
    });
  throw failure();
}
function decodeApplications(value: unknown): ApplicationObservation {
  const fields = ownData(value, ["status", "reason"]);
  if (fields.status === "clear" && fields.reason === "policy_clear")
    return Object.freeze({ status: "clear", reason: "policy_clear" });
  if (fields.status === "blocked" && fields.reason === "prohibited_application")
    return Object.freeze({
      status: "blocked",
      reason: "prohibited_application",
    });
  if (
    fields.status === "unavailable" &&
    (fields.reason === "observation_not_started" ||
      fields.reason === "observation_failed" ||
      fields.reason === "application_identity_unavailable")
  )
    return Object.freeze({ status: "unavailable", reason: fields.reason });
  throw failure();
}
function decodeEvent(value: unknown): NativeAssessmentEvent {
  const fields = ownData(value, ["type", "attemptId", "sequence", "code"]);
  if (
    !canonicalAttempt(fields.attemptId) ||
    !canonicalSequence(fields.sequence)
  )
    throw failure();
  if (
    fields.type !== "did_begin" &&
    fields.type !== "failed_to_begin" &&
    fields.type !== "interrupted" &&
    fields.type !== "did_end"
  )
    throw failure();
  const normal =
    fields.type === "failed_to_begin"
      ? "native_failed_to_begin"
      : fields.type === "interrupted"
        ? "native_interrupted"
        : "none";
  if (
    fields.code !== normal &&
    (fields.code !== "content_hide_failed" || fields.type === "did_begin")
  )
    throw failure();
  return Object.freeze({
    type: fields.type,
    attemptId: fields.attemptId,
    sequence: fields.sequence,
    code: fields.code === normal ? normal : "content_hide_failed",
  });
}
function acknowledgment(value: unknown): void {
  if (value !== true) throw failure();
}
function packagedModule(): unknown {
  if (process.platform !== "darwin") throw failure();
  // Bundled beside dist/main.js; neither paths nor loaders are renderer inputs.
  return createRequire(import.meta.url)(
    "./native/aac-protection.node",
  ) as unknown;
}

/** Main-private factory. An injected loader is only a synthetic unit-test seam. */
export function createNativeProtectionAdapter(
  load: () => unknown = packagedModule,
): NativeProtectionAdapter {
  let loadAttempted = false;
  let binding: Binding | null = null;
  let retainedModule: unknown;
  let busy = false;
  let handlingCallback = false;
  let firstFailure: NativeProtectionUnavailableError | null = null;
  let failureVersion = 0n;
  let attempt: Attempt | null = null;
  let lifecycle: Subscription | null = null;
  let applications: Subscription | null = null;
  let cleanupNeeded = false;
  let cleanupAttempted = false;

  function poison(): void {
    firstFailure ??= failure();
    failureVersion += 1n;
    if (attempt !== null) {
      attempt.cancelled = true;
      if (!attempt.terminal && !cleanupAttempted) cleanupNeeded = true;
    }
  }
  function invoke(method: Method, args: unknown[]): unknown {
    if (binding === null) throw failure();
    return Reflect.apply(
      binding.methods[method],
      binding.receiver,
      args,
    ) as unknown;
  }
  function ensureLoaded(): void {
    if (binding !== null) return;
    if (loadAttempted) throw failure();
    loadAttempted = true; // A loader failure never permits a second owner/load.
    retainedModule = load();
    binding = decodeBinding(retainedModule);
  }
  function flushCleanup(): void {
    if (
      busy ||
      !cleanupNeeded ||
      binding === null ||
      attempt === null ||
      attempt.terminal
    )
      return;
    cleanupNeeded = false;
    cleanupAttempted = true;
    busy = true;
    try {
      acknowledgment(invoke("requestEnd", [attempt.id]));
    } catch {
      poison();
    } finally {
      busy = false;
    }
  }
  function operation<T>(body: () => T, cleanup = false): T {
    if (busy) {
      poison();
      throw failure();
    }
    if (firstFailure !== null && !cleanup) throw failure();
    const version = failureVersion;
    busy = true;
    try {
      ensureLoaded();
      if (version !== failureVersion || (!cleanup && firstFailure !== null))
        throw failure();
      const result = body();
      if (version !== failureVersion || (!cleanup && firstFailure !== null))
        throw failure();
      return result;
    } catch {
      poison();
      throw failure();
    } finally {
      busy = false;
      flushCleanup();
    }
  }
  function callback(body: () => void): void {
    if (busy || handlingCallback) {
      poison();
      flushCleanup();
      throw failure();
    }
    const version = failureVersion;
    handlingCallback = true;
    try {
      body();
      if (version !== failureVersion) throw failure();
    } catch {
      poison();
      // Throw only a local finite failure back into the real native listener;
      // its TSFN then invalidates/hides even if a consumer failed before cleanup.
      throw failure();
    } finally {
      handlingCallback = false;
      flushCleanup();
    }
  }
  function notify<T>(listener: (value: T) => void, value: T): void {
    const returned: unknown = listener(value);
    // The private subscription contract is synchronous. Consume rejected
    // asynchronous returns, but never keep native eligibility while awaiting one.
    busy = true;
    try {
      if (
        ((typeof returned === "object" && returned !== null) ||
          typeof returned === "function") &&
        (isPromise(returned) ||
          typeof Reflect.get(returned, "then") === "function")
      ) {
        const pending = Promise.resolve(returned);
        Reflect.apply(Promise.prototype.then, pending, [() => {}, () => {}]);
        throw failure();
      }
    } finally {
      busy = false;
    }
  }
  function lifecycleEvent(
    token: Subscription,
    listener: (event: NativeAssessmentEvent) => void,
    value: unknown,
  ): void {
    if (token.closed || lifecycle !== token) return;
    callback(() => {
      busy = true;
      let event: NativeAssessmentEvent;
      const version = failureVersion;
      try {
        event = decodeEvent(value);
      } finally {
        busy = false;
      }
      if (
        version !== failureVersion ||
        attempt === null ||
        event.attemptId !== attempt.id
      )
        throw failure();
      const previous = attempt.last;
      if (previous !== null && event.sequence <= previous.sequence) {
        if (
          event.sequence === previous.sequence &&
          event.type === previous.type &&
          event.code === previous.code
        )
          return;
        throw failure();
      }
      if (event.type === "did_begin") {
        if (
          firstFailure !== null ||
          attempt.cancelled ||
          attempt.began ||
          attempt.terminal
        )
          throw failure();
        attempt.began = true;
      } else {
        if (
          attempt.terminal ||
          (event.type === "failed_to_begin" && attempt.began)
        )
          throw failure();
        attempt.cancelled = true;
        if (event.type === "did_end" || event.type === "failed_to_begin")
          attempt.terminal = true;
      }
      attempt.last = event; // Reserve native observation before arbitrary listener work.
      notify(listener, event);
    });
  }
  function applicationEvent(
    token: Subscription,
    listener: (value: ApplicationObservation) => void,
    value: unknown,
  ): void {
    if (token.closed || applications !== token) return;
    callback(() => {
      busy = true;
      let observation: ApplicationObservation;
      const version = failureVersion;
      try {
        observation = decodeApplications(value);
      } finally {
        busy = false;
      }
      if (
        version !== failureVersion ||
        (firstFailure !== null && observation.status === "clear")
      )
        throw failure();
      if (observation.status !== "clear" && attempt !== null) {
        attempt.cancelled = true;
        cleanupNeeded = !attempt.terminal && !cleanupAttempted;
        flushCleanup();
      }
      notify(listener, observation);
    });
  }
  function subscribe(
    kind: "lifecycle" | "applications",
    listener:
      | ((event: NativeAssessmentEvent) => void)
      | ((value: ApplicationObservation) => void),
  ): () => void {
    if (typeof listener !== "function") throw failure();
    if ((kind === "lifecycle" ? lifecycle : applications) !== null)
      throw failure();
    const token: Subscription = { closed: false, disposer: null };
    operation(() => {
      if (kind === "lifecycle") lifecycle = token;
      else applications = token;
      const nativeListener =
        kind === "lifecycle"
          ? (value: unknown) =>
              lifecycleEvent(
                token,
                listener as (event: NativeAssessmentEvent) => void,
                value,
              )
          : (value: unknown) =>
              applicationEvent(
                token,
                listener as (value: ApplicationObservation) => void,
                value,
              );
      const result = invoke(
        kind === "lifecycle" ? "subscribe" : "observeApplicationStatus",
        [nativeListener],
      );
      if (typeof result !== "function") throw failure();
      token.disposer = result as NativeMethod; // Retain even if a synchronous callback poisoned this call.
    });
    return () => {
      if (token.closed) return;
      operation(() => {
        if (token.disposer === null) throw failure();
        const version = failureVersion;
        acknowledgment(Reflect.apply(token.disposer, undefined, []) as unknown);
        if (version !== failureVersion) throw failure();
        token.closed = true;
        if (kind === "lifecycle" && lifecycle === token) lifecycle = null;
        if (kind === "applications" && applications === token)
          applications = null;
      }, true);
    };
  }

  return Object.freeze({
    inspectSupport() {
      try {
        return operation(() => decodeSupport(invoke("inspectSupport", [])));
      } catch {
        return unavailableSupport;
      }
    },
    subscribe(listener: (event: NativeAssessmentEvent) => void) {
      return subscribe("lifecycle", listener);
    },
    observeApplicationStatus(
      listener: (value: ApplicationObservation) => void,
    ) {
      return subscribe("applications", listener);
    },
    readApplicationStatus() {
      if (firstFailure !== null) return unavailableApplications;
      if (applications === null || applications.closed) return notObserving;
      try {
        return operation(() => {
          const value = decodeApplications(invoke("readApplicationStatus", []));
          if (value.status !== "clear" && attempt !== null) {
            attempt.cancelled = true;
            cleanupNeeded = !attempt.terminal && !cleanupAttempted;
          }
          return value;
        });
      } catch {
        return unavailableApplications;
      }
    },
    begin(attemptId: string) {
      if (!canonicalAttempt(attemptId)) throw failure();
      if (attempt !== null && attempt.id !== attemptId) throw failure();
      if (
        lifecycle === null ||
        lifecycle.closed ||
        applications === null ||
        applications.closed
      )
        throw failure();
      operation(() => {
        if (attempt !== null) return; // Same retained attempt never invokes a second begin.
        attempt = {
          id: attemptId,
          cancelled: false,
          began: false,
          terminal: false,
          last: null,
        };
        cleanupAttempted = false;
        acknowledgment(invoke("begin", [attemptId]));
      });
    },
    requestEnd(attemptId: string) {
      if (!canonicalAttempt(attemptId) || attempt?.id !== attemptId)
        throw failure();
      operation(() => {
        if (attempt === null) throw failure();
        attempt.cancelled = true;
        cleanupAttempted = true;
        cleanupNeeded = false;
        acknowledgment(invoke("requestEnd", [attemptId]));
      }, true);
    },
    isAttemptActive(attemptId: string, sequence: number) {
      if (!canonicalAttempt(attemptId) || !canonicalSequence(sequence))
        return false;
      if (
        firstFailure !== null ||
        attempt?.id !== attemptId ||
        !attempt.began ||
        attempt.cancelled ||
        attempt.terminal ||
        attempt.last?.type !== "did_begin" ||
        attempt.last.sequence !== sequence
      )
        return false;
      try {
        return operation(() => {
          const result = invoke("isAttemptActive", [attemptId, sequence]);
          if (typeof result !== "boolean") throw failure();
          if (!result && attempt !== null) {
            attempt.cancelled = true;
            cleanupNeeded = !attempt.terminal && !cleanupAttempted;
          }
          return result;
        });
      } catch {
        return false;
      }
    },
    disposeAfterEnd() {
      operation(() => {
        const version = failureVersion;
        acknowledgment(invoke("disposeAfterEnd", []));
        if (version !== failureVersion) throw failure();
        if (lifecycle !== null) lifecycle.closed = true;
        if (applications !== null) applications.closed = true;
        lifecycle = null;
        applications = null;
        attempt = null;
        cleanupNeeded = false;
        cleanupAttempted = false;
      }, true);
    },
  });
}
