import type {
  PrivilegedRequestResult,
  PrivilegedRequestRouter,
} from "./privileged-request-router.js";

export interface TrustedIpcFrame {
  isDestroyed(): boolean;
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
}

export interface TrustedIpcEvent {
  readonly sender: {
    readonly id: number;
    isDestroyed(): boolean;
    readonly mainFrame: TrustedIpcFrame;
  };
  readonly senderFrame: TrustedIpcFrame | null;
}

export type TrustedRequestHandler = (
  event: TrustedIpcEvent,
  ...args: readonly unknown[]
) => Promise<PrivilegedRequestResult>;

export function createTrustedRequestHandler(
  router: PrivilegedRequestRouter,
): TrustedRequestHandler {
  return async (event, ...args) => {
    if (args.length !== 1) {
      return { ok: false, reason: "invalid-request" };
    }

    if (event.sender.isDestroyed()) {
      return { ok: false, reason: "untrusted-caller" };
    }
    const senderFrame = event.senderFrame;
    if (senderFrame === null || senderFrame.isDestroyed()) {
      return { ok: false, reason: "untrusted-caller" };
    }
    const mainFrame = event.sender.mainFrame;
    if (mainFrame.isDestroyed()) {
      return { ok: false, reason: "untrusted-caller" };
    }
    const isCurrentMainFrame =
      senderFrame.processId === mainFrame.processId &&
      senderFrame.routingId === mainFrame.routingId;
    return router.requestLock(
      {
        frameProcessId: senderFrame.processId,
        frameRoutingId: senderFrame.routingId,
        isMainFrame: isCurrentMainFrame,
        url: senderFrame.url,
        webContentsId: event.sender.id,
      },
      args[0],
    );
  };
}
