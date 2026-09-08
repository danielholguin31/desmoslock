import type { BackendObservation } from "@desmoslock/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  detectStaffAuthCallback,
  staffAuthCallbackHistoryMarker,
  startStaffAuthApplication,
  type StaffAuthApplicationAdapter,
  type StaffAuthApplicationElements,
  type StaffAuthApplicationLifecycleHandlers,
} from "../src/auth/staff-auth-application.js";
import type {
  StaffAuthAccessEvent,
  StaffAuthAccessGrant,
  StaffAuthAdapter,
  StaffAuthController,
  StaffAuthMutation,
  StaffAuthMutationResult,
} from "../src/auth/staff-auth-controller.js";

import { createStaffAuthViewModel } from "../src/auth/staff-auth-view.js";
import {
  createSupabaseStaffAuthAdapter,
  type SupabaseStaffAuthPort,
} from "../src/auth/supabase-staff-auth-adapter.js";

const configuration = {
  environment: "local",
  origin: "http://localhost:43173",
  publishableKey: `sb_publishable_${"r".repeat(22)}_${"c".repeat(8)}`,
  url: "http://127.0.0.1:43174",
} as const;
const operationId = "00000000-0000-4000-8000-000000000001";

function syntheticAccess(
  secondFactor: "enrollment_required" | "satisfied" = "satisfied",
): StaffAuthAccessGrant {
  const access = {
    assuranceLevel: secondFactor === "satisfied" ? "aal2" : "aal1",
    identity: {
      accountId: "account-owner",
      email: "owner@example.test",
      membership: {
        id: "membership-owner",
        role: "owner",
        status: "active",
      },
      profile: { displayName: "Synthetic Owner", id: "profile-owner" },
      school: { id: "school-1", label: "Synthetic High School" },
    },
    identityGeneration: "identity-owner",
    kind: "access_granted",
    manageableInvitations: [],
    manageableStaff: [],
    sessionGeneration: "session-owner",
  } as const;
  return secondFactor === "satisfied"
    ? { ...access, secondFactor: "satisfied" }
    : { ...access, secondFactor: "enrollment_required" };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

interface FakeDomElement {
  alt?: string;
  children: FakeDomElement[];
  defaultValue?: string;
  hidden: boolean;
  inert: boolean;
  label?: string;
  options?: FakeDomElement[];
  querySelectorAll: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  replaceChildren: ReturnType<typeof vi.fn>;
  selected?: boolean;
  selectedIndex?: number;
  src?: string;
  tagName: string;
  textContent: string;
  value?: string;
}

function createFakeDomElement(
  tagName: string,
  properties: Partial<FakeDomElement> = {},
): FakeDomElement {
  const element = {
    children: [],
    hidden: false,
    inert: false,
    tagName: tagName.toUpperCase(),
    textContent: "",
    ...properties,
  } as FakeDomElement;
  element.querySelectorAll = vi.fn(() => {
    const descendants: FakeDomElement[] = [];
    const visit = (children: readonly FakeDomElement[]) => {
      for (const child of children) {
        descendants.push(child);
        visit(child.children);
      }
    };
    visit(element.children);
    return descendants;
  });
  element.removeAttribute = vi.fn((name: string) => {
    if (name === "src") element.src = "";
    if (name === "alt") element.alt = "";
    if (name === "value") element.value = "";
  });
  element.replaceChildren = vi.fn((...children: FakeDomElement[]) => {
    element.children = children;
    element.textContent = "";
  });
  return element;
}

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
    readonly adapters?: readonly StaffAuthApplicationAdapter[];
    readonly bindView?: (
      root: HTMLElement,
      controller: StaffAuthController,
    ) => () => void;
    readonly callbackHistoryMarkerPresent?: boolean;
    readonly callbackUrl?: string;
    readonly callbackWasScrubbed?: boolean;
    readonly configuration?: unknown;
    readonly elements?: StaffAuthApplicationElements;
    readonly history?: {
      replaceState(data: unknown, unused: string, url: string): void;
    };
    readonly observeHealth?: () => Promise<BackendObservation>;
    readonly nextOperationId?: () => string;
    readonly storage?: ReturnType<typeof createStorage>;
  } = {},
) {
  const elements = options.elements ?? createElements();
  const bindView = vi.fn(options.bindView ?? (() => vi.fn()));
  let adapterIndex = 0;
  const createAdapterFactory = vi.fn(() => {
    const configuredAdapter = options.adapters?.[adapterIndex];
    adapterIndex += 1;
    return configuredAdapter ?? options.adapter ?? createAdapter().adapter;
  });
  const observeHealth = vi.fn(
    options.observeHealth ??
      (async () =>
        ({
          reason: "service_unavailable",
          status: "unavailable",
        }) as const),
  );
  const lifecycleListeners = new Set<StaffAuthApplicationLifecycleHandlers>();
  const unregisterLifecycle = vi.fn();
  const application = startStaffAuthApplication(
    {
      callbackHistoryMarkerPresent:
        options.callbackHistoryMarkerPresent ?? false,
      callbackUrl:
        options.callbackUrl ?? "http://localhost:43173/dashboard?tab=staff",
      callbackWasScrubbed: options.callbackWasScrubbed ?? false,
      clock: { now: () => Date.parse("2026-09-03T12:00:00.000Z") },
      configuration: options.configuration ?? configuration,
      elements,
      fetch: vi.fn(),
      history:
        options.history ??
        ({ replaceState: vi.fn() } satisfies {
          replaceState(data: unknown, unused: string, url: string): void;
        }),
      lifecycle: {
        register(handlers) {
          lifecycleListeners.add(handlers);
          return () => {
            lifecycleListeners.delete(handlers);
            unregisterLifecycle();
          };
        },
      },
      operationIds: { next: options.nextOperationId ?? (() => operationId) },
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

function createRecoveryNotificationHarness() {
  const state = "B".repeat(43);
  const flowId = "A".repeat(22);
  let notifyAuthChange: () => void = () => undefined;
  let originalRecoveryBindingPresent = true;
  const capturePasswordAuthority = vi.fn(async () =>
    originalRecoveryBindingPresent ? "synthetic-recovery-handle" : null,
  );
  const releasePasswordAuthority = vi.fn();
  const readCurrentContext = vi.fn(async () => [
    {
      code: "forbidden",
      display_name: null,
      membership_role: null,
      profile_id: null,
      role_revision: null,
      school_id: null,
      school_name: null,
      school_slug: null,
    },
  ]);
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected external call");
  };
  const adapter = createSupabaseStaffAuthAdapter({
    clock: { now: () => Date.parse("2026-09-03T12:00:00.000Z") },
    createBlobUrl: () => {
      throw new Error("unexpected image presentation");
    },
    operationIds: { next: () => operationId },
    port: {
      acceptInvitation: unavailable,
      beginPasswordRecovery: unavailable,
      capturePasswordAuthority,
      captureSignOutAuthority: unavailable,
      clearPrivateAuthContinuations: () => undefined,
      challengeTotp: unavailable,
      enrollTotp: unavailable,
      exchangeEmailVerificationCode: unavailable,
      async exchangeRecoveryCode() {
        // The installed SDK queues its setSession SIGNED_IN notification while
        // the successful exchange is still returning through the adapter.
        queueMicrotask(() => notifyAuthChange());
        return { status: "ready" };
      },
      finishPasswordRecovery: unavailable,
      invokeInvitation: unavailable,
      invokeRecovery: unavailable,
      onAuthStateChange(listener) {
        notifyAuthChange = listener;
        return () => {
          notifyAuthChange = () => undefined;
        };
      },
      readAccount: async () => ({
        accountId: "a1000000-0000-4000-8000-000000000001",
        email: "teacher@example.test",
        emailVerified: true,
      }),
      readAssurance: unavailable,
      readCurrentContext,
      readCurrentInvitations: unavailable,
      readManageableInvitations: unavailable,
      readManageableStaff: unavailable,
      readSession: async () => ({ status: "authenticated" }),
      readTotpFactors: unavailable,
      releasePasswordAuthority,
      removeTotpFactor: unavailable,
      resendEmailVerification: unavailable,
      revokeAllStaffSessions: unavailable,
      revokeCurrentStaffSession: unavailable,
      revokeInvitation: unavailable,
      revokeMembership: unavailable,
      signIn: unavailable,
      signOut: unavailable,
      updatePassword: unavailable,
      verifyInvitationToken: unavailable,
      verifyTotp: unavailable,
    } satisfies SupabaseStaffAuthPort,
    revokeBlobUrl: () => undefined,
  });
  const read = vi.spyOn(adapter, "read");
  const viewModels: ReturnType<typeof createStaffAuthViewModel>[] = [];
  const harness = createHarness({
    adapter,
    bindView(_root, controller) {
      return controller.subscribe((snapshot) => {
        viewModels.push(createStaffAuthViewModel(snapshot));
      });
    },
    callbackUrl: `http://localhost:43173/?auth=recovery&flow=${flowId}&state=${state}&code=one-shot-code`,
    storage: createStorage({
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
    }),
  });
  return {
    ...harness,
    capturePasswordAuthority,
    read,
    readCurrentContext,
    releasePasswordAuthority,
    switchSession() {
      originalRecoveryBindingPresent = false;
      queueMicrotask(() => notifyAuthChange());
    },
    viewModels,
  };
}

describe("staff auth application composition", () => {
  it.each([
    [
      "invite",
      "invite",
      "http://localhost:43173/?auth=invite#token_hash=" + "a".repeat(56),
    ],
    [
      "recovery",
      "recovery",
      "http://localhost:43173/?auth=recovery&flow=" +
        "A".repeat(22) +
        "&state=" +
        "B".repeat(43) +
        "&code=provider-code",
    ],
    [
      "email verification",
      "email-verification",
      "http://localhost:43173/?auth=email-verification&sb_flow_id=0123456789abcdef0123456789abcdef&code=provider-code",
    ],
    ["legacy", "invite", "http://localhost:43173/?token=legacy-provider-value"],
    [
      "mixed",
      "invite",
      "http://localhost:43173/?auth=invite&code=x&token_hash=y",
    ],
    [
      "legacy implicit fragment",
      "recovery",
      "http://localhost:43173/#access_token=fragment-access&refresh_token=fragment-refresh&type=recovery",
    ],
    [
      "encoded sensitive fragment",
      "recovery",
      "http://localhost:43173/#%61ccess_token=fragment-access",
    ],
    [
      "uppercase unsupported fragment",
      "recovery",
      "http://localhost:43173/#ACCESS_TOKEN=fragment-access",
    ],
    [
      "valueless sensitive fragment",
      "recovery",
      "http://localhost:43173/#refresh_token",
    ],
  ])(
    "detects a %s callback without exposing its credential",
    (_label, kind, url) => {
      const detected = detectStaffAuthCallback(url);

      expect(detected).not.toBeNull();
      expect(detected).toBe(kind);
      expect(JSON.stringify(detected)).not.toContain("provider");
      expect(JSON.stringify(detected)).not.toContain("legacy");
    },
  );

  it("scrubs an unsupported sensitive fragment before provider, render, or health work", async () => {
    const perform = vi.fn(async () => {
      throw new Error("unsupported callbacks must not reach the provider");
    });
    const { adapter } = createAdapter({ perform });
    const history = { replaceState: vi.fn() };
    const harness = createHarness({
      adapter,
      callbackUrl:
        "http://localhost:43173/#access_token=fragment-access&refresh_token=fragment-refresh&type=recovery",
      history,
    });

    expect(history.replaceState).toHaveBeenCalledWith(
      staffAuthCallbackHistoryMarker,
      "",
      "/",
    );
    expect(perform).not.toHaveBeenCalled();
    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();

    await harness.application.ready;

    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.observeHealth).toHaveBeenCalledOnce();
  });

  it("waits for explicit confirmation before exchanging an email-verification callback", async () => {
    let resolveMutation:
      ((result: StaffAuthMutationResult) => void) | undefined;
    const perform = vi.fn(
      (request: StaffAuthMutation) =>
        new Promise<StaffAuthMutationResult>((resolve) => {
          void request;
          resolveMutation = resolve;
        }),
    );
    const { adapter } = createAdapter({ perform });
    const history = { replaceState: vi.fn() };
    const flowId = "0123456789abcdef0123456789abcdef";
    const harness = createHarness({
      adapter,
      callbackUrl: `http://localhost:43173/?auth=email-verification&sb_flow_id=${flowId}&code=one-shot-code`,
      history,
    });

    expect(history.replaceState).toHaveBeenCalledWith(
      staffAuthCallbackHistoryMarker,
      "",
      "/",
    );
    expect(perform).not.toHaveBeenCalled();

    await harness.application.ready;

    const controller = harness.bindView.mock.calls[0]?.[1];
    expect(controller?.getSnapshot()).toMatchObject({
      kind: "callback_confirmation_required",
    });
    const confirmation = controller?.dispatch({ type: "confirm_callback" });
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0]?.[0]).toMatchObject({
      authorizationCode: "one-shot-code",
      flowId,
      type: "exchange_email_verification_code",
    });
    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.observeHealth).toHaveBeenCalledOnce();

    resolveMutation?.({
      operationId,
      result: { kind: "membership_inactive" },
    });
    await confirmation;
  });

  it("waits for explicit confirmation before consuming an invitation callback", async () => {
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
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${"a".repeat(56)}`,
      history,
    });

    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(perform).not.toHaveBeenCalled();

    await harness.application.ready;

    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(harness.elements.authRoot.hidden).toBe(false);
    const controller = harness.bindView.mock.calls[0]?.[1];
    expect(controller?.getSnapshot()).toMatchObject({
      kind: "callback_confirmation_required",
    });
    expect(perform).not.toHaveBeenCalled();

    const confirmation = controller?.dispatch({
      type: "confirm_callback",
    } as never);
    expect(perform).toHaveBeenCalledOnce();
    await controller?.dispatch({ type: "confirm_callback" });
    expect(perform).toHaveBeenCalledOnce();
    resolveMutation?.({
      operationId,
      result: { kind: "invitation_rejected", reason: "invalid" },
    });
    await confirmation;

    expect(controller?.getSnapshot()).toMatchObject({
      kind: "invitation_rejected",
    });
  });

  it("accepts an already-scrubbed callback without rewriting or exposing its credential", async () => {
    const callbackCredential = "d".repeat(56);
    const history = { replaceState: vi.fn() };
    const { adapter } = createAdapter({
      perform: async (request) => ({
        operationId: request.operationId,
        result: { kind: "invitation_rejected", reason: "invalid" },
      }),
    });
    const harness = createHarness({
      adapter,
      callbackHistoryMarkerPresent: true,
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${callbackCredential}`,
      callbackWasScrubbed: true,
      history,
    });

    expect(history.replaceState).not.toHaveBeenCalled();
    await harness.application.ready;
    const controller = harness.bindView.mock.calls[0]?.[1];
    expect(JSON.stringify(controller?.getSnapshot())).not.toContain(
      callbackCredential,
    );

    await controller?.dispatch({ type: "confirm_callback" });
    expect(JSON.stringify(controller)).not.toContain(callbackCredential);
  });

  it("revalidates a scrub-marker reload and asks a signed-out user to reopen the email", async () => {
    const history = { replaceState: vi.fn() };
    const read = vi.fn(async () => ({ kind: "signed_out" as const }));
    const { adapter } = createAdapter({ read });
    const harness = createHarness({
      adapter,
      callbackHistoryMarkerPresent: true,
      callbackUrl: "http://localhost:43173/",
      callbackWasScrubbed: true,
      history,
    });

    await harness.application.ready;

    expect(history.replaceState).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(harness.bindView.mock.calls[0]?.[1]?.getSnapshot()).toMatchObject({
      kind: "callback_link_lost",
    });
  });

  it.each(["failed invitation", "reload marker"] as const)(
    "leaves the %s callback behind when returning to sign in",
    async (entry) => {
      const callbackCredential = "a".repeat(56);
      let historyState: unknown =
        entry === "reload marker" ? staffAuthCallbackHistoryMarker : null;
      let browserUrl =
        entry === "failed invitation"
          ? `http://localhost:43173/?auth=invite#token_hash=${callbackCredential}`
          : "http://localhost:43173/";
      const history = {
        replaceState: vi.fn((data: unknown, _unused: string, url: string) => {
          historyState = data;
          browserUrl = new URL(url, "http://localhost:43173").href;
        }),
      };
      let notify: ((event: StaffAuthAccessEvent) => void) | undefined;
      const read = vi.fn(async () => ({ kind: "signed_out" as const }));
      const resetComplete = deferred<StaffAuthMutationResult["result"]>();
      let operationSequence = 0;
      const operations: StaffAuthMutation["type"][] = [];
      const perform = vi.fn(async (request: StaffAuthMutation) => {
        operations.push(request.type);
        if (request.type === "inspect_invitation") {
          throw new Error(
            "synthetic provider rejected invitation confirmation",
          );
        }
        if (request.type !== "reset_to_sign_in") {
          throw new Error("unexpected callback consumption");
        }
        // The original browser-history boundary must be cleared before the
        // provider's reset can trigger a new authority read.
        expect(history.replaceState).toHaveBeenLastCalledWith(null, "", "/");
        expect(historyState).toBeNull();
        notify?.({ kind: "revalidation_required" });
        return {
          operationId: request.operationId,
          result: await resetComplete.promise,
        };
      });
      const first = createAdapter({
        perform,
        read,
        subscribe(listener) {
          notify = listener;
          return () => undefined;
        },
      });
      const resumeRead = vi.fn(async () => ({ kind: "signed_out" as const }));
      const resumePerform = vi.fn(async () => {
        throw new Error("resume must not consume a discarded callback");
      });
      const resumed = createAdapter({
        perform: resumePerform,
        read: resumeRead,
      });
      const viewModels: ReturnType<typeof createStaffAuthViewModel>[] = [];
      const harness = createHarness({
        adapters: [first.adapter, resumed.adapter],
        bindView(_root, controller) {
          viewModels.push(createStaffAuthViewModel(controller.getSnapshot()));
          return controller.subscribe((snapshot) => {
            viewModels.push(createStaffAuthViewModel(snapshot));
          });
        },
        callbackHistoryMarkerPresent: entry === "reload marker",
        callbackUrl: browserUrl,
        callbackWasScrubbed: entry === "reload marker",
        history,
        nextOperationId: () => {
          operationSequence += 1;
          return `00000000-0000-4000-8000-${String(operationSequence).padStart(12, "0")}`;
        },
      });

      expect(harness.elements.authRoot.hidden).toBe(true);
      expect(harness.elements.authRoot.inert).toBe(true);
      expect(perform).not.toHaveBeenCalled();
      if (entry === "failed invitation") expect(read).not.toHaveBeenCalled();
      await harness.application.ready;
      const controller = harness.bindView.mock.calls[0]?.[1];
      if (controller === undefined) throw new Error("auth view was not bound");

      if (entry === "failed invitation") {
        expect(viewModels.at(-1)).toMatchObject({
          actions: [{ id: "confirm_callback", label: "Continue securely" }],
          fields: [],
          status: "callback_confirmation_required",
        });
        await controller.dispatch({ type: "confirm_callback" });
        expect(viewModels.at(-1)).toMatchObject({
          actions: [{ id: "back_to_sign_in", label: "Start again" }],
          status: "dependency_failure",
        });
      } else {
        expect(viewModels.at(-1)).toMatchObject({
          actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
          heading: "Reopen your email",
          status: "callback_link_lost",
        });
      }

      const restarting = controller.dispatch({ type: "back_to_sign_in" });
      expect(history.replaceState).toHaveBeenLastCalledWith(null, "", "/");
      expect(historyState).toBeNull();
      expect(browserUrl).toBe("http://localhost:43173/");
      expect(controller.getSnapshot()).toMatchObject({ kind: "bootstrapping" });
      await vi.waitFor(() =>
        expect(viewModels.at(-1)).toMatchObject({
          actions: [
            { id: "sign_in", label: "Sign in" },
            { id: "request_recovery", label: "Forgot password?" },
          ],
          fields: [
            { id: "email", type: "email" },
            { id: "password", type: "password" },
          ],
          heading: "Staff sign in",
          status: "signed_out",
        }),
      );
      resetComplete.resolve({ kind: "sign_out_complete", scope: "local" });
      await restarting;
      const resetViewIndex = viewModels.length;
      await controller.dispatch({ type: "confirm_callback" });
      expect(operations).toEqual(
        entry === "failed invitation"
          ? ["inspect_invitation", "reset_to_sign_in"]
          : ["reset_to_sign_in"],
      );

      const readsBeforeEvent = read.mock.calls.length;
      notify?.({ kind: "revalidation_required" });
      await vi.waitFor(() => {
        expect(read).toHaveBeenCalledTimes(readsBeforeEvent + 1);
        expect(viewModels.at(-1)).toMatchObject({
          heading: "Staff sign in",
          status: "signed_out",
        });
      });
      harness.application.suspend();
      expect(harness.elements.authRoot.hidden).toBe(true);
      await harness.application.resume();
      expect(resumeRead).toHaveBeenCalledOnce();
      expect(viewModels.at(-1)).toMatchObject({
        heading: "Staff sign in",
        status: "signed_out",
      });
      const resumedController = harness.bindView.mock.calls[1]?.[1];
      await resumedController?.dispatch({ type: "confirm_callback" });
      expect(resumePerform).not.toHaveBeenCalled();
      expect(
        viewModels.slice(resetViewIndex).map((view) => view.status),
      ).not.toContain("callback_link_lost");
      harness.application.dispose();

      const reloadRead = vi.fn(async () => ({ kind: "signed_out" as const }));
      const reloadPerform = vi.fn(async () => {
        throw new Error("a clean reload must not consume a discarded callback");
      });
      const reload = createHarness({
        adapter: createAdapter({ perform: reloadPerform, read: reloadRead })
          .adapter,
        callbackHistoryMarkerPresent: historyState !== null,
        callbackUrl: browserUrl,
        history,
      });
      await reload.application.ready;
      const reloadedController = reload.bindView.mock.calls[0]?.[1];
      if (reloadedController === undefined)
        throw new Error("reload was not bound");
      expect(
        createStaffAuthViewModel(reloadedController.getSnapshot()),
      ).toMatchObject({ heading: "Staff sign in", status: "signed_out" });
      await reloadedController.dispatch({ type: "confirm_callback" });
      expect(reloadRead).toHaveBeenCalledOnce();
      expect(reloadPerform).not.toHaveBeenCalled();
      expect(historyState).toBeNull();
      expect(JSON.stringify(viewModels)).not.toContain(callbackCredential);
      reload.application.dispose();
    },
  );

  it("waits for explicit confirmation before consuming a recovery flow", async () => {
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
    expect(perform).not.toHaveBeenCalled();
    const persisted = storage.getItem(
      "desmoslock.staff-auth.recovery-flows.v1",
    );
    expect(persisted).toContain("C".repeat(43));

    await harness.application.ready;

    const controller = harness.bindView.mock.calls[0]?.[1];
    expect(controller?.getSnapshot()).toMatchObject({
      kind: "callback_confirmation_required",
    });
    const confirmation = controller?.dispatch({ type: "confirm_callback" });
    await Promise.resolve();
    await Promise.resolve();
    expect(perform).toHaveBeenCalledOnce();
    const consumed = storage.getItem("desmoslock.staff-auth.recovery-flows.v1");
    expect(consumed).not.toContain("C".repeat(43));
    expect(consumed).not.toContain(state);

    resolveMutation?.({
      operationId,
      result: { kind: "password_recovery_ready" },
    });
    await confirmation;
  });

  it("keeps the recovery form after the SDK notification revalidates its original session", async () => {
    const harness = createRecoveryNotificationHarness();
    try {
      await harness.application.ready;
      const controller = harness.bindView.mock.calls[0]?.[1];
      expect(controller).toBeDefined();
      await controller?.dispatch({ type: "confirm_callback" });
      await vi.waitFor(() => {
        expect(harness.read).toHaveBeenCalledOnce();
        expect(controller?.getSnapshot()).toMatchObject({
          kind: "password_recovery_ready",
        });
      });
      expect(harness.viewModels.at(-1)).toMatchObject({
        actions: [
          { id: "complete_password_recovery", label: "Update password" },
        ],
        heading: "Set a new password",
        status: "password_recovery_ready",
      });
      expect(harness.capturePasswordAuthority).toHaveBeenCalledWith();
      expect(harness.releasePasswordAuthority).toHaveBeenCalledWith(
        "synthetic-recovery-handle",
      );
      expect(harness.readCurrentContext).not.toHaveBeenCalled();
      expect(harness.elements.protectedSchoolDataRoot.hidden).toBe(true);
    } finally {
      harness.application.dispose();
    }
  });

  it("rejects the recovery form when a later SDK notification has a different session binding", async () => {
    const harness = createRecoveryNotificationHarness();
    try {
      await harness.application.ready;
      const controller = harness.bindView.mock.calls[0]?.[1];
      expect(controller).toBeDefined();
      await controller?.dispatch({ type: "confirm_callback" });
      await vi.waitFor(() => {
        expect(controller?.getSnapshot()).toMatchObject({
          kind: "password_recovery_ready",
        });
      });

      harness.switchSession();

      await vi.waitFor(() => {
        expect(harness.read).toHaveBeenCalledTimes(2);
        expect(controller?.getSnapshot()).toMatchObject({
          kind: "password_recovery_rejected",
        });
      });
      harness.switchSession();
      await vi.waitFor(() => {
        expect(harness.read).toHaveBeenCalledTimes(3);
        expect(controller?.getSnapshot()).toMatchObject({
          kind: "password_recovery_rejected",
        });
      });
      expect(harness.viewModels.at(-1)).toMatchObject({
        actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
        fields: [],
        status: "password_recovery_rejected",
      });
      expect(harness.readCurrentContext).not.toHaveBeenCalled();
      expect(harness.elements.protectedSchoolDataRoot.hidden).toBe(true);
    } finally {
      harness.application.dispose();
    }
  });

  it("fails closed without constructing a provider or fetching health for invalid runtime configuration", async () => {
    const history = { replaceState: vi.fn() };
    const harness = createHarness({
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${"a".repeat(56)}`,
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

  it("does no provider, render, or network work when synchronous callback scrubbing fails", async () => {
    const history = {
      replaceState: vi.fn(() => {
        throw new Error("synthetic history denial");
      }),
    };
    const harness = createHarness({
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${"a".repeat(56)}`,
      history,
    });

    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(harness.createAdapterFactory).not.toHaveBeenCalled();
    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
    expect(harness.elements.authRoot.hidden).toBe(true);
    expect(harness.elements.protectedSchoolDataRoot.hidden).toBe(true);

    await harness.application.ready;
    harness.application.dispose();

    expect(harness.createAdapterFactory).not.toHaveBeenCalled();
    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
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

  it("synchronously hides and deeply scrubs held DOM references before suspending a generation", async () => {
    const input = createFakeDomElement("input", {
      defaultValue: "person@example.test",
      value: "person@example.test",
    });
    const password = createFakeDomElement("textarea", {
      defaultValue: "typed synthetic password",
      value: "typed synthetic password",
    });
    const firstOption = createFakeDomElement("option", {
      label: "Synthetic School",
      selected: true,
      textContent: "Synthetic School",
      value: "school-1",
    });
    const secondOption = createFakeDomElement("option", {
      label: "Other School",
      selected: false,
      textContent: "Other School",
      value: "school-2",
    });
    const select = createFakeDomElement("select", {
      children: [firstOption, secondOption],
      options: [firstOption, secondOption],
      selectedIndex: 0,
      value: "school-1",
    });
    const qr = createFakeDomElement("img", {
      alt: "Authenticator QR for person@example.test",
      src: "blob:synthetic-qr",
    });
    const pii = createFakeDomElement("p", {
      textContent: "person@example.test owns Synthetic School",
    });
    const authRoot = createFakeDomElement("main", {
      children: [input, password, select, qr, pii],
      hidden: true,
      textContent: "person@example.test",
    });
    const protectedRoot = createFakeDomElement("section", {
      children: [
        createFakeDomElement("p", {
          textContent: "Protected synthetic roster",
        }),
      ],
      textContent: "Protected synthetic roster",
    });
    const first = createAdapter();
    const secondRead = deferred<{ readonly kind: "signed_out" }>();
    const second = createAdapter({ read: () => secondRead.promise });
    const viewDisposers = [vi.fn(), vi.fn()];
    let viewIndex = 0;
    const harness = createHarness({
      adapters: [first.adapter, second.adapter],
      bindView: () => viewDisposers[viewIndex++] ?? vi.fn(),
      elements: {
        authRoot: authRoot as unknown as HTMLElement,
        protectedSchoolDataRoot: protectedRoot as unknown as HTMLElement,
        status: {
          dataset: {},
          textContent: "Loading status…",
        } as unknown as HTMLElement,
      },
    });
    await harness.application.ready;

    harness.application.suspend();

    expect(authRoot.hidden).toBe(true);
    expect(authRoot.inert).toBe(true);
    expect(protectedRoot.hidden).toBe(true);
    expect(protectedRoot.inert).toBe(true);
    expect(authRoot.children).toEqual([]);
    expect(protectedRoot.children).toEqual([]);
    expect(input.value).toBe("");
    expect(input.defaultValue).toBe("");
    expect(password.value).toBe("");
    expect(password.defaultValue).toBe("");
    expect(select.value).toBe("");
    expect(select.selectedIndex).toBe(-1);
    expect(firstOption.value).toBe("");
    expect(firstOption.label).toBe("");
    expect(firstOption.selected).toBe(false);
    expect(firstOption.textContent).toBe("");
    expect(secondOption.value).toBe("");
    expect(secondOption.label).toBe("");
    expect(secondOption.selected).toBe(false);
    expect(secondOption.textContent).toBe("");
    expect(qr.src).toBe("");
    expect(qr.alt).toBe("");
    expect(pii.textContent).toBe("");
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(viewDisposers[0]).toHaveBeenCalledOnce();

    harness.application.suspend();
    expect(first.dispose).toHaveBeenCalledOnce();

    const resumed = harness.application.resume();
    expect(harness.createAdapterFactory).toHaveBeenCalledTimes(2);
    expect(authRoot.hidden).toBe(true);
    expect(authRoot.inert).toBe(true);
    secondRead.resolve({ kind: "signed_out" });
    await resumed;

    expect(harness.bindView).toHaveBeenCalledTimes(2);
    expect(authRoot.hidden).toBe(false);
    expect(authRoot.inert).toBe(false);
  });

  it("revokes authenticated PII and revalidates before revealing a restored page", async () => {
    const identityText = createFakeDomElement("p", {
      textContent: "Synthetic Owner · owner@example.test",
    });
    const schoolSelection = createFakeDomElement("option", {
      label: "Synthetic High School",
      selected: true,
      textContent: "Synthetic High School",
      value: "school-1",
    });
    const authRoot = createFakeDomElement("main", { hidden: true });
    const protectedRoot = createFakeDomElement("section");
    const first = createAdapter({
      read: async () => syntheticAccess(),
    });
    const restoredRead = deferred<{ readonly kind: "signed_out" }>();
    const restored = createAdapter({ read: () => restoredRead.promise });
    const harness = createHarness({
      adapters: [first.adapter, restored.adapter],
      elements: {
        authRoot: authRoot as unknown as HTMLElement,
        protectedSchoolDataRoot: protectedRoot as unknown as HTMLElement,
        status: { dataset: {}, textContent: "" } as unknown as HTMLElement,
      },
    });
    await harness.application.ready;
    expect(harness.bindView.mock.calls[0]?.[1]?.getSnapshot()).toMatchObject({
      identity: { email: "owner@example.test" },
      kind: "authenticated",
    });
    authRoot.children = [identityText, schoolSelection];

    harness.application.suspend();
    expect(identityText.textContent).toBe("");
    expect(schoolSelection.textContent).toBe("");
    expect(schoolSelection.value).toBe("");
    expect(authRoot.hidden).toBe(true);
    expect(authRoot.inert).toBe(true);

    const resumption = harness.application.resume();
    expect(authRoot.hidden).toBe(true);
    expect(authRoot.inert).toBe(true);
    restoredRead.resolve({ kind: "signed_out" });
    await resumption;

    expect(harness.bindView.mock.calls[1]?.[1]?.getSnapshot()).toMatchObject({
      kind: "signed_out",
    });
    expect(authRoot.hidden).toBe(false);
    expect(authRoot.inert).toBe(false);
  });

  it("revokes an in-progress TOTP QR and clears ceremony inputs on suspension", async () => {
    const revokeQr = vi.fn();
    const first = createAdapter({
      perform: async (request) => ({
        operationId: request.operationId,
        result: {
          enrollmentReceipt: "opaque-synthetic-receipt",
          kind: "totp_enrollment_ready",
          presentation: {
            blobUrl: "blob:synthetic-totp-qr",
            revoke: revokeQr,
          },
        },
      }),
      read: async () => syntheticAccess("enrollment_required"),
    });
    const qr = createFakeDomElement("img", {
      alt: "Authenticator enrollment QR",
      src: "blob:synthetic-totp-qr",
    });
    const code = createFakeDomElement("input", {
      defaultValue: "123456",
      value: "123456",
    });
    const authRoot = createFakeDomElement("main", { hidden: true });
    const protectedRoot = createFakeDomElement("section");
    const harness = createHarness({
      adapter: first.adapter,
      elements: {
        authRoot: authRoot as unknown as HTMLElement,
        protectedSchoolDataRoot: protectedRoot as unknown as HTMLElement,
        status: { dataset: {}, textContent: "" } as unknown as HTMLElement,
      },
    });
    await harness.application.ready;
    const controller = harness.bindView.mock.calls[0]?.[1];
    expect(controller?.getSnapshot()).toMatchObject({
      kind: "totp_enrollment_required",
    });
    await controller?.dispatch({ type: "begin_totp_enrollment" });
    expect(controller?.getSnapshot()).toMatchObject({
      kind: "totp_provisioning",
      qrBlobUrl: "blob:synthetic-totp-qr",
    });
    authRoot.children = [qr, code];

    harness.application.suspend();

    expect(qr.src).toBe("");
    expect(qr.alt).toBe("");
    expect(code.value).toBe("");
    expect(code.defaultValue).toBe("");
    expect(revokeQr).toHaveBeenCalledOnce();
    expect(controller?.getSnapshot()).toMatchObject({ kind: "disposed" });
    expect(authRoot.hidden).toBe(true);
    expect(authRoot.inert).toBe(true);
  });

  it("discards an unconfirmed callback on suspension and resumes through the generic lost-link bootstrap", async () => {
    const firstPerform = vi.fn(async () => {
      throw new Error("the suspended callback must never be consumed");
    });
    const first = createAdapter({ perform: firstPerform });
    const secondRead = vi.fn(async () => ({ kind: "signed_out" as const }));
    const secondPerform = vi.fn(async () => {
      throw new Error("resume must bootstrap without callback consumption");
    });
    const second = createAdapter({ perform: secondPerform, read: secondRead });
    const callbackCredential = "f".repeat(56);
    const harness = createHarness({
      adapters: [first.adapter, second.adapter],
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${callbackCredential}`,
    });
    await harness.application.ready;

    harness.application.suspend();
    await harness.application.resume();

    expect(firstPerform).not.toHaveBeenCalled();
    expect(secondPerform).not.toHaveBeenCalled();
    expect(secondRead).toHaveBeenCalledOnce();
    const resumedController = harness.bindView.mock.calls[1]?.[1];
    expect(resumedController?.getSnapshot()).toMatchObject({
      kind: "callback_link_lost",
    });
    expect(JSON.stringify(resumedController)).not.toContain(callbackCredential);
  });

  it("prevents late bootstrap and health work from binding or revealing a suspended generation", async () => {
    const initialRead = deferred<{ readonly kind: "signed_out" }>();
    const initialHealth = deferred<BackendObservation>();
    const first = createAdapter({ read: () => initialRead.promise });
    const second = createAdapter();
    const harness = createHarness({
      adapters: [first.adapter, second.adapter],
      observeHealth: () => initialHealth.promise,
    });

    harness.application.suspend();
    initialRead.resolve({ kind: "signed_out" });
    initialHealth.resolve({
      reason: "service_unavailable",
      status: "unavailable",
    });
    await harness.application.ready;

    expect(harness.bindView).not.toHaveBeenCalled();
    expect(harness.observeHealth).not.toHaveBeenCalled();
    expect(harness.elements.authRoot.hidden).toBe(true);

    await harness.application.resume();
    expect(harness.bindView).toHaveBeenCalledOnce();

    const laterHealth = deferred<BackendObservation>();
    harness.observeHealth.mockImplementationOnce(() => laterHealth.promise);
    harness.application.suspend();
    const resumedAgain = harness.application.resume();
    await vi.waitFor(() => {
      expect(harness.observeHealth).toHaveBeenCalledTimes(2);
    });
    harness.application.suspend();
    laterHealth.resolve({
      reason: "configuration_invalid",
      status: "unavailable",
    });
    await resumedAgain;

    expect(harness.elements.authRoot.hidden).toBe(true);
    expect(harness.elements.status.textContent).not.toContain(
      "configuration_invalid",
    );
  });

  it("invalidates an in-flight callback mutation before its result can reveal stale authority", async () => {
    const mutation = deferred<StaffAuthMutationResult>();
    const perform = vi.fn(() => mutation.promise);
    const first = createAdapter({ perform });
    const harness = createHarness({
      adapter: first.adapter,
      callbackUrl: `http://localhost:43173/?auth=invite#token_hash=${"e".repeat(56)}`,
    });
    await harness.application.ready;
    const controller = harness.bindView.mock.calls[0]?.[1];
    const confirmation = controller?.dispatch({ type: "confirm_callback" });
    expect(perform).toHaveBeenCalledOnce();

    harness.application.suspend();
    mutation.resolve({
      operationId,
      result: { kind: "invitation_rejected", reason: "invalid" },
    });
    await confirmation;

    expect(harness.elements.authRoot.hidden).toBe(true);
    expect(harness.bindView).toHaveBeenCalledOnce();
    expect(controller?.getSnapshot()).toMatchObject({ kind: "disposed" });
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
