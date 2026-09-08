import type {
  StaffAuthSessionSnapshot,
  StaffAuthSessionStorage,
} from "../../src/auth/staff-auth-session-storage.js";

// A synchronous transactional memory seam for installed-SDK tests. Native
// IndexedDB transactions and cross-tab delivery have separate browser gates.
export function createStaffAuthSessionStorageFixture(
  storageKey: string,
  values = new Map<string, string>(),
): StaffAuthSessionStorage {
  const storeGeneration = "e1000000-0000-4000-8000-000000000001";
  const issued = new WeakSet<StaffAuthSessionSnapshot>();
  const listeners = new Set<() => void>();
  let version = 0;
  let disposed = false;
  function ensureAvailable() {
    if (disposed) throw new Error("Synthetic session store is unavailable");
  }
  function matches(snapshot: StaffAuthSessionSnapshot) {
    return (
      issued.has(snapshot) &&
      snapshot.storeGeneration === storeGeneration &&
      snapshot.version === version &&
      snapshot.value === (values.get(storageKey) ?? null)
    );
  }
  return {
    storageKey,
    async getItem(key) {
      ensureAvailable();
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      ensureAvailable();
      values.set(key, value);
      if (key === storageKey) version += 1;
    },
    async removeItem(key) {
      ensureAvailable();
      values.delete(key);
      if (key === storageKey) version += 1;
    },
    async readSessionSnapshot() {
      ensureAvailable();
      const snapshot = Object.freeze({
        storeGeneration,
        version,
        value: values.get(storageKey) ?? null,
      });
      issued.add(snapshot);
      return snapshot;
    },
    async isCurrentSession(snapshot) {
      ensureAvailable();
      return matches(snapshot);
    },
    async compareAndPublish(snapshot, candidate) {
      ensureAvailable();
      if (!matches(snapshot)) return false;
      values.set(storageKey, candidate);
      version += 1;
      for (const listener of listeners) listener();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
