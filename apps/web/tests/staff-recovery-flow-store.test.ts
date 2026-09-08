import { describe, expect, it, vi } from "vitest";

import { consumeStaffRecoveryCallback } from "../src/auth/staff-auth-callback.js";

import {
  createStaffRecoveryFlowStore,
  type StaffRecoveryFlowStorage,
} from "../src/auth/staff-recovery-flow-store.js";

function memoryStorage(
  initial: string | null = null,
): StaffRecoveryFlowStorage & {
  read(): string | null;
} {
  let value = initial;
  return {
    getItem() {
      return value;
    },
    read() {
      return value;
    },
    setItem(_key, next) {
      value = next;
    },
  };
}

function deterministicCrypto() {
  let fill = 1;
  const digest = vi.fn(
    async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      void algorithm;
      void data;
      return new Uint8Array(32).fill(0xab).buffer;
    },
  );
  const getRandomValues = ((array: Uint8Array) => {
    array.fill(fill);
    fill += 1;
    return array;
  }) as Crypto["getRandomValues"];
  return {
    crypto: {
      getRandomValues,
      subtle: { digest } as unknown as SubtleCrypto,
    },
    digest,
  };
}

describe("staff recovery flow store", () => {
  it("creates exact browser PKCE bindings without exposing the verifier", async () => {
    const storage = memoryStorage();
    const crypto = deterministicCrypto();
    const store = createStaffRecoveryFlowStore({
      clock: { now: () => 1_000 },
      crypto: crypto.crypto,
      storage,
    });

    const publicFlow = await store.create();

    expect(publicFlow.flowId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(publicFlow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicFlow.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicFlow).not.toHaveProperty("verifier");
    expect(crypto.digest).toHaveBeenCalledOnce();
    const stored = storage.read();
    const [active] = JSON.parse(stored ?? "[]") as Array<{
      verifier: string;
    }>;
    const [, digestInput] = crypto.digest.mock.calls[0] ?? [];
    expect(digestInput).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(digestInput as Uint8Array)).toBe(
      active?.verifier,
    );
    expect(stored).toContain('"kind":"active"');
    expect(stored).not.toContain(publicFlow.codeChallenge);
    expect(JSON.parse(stored ?? "[]")).toHaveLength(1);
  });

  it("atomically consumes once and erases verifier and state from its tombstone", async () => {
    const storage = memoryStorage();
    const store = createStaffRecoveryFlowStore({
      clock: { now: () => 1_000 },
      crypto: deterministicCrypto().crypto,
      storage,
    });
    const created = await store.create();
    const before = storage.read() ?? "";
    const parsed = JSON.parse(before) as Array<{ verifier: string }>;
    const verifier = parsed[0]?.verifier;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const first = await store.consume(created.flowId);
    expect(first).toMatchObject({ status: "accepted", verifier });
    const tombstone = storage.read() ?? "";
    expect(tombstone).toContain('"kind":"consumed"');
    expect(tombstone).not.toContain(verifier);
    expect(tombstone).not.toContain(created.state);
    await expect(store.consume(created.flowId)).resolves.toEqual({
      status: "replayed",
    });
  });

  it("serializes concurrent creates and caps live origin records at sixteen", async () => {
    const storage = memoryStorage();
    const store = createStaffRecoveryFlowStore({
      clock: { now: () => 1_000 },
      crypto: deterministicCrypto().crypto,
      storage,
    });

    const created = await Promise.all(
      Array.from({ length: 17 }, () => store.create()),
    );
    expect(new Set(created.map(({ flowId }) => flowId)).size).toBe(17);
    expect(JSON.parse(storage.read() ?? "[]")).toHaveLength(16);
    await expect(store.consume(created[0]!.flowId)).resolves.toEqual({
      status: "invalid",
    });
    await expect(store.consume(created[16]!.flowId)).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("returns an expired one-shot record once and removes all secret bytes", async () => {
    let now = 1_000;
    const storage = memoryStorage();
    const store = createStaffRecoveryFlowStore({
      clock: { now: () => now },
      crypto: deterministicCrypto().crypto,
      storage,
    });
    const created = await store.create();
    now = 301_000;

    const result = await store.consume(created.flowId);
    expect(result).toMatchObject({ expiresAt: 301_000, status: "accepted" });
    expect(storage.read()).not.toContain(created.state);
  });

  it.each([
    "not-json",
    JSON.stringify([{ kind: "active" }]),
    JSON.stringify(Array.from({ length: 17 }, () => ({ kind: "consumed" }))),
  ])("fails closed on malformed storage %j", async (value) => {
    const storage = memoryStorage(value);
    const store = createStaffRecoveryFlowStore({
      clock: { now: () => 1_000 },
      crypto: deterministicCrypto().crypto,
      storage,
    });
    await expect(store.create()).rejects.toThrow();
    expect(storage.read()).toBe(value);
  });

  it("fails closed when storage writes or the clock fail", async () => {
    const storage: StaffRecoveryFlowStorage = {
      getItem: () => null,
      setItem() {
        throw new Error("storage blocked");
      },
    };
    const blocked = createStaffRecoveryFlowStore({
      clock: { now: () => 1_000 },
      crypto: deterministicCrypto().crypto,
      storage,
    });
    await expect(blocked.create()).rejects.toThrow();

    const invalidClock = createStaffRecoveryFlowStore({
      clock: { now: () => Number.NaN },
      crypto: deterministicCrypto().crypto,
      storage: memoryStorage(),
    });
    await expect(invalidClock.create()).rejects.toThrow();
  });
});

describe("recovery across browser tabs", () => {
  function originLock() {
    let tail: Promise<unknown> = Promise.resolve();
    return {
      request<T>(_name: string, callback: () => Promise<T> | T): Promise<T> {
        const next = tail.then(callback, callback);
        tail = next.catch(() => undefined);
        return next;
      },
    };
  }

  it("shares a bounded flow across independent tabs and consumes it exactly once", async () => {
    const storage = memoryStorage();
    const lock = originLock();
    const dependencies = {
      clock: { now: () => 1_000 },
      crypto: deterministicCrypto().crypto,
      lock,
      storage,
    };
    const requestingTab = createStaffRecoveryFlowStore(dependencies);
    const callbackTab = createStaffRecoveryFlowStore(dependencies);
    const anotherTab = createStaffRecoveryFlowStore(dependencies);
    const flow = await requestingTab.create();
    const exchange = vi.fn(async () => undefined);
    const url = `https://app.example.test/?auth=recovery&flow=${flow.flowId}&state=${flow.state}&code=provider-code`;
    const options = {
      clock: dependencies.clock,
      exchange,
      history: { replaceState: vi.fn() },
      route: { origin: "https://app.example.test", pathname: "/" as const },
    };
    const results = await Promise.all([
      consumeStaffRecoveryCallback(url, { ...options, flows: callbackTab }),
      consumeStaffRecoveryCallback(url, { ...options, flows: anotherTab }),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([
      "accepted",
      "recovery_flow_replayed",
    ]);
    expect(exchange).toHaveBeenCalledOnce();
    expect(storage.read()).not.toContain(flow.state);
    expect(storage.read()).not.toContain('"verifier"');
  });

  it("does not navigate a first-hop credential in another browser or after expiry", async () => {
    let now = 1_000;
    const storage = memoryStorage();
    const dependencies = {
      clock: { now: () => now },
      crypto: deterministicCrypto().crypto,
      lock: originLock(),
      storage,
    };
    const requestingTab = createStaffRecoveryFlowStore(dependencies);
    const flow = await requestingTab.create();
    const navigate = vi.fn();
    const exchange = vi.fn(async () => undefined);
    const url = `https://app.example.test/?auth=recovery&flow=${flow.flowId}&state=${flow.state}#token_hash=pkce_${"a".repeat(56)}&type=recovery`;
    const options = {
      backendOrigin: "https://project.supabase.co",
      clock: dependencies.clock,
      exchange,
      history: { replaceState: vi.fn() },
      navigate,
      route: { origin: "https://app.example.test", pathname: "/" as const },
    };
    const differentBrowser = createStaffRecoveryFlowStore({
      ...dependencies,
      storage: memoryStorage(),
    });
    await expect(
      consumeStaffRecoveryCallback(url, {
        ...options,
        flows: differentBrowser,
      }),
    ).resolves.toMatchObject({ code: "recovery_flow_invalid" });
    expect(navigate).not.toHaveBeenCalled();
    await expect(
      consumeStaffRecoveryCallback(url, { ...options, flows: requestingTab }),
    ).resolves.toMatchObject({ status: "redirecting" });
    expect(navigate).toHaveBeenCalledOnce();
    now = 301_000;
    await expect(
      consumeStaffRecoveryCallback(url, { ...options, flows: requestingTab }),
    ).resolves.toMatchObject({ code: "recovery_flow_invalid" });
    expect(navigate).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
    expect(storage.read()).not.toContain(flow.state);
  });

  it("rejects an expired or mismatched callback before provider exchange", async () => {
    for (const mode of ["expired", "mismatched"] as const) {
      let now = 1_000;
      const storage = memoryStorage();
      const dependencies = {
        clock: { now: () => now },
        crypto: deterministicCrypto().crypto,
        lock: originLock(),
        storage,
      };
      const flows = createStaffRecoveryFlowStore(dependencies);
      const flow = await flows.create();
      if (mode === "expired") now = 301_000;
      const exchange = vi.fn(async () => undefined);
      const state = mode === "mismatched" ? "x".repeat(43) : flow.state;
      const result = await consumeStaffRecoveryCallback(
        `https://app.example.test/?auth=recovery&flow=${flow.flowId}&state=${state}&code=provider-code`,
        {
          clock: dependencies.clock,
          exchange,
          flows,
          history: { replaceState: vi.fn() },
          route: { origin: "https://app.example.test", pathname: "/" },
        },
      );
      expect(result).toMatchObject({
        code:
          mode === "expired"
            ? "recovery_flow_expired"
            : "recovery_state_mismatch",
      });
      expect(exchange).not.toHaveBeenCalled();
      expect(storage.read()).not.toContain(flow.state);
      expect(storage.read()).not.toContain('"verifier"');
    }
  });
});
