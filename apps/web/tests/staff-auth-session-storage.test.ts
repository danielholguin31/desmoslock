import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStaffAuthSessionStorage,
  StaffAuthSessionStorageUnavailableError,
  type StaffAuthSessionStoragePlatform,
} from "../src/auth/staff-auth-session-storage.js";

type Request = {
  result: unknown;
  onsuccess: (() => void) | null;
};
type State = {
  data: Map<string, unknown>;
  queue: Transaction[];
  active: boolean;
};

// A deliberately narrow injected request/transaction scheduler, not a browser
// IndexedDB implementation. Native persistence and two-tab QA remain separate.
class Transaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  data = new Map<string, unknown>();
  requests: Array<() => void> = [];
  active = false;
  ended = false;
  scheduled = false;

  constructor(
    readonly state: State,
    readonly mode: IDBTransactionMode,
    readonly platform: Platform,
  ) {
    state.queue.push(this);
    queueMicrotask(() => this.start());
  }

  start() {
    if (this.state.active || this.state.queue[0] !== this) return;
    this.state.active = true;
    this.active = true;
    this.data = new Map(this.state.data);
    this.schedule();
  }

  release() {
    this.state.active = false;
    this.state.queue.shift();
    queueMicrotask(() => this.state.queue[0]?.start());
  }

  schedule() {
    if (!this.active || this.ended || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.ended) return;
      const request = this.requests.shift();
      if (request) {
        request();
        this.schedule();
        return;
      }
      if (this.mode === "readwrite" && this.platform.holdCommits) {
        this.platform.heldCommits.push(() => this.commit());
      } else this.commit();
    });
  }

  commit() {
    if (this.ended) return;
    this.ended = true;
    this.state.data = this.data;
    this.release();
    if (this.mode === "readwrite" && this.platform.holdCompleteEvents) {
      this.platform.heldCompleteEvents.push(() => this.oncomplete?.());
    } else this.oncomplete?.();
  }

  abort() {
    if (this.ended) throw new Error("transaction already finished");
    this.ended = true;
    this.platform.aborts += 1;
    if (this.active) this.release();
    else this.state.queue.splice(this.state.queue.indexOf(this), 1);
    queueMicrotask(() => this.onabort?.());
  }

  objectStore() {
    const request = (operation: () => unknown) => {
      const result: Request = { result: undefined, onsuccess: null };
      this.requests.push(() => {
        if (this.platform.failNextRequest) {
          this.platform.failNextRequest = false;
          this.onerror?.();
          if (!this.ended) this.abort();
          return;
        }
        result.result = operation();
        result.onsuccess?.();
      });
      this.schedule();
      return result;
    };
    return {
      get: (key: string) => request(() => structuredClone(this.data.get(key))),
      put: (value: unknown, key: string) =>
        request(() => {
          this.platform.writes += 1;
          this.data.set(key, structuredClone(value));
        }),
      delete: (key: string) =>
        request(() => {
          this.platform.writes += 1;
          this.data.delete(key);
        }),
    };
  }
}

class Connection {
  readonly version = 1;
  readonly objectStoreNames = {
    length: 1,
    contains: (name: string) => name === "entries",
  };
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly state: State,
    readonly platform: Platform,
  ) {}

  createObjectStore() {
    return {
      put: (value: unknown, key: string) =>
        this.state.data.set(key, structuredClone(value)),
    };
  }

  transaction(_name: string, mode: IDBTransactionMode) {
    if (this.closed) throw new Error("closed");
    const transaction = new Transaction(this.state, mode, this.platform);
    this.platform.transactions.push(transaction);
    return transaction;
  }

  close() {
    this.closed = true;
  }
}

class Channel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly name: string,
    readonly platform: Platform,
  ) {}

  postMessage(data: unknown) {
    if (this.closed || this.platform.failBroadcast)
      throw new Error("channel unavailable");
    this.platform.messages.push(data);
    for (const other of this.platform.channels) {
      if (other !== this && !other.closed && other.name === this.name) {
        queueMicrotask(() =>
          other.onmessage?.({ data: structuredClone(data) }),
        );
      }
    }
  }

  close() {
    this.closed = true;
  }
}

