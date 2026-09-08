import { describe, expect, it, vi } from "vitest";

import type { DesktopStudentView } from "../src/assessment-protection-view-state.js";
import {
  createStudentSessionIpc,
  type StudentSessionIpcCoordinator,
} from "../src/main/student-session-ipc.js";
import {
  createTrustedDesktopBridge,
  studentSessionChannels,
  trustedAssessmentLockChannel,
} from "../src/trusted-bridge.js";

const view: DesktopStudentView = {
  revision: 7,
  admission: { phase: "entry", session: null, pendingOperation: null },
  protection: {
    phase: "idle",
    categories: {
      aac: { status: "pending", code: "none" },
      shortcuts: { status: "pending", code: "none" },
      applications: { status: "pending", code: "none" },
      persistence: { status: "pending", code: "none" },
      windowNetwork: { status: "pending", code: "none" },
    },
    calculatorVisible: false,
    failure: null,
    nativeEndObserved: false,
    cleanup: "not_requested",
    evidence: "none",
    emergencyReview: false,
  },
};
const url = "desmoslock-app://shell/index.html";
const actions = [
  ["startAssessment", "start", "start", "desmoslock:assessment:start"],
  [
    "reviewEmergencyEnd",
    "emergencyReview",
    "reviewEmergency",
    "desmoslock:assessment:emergency-review",
  ],
  [
    "cancelEmergencyEnd",
    "emergencyCancel",
    "cancelEmergency",
    "desmoslock:assessment:emergency-cancel",
  ],
  [
    "confirmEmergencyEnd",
    "emergencyConfirm",
    "confirmEmergency",
    "desmoslock:assessment:emergency-confirm",
  ],
] as const;

function fixture() {
  const coordinator: StudentSessionIpcCoordinator = {
    joinInitial: vi.fn(async () => undefined),
    beginTargetedReadmission: vi.fn(async () => undefined),
    retryPending: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    forfeit: vi.fn(async () => undefined),
    readView: vi.fn(() => view),
    start: vi.fn(async () => undefined),
    reviewEmergency: vi.fn(),
    cancelEmergency: vi.fn(),
    confirmEmergency: vi.fn(async () => undefined),
  };
  const invalidated = vi.fn();
  const ipc = createStudentSessionIpc(coordinator, invalidated);
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
  const bridge = createTrustedDesktopBridge((channel, ...args) => {
    if (channel === trustedAssessmentLockChannel) throw new Error("legacy");
    return ipc.request(channel, event, ...args);
  });
  return { ipc, bridge, coordinator, invalidated, frame, event, registration };
}

