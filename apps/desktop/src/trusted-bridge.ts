export const trustedRequestLockChannel =
  "desmoslock:trusted:test-lock-intent" as const;

export type TrustedBridgeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface TrustedDesktopBridge {
  readonly requestLock: () => Promise<TrustedBridgeResult>;
  readonly version: "2.0.0";
}

export type InvokeTrustedRequest = (
  channel: typeof trustedRequestLockChannel,
  request: unknown,
) => Promise<TrustedBridgeResult>;

export function createTrustedDesktopBridge(
  invoke: InvokeTrustedRequest,
): TrustedDesktopBridge {
  return Object.freeze({
    requestLock: () => invoke(trustedRequestLockChannel, { intent: "engage" }),
    version: "2.0.0" as const,
  });
}
