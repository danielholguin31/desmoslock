/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { parsePublicBackendConfiguration } from "@desmoslock/contracts";
import { describe, expect, it, vi } from "vitest";

import * as staffAuthApplication from "../src/auth/staff-auth-application.js";
import {
  observeWebBackend,
  publicWebBackendConfiguration,
  updateWebBackendStatus,
} from "../src/backend-status.js";
import {
  STAFF_AUTH_CALLBACK_HISTORY_MARKER,
  bootWebApplication,
  internalWorkspacePreview,
  isStaffAuthCallbackHistoryMarker,
  mountWebApplication,
  registerWebApplicationLifecycle,
} from "../src/main.js";

const indexHtmlPath = fileURLToPath(
  new URL("../src/index.html", import.meta.url),
);

interface ExecutedEarlyBootstrap {
  readonly boot: ReturnType<typeof vi.fn>;
  readonly completeModuleImport: () => Promise<void>;
  readonly failModuleImport: () => Promise<void>;
  readonly documentRoot: Record<PropertyKey, unknown>;
  readonly documentElement: { hidden: boolean };
  readonly effects: string[];
  readonly importedModules: string[];
  readonly replaceState: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly runtime: Record<PropertyKey, unknown>;
}

function readIndexHtml(): string {
  return readFileSync(indexHtmlPath, "utf8");
}

function createLifecycleRuntime(initialVisibility = "visible") {
  const windowListeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const documentRoot = {
    addEventListener(type: string, listener: EventListener) {
      documentListeners.set(type, listener);
    },
    removeEventListener: vi.fn((type: string) => {
      documentListeners.delete(type);
    }),
    visibilityState: initialVisibility,
  };
  const runtime = {
    addEventListener(type: string, listener: EventListener) {
      windowListeners.set(type, listener);
    },
    clearInterval: vi.fn((id: number) => {
      timers.delete(id);
    }),
    document: documentRoot,
    removeEventListener: vi.fn((type: string) => {
      windowListeners.delete(type);
    }),
    setInterval: vi.fn((callback: () => void) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    }),
  };
  return {
    documentListeners,
    documentRoot,
    emit(type: string, event: Partial<PageTransitionEvent> = {}) {
      windowListeners.get(type)?.(event as Event);
    },
    runtime,
    timers,
    visibility(state: "hidden" | "visible") {
      documentRoot.visibilityState = state;
      documentListeners.get("visibilitychange")?.({} as Event);
    },
    windowListeners,
  };
}

async function completeLifecycleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function readEarlyBootstrapSource(): string {
  const match = /<script data-staff-auth-bootstrap>([\s\S]*?)<\/script>/u.exec(
    readIndexHtml(),
  );
  if (match?.[1] === undefined) {
    throw new Error("index.html must contain the inline staff-auth bootstrap");
  }
  return match[1];
}