class Platform {
  readonly states = new Map<string, State>();
  readonly connections: Connection[] = [];
  readonly channels: Channel[] = [];
  readonly transactions: Transaction[] = [];
  readonly messages: unknown[] = [];
  readonly heldCommits: Array<() => void> = [];
  readonly heldCompleteEvents: Array<() => void> = [];
  readonly heldOpens: Array<() => void> = [];
  holdCommits = false;
  holdCompleteEvents = false;
  holdOpen = false;
  blockOpen = false;
  errorOpen = false;
  failNextRequest = false;
  failBroadcast = false;
  writes = 0;
  aborts = 0;
  generations = 0;

  readonly options: Partial<StaffAuthSessionStoragePlatform> = {
    indexedDB: {
      open: ((name: string) => {
        const request = {
          result: undefined as unknown,
          onupgradeneeded: null as
            ((event: { oldVersion: number }) => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
          transaction: null as { abort(): void } | null,
        };
        const complete = () => {
          if (this.blockOpen) {
            request.onblocked?.();
            return;
          }
          if (this.errorOpen) {
            request.onerror?.();
            return;
          }
          let state = this.states.get(name);
          const fresh = state === undefined;
          if (!state) {
            state = { data: new Map(), queue: [], active: false };
            this.states.set(name, state);
          }
          const connection = new Connection(state, this);
          this.connections.push(connection);
          request.result = connection;
          let aborted = false;
          request.transaction = {
            abort: () => {
              aborted = true;
              this.states.delete(name);
            },
          };
          if (fresh) request.onupgradeneeded?.({ oldVersion: 0 });
          request.transaction = null;
          if (aborted) request.onerror?.();
          else request.onsuccess?.();
        };
        queueMicrotask(() => {
          if (this.holdOpen) this.heldOpens.push(complete);
          else complete();
        });
        return request;
      }) as unknown as IDBFactory["open"],
    },
    createBroadcastChannel: (name) => {
      const channel = new Channel(name, this);
      this.channels.push(channel);
      return channel as unknown as ReturnType<
        StaffAuthSessionStoragePlatform["createBroadcastChannel"]
      >;
    },
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++this.generations).padStart(12, "0")}`,
  };

  create(url = "https://backend.invalid") {
    return createStaffAuthSessionStorage(url, this.options);
  }

  record(storageKey: string) {
    return this.states.get(storageKey)!.data.get("session") as {
      storeGeneration: string;
      version: number;
      value: string | null;
    };
  }

  releaseCommits() {
    this.holdCommits = false;
    for (const commit of this.heldCommits.splice(0)) commit();
  }
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("staff auth IndexedDB session storage", () => {
  it("uses a new exact normalized backend namespace and never touches legacy storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("legacy read");
      },
    });
    const platform = new Platform();
    const first = platform.create("https://BACKEND.invalid:443/");
    const equivalent = platform.create("https://backend.invalid");
    const different = platform.create("https://backend.invalid/another");
    expect(first.storageKey).toBe(equivalent.storageKey);
    expect(first.storageKey).not.toBe(different.storageKey);
    expect(first.storageKey).toMatch(/^desmoslock\.staff-auth\.indexeddb\.v1:/);
    expect(platform.channels[0]?.name).toBe(`${first.storageKey}:metadata`);
    expect(platform.channels[0]?.name).not.toBe(first.storageKey);
    await first.setItem(first.storageKey, "synthetic-session");
    expect(await equivalent.getItem(equivalent.storageKey)).toBe(
      "synthetic-session",
    );
    expect(await different.getItem(different.storageKey)).toBeNull();
    for (const url of [
      "file:///tmp/session",
      "https://user@backend.invalid",
      "https://backend.invalid?x=1",
      "https://backend.invalid#x",
    ]) {
      expect(() => platform.create(url)).toThrow();
    }
  });

  it("retains primary tombstones and increments the safe revision for repeated removal and same-value writes", async () => {
    const platform = new Platform();
    const store = platform.create();
    const first = await store.readSessionSnapshot();
    expect(first).toMatchObject({ version: 0, value: null });
    expect(Object.isFrozen(first)).toBe(true);
    await store.setItem(store.storageKey, "A");
    await store.setItem(store.storageKey, "A");
    await store.removeItem(store.storageKey);
    await store.removeItem(store.storageKey);
    expect(await store.readSessionSnapshot()).toEqual({ ...first, version: 4 });
    expect(platform.record(store.storageKey)).toEqual({ ...first, version: 4 });
    expect(await store.isCurrentSession(first)).toBe(false);
  });

  it("supports independent SDK PKCE and cache keys without changing session authority or notifications", async () => {
    const platform = new Platform();
    const store = platform.create();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = await store.readSessionSnapshot();
    const key = `${store.storageKey}-code-verifier`;
    await store.setItem(key, "synthetic-verifier");
    await store.setItem("__proto__", "synthetic-cache");
    expect(await store.getItem(key)).toBe("synthetic-verifier");
    expect(await store.getItem("__proto__")).toBe("synthetic-cache");
    await store.removeItem(key);
    expect(await store.getItem(key)).toBeNull();
    expect(await store.isCurrentSession(before)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(platform.messages).toEqual([]);
  });

  it("serializes competing CAS publishers across instances and rejects the loser without writes or notifications", async () => {
    const platform = new Platform();
    const first = platform.create();
    const second = platform.create();
    await first.setItem(first.storageKey, "A");
    const captures = await Promise.all([
      first.readSessionSnapshot(),
      second.readSessionSnapshot(),
    ]);
    const results = await Promise.all([
      first.compareAndPublish(captures[0], "B"),
      second.compareAndPublish(captures[1], "C"),
    ]);
    expect(results).toEqual([true, false]);
    expect(await second.getItem(second.storageKey)).toBe("B");
    expect(platform.writes).toBe(2);
    expect(platform.messages).toHaveLength(2);
    expect(platform.messages).toEqual([
      { kind: "session-committed" },
      { kind: "session-committed" },
    ]);
  });

  it("rejects exact-value ABA and deleted-session ABA without resurrecting a session", async () => {
    const platform = new Platform();
    const store = platform.create();
    await store.setItem(store.storageKey, "A");
    const before = await store.readSessionSnapshot();
    await store.setItem(store.storageKey, "B");
    await store.setItem(store.storageKey, "A");
    expect(await store.compareAndPublish(before, "obsolete-upgrade")).toBe(
      false,
    );
    const signedIn = await store.readSessionSnapshot();
    await store.removeItem(store.storageKey);
    const signedOut = await store.readSessionSnapshot();
    await store.removeItem(store.storageKey);
    expect(await store.compareAndPublish(signedIn, "resurrected")).toBe(false);
    expect(await store.compareAndPublish(signedOut, "resurrected")).toBe(false);
    expect(await store.getItem(store.storageKey)).toBeNull();
  });

  it("checks raw session bytes as well as version and generation", async () => {
    const platform = new Platform();
    const store = platform.create();
    await store.setItem(store.storageKey, "A");
    const before = await store.readSessionSnapshot();
    platform.record(store.storageKey).value = "different-account-same-version";
    const writes = platform.writes;
    expect(await store.isCurrentSession(before)).toBe(false);
    expect(await store.compareAndPublish(before, "obsolete")).toBe(false);
    expect(platform.writes).toBe(writes);
  });

  it("resolves primary publication and notifies listeners only after transaction completion", async () => {
    const platform = new Platform();
    const store = platform.create();
    const capture = await store.readSessionSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    platform.holdCommits = true;
    const settled = vi.fn();
    const publication = store.compareAndPublish(capture, "A").then(settled);
    await flush();
    expect(platform.writes).toBe(1);
    expect(platform.record(store.storageKey).value).toBeNull();
    expect(settled).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(platform.messages).toEqual([]);
    platform.releaseCommits();
    await publication;
    expect(settled).toHaveBeenCalledWith(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(platform.record(store.storageKey).value).toBe("A");
  });

  it("aborts a pending publication on its deadline before rejection and cannot later publish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const platform = new Platform();
    const store = platform.create();
    const before = await store.readSessionSnapshot();
    platform.holdCommits = true;
    const publication = store.compareAndPublish(before, "obsolete");
    const rejected = expect(publication).rejects.toMatchObject({
      publicationOutcome: "unknown",
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(platform.aborts).toBe(1);
    platform.releaseCommits();
    await flush();
    expect(platform.record(store.storageKey)).toEqual(before);
    expect(platform.messages).toEqual([]);
    expect(platform.connections[0]?.closed).toBe(true);
    await expect(store.getItem(store.storageKey)).rejects.toThrow(
      StaffAuthSessionStorageUnavailableError,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an unknown publication outcome when a committed transaction loses its completion signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const platform = new Platform();
    const store = platform.create();
    const before = await store.readSessionSnapshot();
    platform.holdCompleteEvents = true;
    const publication = store.compareAndPublish(
      before,
      "committed-before-signal",
    );
    const rejected = expect(publication).rejects.toMatchObject({
      publicationOutcome: "unknown",
    });
    await flush();
    expect(platform.record(store.storageKey).value).toBe(
      "committed-before-signal",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    for (const complete of platform.heldCompleteEvents) complete();
    expect(platform.messages).toEqual([]);
    await expect(store.isCurrentSession(before)).rejects.toThrow();
  });

  it("does not transfer an auxiliary transaction's confirmed abort to an already committed CAS", async () => {
    const platform = new Platform();
    const store = platform.create();
    const before = await store.readSessionSnapshot();
    platform.holdCompleteEvents = true;
    const publication = store.compareAndPublish(
      before,
      "committed-before-signal",
    );
    const publicationRejected = expect(publication).rejects.toMatchObject({
      publicationOutcome: "unknown",
    });
    await flush();
    expect(platform.record(store.storageKey).value).toBe(
      "committed-before-signal",
    );

    platform.holdCommits = true;
    const auxiliaryKey = `${store.storageKey}-code-verifier`;
    const auxiliary = store.setItem(auxiliaryKey, "aborted-verifier");
    const auxiliaryRejected = expect(auxiliary).rejects.toMatchObject({
      publicationOutcome: "not_committed",
    });
    await flush();
    platform.transactions.at(-1)!.abort();
    await Promise.all([publicationRejected, auxiliaryRejected]);
    platform.releaseCommits();
    for (const complete of platform.heldCompleteEvents) complete();
    expect(platform.messages).toEqual([]);
    await expect(store.readSessionSnapshot()).rejects.toThrow();

    const replacement = platform.create();
    expect(await replacement.readSessionSnapshot()).toEqual({
      ...before,
      version: before.version + 1,
      value: "committed-before-signal",
    });
    expect(await replacement.getItem(auxiliaryKey)).toBeNull();
  });

  it("rejects a storage abort after successful requests without publishing", async () => {
    const platform = new Platform();
    const store = platform.create();
    const before = await store.readSessionSnapshot();
    platform.holdCommits = true;
    const publication = store.compareAndPublish(before, "aborted");
    const rejected = expect(publication).rejects.toMatchObject({
      publicationOutcome: "not_committed",
    });
    await flush();
    platform.transactions.at(-1)!.abort();
    await rejected;
    platform.releaseCommits();
    expect(platform.record(store.storageKey)).toEqual(before);
    expect(platform.messages).toEqual([]);
  });

  it("disposes pending transactions and only owns its own listeners, channel and connection", async () => {
    const platform = new Platform();
    const store = platform.create();
    const other = platform.create();
    const before = await store.readSessionSnapshot();
    await other.readSessionSnapshot();
    const removed = vi.fn();
    const retained = vi.fn();
    store.subscribe(removed)();
    other.subscribe(retained);
    platform.holdCommits = true;
    const publication = store.compareAndPublish(before, "obsolete");
    const rejected = expect(publication).rejects.toThrow();
    await flush();
    store.dispose();
    store.dispose();
    await rejected;
    platform.releaseCommits();
    await other.setItem(other.storageKey, "other-owner");
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
    expect(await other.getItem(other.storageKey)).toBe("other-owner");
    expect(() => store.subscribe(vi.fn())).toThrow();
  });

  it("invalidates old captures when the database is deleted and recreated with a new persistent generation", async () => {
    const platform = new Platform();
    const old = platform.create();
    const before = await old.readSessionSnapshot();
    platform.connections[0]!.onversionchange?.();
    platform.states.delete(old.storageKey);
    const replacement = platform.create();
    const current = await replacement.readSessionSnapshot();
    expect(current.version).toBe(before.version);
    expect(current.value).toBe(before.value);
    expect(current.storeGeneration).not.toBe(before.storeGeneration);
    await expect(old.compareAndPublish(before, "obsolete")).rejects.toThrow();
    await expect(
      replacement.compareAndPublish(before, "obsolete"),
    ).rejects.toThrow();
    expect(platform.record(old.storageKey).value).toBeNull();
  });

  it.each(["onversionchange", "onclose", "onerror"] as const)(
    "fails closed on database %s without reopening",
    async (event) => {
      const platform = new Platform();
      const store = platform.create();
      const before = await store.readSessionSnapshot();
      const listener = vi.fn();
      store.subscribe(listener);
      platform.connections[0]![event]?.();
      await expect(store.isCurrentSession(before)).rejects.toThrow();
      await expect(
        store.setItem(store.storageKey, "obsolete"),
      ).rejects.toThrow();
      expect(platform.connections).toHaveLength(1);
      expect(platform.connections[0]?.closed).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
    },
  );

  it.each(["blockOpen", "errorOpen"] as const)(
    "rejects %s and keeps the adapter terminally unavailable",
    async (failure) => {
      const platform = new Platform();
      platform[failure] = true;
      const store = platform.create();
      await expect(store.readSessionSnapshot()).rejects.toThrow();
      platform[failure] = false;
      await expect(store.readSessionSnapshot()).rejects.toThrow();
      expect(platform.connections).toHaveLength(0);
    },
  );

  it("bounds initialization and closes a late successful open without reactivating the adapter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const platform = new Platform();
    platform.holdOpen = true;
    const store = platform.create();
    const reading = store.readSessionSnapshot();
    const rejected = expect(reading).rejects.toThrow();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    for (const complete of platform.heldOpens) complete();
    expect(platform.connections.every((connection) => connection.closed)).toBe(
      true,
    );
    expect(platform.states.has(store.storageKey)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(store.readSessionSnapshot()).rejects.toThrow();
  });

  it("rejects malformed primary metadata, unsafe revisions and an observed revision reset", async () => {
    for (const metadata of [
      undefined,
      {},
      { storeGeneration: "not-random", version: 0, value: null },
      {
        storeGeneration: "00000000-0000-4000-8000-000000000001",
        version: -1,
        value: null,
      },
    ]) {
      const platform = new Platform();
      const store = platform.create();
      await store.readSessionSnapshot();
      platform.states.get(store.storageKey)!.data.set("session", metadata);
      await expect(store.getItem("sdk-cache")).rejects.toThrow();
      expect(platform.writes).toBe(0);
    }
    const platform = new Platform();
    const ceiling = platform.create();
    await ceiling.readSessionSnapshot();
    platform.record(ceiling.storageKey).version = Number.MAX_SAFE_INTEGER;
    const capture = await ceiling.readSessionSnapshot();
    await expect(
      ceiling.compareAndPublish(capture, "overflow"),
    ).rejects.toThrow();
    expect(platform.record(ceiling.storageKey).version).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    const resetPlatform = new Platform();
    const reset = resetPlatform.create();
    await reset.setItem(reset.storageKey, "A");
    resetPlatform.record(reset.storageKey).version = 0;
    await expect(reset.readSessionSnapshot()).rejects.toThrow();
  });

  it("treats cross-tab metadata as a reread hint and rejects malformed channel data", async () => {
    const platform = new Platform();
    const first = platform.create();
    const second = platform.create();
    const notified = vi.fn();
    second.subscribe(notified);
    await first.setItem(first.storageKey, "synthetic-account-session");
    await flush();
    expect(notified).toHaveBeenCalledOnce();
    expect(await second.getItem(second.storageKey)).toBe(
      "synthetic-account-session",
    );
    expect(JSON.stringify(platform.messages)).not.toContain(
      "synthetic-account-session",
    );
    platform.channels[1]!.onmessage?.({
      data: { kind: "session-committed", value: "not-accepted" },
    });
    await expect(second.readSessionSnapshot()).rejects.toThrow();
    expect(await first.getItem(first.storageKey)).toBe(
      "synthetic-account-session",
    );
  });

  it("has no fallback when native APIs, requests or the owned notification channel fail", async () => {
    expect(() =>
      createStaffAuthSessionStorage("https://backend.invalid", {
        indexedDB: null,
      }),
    ).toThrow();
    const platform = new Platform();
    const store = platform.create();
    await store.readSessionSnapshot();
    platform.failNextRequest = true;
    await expect(store.getItem(store.storageKey)).rejects.toThrow();
    const other = platform.create();
    await other.readSessionSnapshot();
    platform.failBroadcast = true;
    await expect(
      other.setItem(other.storageKey, "committed-notification-failed"),
    ).rejects.toMatchObject({ publicationOutcome: "unknown" });
    await expect(other.readSessionSnapshot()).rejects.toThrow();
    expect(platform.record(other.storageKey).value).toBe(
      "committed-notification-failed",
    );
  });
});
