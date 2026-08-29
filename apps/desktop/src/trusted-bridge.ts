export const trustedAssessmentLockChannel =
  "desmoslock:assessment:request-lock" as const;

export type TrustedBridgeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface TrustedDesktopBridge {
  readonly requestAssessmentLock: () => Promise<TrustedBridgeResult>;
  readonly version: "2.0.0";
}

export type InvokeTrustedRequest = (
  channel: typeof trustedAssessmentLockChannel,
  request: unknown,
) => Promise<unknown>;

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
): TrustedDesktopBridge {
  return Object.freeze({
    requestAssessmentLock: async () =>
      parseTrustedBridgeResult(
        await invoke(trustedAssessmentLockChannel, { intent: "engage" }),
      ),
    version: "2.0.0" as const,
  });
}