function executeEarlyBootstrap(options: {
  readonly hash?: string;
  readonly href: string;
  readonly search?: string;
  readonly throwWhileScrubbing?: boolean;
}): ExecutedEarlyBootstrap {
  const effects: string[] = [];
  const importedModules: string[] = [];
  const boot = vi.fn();
  let resolveImport!: (module: { bootWebApplication: typeof boot }) => void;
  let rejectImport!: (reason: Error) => void;
  const pendingImport = new Promise<{ bootWebApplication: typeof boot }>(
    (resolve, reject) => {
      resolveImport = resolve;
      rejectImport = reject;
    },
  );
  const documentElement = { hidden: false };
  const stop = vi.fn();
  const replaceState = vi.fn((data: unknown, _unused: string, url: string) => {
    effects.push("scrub");
    if (options.throwWhileScrubbing === true) {
      throw new Error("synthetic history failure");
    }
    runtime.history = { ...runtime.history, state: data };
    runtime.location = {
      ...runtime.location,
      hash: "",
      href: `https://staff.example.test${url}`,
      search: "",
    };
  });
  const runtime: Record<string, unknown> & {
    history: { replaceState: typeof replaceState; state: unknown };
    location: { hash: string; href: string; search: string };
  } = {
    history: { replaceState, state: null },
    location: {
      hash: options.hash ?? "",
      href: options.href,
      search: options.search ?? "",
    },
    stop,
  };
  const documentRoot = {
    createElement(tag: string) {
      expect(tag).toBe("link");
      return { rel: "", href: "" };
    },
    documentElement,
    head: {
      append(link: { rel: string; href: string }) {
        expect(link).toEqual({ rel: "stylesheet", href: "./styles.css" });
        effects.push("stylesheet");
      },
    },
  };

  // Replace only the module-loading syntax: the real inline scrub/closure
  // logic executes unmodified, with import completion controlled by the test.
  const source = readEarlyBootstrapSource();
  expect(source.match(/import\("\.\/main\.js"\)/gu)).toHaveLength(1);
  new Script(
    source.replace('import("./main.js")', 'loadModule("./main.js")'),
  ).runInNewContext({
    document: documentRoot,
    loadModule(specifier: string) {
      effects.push("module");
      importedModules.push(specifier);
      return pendingImport;
    },
    window: runtime,
  });

  return {
    boot,
    async completeModuleImport() {
      resolveImport({ bootWebApplication: boot });
      await pendingImport;
      await Promise.resolve();
    },
    async failModuleImport() {
      rejectImport(new Error("synthetic module load failure"));
      await pendingImport.catch(() => undefined);
      await Promise.resolve();
    },
    documentRoot,
    documentElement,
    effects,
    importedModules,
    replaceState,
    runtime,
    stop,
  };
}

