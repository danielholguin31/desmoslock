import { describe, expect, it, vi } from "vitest";

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
