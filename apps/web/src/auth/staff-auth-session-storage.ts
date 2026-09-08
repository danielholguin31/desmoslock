export interface StaffAuthSessionSnapshot {
  readonly storeGeneration: string;
  readonly version: number;
  readonly value: string | null;
}

export interface StaffAuthSessionStorage {
  readonly storageKey: string;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  readSessionSnapshot(): Promise<StaffAuthSessionSnapshot>;
  isCurrentSession(snapshot: StaffAuthSessionSnapshot): Promise<boolean>;
  compareAndPublish(
    snapshot: StaffAuthSessionSnapshot,
    value: string,
  ): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface StaffAuthSessionStoragePlatform {
  readonly indexedDB: Pick<IDBFactory, "open"> | null;
  readonly createBroadcastChannel: (
    name: string,
  ) => Pick<
    BroadcastChannel,
    "onmessage" | "onmessageerror" | "postMessage" | "close"
  >;
  readonly randomUUID: () => string;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
}

export class StaffAuthSessionStorageUnavailableError extends Error {
  readonly publicationOutcome: "not_committed" | "unknown";

  constructor(
    publicationOutcome: "not_committed" | "unknown" = "not_committed",
  ) {
    super(
      publicationOutcome === "unknown"
        ? "Staff session storage unavailable; pending publication outcome is unknown"
        : "Staff session storage unavailable",
    );
    this.name = "StaffAuthSessionStorageUnavailableError";
    this.publicationOutcome = publicationOutcome;
  }
}

const objectStoreName = "entries";
const primaryKey = "session";
const deadlineMilliseconds = 5_000;
const generationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function namespace(backendUrl: string): string {
  const url = new URL(backendUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new StaffAuthSessionStorageUnavailableError();
  }
  return `desmoslock.staff-auth.indexeddb.v1:${encodeURIComponent(url.href.replace(/\/+$/, ""))}`;
}

function isRecord(value: unknown): value is StaffAuthSessionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StaffAuthSessionSnapshot>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.storeGeneration === "string" &&
    generationPattern.test(record.storeGeneration) &&
    typeof record.version === "number" &&
    Number.isSafeInteger(record.version) &&
    record.version >= 0 &&
    (record.value === null || typeof record.value === "string")
  );
}

