import { describe, expect, it } from "vitest";

import { createPrivilegedRequestRouter } from "../src/main/privileged-request-router.js";

describe("privileged request router", () => {
  it("allows a registered trusted main frame to request lock engagement", async () => {
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

    await expect(
      router.requestLock(
        {
          frameProcessId: 7,
          frameRoutingId: 101,
          isMainFrame: true,
          url: "desmoslock-app://shell/index.html",
          webContentsId: 11,
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(effects).toEqual(["engage"]);
  });

  it("denies lock engagement outside an open unlocked assessment", async () => {
    const effects: string[] = [];
    const router = createPrivilegedRequestRouter({
      engageLock: async () => {
        effects.push("engage");
      },
      readState: () => ({
        generation: "student-session-1",
        lockState: "locked",
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

    await expect(
      router.requestLock(
        {
          frameProcessId: 7,
          frameRoutingId: 101,
          isMainFrame: true,
          url: "desmoslock-app://shell/index.html",
          webContentsId: 11,
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid-state" });
    expect(effects).toEqual([]);
  });

  it.each([
    {
      caller: {
        frameProcessId: 8,
        frameRoutingId: 201,
        isMainFrame: true,
        url: "desmoslock-calculator://host/index.html",
        webContentsId: 21,
      },
      label: "an unregistered calculator renderer",
    },
    {
      caller: {
        frameProcessId: 7,
        frameRoutingId: 102,
        isMainFrame: false,
        url: "desmoslock-app://shell/index.html",
        webContentsId: 11,
      },
      label: "a trusted renderer subframe",
    },
    {
      caller: {
        frameProcessId: 7,
        frameRoutingId: 101,
        isMainFrame: true,
        url: "desmoslock-app://shell.attacker.invalid/index.html",
        webContentsId: 11,
      },
      label: "a trusted renderer at a lookalike origin",
    },
    {
      caller: {
        frameProcessId: 7,
        frameRoutingId: 999,
        isMainFrame: true,
        url: "desmoslock-app://shell/index.html",
        webContentsId: 11,
      },
      label: "a replaced main frame in the same WebContents",
    },
    {
      caller: {
        frameProcessId: 999,
        frameRoutingId: 101,
        isMainFrame: true,
        url: "desmoslock-app://shell/index.html",
        webContentsId: 11,
      },
      label: "a main frame from a replaced renderer process",
    },
  ])(
    "denies $label without consulting state or causing effects",
    async ({ caller }) => {
      const effects: string[] = [];
      let stateReads = 0;
      const router = createPrivilegedRequestRouter({
        engageLock: async () => {
          effects.push("engage");
        },
        readState: () => {
          stateReads += 1;
          return {
            generation: "student-session-1",
            lockState: "unlocked",
            testLifecycle: "open",
          };
        },
      });
      router.registerTrustedCaller({
        generation: "student-session-1",
        mainFrameProcessId: 7,
        mainFrameRoutingId: 101,
        trustedUrl: "desmoslock-app://shell/index.html",
        webContentsId: 11,
      });

      await expect(
        router.requestLock(caller, { intent: "engage" }),
      ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
      expect(stateReads).toBe(0);
      expect(effects).toEqual([]);
    },
  );

  it("revokes a formerly trusted caller before accepting another request", async () => {
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
    router.revokeTrustedCaller(11);

    await expect(
      router.requestLock(
        {
          frameProcessId: 7,
          frameRoutingId: 101,
          isMainFrame: true,
          url: "desmoslock-app://shell/index.html",
          webContentsId: 11,
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted-caller" });
    expect(effects).toEqual([]);
  });

  it.each([
    {
      label: "a stale assessment generation",
      state: {
        generation: "student-session-2",
        lockState: "unlocked" as const,
        testLifecycle: "open" as const,
      },
    },
    {
      label: "an ended assessment",
      state: {
        generation: "student-session-1",
        lockState: "unlocked" as const,
        testLifecycle: "ended" as const,
      },
    },
  ])("denies $label without causing effects", async ({ state }) => {
    const effects: string[] = [];
    const router = createPrivilegedRequestRouter({
      engageLock: async () => {
        effects.push("engage");
      },
      readState: () => state,
    });
    router.registerTrustedCaller({
      generation: "student-session-1",
      mainFrameProcessId: 7,
      mainFrameRoutingId: 101,
      trustedUrl: "desmoslock-app://shell/index.html",
      webContentsId: 11,
    });

    await expect(
      router.requestLock(
        {
          frameProcessId: 7,
          frameRoutingId: 101,
          isMainFrame: true,
          url: "desmoslock-app://shell/index.html",
          webContentsId: 11,
        },
        { intent: "engage" },
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid-state" });
    expect(effects).toEqual([]);
  });

  it.each([
    ["a missing request", undefined],
    ["a null request", null],
    ["a primitive request", "engage"],
    ["an unknown intent", { intent: "release" }],
    ["an extra argument", { intent: "engage", target: "lock" }],
  ])("rejects %s before causing effects", async (_label, request) => {
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

    await expect(
      router.requestLock(
        {
          frameProcessId: 7,
          frameRoutingId: 101,
          isMainFrame: true,
          url: "desmoslock-app://shell/index.html",
          webContentsId: 11,
        },
        request,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid-request" });
    expect(effects).toEqual([]);
  });

  it("permits only one in-flight lock effect", async () => {
    const effects: string[] = [];
    let finishEffect: (() => void) | undefined;
    const effectStarted = new Promise<void>((resolveStarted) => {
      finishEffect = resolveStarted;
    });
    let releaseEffect: (() => void) | undefined;
    const holdEffect = new Promise<void>((resolveEffect) => {
      releaseEffect = resolveEffect;
    });
    const router = createPrivilegedRequestRouter({
      engageLock: async () => {
        effects.push("engage");
        finishEffect?.();
        await holdEffect;
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
    const caller = {
      frameProcessId: 7,
      frameRoutingId: 101,
      isMainFrame: true,
      url: "desmoslock-app://shell/index.html",
      webContentsId: 11,
    };

    const firstRequest = router.requestLock(caller, { intent: "engage" });
    await effectStarted;
    await expect(
      router.requestLock(caller, { intent: "engage" }),
    ).resolves.toEqual({ ok: false, reason: "invalid-state" });
    releaseEffect?.();
    await expect(firstRequest).resolves.toEqual({ ok: true });
    expect(effects).toEqual(["engage"]);
  });

  it("routes state and effects through each trusted window identity", async () => {
    const effects: number[] = [];
    const states = new Map([
      [
        11,
        {
          generation: "student-session-1",
          lockState: "unlocked" as "locked" | "unlocked",
          testLifecycle: "open" as const,
        },
      ],
      [
        22,
        {
          generation: "student-session-2",
          lockState: "unlocked" as "locked" | "unlocked",
          testLifecycle: "open" as const,
        },
      ],
    ]);
    const router = createPrivilegedRequestRouter({
      engageLock: async (webContentsId) => {
        const state = states.get(webContentsId);
        if (state === undefined) throw new Error("missing assessment state");
        state.lockState = "locked";
        effects.push(webContentsId);
      },
      readState: (webContentsId) => states.get(webContentsId),
    });
    const register = (
      webContentsId: number,
      generation: string,
      processId: number,
      routingId: number,
    ) => {
      router.registerTrustedCaller({
        generation,
        mainFrameProcessId: processId,
        mainFrameRoutingId: routingId,
        trustedUrl: "desmoslock-app://shell/index.html",
        webContentsId,
      });
      return {
        frameProcessId: processId,
        frameRoutingId: routingId,
        isMainFrame: true,
        url: "desmoslock-app://shell/index.html",
        webContentsId,
      };
    };
    const firstWindow = register(11, "student-session-1", 7, 101);
    const freshWindow = register(22, "student-session-2", 8, 201);

    await expect(
      router.requestLock(firstWindow, { intent: "engage" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      router.requestLock(firstWindow, { intent: "engage" }),
    ).resolves.toEqual({ ok: false, reason: "invalid-state" });
    await expect(
      router.requestLock(freshWindow, { intent: "engage" }),
    ).resolves.toEqual({ ok: true });
    expect(effects).toEqual([11, 22]);
  });
});
