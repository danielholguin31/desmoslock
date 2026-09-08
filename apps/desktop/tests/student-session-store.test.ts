import { describe, expect, it } from "vitest";

import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  type NativeStudentRecordHandle,
  type StudentSessionSuccessor,
} from "../src/main/student-session-store.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:43175",
} as const;
const crypto = createStudentSessionCrypto(configuration);
const requestId = "10000000-0000-4000-8000-000000000001";

function pending(): StudentSessionSuccessor {
  return {
    version: 1,
    apiOrigin: configuration.url,
    device: crypto.createEnrollment(),
    current: null,
    pending: {
      kind: "join",
      admissionMode: "initial",
      requestId,
      joinCode: "0123456789AB",
      candidates: crypto.createCandidates(),
    },
    lastReservedCounter: 0,
    terminal: false,
  };
}

function fixture() {
  let bytes: Buffer | null = null;
  let writeFailure: "none" | "before" | "after" = "none";
  let quarantineFailure = false;
  let blockedWrite: Promise<void> | null = null;
  const preserved: Buffer[] = [];
  const events: string[] = [];
  const native: NativeStudentRecordHandle = {
    async loadEncryptedRecord() {
      events.push("load");
      if (bytes === null && preserved.length > 0)
        throw new Error("STORE_RECOVERY_REQUIRED");
      return bytes === null ? null : Buffer.from(bytes);
    },
    async replaceEncryptedRecord(value) {
      events.push("write");
      if (blockedWrite !== null) await blockedWrite;
      if (writeFailure === "before") throw new Error("before");
      bytes = Buffer.from(value);
      if (writeFailure === "after") throw new Error("after");
      events.push("barrier");
    },
    async quarantineEncryptedRecord() {
      events.push("quarantine");
      if (quarantineFailure) throw new Error("quarantine");
      if (bytes !== null) preserved.push(Buffer.from(bytes));
      bytes = null;
    },
    async close() {
      events.push("close");
    },
  };
  const options = {
    apiOrigin: configuration.url,
    openNativeStore: async () => {
      events.push("lock");
      return native;
    },
    codec: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => {
        events.push("encrypt");
        return Buffer.from(`synthetic:${value}`);
      },
      decryptString: (value: Buffer) => {
        events.push("decrypt");
        if (!value.toString().startsWith("synthetic:"))
          throw new Error("invalid");
        return value.toString().slice(10);
      },
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  };
  return {
    store: createStudentSessionStore(options),
    options,
    events,
    preserved,
    setBytes(value: Buffer) {
      bytes = value;
    },
    getBytes: () => (bytes === null ? null : Buffer.from(bytes)),
    fail(value: typeof writeFailure) {
      writeFailure = value;
    },
    failQuarantine() {
      quarantineFailure = true;
    },
    blockWrite(value: Promise<void>) {
      blockedWrite = value;
    },
  };
}

