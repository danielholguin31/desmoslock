import {
  parseStudentSessionViewState,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

import {
  parseStudentSessionIpcArguments,
  studentSessionChannels,
  type StudentSessionRequestChannel,
} from "../trusted-bridge.js";
import type { StudentSessionCoordinator } from "./student-session-coordinator.js";
import type { TrustedCallerRegistration } from "./privileged-request-router.js";
import type { TrustedIpcEvent } from "./trusted-request-handler.js";

export function createStudentSessionIpc(
  coordinator: StudentSessionCoordinator,
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
        main.url !== registration.trustedUrl
      )
        return null;
      return registration;
    } catch {
      return null;
    }
  }

  return {
    register(registration: TrustedCallerRegistration) {
      callers.set(
        registration.webContentsId,
        Object.freeze({ ...registration }),
      );
    },
    revoke(webContentsId: number) {
      callers.delete(webContentsId);
    },
    mayPublish(webContentsId: number, generation: string): boolean {
      return callers.get(webContentsId)?.generation === generation;
    },
    async request(
      channel: StudentSessionRequestChannel,
      event: TrustedIpcEvent,
      ...args: readonly unknown[]
    ): Promise<StudentSessionViewState | null> {
      const initiating = current(event);
      if (initiating === null) return null;
      const parsed = parseStudentSessionIpcArguments(channel, args);
      // Exact snapshots can encounter hostile reflection in direct tests. A
      // revoked registration must never survive that synchronous boundary.
      if (parsed === null || current(event) !== initiating) return null;
      const request = parsed[0] as
        | { readonly code: string; readonly snapshotRevision: number }
        | undefined;
      try {
        if (channel === studentSessionChannels.join && request !== undefined)
          await coordinator.joinInitial(request.code);
        else if (
          channel === studentSessionChannels.recover &&
          request !== undefined
        )
          await coordinator.beginTargetedReadmission(
            request.code,
            request.snapshotRevision,
          );
        else if (channel === studentSessionChannels.retry)
          await coordinator.retryPending();
        else if (channel === studentSessionChannels.refresh)
          await coordinator.refresh();
        else if (
          channel === studentSessionChannels.forfeit &&
          request !== undefined
        )
          await coordinator.forfeit(request.snapshotRevision);
        else if (channel !== studentSessionChannels.read) return null;
        return current(event) === initiating
          ? parseStudentSessionViewState(coordinator.readView())
          : null;
      } catch {
        return null;
      }
    },
  };
}
