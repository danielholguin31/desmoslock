import type { BackendObservation } from "@desmoslock/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  detectStaffAuthCallback,
  startStaffAuthApplication,
  type StaffAuthApplicationAdapter,
  type StaffAuthApplicationElements,
} from "../src/auth/staff-auth-application.js";
import type {
  StaffAuthAdapter,
  StaffAuthMutation,
  StaffAuthMutationResult,
} from "../src/auth/staff-auth-controller.js";

const configuration = {
  environment: "local",
  origin: "http://localhost:43173",
  publishableKey: `sb_publishable_${"r".repeat(22)}_${"c".repeat(8)}`,
  url: "http://127.0.0.1:43174",
} as const;
const operationId = "00000000-0000-4000-8000-000000000001";

function createElements(): StaffAuthApplicationElements & {
  readonly authRoot: HTMLElement & { hidden: boolean };
  readonly protectedSchoolDataRoot: HTMLElement & { hidden: boolean };
} {
  return {
    authRoot: {
      hidden: true,
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement & { hidden: boolean },
    protectedSchoolDataRoot: {
      hidden: false,
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement & { hidden: boolean },
    status: {
      dataset: {},
      textContent: "Loading status…",
    } as unknown as HTMLElement,
  };
}

function createStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function createAdapter(overrides: Partial<StaffAuthAdapter> = {}): {
  readonly adapter: StaffAuthApplicationAdapter;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn();
  return {
    adapter: {
      dispose,
      async perform(
        request: StaffAuthMutation,
      ): Promise<StaffAuthMutationResult> {
        if (overrides.perform !== undefined) {
          return overrides.perform(request);
        }
        throw new Error("unexpected mutation");
      },
      async read() {
        return overrides.read?.() ?? { kind: "signed_out" as const };
      },
      subscribe(listener) {
        return overrides.subscribe?.(listener) ?? (() => undefined);
      },
    },
    dispose,
  };
}

function createHarness(
  options: {
    readonly adapter?: StaffAuthApplicationAdapter;
    readonly callbackUrl?: string;
    readonly configuration?: unknown;
    readonly history?: {
      replaceState(data: null, unused: string, url: string): void;
    };
    readonly observeHealth?: () => Promise<BackendObservation>;
    readonly storage?: ReturnType<typeof createStorage>;
  } = {},
) {
  const elements = createElements();
  const bindView = vi.fn(() => vi.fn());
  const createAdapterFactory = vi.fn(
    () => options.adapter ?? createAdapter().adapter,
  );
  const observeHealth = vi.fn(
    options.observeHealth ??
      (async () =>
        ({
          reason: "service_unavailable",
          status: "unavailable",
        }) as const),
  );
  const lifecycleListeners = new Set<() => void>();
  const unregisterLifecycle = vi.fn();
  const application = startStaffAuthApplication(
    {
      callbackUrl:
        options.callbackUrl ?? "http://localhost:43173/dashboard?tab=staff",
      clock: { now: () => Date.parse("2026-09-03T12:00:00.000Z") },
      configuration: options.configuration ?? configuration,
      elements,
      fetch: vi.fn(),
      history:
        options.history ??
        ({ replaceState: vi.fn() } satisfies {
          replaceState(data: null, unused: string, url: string): void;
        }),
      lifecycle: {
        register(dispose) {
          lifecycleListeners.add(dispose);
          return () => {
            lifecycleListeners.delete(dispose);
            unregisterLifecycle();
          };
        },
      },
      operationIds: { next: () => operationId },
      recoveryCrypto: globalThis.crypto,
      runtimeOrigin: "http://localhost:43173",
      storage: options.storage ?? createStorage(),
    },
    { bindView, createAdapter: createAdapterFactory, observeHealth },
  );
  return {
    application,
    bindView,
    createAdapterFactory,
    elements,
    lifecycleListeners,
    observeHealth,
    unregisterLifecycle,
  };
}

describe("staff auth application composition", () => {
  it.each([
    [
      "invite",
      "http://localhost:43173/?auth=invite&token_hash=" + "a".repeat(56),
    ],
    [
      "recovery",
      "http://localhost:43173/?auth=recovery&flow=" +
        "A".repeat(22) +
        "&state=" +
        "B".repeat(43) +
        "&code=provider-code",
    ],
    ["legacy", "http://localhost:43173/?token=legacy-provider-value"],
    ["mixed", "http://localhost:43173/?auth=invite&code=x&token_hash=y"],
  ])("detects a %s callback without exposing its credential", (kind, url) => {
    const detected = detectStaffAuthCallback(url);

    expect(detected).not.toBeNull();
    expect(detected).toBe(kind === "recovery" ? "recovery" : "invite");
    expect(JSON.stringify(detected)).not.toContain("provider");
    expect(JSON.stringify(detected)).not.toContain("legacy");
  });

  it("scrubs an invitation callback synchronously before provider completion, render, or health", async () => {
    let resolveMutation:
      ((result: StaffAuthMutationResult) => void) | undefined;
    const perform = vi.fn(
      () =>
        new Promise<StaffAuthMutationResult>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    const { adapter } = createAdapter({ perform });
    const history = { replaceState: vi.fn() };
    const harness = createHarness({
      adapter,
      callbackUrl: `http://localhost:43173/?auth=invite&token_hash=${"a".repeat(56)}`,
      history,
    });

    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(perform).toHaveBeenCalledOnce();
    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
    expect(harness.elements.authRoot.hidden).toBe(true);

    resolveMutation?.({
      operationId,
      result: { kind: "invitation_rejected", reason: "invalid" },
    });
    await harness.application.ready;

    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.observeHealth).toHaveBeenCalledOnce();
    expect(harness.elements.authRoot.hidden).toBe(false);
  });

  it("consumes a recovery flow and scrubs before exchanging or rendering", async () => {
    const state = "B".repeat(43);
    const flowId = "A".repeat(22);
    const storage = createStorage({
      "desmoslock.staff-auth.recovery-flows.v1": JSON.stringify([
        {
          createdAt: Date.parse("2026-09-03T11:59:00.000Z"),
          expiresAt: Date.parse("2026-09-03T12:04:00.000Z"),
          flowId,
          kind: "active",
          state,
          verifier: "C".repeat(43),
        },
      ]),
    });
    let resolveMutation:
      ((result: StaffAuthMutationResult) => void) | undefined;
    const perform = vi.fn(
      () =>
        new Promise<StaffAuthMutationResult>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    const { adapter } = createAdapter({ perform });
    const history = { replaceState: vi.fn() };
    const harness = createHarness({
      adapter,
      callbackUrl: `http://localhost:43173/?auth=recovery&flow=${flowId}&state=${state}&code=one-shot-code`,
      history,
      storage,
    });

    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(perform).toHaveBeenCalledOnce();
    const persisted = storage.getItem(
      "desmoslock.staff-auth.recovery-flows.v1",
    );
    expect(persisted).not.toContain("C".repeat(43));
    expect(persisted).not.toContain(state);

    resolveMutation?.({
      operationId,
      result: { kind: "password_recovery_ready" },
    });
    await harness.application.ready;

    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.observeHealth).toHaveBeenCalledOnce();
  });

  it("fails closed without constructing a provider or fetching health for invalid runtime configuration", async () => {
    const history = { replaceState: vi.fn() };
    const harness = createHarness({
      callbackUrl: `http://localhost:43173/?auth=invite&token_hash=${"a".repeat(56)}`,
      configuration: { ...configuration, origin: "https://other.example.test" },
      history,
    });

    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(harness.createAdapterFactory).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();

    await harness.application.ready;

    expect(harness.createAdapterFactory).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
    expect(harness.elements.status.dataset.backendStatus).toBe("unavailable");
    expect(harness.elements.status.textContent).toContain(
      "configuration_invalid",
    );
  });

  it("clears protected School data before publishing the bootstrapped view", async () => {
    const { adapter } = createAdapter();
    const harness = createHarness({ adapter });

    await harness.application.ready;

    expect(
      harness.elements.protectedSchoolDataRoot.replaceChildren,
    ).toHaveBeenCalled();
    expect(harness.elements.protectedSchoolDataRoot.hidden).toBe(true);
    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.createAdapterFactory).toHaveBeenCalledWith(
      configuration,
      expect.objectContaining({ next: expect.any(Function) }),
    );
  });

  it("disposes the bound view, provider, and lifecycle registration exactly once", async () => {
    const { adapter, dispose: disposeAdapter } = createAdapter();
    const harness = createHarness({ adapter });
    await harness.application.ready;
    const disposeView = harness.bindView.mock.results[0]?.value as
      (() => void) | undefined;

    harness.application.dispose();
    harness.application.dispose();

    expect(disposeView).toHaveBeenCalledOnce();
    expect(disposeAdapter).toHaveBeenCalledOnce();
    expect(harness.unregisterLifecycle).toHaveBeenCalledOnce();
    expect(harness.lifecycleListeners).toHaveLength(0);
  });
});
