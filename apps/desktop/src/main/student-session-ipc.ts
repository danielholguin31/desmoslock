import {
  parseDesktopStudentView,
  type DesktopStudentView,
} from "../assessment-protection-view-state.js";

import {
  parseStudentSessionIpcArguments,
  studentSessionChannels,
  type StudentSessionRequestChannel,
} from "../trusted-bridge.js";
import type { TrustedCallerRegistration } from "./privileged-request-router.js";
import type { TrustedIpcEvent } from "./trusted-request-handler.js";

// The composed owner synchronously validates public revisions and captures the
// underlying admission before awaiting. These methods never forward a desktop
// revision directly to the admission-only coordinator.
export interface StudentSessionIpcCoordinator {
  readView(): DesktopStudentView;
  joinInitial(code: string, isCurrent: () => boolean): Promise<void>;
  beginTargetedReadmission(
    code: string,
    snapshotRevision: number,
    isCurrent: () => boolean,
  ): Promise<void>;
  retryPending(isCurrent: () => boolean): Promise<void>;
  refresh(): Promise<void>;
  forfeit(snapshotRevision: number, isCurrent: () => boolean): Promise<void>;
  start(snapshotRevision: number, isCurrent: () => boolean): Promise<void>;
  reviewEmergency(snapshotRevision: number, isCurrent: () => boolean): void;
  cancelEmergency(snapshotRevision: number, isCurrent: () => boolean): void;
  confirmEmergency(
    snapshotRevision: number,
    isCurrent: () => boolean,
  ): Promise<void>;
}

export function createStudentSessionIpc(
  coordinator: StudentSessionIpcCoordinator,
  onCallerInvalidated: () => void,
) {
  const callers = new Map<number, TrustedCallerRegistration>();

  function current(event: TrustedIpcEvent): TrustedCallerRegistration | null {
    try {
      const registration = callers.get(event.sender.id);
      const frame = event.senderFrame;
      const main = event.sender.mainFrame;
      if (
        registration === undefined ||
        event.sender.isDestroyed() ||
        frame === null ||
        frame.isDestroyed() ||
        main.isDestroyed() ||
        frame.processId !== main.processId ||
        frame.routingId !== main.routingId ||
        frame.processId !== registration.mainFrameProcessId ||
        frame.routingId !== registration.mainFrameRoutingId ||
        frame.url !== registration.trustedUrl ||
        main.url !== registration.trustedUrl ||
        callers.get(event.sender.id) !== registration
      )
        return null;
      return registration;
    } catch {
      return null;
    }
  }

  return {
    register(registration: TrustedCallerRegistration) {
      const previous = callers.get(registration.webContentsId);
      if (previous !== undefined) {
        if (
          previous.generation === registration.generation &&
          previous.mainFrameProcessId === registration.mainFrameProcessId &&
          previous.mainFrameRoutingId === registration.mainFrameRoutingId &&
          previous.trustedUrl === registration.trustedUrl
        )
          return;
        callers.delete(registration.webContentsId);
        onCallerInvalidated();
      }
      callers.set(
        registration.webContentsId,
        Object.freeze({ ...registration }),
      );
    },
    revoke(webContentsId: number) {
      if (callers.delete(webContentsId)) onCallerInvalidated();
    },
    mayPublish(webContentsId: number, generation: string): boolean {
      return callers.get(webContentsId)?.generation === generation;
    },
    async request(
      channel: StudentSessionRequestChannel,
      event: TrustedIpcEvent,
      ...args: readonly unknown[]
    ): Promise<DesktopStudentView | null> {
      const initiating = current(event);
      if (initiating === null) return null;
      const parsed = parseStudentSessionIpcArguments(channel, args);
      // Exact snapshots can encounter hostile reflection in direct tests. A
      // revoked registration must never survive that synchronous boundary.
      if (parsed === null || current(event) !== initiating) return null;
      const isCurrent = () => current(event) === initiating;
      const request = parsed[0] as
        | { readonly code: string; readonly snapshotRevision: number }
        | undefined;
      try {
        if (channel === studentSessionChannels.join && request !== undefined)
          await coordinator.joinInitial(request.code, isCurrent);
        else if (
          channel === studentSessionChannels.recover &&
          request !== undefined
        )
          await coordinator.beginTargetedReadmission(
            request.code,
            request.snapshotRevision,
            isCurrent,
          );
        else if (channel === studentSessionChannels.retry)
          await coordinator.retryPending(isCurrent);
        else if (channel === studentSessionChannels.refresh)
          await coordinator.refresh();
        else if (
          channel === studentSessionChannels.forfeit &&
          request !== undefined
        )
          await coordinator.forfeit(request.snapshotRevision, isCurrent);
        else if (
          channel === studentSessionChannels.start &&
          request !== undefined
        )
          await coordinator.start(request.snapshotRevision, isCurrent);
        else if (
          channel === studentSessionChannels.emergencyReview &&
          request !== undefined
        )
          coordinator.reviewEmergency(request.snapshotRevision, isCurrent);
        else if (
          channel === studentSessionChannels.emergencyCancel &&
          request !== undefined
        )
          coordinator.cancelEmergency(request.snapshotRevision, isCurrent);
        else if (
          channel === studentSessionChannels.emergencyConfirm &&
          request !== undefined
        )
          await coordinator.confirmEmergency(
            request.snapshotRevision,
            isCurrent,
          );
        else if (channel !== studentSessionChannels.read) return null;
        if (!isCurrent()) return null;
        const view = parseDesktopStudentView(coordinator.readView());
        return isCurrent() ? view : null;
      } catch {
        return null;
      }
    },
  };
}