/** One database per exact backend namespace; no legacy storage is consulted. */
export function createStaffAuthSessionStorage(
  backendUrl: string,
  options: Partial<StaffAuthSessionStoragePlatform> = {},
): StaffAuthSessionStorage {
  const storageKey = namespace(backendUrl);
  const platform = {
    indexedDB:
      options.indexedDB === undefined
        ? globalThis.indexedDB
        : options.indexedDB,
    createBroadcastChannel:
      options.createBroadcastChannel ??
      ((name: string) => new BroadcastChannel(name)),
    randomUUID: options.randomUUID ?? (() => globalThis.crypto.randomUUID()),
    setTimeout: options.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clearTimeout:
      options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis),
  };
  let channel: ReturnType<
    StaffAuthSessionStoragePlatform["createBroadcastChannel"]
  >;
  try {
    if (!platform.indexedDB) throw new Error();
    // GoTrue uses storageKey for its own Auth-event channel. This channel is
    // separate so metadata never enters that protocol (or receives sessions).
    channel = platform.createBroadcastChannel(`${storageKey}:metadata`);
  } catch {
    throw new StaffAuthSessionStorageUnavailableError();
  }
  let failure: StaffAuthSessionStorageUnavailableError | null = null;
  let database: IDBDatabase | null = null;
  let initialization: Promise<IDBDatabase> | null = null;
  let instanceGeneration: string | null = null;
  let instanceVersion = 0;
  const listeners = new Set<() => void>();
  const pending = new Set<() => void>();
  const issuedSnapshots = new WeakSet<StaffAuthSessionSnapshot>();

  function emitLocal() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A consumer cannot affect committed storage. */
      }
    }
  }

  function invalidate() {
    if (failure !== null) return failure;
    failure = new StaffAuthSessionStorageUnavailableError("unknown");
    for (const stop of [...pending]) stop();
    try {
      database?.close();
    } catch {
      /* This instance still remains invalid. */
    }
    channel.onmessage = null;
    channel.onmessageerror = null;
    try {
      channel.close();
    } catch {
      /* No channel is reused after failure. */
    }
    emitLocal();
    listeners.clear();
    return failure;
  }

  function requireLive() {
    if (failure !== null) throw failure;
  }

  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (failure !== null) return;
    if (
      typeof event.data !== "object" ||
      event.data === null ||
      Object.keys(event.data).length !== 1 ||
      (event.data as { kind?: unknown }).kind !== "session-committed"
    ) {
      invalidate();
      return;
    }
    // A notification is only a hint. Consumers must reread IndexedDB authority.
    emitLocal();
  };
  channel.onmessageerror = () => {
    invalidate();
  };

  function openDatabase(): Promise<IDBDatabase> {
    requireLive();
    if (initialization !== null) return initialization;
    initialization = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest | undefined;
      let settled = false;
      const stop = () => {
        if (settled) return;
        settled = true;
        platform.clearTimeout(timer);
        pending.delete(stop);
        try {
          request?.transaction?.abort();
        } catch {
          /* Opening may already have finished. */
        }
        reject(failure ?? invalidate());
      };
      const timer = platform.setTimeout(() => {
        invalidate();
      }, deadlineMilliseconds);
      pending.add(stop);
      try {
        request = platform.indexedDB!.open(storageKey, 1);
        request.onblocked = () => {
          invalidate();
        };
        request.onerror = () => {
          invalidate();
        };
        request.onupgradeneeded = (event) => {
          try {
            requireLive();
            if (event.oldVersion !== 0 || !request) throw new Error();
            const storeGeneration = platform.randomUUID();
            if (!generationPattern.test(storeGeneration)) throw new Error();
            request.result
              .createObjectStore(objectStoreName)
              .put({ storeGeneration, version: 0, value: null }, primaryKey);
          } catch {
            // A timed-out open can receive its upgrade event later. Abort that
            // transaction too, instead of leaving an empty namespace behind.
            try {
              request?.transaction?.abort();
            } catch {
              /* Already finished. */
            }
            try {
              request?.result.close();
            } catch {
              /* No open connection. */
            }
            invalidate();
          }
        };
        request.onsuccess = () => {
          if (!request) return;
          const opened = request.result;
          if (settled || failure !== null) {
            opened.close();
            return;
          }
          database = opened;
          opened.onversionchange = () => {
            invalidate();
          };
          opened.onclose = () => {
            invalidate();
          };
          opened.onerror = () => {
            invalidate();
          };
          if (
            opened.version !== 1 ||
            opened.objectStoreNames.length !== 1 ||
            !opened.objectStoreNames.contains(objectStoreName)
          ) {
            invalidate();
            return;
          }
          settled = true;
          platform.clearTimeout(timer);
          pending.delete(stop);
          resolve(opened);
        };
      } catch {
        invalidate();
      }
    });
    return initialization;
  }

  async function transaction<T>(
    mode: IDBTransactionMode,
    work: (
      store: IDBObjectStore,
      record: StaffAuthSessionSnapshot,
      finish: (result: T, changed?: boolean) => void,
    ) => void,
  ): Promise<T> {
    const opened = await openDatabase();
    requireLive();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction | undefined;
      let finished = false;
      let result: T;
      let hasResult = false;
      let primaryChanged = false;
      const cleanup = () => {
        platform.clearTimeout(timer);
        pending.delete(stop);
      };
      const stop = () => {
        if (finished) return;
        finished = true;
        cleanup();
        try {
          tx?.abort();
        } catch {
          /* Commit may have raced the terminal signal. */
        }
        reject(failure ?? invalidate());
      };
      const timer = platform.setTimeout(() => {
        invalidate();
      }, deadlineMilliseconds);
      pending.add(stop);
      try {
        tx = opened.transaction(objectStoreName, mode);
        tx.onabort = () => {
          // Only this transaction has a confirmed abort. Other pending writes
          // may have committed while their completion events were delayed.
          if (!finished) {
            finished = true;
            cleanup();
            reject(
              new StaffAuthSessionStorageUnavailableError("not_committed"),
            );
          }
          invalidate();
        };
        tx.onerror = () => {
          invalidate();
        };
        tx.oncomplete = () => {
          if (finished) return;
          if (!hasResult || failure !== null) {
            invalidate();
            return;
          }
          finished = true;
          cleanup();
          if (primaryChanged) {
            try {
              channel.postMessage({ kind: "session-committed" });
            } catch {
              reject(invalidate());
              return;
            }
            emitLocal();
          }
          resolve(result);
        };
        const store = tx.objectStore(objectStoreName);
        const request = store.get(primaryKey);
        request.onsuccess = () => {
          try {
            requireLive();
            const record: unknown = request.result;
            if (
              !isRecord(record) ||
              record.version < instanceVersion ||
              (instanceGeneration !== null &&
                instanceGeneration !== record.storeGeneration)
            )
              throw new Error();
            instanceGeneration = record.storeGeneration;
            instanceVersion = record.version;
            work(store, record, (value, changed = false) => {
              result = value;
              hasResult = true;
              primaryChanged = changed;
            });
          } catch {
            invalidate();
          }
        };
      } catch {
        invalidate();
      }
    });
  }

  function matches(
    current: StaffAuthSessionSnapshot,
    expected: StaffAuthSessionSnapshot,
  ) {
    if (!issuedSnapshots.has(expected))
      throw new StaffAuthSessionStorageUnavailableError();
    return (
      current.storeGeneration === expected.storeGeneration &&
      current.version === expected.version &&
      current.value === expected.value
    );
  }

  function replace(
    store: IDBObjectStore,
    current: StaffAuthSessionSnapshot,
    value: string | null,
  ) {
    if (current.version === Number.MAX_SAFE_INTEGER) throw new Error();
    store.put(
      {
        storeGeneration: current.storeGeneration,
        version: current.version + 1,
        value,
      },
      primaryKey,
    );
    instanceVersion = current.version + 1;
  }

  return {
    storageKey,
    async getItem(key) {
      if (typeof key !== "string")
        throw new StaffAuthSessionStorageUnavailableError();
      return transaction("readonly", (store, current, finish) => {
        if (key === storageKey) {
          finish(current.value);
          return;
        }
        const request = store.get(`sdk:${key}`);
        request.onsuccess = () => {
          if (
            request.result === undefined ||
            typeof request.result === "string"
          )
            finish(request.result ?? null);
          else invalidate();
        };
      });
    },
    async setItem(key, value) {
      if (typeof key !== "string" || typeof value !== "string")
        throw new StaffAuthSessionStorageUnavailableError();
      await transaction<void>("readwrite", (store, current, finish) => {
        if (key === storageKey) replace(store, current, value);
        else store.put(value, `sdk:${key}`);
        finish(undefined, key === storageKey);
      });
    },
    async removeItem(key) {
      if (typeof key !== "string")
        throw new StaffAuthSessionStorageUnavailableError();
      await transaction<void>("readwrite", (store, current, finish) => {
        if (key === storageKey) replace(store, current, null);
        else store.delete(`sdk:${key}`);
        finish(undefined, key === storageKey);
      });
    },
    async readSessionSnapshot() {
      return transaction("readonly", (_store, current, finish) => {
        const snapshot = Object.freeze({ ...current });
        issuedSnapshots.add(snapshot);
        finish(snapshot);
      });
    },
    async isCurrentSession(snapshot) {
      return transaction("readonly", (_store, current, finish) => {
        finish(matches(current, snapshot));
      });
    },
    async compareAndPublish(snapshot, value) {
      if (typeof value !== "string")
        throw new StaffAuthSessionStorageUnavailableError();
      return transaction("readwrite", (store, current, finish) => {
        if (!matches(current, snapshot)) {
          finish(false);
          return;
        }
        replace(store, current, value);
        finish(true, true);
      });
    },
    subscribe(listener) {
      requireLive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      invalidate();
    },
  };
}
