import type { LockState, TestLifecycle } from "@desmoslock/domain";

export interface PrivilegedCaller {
  readonly frameProcessId: number;
  readonly frameRoutingId: number;
  readonly isMainFrame: boolean;
  readonly url: string;
  readonly webContentsId: number;
}

export interface TrustedCallerRegistration {
  readonly generation: string;
  readonly mainFrameProcessId: number;
  readonly mainFrameRoutingId: number;
  readonly trustedUrl: string;
  readonly webContentsId: number;
}

export interface PrivilegedRequestState {
  readonly generation: string;
  readonly lockState: LockState;
  readonly testLifecycle: TestLifecycle;
}

export interface LockIntentRequest {
  readonly intent: "engage";
}

export type PrivilegedRequestResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface PrivilegedRequestRouter {
  registerTrustedCaller(registration: TrustedCallerRegistration): void;
  requestLock(
    caller: PrivilegedCaller,
    request: unknown,
  ): Promise<PrivilegedRequestResult>;
  revokeTrustedCaller(webContentsId: number): void;
}

export interface PrivilegedRequestRouterOptions {
  readonly engageLock: (webContentsId: number) => Promise<void>;
  readonly readState: (
    webContentsId: number,
  ) => PrivilegedRequestState | undefined;
}

function isLockIntentRequest(request: unknown): request is LockIntentRequest {
  if (typeof request !== "object" || request === null) return false;

  const keys = Object.keys(request);
  return (
    keys.length === 1 &&
    keys[0] === "intent" &&
    Reflect.get(request, "intent") === "engage"
  );
}

export function createPrivilegedRequestRouter(
  options: PrivilegedRequestRouterOptions,
): PrivilegedRequestRouter {
  const callers = new Map<number, TrustedCallerRegistration>();
  let lockRequestInFlight = false;

  return {
    registerTrustedCaller(registration) {
      callers.set(registration.webContentsId, { ...registration });
    },
    async requestLock(caller, request) {
      const registration = callers.get(caller.webContentsId);
      if (
        registration === undefined ||
        !caller.isMainFrame ||
        caller.frameProcessId !== registration.mainFrameProcessId ||
        caller.frameRoutingId !== registration.mainFrameRoutingId ||
        caller.url !== registration.trustedUrl
      ) {
        return { ok: false, reason: "untrusted-caller" };
      }

      if (!isLockIntentRequest(request)) {
        return { ok: false, reason: "invalid-request" };
      }

      const state = options.readState(caller.webContentsId);
      if (
        state === undefined ||
        state.generation !== registration.generation ||
        state.lockState !== "unlocked" ||
        state.testLifecycle !== "open" ||
        lockRequestInFlight
      ) {
        return { ok: false, reason: "invalid-state" };
      }

      lockRequestInFlight = true;
      try {
        await options.engageLock(caller.webContentsId);
        return { ok: true };
      } finally {
        lockRequestInFlight = false;
      }
    },
    revokeTrustedCaller(webContentsId) {
      callers.delete(webContentsId);
    },
  };
}
