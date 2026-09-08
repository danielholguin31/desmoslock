import {
  parseStudentJoinCode,
  parseStudentSessionViewState,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

export const trustedAssessmentLockChannel =
  "desmoslock:assessment:request-lock" as const;

export const studentSessionChannels = Object.freeze({
  read: "desmoslock:student:read-view",
  join: "desmoslock:student:join",
  recover: "desmoslock:student:targeted-readmission",
  retry: "desmoslock:student:retry",
  refresh: "desmoslock:student:refresh",
  forfeit: "desmoslock:student:forfeit",
  changed: "desmoslock:student:view-changed",
} as const);
export type StudentSessionRequestChannel = Exclude<
  (typeof studentSessionChannels)[keyof typeof studentSessionChannels],
  typeof studentSessionChannels.changed
>;

export type TrustedBridgeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface TrustedDesktopBridge {
  readonly requestAssessmentLock: () => Promise<TrustedBridgeResult>;
  readonly version: "2.0.0";
  readStudentSessionView(): Promise<StudentSessionViewState | null>;
  joinTest(request: {
    readonly code: string;
  }): Promise<StudentSessionViewState | null>;
  beginTargetedReadmission(request: {
    readonly code: string;
    readonly snapshotRevision: number;
  }): Promise<StudentSessionViewState | null>;
  retryStudentSession(): Promise<StudentSessionViewState | null>;
  refreshStudentSession(): Promise<StudentSessionViewState | null>;
  forfeitStudentSession(request: {
    readonly snapshotRevision: number;
  }): Promise<StudentSessionViewState | null>;
  onStudentSessionViewChanged(
    listener: (view: StudentSessionViewState) => void,
  ): () => void;
}

export type InvokeTrustedRequest = (
  channel: typeof trustedAssessmentLockChannel | StudentSessionRequestChannel,
  ...args: readonly unknown[]
) => Promise<unknown>;

function exactIntent(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Reflect.ownKeys(value);
    if (
      names.length !== keys.length ||
      names.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function parseStudentSessionIpcArguments(
  channel: StudentSessionRequestChannel,
  args: readonly unknown[],
): readonly unknown[] | null {
  if (
    channel === studentSessionChannels.read ||
    channel === studentSessionChannels.refresh ||
    channel === studentSessionChannels.retry
  )
    return args.length === 0 ? [] : null;
  if (args.length !== 1) return null;
  const keys =
    channel === studentSessionChannels.join
      ? ["code"]
      : channel === studentSessionChannels.recover
        ? ["code", "snapshotRevision"]
        : channel === studentSessionChannels.forfeit
          ? ["snapshotRevision"]
          : null;
  if (keys === null) return null;
  const request = exactIntent(args[0], keys);
  if (request === null) return null;
  if (keys.includes("code") && parseStudentJoinCode(request.code) === null)
    return null;
  if (
    keys.includes("snapshotRevision") &&
    (typeof request.snapshotRevision !== "number" ||
      !Number.isSafeInteger(request.snapshotRevision) ||
      request.snapshotRevision < 1)
  )
    return null;
  return [Object.freeze(request)];
}

function immutableStudentView(value: unknown): StudentSessionViewState | null {
  const parsed = parseStudentSessionViewState(value);
  if (parsed === null) return null;
  if (parsed.session !== null) Object.freeze(parsed.session);
  return Object.freeze(parsed);
}

function parseTrustedBridgeResult(response: unknown): TrustedBridgeResult {
  if (typeof response !== "object" || response === null) {
    return { ok: false, reason: "invalid-response" };
  }

  const keys = Object.keys(response);
  if (
    keys.length === 1 &&
    keys[0] === "ok" &&
    "ok" in response &&
    response.ok === true
  ) {
    return { ok: true };
  }

  if (
    keys.length === 2 &&
    keys.includes("ok") &&
    keys.includes("reason") &&
    "ok" in response &&
    response.ok === false &&
    "reason" in response &&
    typeof response.reason === "string"
  ) {
    return { ok: false, reason: response.reason };
  }

  return { ok: false, reason: "invalid-response" };
}

export function createTrustedDesktopBridge(
  invoke: InvokeTrustedRequest,
  watchStudentView: (listener: (view: unknown) => void) => () => void = () =>
    () =>
      undefined,
): TrustedDesktopBridge {
  async function student(
    channel: StudentSessionRequestChannel,
    args: readonly unknown[],
  ): Promise<StudentSessionViewState | null> {
    const parsed = parseStudentSessionIpcArguments(channel, args);
    if (parsed === null) return null;
    try {
      return immutableStudentView(await invoke(channel, ...parsed));
    } catch {
      return null;
    }
  }
  return Object.freeze({
    requestAssessmentLock: async () =>
      parseTrustedBridgeResult(
        await invoke(trustedAssessmentLockChannel, { intent: "engage" }),
      ),
    version: "2.0.0" as const,
    readStudentSessionView: (...args: readonly unknown[]) =>
      student(studentSessionChannels.read, args),
    joinTest: (...args: readonly unknown[]) =>
      student(studentSessionChannels.join, args),
    beginTargetedReadmission: (...args: readonly unknown[]) =>
      student(studentSessionChannels.recover, args),
    retryStudentSession: (...args: readonly unknown[]) =>
      student(studentSessionChannels.retry, args),
    refreshStudentSession: (...args: readonly unknown[]) =>
      student(studentSessionChannels.refresh, args),
    forfeitStudentSession: (...args: readonly unknown[]) =>
      student(studentSessionChannels.forfeit, args),
    onStudentSessionViewChanged(
      listener: (view: StudentSessionViewState) => void,
    ) {
      if (typeof listener !== "function") return () => undefined;
      let active = true;
      const unsubscribe = watchStudentView((value) => {
        if (!active) return;
        const parsed = immutableStudentView(value);
        if (parsed !== null) listener(parsed);
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
  });
}