describe("web v2 foundation", () => {
  it("starts with no imported legacy product rows", () => {
    expect(internalWorkspacePreview).toEqual([]);
  });

  it("scrubs before importing/rendering and keeps the callback only in a private closure", async () => {
    const html = readIndexHtml();
    const bootstrapStart = html.indexOf("<script data-staff-auth-bootstrap>");
    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(bootstrapStart).toBeLessThan(html.indexOf("<body>"));
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script type="module" src="./main.js">');

    const callbackUrl =
      "https://staff.example.test/?auth=invite#token_hash=" + "a".repeat(56);
    const result = executeEarlyBootstrap({
      href: callbackUrl,
      search: "?auth=invite",
      hash: `#token_hash=${"a".repeat(56)}`,
    });

    expect(result.effects).toEqual(["scrub", "stylesheet", "module"]);
    expect(result.replaceState).toHaveBeenCalledWith(
      STAFF_AUTH_CALLBACK_HISTORY_MARKER,
      "",
      "/",
    );
    expect(JSON.stringify(result.runtime.history)).not.toContain(
      "a".repeat(56),
    );
    expect(result.importedModules).toEqual(["./main.js"]);
    expect(result.boot).not.toHaveBeenCalled();
    // Reflect.ownKeys also catches non-enumerable and symbol capabilities.
    expect(Reflect.ownKeys(result.runtime)).toEqual([
      "history",
      "location",
      "stop",
    ]);
    expect(Reflect.ownKeys(result.documentRoot)).toEqual([
      "createElement",
      "documentElement",
      "head",
    ]);
    expect(JSON.stringify(result.runtime)).not.toContain("a".repeat(56));
    expect(JSON.stringify(result.documentRoot)).not.toContain("a".repeat(56));

    await result.completeModuleImport();
    expect(result.boot).toHaveBeenCalledExactlyOnceWith({
      callbackUrl,
      callbackWasScrubbed: true,
    });
    expect(Object.isFrozen(result.boot.mock.calls[0]?.[0])).toBe(true);
    expect(Reflect.ownKeys(result.runtime)).toEqual([
      "history",
      "location",
      "stop",
    ]);
  });

  it("starts normally without callback material and hands off no raw URL", async () => {
    const result = executeEarlyBootstrap({
      href: "https://staff.example.test/",
    });

    expect(result.effects).toEqual(["stylesheet", "module"]);
    expect(result.replaceState).not.toHaveBeenCalled();
    await result.completeModuleImport();
    expect(result.boot).toHaveBeenCalledExactlyOnceWith({
      callbackUrl: null,
      callbackWasScrubbed: false,
    });
  });

  it("fails closed without requesting application code when callback scrubbing fails", () => {
    const result = executeEarlyBootstrap({
      href: `https://staff.example.test/#access_token=${"b".repeat(32)}`,
      hash: `#access_token=${"b".repeat(32)}`,
      throwWhileScrubbing: true,
    });

    expect(result.effects).toEqual(["scrub"]);
    expect(result.importedModules).toEqual([]);
    expect(result.boot).not.toHaveBeenCalled();
    expect(result.documentElement.hidden).toBe(true);
    expect(result.stop).toHaveBeenCalledOnce();
    expect(Reflect.ownKeys(result.runtime)).toEqual([
      "history",
      "location",
      "stop",
    ]);
  });

  it("fails closed and never boots when the application module cannot load", async () => {
    const result = executeEarlyBootstrap({
      href: "https://staff.example.test/?auth=recovery&code=synthetic",
      search: "?auth=recovery&code=synthetic",
    });

    await result.failModuleImport();

    expect(result.effects).toEqual(["scrub", "stylesheet", "module"]);
    expect(result.boot).not.toHaveBeenCalled();
    expect(result.documentElement.hidden).toBe(true);
    expect(result.stop).toHaveBeenCalledOnce();
  });

  it("waits for the document before mounting the privately passed bootstrap once", () => {
    let onReady: (() => void) | undefined;
    const documentRoot = {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        expect(type).toBe("DOMContentLoaded");
        onReady = listener;
      }),
      documentElement: { hidden: false },
      querySelector: vi.fn(() => null),
      readyState: "loading",
    };
    bootWebApplication(
      { callbackUrl: null, callbackWasScrubbed: false },
      documentRoot as unknown as Document,
      {} as Window,
    );

    expect(documentRoot.querySelector).not.toHaveBeenCalled();
    expect(documentRoot.addEventListener).toHaveBeenCalledWith(
      "DOMContentLoaded",
      expect.any(Function),
      { once: true },
    );
    onReady?.();
    expect(documentRoot.querySelector).toHaveBeenCalledTimes(3);
    onReady?.();
    expect(documentRoot.querySelector).toHaveBeenCalledTimes(3);
  });

  it("fails closed without mounting an invalid private bootstrap", () => {
    const documentRoot = {
      documentElement: { hidden: false },
      querySelector: vi.fn(),
    };

    bootWebApplication(
      {
        callbackUrl: "https://staff.example.test/?code=synthetic",
        callbackWasScrubbed: false,
      },
      documentRoot as unknown as Document,
      {} as Window,
    );

    expect(documentRoot.documentElement.hidden).toBe(true);
    expect(documentRoot.querySelector).not.toHaveBeenCalled();
  });

  it("accepts only the exact nonsecret callback reload marker", () => {
    expect(Object.isFrozen(STAFF_AUTH_CALLBACK_HISTORY_MARKER)).toBe(true);
    expect(
      isStaffAuthCallbackHistoryMarker({
        desmoslockStaffAuthCallback: "pending-v1",
      }),
    ).toBe(true);
    expect(
      isStaffAuthCallbackHistoryMarker({
        desmoslockStaffAuthCallback: "pending-v1",
        token_hash: "synthetic",
      }),
    ).toBe(false);
    expect(
      isStaffAuthCallbackHistoryMarker({
        desmoslockStaffAuthCallback: "pending-v2",
      }),
    ).toBe(false);
    expect(isStaffAuthCallbackHistoryMarker(null)).toBe(false);
  });

  it("wires shared recovery storage, cross-tab locking, and navigation into production", async () => {
    const intercepted = new Error("application dependencies captured");
    const start = vi
      .spyOn(staffAuthApplication, "startStaffAuthApplication")
      .mockImplementation(() => {
        throw intercepted;
      });
    const localStorage = {
      getItem: vi.fn(() => "synthetic-flow-metadata"),
      setItem: vi.fn(),
    };
    const request = vi.fn(async (_name: string, callback: () => unknown) =>
      callback(),
    );
    const runtime = {
      crypto: {},
      history: { state: null },
      localStorage,
      location: {
        assign: vi.fn(),
        href: "https://staff.example.test/",
        origin: "https://staff.example.test",
      },
      navigator: { locks: { request } },
    };
    const documentRoot = { querySelector: () => ({}) };

    try {
      expect(() =>
        mountWebApplication(
          documentRoot as unknown as Document,
          runtime as unknown as Window,
        ),
      ).toThrow(intercepted);
      const dependencies = start.mock.calls[0]?.[0];
      expect(dependencies).toBeDefined();
      expect(dependencies?.storage.getItem("recovery-flow")).toBe(
        "synthetic-flow-metadata",
      );
      dependencies?.storage.setItem("recovery-flow", "new-synthetic-metadata");
      expect(localStorage.getItem).toHaveBeenCalledExactlyOnceWith(
        "recovery-flow",
      );
      expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
        "recovery-flow",
        "new-synthetic-metadata",
      );
      dependencies?.navigate?.("https://staff.example.test/");
      expect(runtime.location.assign).toHaveBeenCalledExactlyOnceWith(
        "https://staff.example.test/",
      );
      const operation = vi.fn(async () => "locked-result");
      await expect(
        dependencies?.recoveryFlowLock?.request("recovery-flow", operation),
      ).resolves.toBe("locked-result");
      expect(request).toHaveBeenCalledWith(
        "recovery-flow",
        expect.any(Function),
      );
      expect(operation).toHaveBeenCalledOnce();

      Reflect.deleteProperty(runtime.navigator, "locks");
      operation.mockClear();
      await expect(
        dependencies?.recoveryFlowLock?.request("recovery-flow", operation),
      ).rejects.toThrow("Recovery flow locking is unavailable.");
      expect(operation).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  it("suspends and resumes BFCache entries but disposes on a terminal page hide", async () => {
    const harness = createLifecycleRuntime();
    const application = {
      dispose: vi.fn(),
      refreshMembership: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      suspend: vi.fn(),
    };
    const unregister = registerWebApplicationLifecycle(
      harness.runtime as unknown as Window,
      application,
    );

    expect(harness.timers.size).toBe(1);
    harness.emit("pagehide", { persisted: true });
    expect(application.suspend).toHaveBeenCalledOnce();
    expect(application.dispose).not.toHaveBeenCalled();
    expect(harness.timers.size).toBe(0);

    harness.emit("pageshow", { persisted: false });
    expect(application.resume).not.toHaveBeenCalled();
    harness.emit("pageshow", { persisted: true });
    expect(application.resume).toHaveBeenCalledOnce();
    await completeLifecycleMicrotasks();
    expect(harness.timers.size).toBe(1);

    harness.emit("pagehide", { persisted: false });
    expect(application.dispose).toHaveBeenCalledOnce();
    expect(harness.timers.size).toBe(0);

    unregister();
    expect(harness.runtime.removeEventListener).toHaveBeenCalledWith(
      "pagehide",
      expect.any(Function),
    );
    expect(harness.runtime.removeEventListener).toHaveBeenCalledWith(
      "pageshow",
      expect.any(Function),
    );
    expect(harness.runtime.removeEventListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function),
    );
    expect(harness.documentRoot.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(harness.windowListeners.size).toBe(0);
    expect(harness.documentListeners.size).toBe(0);
  });

  it("refreshes visible Membership on a 15-second timer and coalesces focus and visibility triggers", async () => {
    const harness = createLifecycleRuntime("hidden");
    let finishRefresh: () => void = () => undefined;
    const pendingRefresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const application = {
      dispose: vi.fn(),
      refreshMembership: vi
        .fn(async (): Promise<void> => undefined)
        .mockImplementationOnce(() => pendingRefresh),
      resume: vi.fn(async () => undefined),
      suspend: vi.fn(),
    };
    const unregister = registerWebApplicationLifecycle(
      harness.runtime as unknown as Window,
      application,
    );
    expect(harness.timers.size).toBe(0);
    harness.emit("focus");
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).not.toHaveBeenCalled();

    harness.visibility("visible");
    expect(harness.runtime.setInterval).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      15_000,
    );
    const tick = [...harness.timers.values()][0];
    harness.emit("focus");
    tick?.();
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).toHaveBeenCalledOnce();
    harness.visibility("hidden");
    expect(harness.timers.size).toBe(0);
    tick?.();
    harness.emit("focus");
    finishRefresh();
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).toHaveBeenCalledOnce();

    harness.visibility("visible");
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).toHaveBeenCalledTimes(2);
    for (const callback of harness.timers.values()) callback();
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).toHaveBeenCalledTimes(3);
    expect(application.suspend).not.toHaveBeenCalled();
    expect(application.resume).not.toHaveBeenCalled();
    expect(application.dispose).not.toHaveBeenCalled();
    expect(harness.timers.size).toBe(1);
    unregister();
  });

  it("keeps refresh stopped until the current BFCache resumption finishes", async () => {
    const harness = createLifecycleRuntime();
    let finishResume: () => void = () => undefined;
    const pendingResume = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    const application = {
      dispose: vi.fn(),
      refreshMembership: vi.fn(async () => undefined),
      resume: vi
        .fn(async (): Promise<void> => undefined)
        .mockImplementationOnce(() => pendingResume),
      suspend: vi.fn(),
    };
    const unregister = registerWebApplicationLifecycle(
      harness.runtime as unknown as Window,
      application,
    );
    const oldTick = [...harness.timers.values()][0];
    harness.emit("pagehide", { persisted: true });
    harness.emit("pageshow", { persisted: true });
    harness.emit("focus");
    harness.visibility("visible");
    oldTick?.();
    await completeLifecycleMicrotasks();
    expect(harness.timers.size).toBe(0);
    expect(application.refreshMembership).not.toHaveBeenCalled();

    harness.emit("pagehide", { persisted: true });
    finishResume();
    await completeLifecycleMicrotasks();
    expect(harness.timers.size).toBe(0);
    harness.emit("pageshow", { persisted: true });
    await completeLifecycleMicrotasks();
    expect(harness.timers.size).toBe(1);
    expect(application.refreshMembership).not.toHaveBeenCalled();
    unregister();
  });

  it("disposes queued refresh and resume continuations without leaving timers or listeners", async () => {
    const harness = createLifecycleRuntime();
    let finishResume: () => void = () => undefined;
    const application = {
      dispose: vi.fn(),
      refreshMembership: vi.fn(async () => undefined),
      resume: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishResume = resolve;
          }),
      ),
      suspend: vi.fn(),
    };
    const unregister = registerWebApplicationLifecycle(
      harness.runtime as unknown as Window,
      application,
    );
    const tick = [...harness.timers.values()][0];
    harness.emit("focus");
    harness.emit("pagehide", { persisted: true });
    harness.emit("pageshow", { persisted: true });
    unregister();
    finishResume();
    tick?.();
    await completeLifecycleMicrotasks();
    expect(application.refreshMembership).not.toHaveBeenCalled();
    expect(harness.timers.size).toBe(0);
    expect(harness.windowListeners.size).toBe(0);
    expect(harness.documentListeners.size).toBe(0);
  });

  it("has no implicit loopback backend when build configuration is absent", () => {
    expect(
      parsePublicBackendConfiguration(publicWebBackendConfiguration),
    ).toBeNull();
  });

  it("renders configuration_invalid without fetching when build configuration is absent", async () => {
    const status = {
      dataset: {},
      textContent: "",
    } as unknown as HTMLElement;
    let fetches = 0;
    const observation = await updateWebBackendStatus(status, async () => {
      fetches += 1;
      throw new Error("missing configuration must not reach the network");
    });

    expect(observation).toEqual({
      reason: "configuration_invalid",
      status: "unavailable",
    });
    expect(fetches).toBe(0);
    expect(status.dataset.backendStatus).toBe("unavailable");
    expect(status.textContent).toContain("configuration_invalid");
  });

  it("observes the configured backend through the public health contract", async () => {
    const observation = await observeWebBackend(
      {
        environment: "local",
        url: "http://127.0.0.1:54321",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth", "database", "rest"],
              fixtureDigest:
                "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v2",
              schemaGeneration: 4,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toMatchObject({
      environment: "local",
      schemaGeneration: 4,
      status: "ready",
    });
  });
});
