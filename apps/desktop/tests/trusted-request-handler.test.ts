import { describe, expect, it } from "vitest";

import { createPrivilegedRequestRouter } from "../src/main/privileged-request-router.js";
import { createTrustedRequestHandler } from "../src/main/trusted-request-handler.js";

function createHarness() {
  const effects: string[] = [];
  const router = createPrivilegedRequestRouter({
    engageLock: async () => {
      effects.push("engage");
    },
    readState: () => ({
      generation: "student-session-1",
      lockState: "unlocked",
      testLifecycle: "open",
    }),
  });
  router.registerTrustedCaller({
    generation: "student-session-1",
    mainFrameProcessId: 7,
    mainFrameRoutingId: 101,
    trustedUrl: "desmoslock-app://shell/index.html",
    webContentsId: 11,
  });

  return {
    effects,
    handle: createTrustedRequestHandler(router),
  };
}

function createTrustedEvent() {
  const mainFrame = {
    isDestroyed: () => false,
    processId: 7,
    routingId: 101,
    url: "desmoslock-app://shell/index.html",
  };

  return {
    sender: { id: 11, isDestroyed: () => false, mainFrame },
    senderFrame: mainFrame,
  };
}

describe("trusted IPC request handler", () => {
  it("maps one exact main-frame invocation into a privileged request", async () => {
    const { effects, handle } = createHarness();

    await expect(
      handle(createTrustedEvent(), { intent: "engage" }),
    ).resolves.toEqual({ ok: true });
    expect(effects).toEqual(["engage"]);
  });

  it("rejects omitted or trailing IPC arguments before causing effects", async () => {
    for (const args of [[], [{ intent: "engage" }, "extra"]] as const) {
      const { effects, handle } = createHarness();

      await expect(handle(createTrustedEvent(), ...args)).resolves.toEqual({
        ok: false,
        reason: "invalid-request",
      });
      expect(effects).toEqual([]);
    }
  });

  it("recognizes an equivalent Electron main-frame wrapper by process and route", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();
    const copiedFrame = { ...event.sender.mainFrame };

    await expect(
      handle({ ...event, senderFrame: copiedFrame }, { intent: "engage" }),
    ).resolves.toEqual({ ok: true });
    expect(effects).toEqual(["engage"]);
  });

  it("rejects a destroyed sender frame", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();

    await expect(
      handle({ ...event, senderFrame: null }, { intent: "engage" }),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });

  it("rejects a sender frame Electron reports as destroyed", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();

    await expect(
      handle(
        {
          ...event,
          senderFrame: {
            ...event.sender.mainFrame,
            isDestroyed: () => true,
          },
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });

  it("does not read identity getters from an already destroyed frame", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();
    const destroyedFrame = {
      isDestroyed: () => true,
      get processId(): number {
        throw new Error("disposed frame processId was read");
      },
      get routingId(): number {
        throw new Error("disposed frame routingId was read");
      },
      get url(): string {
        throw new Error("disposed frame URL was read");
      },
    };

    await expect(
      handle({ ...event, senderFrame: destroyedFrame }, { intent: "engage" }),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });

  it("does not read identity getters from an already destroyed current main frame", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();
    const destroyedMainFrame = {
      isDestroyed: () => true,
      get processId(): number {
        throw new Error("disposed main frame processId was read");
      },
      get routingId(): number {
        throw new Error("disposed main frame routingId was read");
      },
      get url(): string {
        throw new Error("disposed main frame URL was read");
      },
    };

    await expect(
      handle(
        {
          ...event,
          sender: { ...event.sender, mainFrame: destroyedMainFrame },
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });

  it("does not read the main-frame getter from destroyed sender WebContents", async () => {
    const { effects, handle } = createHarness();
    const event = createTrustedEvent();
    const destroyedSender = {
      id: 11,
      isDestroyed: () => true,
      get mainFrame(): never {
        throw new Error("disposed WebContents mainFrame was read");
      },
    };

    await expect(
      handle({ ...event, sender: destroyedSender }, { intent: "engage" }),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });
});