describe("private Student record durability adapter (synthetic codec/native)", () => {
  it("locks before loading or decrypting, writes one bounded encrypted successor, and reloads exact private intent", async () => {
    const f = fixture();
    expect(await f.store.load()).toEqual({ kind: "empty", generation: 0 });
    const intended = pending();
    const written = await f.store.commitDurably(0, intended);
    expect(written.generation).toBe(1);
    expect(f.events).toEqual(["lock", "load", "encrypt", "write", "barrier"]);
    expect(await f.store.load()).toEqual({ kind: "ready", record: written });
    expect(f.events.indexOf("lock")).toBeLessThan(f.events.indexOf("decrypt"));
    await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
    expect(f.events.filter((v) => v === "write")).toHaveLength(1);
  });

  it.each(["before", "after"] as const)(
    "does not treat %s-publication failure or readback as a successful barrier",
    async (stage) => {
      const f = fixture();
      await f.store.load();
      const intended = pending();
      f.fail(stage);
      await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
      await expect(f.store.commitDurably(0, intended)).rejects.toThrow();
      const loaded = await f.store.load();
      expect(loaded.kind).toBe(stage === "before" ? "empty" : "ready");
      const generation = loaded.kind === "ready" ? loaded.record.generation : 0;
      f.fail("none");
      await f.store.commitDurably(generation, intended);
      expect(f.events.filter((v) => v === "barrier")).toHaveLength(1);
      expect(f.events.filter((v) => v === "lock")).toHaveLength(2);
    },
  );

  it("rejects a second write and close while a complete native write is pending", async () => {
    const f = fixture();
    await f.store.load();
    let release: (() => void) | undefined;
    f.blockWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const first = f.store.commitDurably(0, pending());
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    await expect(f.store.close()).rejects.toThrow();
    expect(f.events).not.toContain("close");
    release?.();
    await first;
    await f.store.close();
    expect(f.events.at(-1)).toBe("close");
  });

  it("retains corrupt bytes and requires successful quarantine before targeted pending publication", async () => {
    const f = fixture();
    const corrupt = Buffer.from("unreadable-preserved-artifact");
    f.setBytes(corrupt);
    expect(await f.store.load()).toEqual({
      kind: "recovery_required",
      generation: 0,
    });
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    const nextGeneration = await f.store.preserveForTargetedRecovery(0);
    expect(f.preserved).toEqual([corrupt]);
    await expect(
      f.store.commitDurably(nextGeneration, pending()),
    ).rejects.toThrow();
    const next = pending();
    if (next.pending?.kind !== "join") throw new Error("fixture");
    const targeted = {
      ...next,
      pending: { ...next.pending, admissionMode: "readmission" as const },
    };
    await f.store.commitDurably(nextGeneration, targeted);
    expect(f.preserved).toEqual([corrupt]);
  });

  it("retains targeted-only recovery after the quarantine-to-pending crash gap", async () => {
    const f = fixture();
    f.setBytes(Buffer.from("corrupt"));
    await f.store.load();
    await f.store.preserveForTargetedRecovery(0);
    await f.store.close();
    const restarted = createStudentSessionStore(f.options);
    expect(await restarted.load()).toEqual({
      kind: "recovery_required",
      generation: 0,
    });
    await expect(restarted.commitDurably(0, pending())).rejects.toThrow();
  });

  it("failed quarantine preserves artifact and cannot open an initial-admission path", async () => {
    const f = fixture();
    const corrupt = Buffer.from("corrupt");
    f.setBytes(corrupt);
    await f.store.load();
    f.failQuarantine();
    await expect(f.store.preserveForTargetedRecovery(0)).rejects.toThrow();
    await expect(f.store.commitDurably(0, pending())).rejects.toThrow();
    expect(f.getBytes()).toEqual(corrupt);
  });

  it.each([
    "version",
    "origin",
    "key",
    "candidate",
    "extra",
    "counter",
    "mode",
  ])(
    "rejects noncanonical persisted %s without overwriting bytes",
    async (kind) => {
      const f = fixture();
      const base = { ...pending(), generation: 1 };
      const mutated =
        kind === "version"
          ? { ...base, version: 2 }
          : kind === "origin"
            ? { ...base, apiOrigin: "https://other.example" }
            : kind === "key"
              ? {
                  ...base,
                  device: { ...base.device, privateKeyPkcs8: "invalid" },
                }
              : kind === "candidate" && base.pending?.kind === "join"
                ? {
                    ...base,
                    pending: {
                      ...base.pending,
                      candidates: {
                        ...base.pending.candidates,
                        capabilityDigest: "0".repeat(64),
                      },
                    },
                  }
                : kind === "counter"
                  ? { ...base, lastReservedCounter: 1 }
                  : kind === "mode" && base.pending?.kind === "join"
                    ? {
                        ...base,
                        pending: {
                          ...base.pending,
                          admissionMode: "automatic",
                        },
                      }
                    : { ...base, extra: true };
      const original = Buffer.from(`synthetic:${JSON.stringify(mutated)}`);
      f.setBytes(original);
      expect((await f.store.load()).kind).toBe("recovery_required");
      expect(f.getBytes()).toEqual(original);
      expect(f.events).not.toContain("write");
    },
  );

  it("fails closed before record access when native lock or encryption is unavailable", async () => {
    const f = fixture();
    const noLock = createStudentSessionStore({
      ...f.options,
      openNativeStore: async () => {
        throw new Error("in use");
      },
    });
    expect((await noLock.load()).kind).toBe("unavailable");
    const noCodec = createStudentSessionStore({
      ...f.options,
      codec: { ...f.options.codec, isEncryptionAvailable: () => false },
    });
    expect((await noCodec.load()).kind).toBe("unavailable");
    expect(f.events).toEqual(["lock"]);
  });
});
