import { describe, expect, it, vi } from "vitest";
import type { StudentSessionViewState } from "@desmoslock/contracts";

import { createStudentSessionIpc } from "../src/main/student-session-ipc.js";
import {
  createTrustedDesktopBridge,
  studentSessionChannels,
} from "../src/trusted-bridge.js";
import type { StudentSessionCoordinator } from "../src/main/student-session-coordinator.js";

const view: StudentSessionViewState = {
  revision: 1,
  phase: "entry",
  session: null,
  protection: "unavailable",
  calculatorEligible: false,
  pendingOperation: null,
};
const url = "desmoslock-app://shell/index.html";

function fixture() {
  const coordinator: StudentSessionCoordinator = {
    initialize: vi.fn(async () => undefined),
    joinInitial: vi.fn(async () => undefined),
    beginTargetedReadmission: vi.fn(async () => undefined),
    retryPending: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    forfeit: vi.fn(async () => undefined),
    readView: vi.fn(() => view),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(async () => true),
  };
  const ipc = createStudentSessionIpc(coordinator);
  const frame = { processId: 11, routingId: 12, url, isDestroyed: () => false };
  const event = {
    sender: { id: 1, mainFrame: frame, isDestroyed: () => false },
    senderFrame: frame,
  };
  const registration = {
    webContentsId: 1,
    mainFrameProcessId: 11,
    mainFrameRoutingId: 12,
    trustedUrl: url,
    generation: "window-1",
  };
  ipc.register(registration);
  return { ipc, coordinator, frame, event, registration };
}

describe("Student named main-frame IPC", () => {
  it("validates exact named intent and returns only a sanitized projection", async () => {
    const f = fixture();
    expect(
      await f.ipc.request(studentSessionChannels.join, f.event, {
        code: "0123456789AB",
      }),
    ).toEqual(view);
    expect(f.coordinator.joinInitial).toHaveBeenCalledExactlyOnceWith(
      "0123456789AB",
    );
    expect(
      await f.ipc.request(studentSessionChannels.recover, f.event, {
        code: "0123456789AB",
        snapshotRevision: 1,
      }),
    ).toEqual(view);
    expect(
      f.coordinator.beginTargetedReadmission,
    ).toHaveBeenCalledExactlyOnceWith("0123456789AB", 1);
    expect(
      await f.ipc.request(studentSessionChannels.forfeit, f.event, {
        snapshotRevision: 1,
      }),
    ).toEqual(view);
  });

  it.each(["subframe", "foreign-url", "stale-frame", "destroyed", "revoked"])(
    "rejects %s before any coordinator mutation",
    async (reason) => {
      const f = fixture();
      const event =
        reason === "subframe"
          ? { ...f.event, senderFrame: { ...f.frame, routingId: 13 } }
          : reason === "foreign-url"
            ? {
                ...f.event,
                senderFrame: { ...f.frame, url: "https://foreign.invalid" },
              }
            : reason === "stale-frame"
              ? {
                  ...f.event,
                  sender: {
                    ...f.event.sender,
                    mainFrame: { ...f.frame, processId: 99 },
                  },
                }
              : reason === "destroyed"
                ? {
                    ...f.event,
                    sender: { ...f.event.sender, isDestroyed: () => true },
                  }
                : f.event;
      if (reason === "revoked") f.ipc.revoke(1);
      expect(
        await f.ipc.request(studentSessionChannels.join, event, {
          code: "0123456789AB",
        }),
      ).toBeNull();
      expect(f.coordinator.joinInitial).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown fields, argument counts, accessors and revocation during reflection", async () => {
    const f = fixture();
    const getter = vi.fn(() => "0123456789AB");
    for (const args of [
      [],
      [{ code: "0123456789AB" }, {}],
      [{ code: "0123456789AB", scope: {} }],
      [
        {
          get code() {
            return getter();
          },
        },
      ],
    ]) {
      expect(
        await f.ipc.request(studentSessionChannels.join, f.event, ...args),
      ).toBeNull();
    }
    const revoking = new Proxy(
      { code: "0123456789AB" },
      {
        ownKeys(target) {
          f.ipc.revoke(1);
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(
      await f.ipc.request(studentSessionChannels.join, f.event, revoking),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(f.coordinator.joinInitial).not.toHaveBeenCalled();
  });

  it("does not deliver a completion to a replacement frame generation", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    vi.mocked(f.coordinator.joinInitial).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.ipc.request(studentSessionChannels.join, f.event, {
      code: "0123456789AB",
    });
    f.ipc.register({ ...f.registration, generation: "window-2" });
    release?.();
    expect(await pending).toBeNull();
    expect(f.ipc.mayPublish(1, "window-1")).toBe(false);
  });

  it("fails closed if a main projection accidentally includes private material", async () => {
    const f = fixture();
    vi.mocked(f.coordinator.readView).mockReturnValue({
      ...view,
      secret: "synthetic-private",
    } as StudentSessionViewState);
    expect(
      await f.ipc.request(studentSessionChannels.read, f.event),
    ).toBeNull();
  });

  it("preload exposes only named snapshots and unsubscribes without forwarding events", async () => {
    const invoke = vi.fn(async () => view);
    let notify: ((view: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = createTrustedDesktopBridge(invoke, (listener) => {
      notify = listener;
      return unsubscribe;
    });
    expect(await bridge.joinTest({ code: "0123456789AB" })).toEqual(view);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      studentSessionChannels.join,
      { code: "0123456789AB" },
    );
    const listener = vi.fn();
    const stop = bridge.onStudentSessionViewChanged(listener);
    notify?.({ ...view, secret: "private" });
    expect(listener).not.toHaveBeenCalled();
    notify?.(view);
    expect(listener).toHaveBeenCalledExactlyOnceWith(view);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    stop();
    notify?.(view);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