describe("Student named main-frame IPC", () => {
  it("preserves admission intents with the composed revision and current-caller fence", async () => {
    const f = fixture();
    expect(await f.bridge.readStudentSessionView()).toEqual(view);
    expect(await f.bridge.joinTest({ code: "0123456789AB" })).toEqual(view);
    expect(f.coordinator.joinInitial).toHaveBeenCalledExactlyOnceWith(
      "0123456789AB",
      expect.any(Function),
    );
    expect(
      await f.bridge.beginTargetedReadmission({
        code: "0123456789AB",
        snapshotRevision: 7,
      }),
    ).toEqual(view);
    expect(
      f.coordinator.beginTargetedReadmission,
    ).toHaveBeenCalledExactlyOnceWith("0123456789AB", 7, expect.any(Function));
    expect(
      await f.bridge.forfeitStudentSession({ snapshotRevision: 7 }),
    ).toEqual(view);
    expect(f.coordinator.forfeit).toHaveBeenCalledExactlyOnceWith(
      7,
      expect.any(Function),
    );
    expect(await f.bridge.retryStudentSession()).toEqual(view);
    expect(f.coordinator.retryPending).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
    );
    expect(await f.bridge.refreshStudentSession()).toEqual(view);
    expect(f.coordinator.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(actions)(
    "routes %s through its exact channel and initiating-caller fence",
    async (name, channel, method, literal) => {
      const f = fixture();
      expect(await f.bridge[name]({ snapshotRevision: 7 })).toEqual(view);
      expect(f.coordinator[method]).toHaveBeenCalledExactlyOnceWith(
        7,
        expect.any(Function),
      );
      const isCurrent = vi.mocked(f.coordinator[method]).mock.calls[0]?.[1];
      expect(isCurrent?.()).toBe(true);
      f.ipc.revoke(1);
      expect(isCurrent?.()).toBe(false);
      expect(studentSessionChannels[channel]).toBe(literal);
    },
  );

  it.each([
    "subframe",
    "calculator",
    "foreign-url",
    "stale-frame",
    "old-generation",
    "destroyed",
    "revoked",
  ])("rejects %s before any coordinator mutation", async (reason) => {
    const f = fixture();
    const event =
      reason === "subframe"
        ? { ...f.event, senderFrame: { ...f.frame, routingId: 13 } }
        : reason === "calculator"
          ? { ...f.event, sender: { ...f.event.sender, id: 2 } }
          : reason === "foreign-url"
            ? {
                ...f.event,
                senderFrame: { ...f.frame, url: "https://foreign.invalid" },
              }
            : reason === "stale-frame" || reason === "old-generation"
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
    if (reason === "old-generation")
      f.ipc.register({
        ...f.registration,
        generation: "window-2",
        mainFrameProcessId: 99,
      });
    const invalidations = f.invalidated.mock.calls.length;
    for (const [, channel, method] of actions) {
      expect(
        await f.ipc.request(studentSessionChannels[channel], event, {
          snapshotRevision: 7,
        }),
      ).toBeNull();
      expect(f.coordinator[method]).not.toHaveBeenCalled();
    }
    expect(
      await f.ipc.request(studentSessionChannels.join, event, {
        code: "0123456789AB",
      }),
    ).toBeNull();
    expect(f.coordinator.joinInitial).not.toHaveBeenCalled();
    expect(f.invalidated).toHaveBeenCalledTimes(invalidations);
  });

  it("invalidates real registrations synchronously before replacement and only once on revoke", () => {
    const f = fixture();
    expect(f.invalidated).not.toHaveBeenCalled();
    f.ipc.register(f.registration);
    expect(f.invalidated).not.toHaveBeenCalled();
    f.invalidated.mockImplementation(() => {
      expect(f.ipc.mayPublish(1, "window-2")).toBe(false);
      expect(f.ipc.mayPublish(1, "window-1")).toBe(false);
    });
    f.ipc.register({ ...f.registration, generation: "window-2" });
    expect(f.invalidated).toHaveBeenCalledTimes(1);
    expect(f.ipc.mayPublish(1, "window-2")).toBe(true);
    f.ipc.revoke(1);
    f.ipc.revoke(1);
    expect(f.invalidated).toHaveBeenCalledTimes(2);
  });

  it.each(["processId", "routingId"] as const)(
    "rejects matching event frames whose %s differs from registration",
    async (identity) => {
      const f = fixture();
      const frame = { ...f.frame, [identity]: 99 };
      const event = {
        sender: { ...f.event.sender, mainFrame: frame },
        senderFrame: frame,
      };
      expect(
        await f.ipc.request(studentSessionChannels.start, event, {
          snapshotRevision: 7,
        }),
      ).toBeNull();
      expect(f.coordinator.start).not.toHaveBeenCalled();
      expect(f.invalidated).not.toHaveBeenCalled();
    },
  );

  it("retains no caller if invalidation fails during replacement", async () => {
    const f = fixture();
    f.invalidated.mockImplementation(() => {
      throw new Error("local cleanup failed");
    });
    expect(() =>
      f.ipc.register({ ...f.registration, generation: "window-2" }),
    ).toThrow("local cleanup failed");
    expect(f.ipc.mayPublish(1, "window-1")).toBe(false);
    expect(f.ipc.mayPublish(1, "window-2")).toBe(false);
    expect(await f.bridge.startAssessment({ snapshotRevision: 7 })).toBeNull();
    expect(f.coordinator.start).not.toHaveBeenCalled();
  });

  it("rejects revocation during the actual-frame check", async () => {
    const f = fixture();
    Object.defineProperty(f.frame, "url", {
      get() {
        f.ipc.revoke(1);
        return url;
      },
    });
    expect(await f.bridge.startAssessment({ snapshotRevision: 7 })).toBeNull();
    expect(f.coordinator.start).not.toHaveBeenCalled();
  });

  it.each(actions)(
    "rejects hostile %s arguments at both preload and main",
    async (name, channel, method) => {
      const f = fixture();
      const invoke = vi.fn(async () => view);
      const bridge = createTrustedDesktopBridge(invoke);
      const getter = vi.fn(() => 7);
      const inputs: readonly (readonly unknown[])[] = [
        [],
        [{ snapshotRevision: 7 }, {}],
        [null],
        [7],
        [
          {
            get snapshotRevision() {
              return getter();
            },
          },
        ],
        [Object.defineProperty({}, "snapshotRevision", { value: 7 })],
        [Object.create({ snapshotRevision: 7 })],
        [{ snapshotRevision: 7, attemptId: "synthetic-private" }],
        [{ snapshotRevision: 7, [Symbol("secret")]: true }],
        ...[
          0,
          -1,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.MAX_SAFE_INTEGER + 1,
          "7",
        ].map((snapshotRevision) => [{ snapshotRevision }]),
      ];
      for (const args of inputs) {
        expect(
          await f.ipc.request(
            studentSessionChannels[channel],
            f.event,
            ...args,
          ),
        ).toBeNull();
        expect(await Reflect.apply(bridge[name], bridge, args)).toBeNull();
      }
      expect(getter).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(f.coordinator[method]).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown admission fields and revocation during request reflection", async () => {
    const f = fixture();
    for (const args of [
      [],
      [{ code: "0123456789AB" }, {}],
      [{ code: "0123456789AB", scope: {} }],
    ]) {
      expect(
        await f.ipc.request(studentSessionChannels.join, f.event, ...args),
      ).toBeNull();
    }
    const request = new Proxy(
      { snapshotRevision: 7 },
      {
        ownKeys(target) {
          f.ipc.revoke(1);
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(
      await f.ipc.request(studentSessionChannels.start, f.event, request),
    ).toBeNull();
    expect(f.coordinator.start).not.toHaveBeenCalled();
    expect(f.coordinator.joinInitial).not.toHaveBeenCalled();
  });

  it.each(["generation", "navigation", "destroyed"])(
    "fences a late Start completion after %s changes",
    async (change) => {
      const f = fixture();
      let release: (() => void) | undefined;
      vi.mocked(f.coordinator.start).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const pending = f.ipc.request(studentSessionChannels.start, f.event, {
        snapshotRevision: 7,
      });
      const isCurrent = vi.mocked(f.coordinator.start).mock.calls[0]?.[1];
      if (change === "generation")
        f.ipc.register({ ...f.registration, generation: "window-2" });
      if (change === "navigation") f.frame.url = "https://foreign.invalid";
      if (change === "destroyed") f.frame.isDestroyed = () => true;
      expect(isCurrent?.()).toBe(false);
      release?.();
      expect(await pending).toBeNull();
      expect(f.coordinator.readView).not.toHaveBeenCalled();
    },
  );

  it("does not deliver a reply revoked during projection reflection", async () => {
    const f = fixture();
    vi.mocked(f.coordinator.readView).mockReturnValue(
      new Proxy(view, {
        ownKeys(target) {
          f.ipc.revoke(1);
          return Reflect.ownKeys(target);
        },
      }),
    );
    expect(
      await f.ipc.request(studentSessionChannels.read, f.event),
    ).toBeNull();
  });

  it.each(["root", "admission", "protection", "categories", "category"])(
    "rejects private material at the %s reply and changed-event boundary",
    async (boundary) => {
      const f = fixture();
      const invalid = structuredClone(view);
      const target =
        boundary === "root"
          ? invalid
          : boundary === "admission"
            ? invalid.admission
            : boundary === "protection"
              ? invalid.protection
              : boundary === "categories"
                ? invalid.protection.categories
                : invalid.protection.categories.aac;
      Object.assign(target, { attemptId: "synthetic-private" });
      vi.mocked(f.coordinator.readView).mockReturnValue(invalid);
      expect(
        await f.ipc.request(studentSessionChannels.read, f.event),
      ).toBeNull();
      let notify: ((value: unknown) => void) | undefined;
      const bridge = createTrustedDesktopBridge(
        async () => invalid,
        (listener) => {
          notify = listener;
          return () => undefined;
        },
      );
      expect(await bridge.readStudentSessionView()).toBeNull();
      const listener = vi.fn();
      bridge.onStudentSessionViewChanged(listener);
      notify?.(invalid);
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it("rejects admission-only placeholders instead of returning two protection authorities", async () => {
    const old = {
      revision: 1,
      phase: "entry",
      session: null,
      protection: "unavailable",
      calculatorEligible: false,
      pendingOperation: null,
    };
    expect(
      await createTrustedDesktopBridge(
        async () => old,
      ).readStudentSessionView(),
    ).toBeNull();
    const f = fixture();
    const mixed = structuredClone(view);
    Object.assign(mixed.admission, {
      protection: "unavailable",
      calculatorEligible: false,
    });
    vi.mocked(f.coordinator.readView).mockReturnValue(mixed);
    expect(
      await f.ipc.request(studentSessionChannels.read, f.event),
    ).toBeNull();
  });

  it("copies an active public session and rejects private session fields in replies and events", async () => {
    const f = fixture();
    const active: DesktopStudentView = {
      ...view,
      admission: {
        phase: "active",
        pendingOperation: null,
        session: {
          syntheticDisplayName: "Student CEDAR",
          sessionRevision: 1,
          capabilityExpiresAtMs: 2_000_000_000_000,
        },
      },
    };
    let notify: ((value: unknown) => void) | undefined;
    vi.mocked(f.coordinator.readView).mockReturnValue(active);
    const bridge = createTrustedDesktopBridge(
      () => f.ipc.request(studentSessionChannels.read, f.event),
      (listener) => {
        notify = listener;
        return () => undefined;
      },
    );
    const reply = await bridge.readStudentSessionView();
    expect(reply).toEqual(active);
    expect(reply?.admission.session).not.toBe(active.admission.session);
    expect(Object.isFrozen(reply?.admission.session)).toBe(true);
    const listener = vi.fn();
    bridge.onStudentSessionViewChanged(listener);
    notify?.(active);
    expect(listener).toHaveBeenCalledExactlyOnceWith(active);
    Object.assign(active.admission.session ?? {}, {
      capabilityToken: "synthetic-private",
    });
    expect(
      await f.ipc.request(studentSessionChannels.read, f.event),
    ).toBeNull();
    expect(
      await createTrustedDesktopBridge(
        async () => active,
      ).readStudentSessionView(),
    ).toBeNull();
    notify?.(active);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops changed-event delivery even if parsing unsubscribes reentrantly", () => {
    let notify: ((value: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = createTrustedDesktopBridge(
      async () => view,
      (listener) => {
        notify = listener;
        return unsubscribe;
      },
    );
    const listener = vi.fn();
    const stop = bridge.onStudentSessionViewChanged(listener);
    notify?.(
      new Proxy(view, {
        ownKeys(target) {
          stop();
          return Reflect.ownKeys(target);
        },
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    stop();
    notify?.(view);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("fails closed when a coordinator operation throws", async () => {
    const f = fixture();
    vi.mocked(f.coordinator.confirmEmergency).mockRejectedValue(
      new Error("unavailable"),
    );
    expect(
      await f.ipc.request(studentSessionChannels.emergencyConfirm, f.event, {
        snapshotRevision: 7,
      }),
    ).toBeNull();
    expect(f.coordinator.readView).not.toHaveBeenCalled();
  });

  it("loads the actual preload with only named methods and strips event objects", async () => {
    const invoke = vi.fn(async () => view);
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn();
    vi.doMock("electron", () => ({
      ipcRenderer: { invoke, on, removeListener },
      contextBridge: { exposeInMainWorld },
    }));
    try {
      await import("../src/preload.js");
      expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
      const [name, exposed] = exposeInMainWorld.mock.calls[0] as [
        string,
        ReturnType<typeof createTrustedDesktopBridge>,
      ];
      expect(name).toBe("desmoslockDesktop");
      expect(Object.isFrozen(exposed)).toBe(true);
      expect(await exposed.startAssessment({ snapshotRevision: 7 })).toEqual(
        view,
      );
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        studentSessionChannels.start,
        { snapshotRevision: 7 },
      );
      const listener = vi.fn();
      const stop = exposed.onStudentSessionViewChanged(listener);
      expect(on).toHaveBeenCalledExactlyOnceWith(
        studentSessionChannels.changed,
        expect.any(Function),
      );
      const receive = on.mock.calls[0]?.[1] as (
        event: unknown,
        value: unknown,
      ) => void;
      receive({ sender: "synthetic-private" }, view);
      expect(listener).toHaveBeenCalledExactlyOnceWith(view);
      const delivered = listener.mock.calls[0]?.[0] as DesktopStudentView;
      expect(Object.isFrozen(delivered.admission)).toBe(true);
      expect(Object.isFrozen(delivered.protection.categories.aac)).toBe(true);
      stop();
      expect(removeListener).toHaveBeenCalledExactlyOnceWith(
        studentSessionChannels.changed,
        receive,
      );
      receive({}, view);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("electron");
    }
  });
});
