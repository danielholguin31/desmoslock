import { createRequire } from "node:module";

import {
  parseStudentCounter,
  parseStudentJoinCode,
  parseStudentSecret,
  parseStudentSessionScope,
  parseStudentUuid,
  type StudentAdmissionMode,
  type StudentSessionScope,
} from "@desmoslock/contracts";

import type {
  StudentSessionCandidates,
  StudentSessionDevice,
} from "./student-session-crypto.js";

export interface StoredStudentAuthority {
  readonly scope: StudentSessionScope;
  readonly sessionRevision: number;
  readonly syntheticDisplayName: string;
  readonly serverNowMs: number;
  readonly capabilityIssuedAtMs: number;
  readonly capabilityExpiresAtMs: number;
  readonly reconnectExpiresAtMs: number;
  readonly capabilityToken: string;
  readonly reconnectGrant: string;
}

export type PendingStudentIntent =
  | {
      readonly kind: "join";
      readonly admissionMode: StudentAdmissionMode;
      readonly requestId: string;
      readonly joinCode: string;
      readonly candidates: StudentSessionCandidates;
    }
  | {
      readonly kind: "reconnect";
      readonly requestId: string;
      readonly expectedSessionRevision: number;
      readonly candidates: StudentSessionCandidates;
    }
  | {
      readonly kind: "forfeit";
      readonly requestId: string;
      readonly expectedSessionRevision: number;
    };

export interface StudentSessionRecord {
  readonly version: 1;
  readonly generation: number;
  readonly apiOrigin: string;
  readonly device: StudentSessionDevice;
  readonly current: StoredStudentAuthority | null;
  readonly pending: PendingStudentIntent | null;
  readonly lastReservedCounter: number;
  readonly terminal: boolean;
}
export type StudentSessionSuccessor = Omit<StudentSessionRecord, "generation">;
export type StudentSessionLoad =
  | { readonly kind: "empty"; readonly generation: number }
  | { readonly kind: "ready"; readonly record: StudentSessionRecord }
  | { readonly kind: "recovery_required"; readonly generation: number }
  | { readonly kind: "unavailable" };

export interface NativeStudentRecordHandle {
  loadEncryptedRecord(): Promise<Buffer | null>;
  replaceEncryptedRecord(ciphertext: Buffer): Promise<void>;
  quarantineEncryptedRecord(): Promise<void>;
  close(): Promise<void>;
}

export interface StudentRecordCodec {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface StudentSessionStore {
  load(): Promise<StudentSessionLoad>;
  commitDurably(
    expectedGeneration: number,
    record: StudentSessionSuccessor,
  ): Promise<StudentSessionRecord>;
  preserveForTargetedRecovery(expectedGeneration: number): Promise<number>;
  close(): Promise<void>;
}

const maximumPlaintextBytes = 48 * 1024;
const maximumCiphertextBytes = 64 * 1024;
const failure = (): Error => new Error("Student session storage unavailable");

// This parser receives only bounded JSON.parse output. It never inspects a
// renderer object or serializes a caller object to discover its fields.
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createStudentSessionStore(options: {
  readonly apiOrigin: string;
  readonly openNativeStore: () => Promise<NativeStudentRecordHandle>;
  readonly codec: StudentRecordCodec;
  readonly validateDevice: (value: unknown) => StudentSessionDevice | null;
  readonly validateCandidates: (
    value: unknown,
  ) => StudentSessionCandidates | null;
}): StudentSessionStore {
  let handle: NativeStudentRecordHandle | null = null;
  let busy = false;
  let closed = false;
  let loaded = false;
  let mustReopen = false;
  let generation = 0;
  let requiresRecovery = false;
  let targetedOnly = false;

  function parseRecord(value: unknown): StudentSessionRecord | null {
    const row = object(value, [
      "version",
      "generation",
      "apiOrigin",
      "device",
      "current",
      "pending",
      "lastReservedCounter",
      "terminal",
    ]);
    if (
      row === null ||
      row.version !== 1 ||
      parseStudentCounter(row.generation) === null ||
      row.apiOrigin !== options.apiOrigin ||
      !natural(row.lastReservedCounter) ||
      typeof row.terminal !== "boolean"
    )
      return null;
    const device = options.validateDevice(row.device);
    if (device === null) return null;
    let current: StoredStudentAuthority | null = null;
    if (row.current !== null) {
      const c = object(row.current, [
        "scope",
        "sessionRevision",
        "syntheticDisplayName",
        "serverNowMs",
        "capabilityIssuedAtMs",
        "capabilityExpiresAtMs",
        "reconnectExpiresAtMs",
        "capabilityToken",
        "reconnectGrant",
      ]);
      if (c === null) return null;
      const scope = parseStudentSessionScope(c.scope);
      const revision = parseStudentCounter(c.sessionRevision);
      const capabilityToken = parseStudentSecret(c.capabilityToken);
      const reconnectGrant = parseStudentSecret(c.reconnectGrant);
      if (
        scope === null ||
        scope.deviceSessionId !== device.deviceSessionId ||
        revision === null ||
        capabilityToken === null ||
        reconnectGrant === null ||
        capabilityToken === reconnectGrant ||
        typeof c.syntheticDisplayName !== "string" ||
        !/^Student [A-Z0-9][A-Z0-9-]{1,23}$/.test(c.syntheticDisplayName) ||
        !natural(c.serverNowMs) ||
        !natural(c.capabilityIssuedAtMs) ||
        !natural(c.capabilityExpiresAtMs) ||
        !natural(c.reconnectExpiresAtMs) ||
        c.capabilityExpiresAtMs - c.capabilityIssuedAtMs !== 300_000 ||
        c.reconnectExpiresAtMs - c.capabilityIssuedAtMs !== 900_000 ||
        c.serverNowMs < c.capabilityIssuedAtMs ||
        c.serverNowMs >= c.reconnectExpiresAtMs
      )
        return null;
      current = {
        scope,
        sessionRevision: revision,
        syntheticDisplayName: c.syntheticDisplayName,
        serverNowMs: c.serverNowMs,
        capabilityIssuedAtMs: c.capabilityIssuedAtMs,
        capabilityExpiresAtMs: c.capabilityExpiresAtMs,
        reconnectExpiresAtMs: c.reconnectExpiresAtMs,
        capabilityToken,
        reconnectGrant,
      };
    }
    let pending: PendingStudentIntent | null = null;
    if (row.pending !== null) {
      const join = object(row.pending, [
        "kind",
        "admissionMode",
        "requestId",
        "joinCode",
        "candidates",
      ]);
      const rotate = object(row.pending, [
        "kind",
        "requestId",
        "expectedSessionRevision",
        "candidates",
      ]);
      const forfeit = object(row.pending, [
        "kind",
        "requestId",
        "expectedSessionRevision",
      ]);
      if (join !== null && join.kind === "join") {
        const requestId = parseStudentUuid(join.requestId);
        const joinCode = parseStudentJoinCode(join.joinCode);
        const candidates = options.validateCandidates(join.candidates);
        if (
          requestId === null ||
          joinCode === null ||
          candidates === null ||
          (join.admissionMode !== "initial" &&
            join.admissionMode !== "readmission") ||
          current !== null ||
          row.lastReservedCounter !== 0
        )
          return null;
        pending = {
          kind: "join",
          admissionMode: join.admissionMode,
          requestId,
          joinCode,
          candidates,
        };
      } else if (rotate !== null && rotate.kind === "reconnect") {
        const requestId = parseStudentUuid(rotate.requestId);
        const expectedSessionRevision = parseStudentCounter(
          rotate.expectedSessionRevision,
        );
        const candidates = options.validateCandidates(rotate.candidates);
        if (
          requestId === null ||
          expectedSessionRevision === null ||
          candidates === null ||
          current === null ||
          expectedSessionRevision !== current.sessionRevision ||
          candidates.capabilityToken === current.capabilityToken ||
          candidates.reconnectGrant === current.reconnectGrant
        )
          return null;
        pending = {
          kind: "reconnect",
          requestId,
          expectedSessionRevision,
          candidates,
        };
      } else if (forfeit !== null && forfeit.kind === "forfeit") {
        const requestId = parseStudentUuid(forfeit.requestId);
        const expectedSessionRevision = parseStudentCounter(
          forfeit.expectedSessionRevision,
        );
        if (
          requestId === null ||
          expectedSessionRevision === null ||
          current === null ||
          expectedSessionRevision !== current.sessionRevision
        )
          return null;
        pending = { kind: "forfeit", requestId, expectedSessionRevision };
      } else return null;
    }
    if (
      row.terminal
        ? current !== null || pending !== null
        : current === null && pending?.kind !== "join"
    )
      return null;
    return {
      version: 1,
      generation: row.generation as number,
      apiOrigin: options.apiOrigin,
      device,
      current,
      pending,
      lastReservedCounter: row.lastReservedCounter,
      terminal: row.terminal,
    };
  }

  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (closed || busy) throw failure();
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  }

  async function lockedHandle(): Promise<NativeStudentRecordHandle> {
    if (mustReopen && handle !== null) {
      await handle.close();
      handle = null;
    }
    handle ??= await options.openNativeStore();
    mustReopen = false;
    return handle;
  }

  return {
    async load() {
      try {
        return await exclusive(async (): Promise<StudentSessionLoad> => {
          loaded = false;
          const native = await lockedHandle();
          if (!options.codec.isEncryptionAvailable())
            return { kind: "unavailable" };
          let ciphertext: Buffer | null;
          try {
            ciphertext = await native.loadEncryptedRecord();
          } catch {
            requiresRecovery = true;
            targetedOnly = true;
            loaded = true;
            return { kind: "recovery_required", generation };
          }
          if (ciphertext === null) {
            generation = 0;
            requiresRecovery = false;
            loaded = true;
            return { kind: "empty", generation };
          }
          try {
            if (
              ciphertext.byteLength === 0 ||
              ciphertext.byteLength > maximumCiphertextBytes
            )
              throw failure();
            const plaintext = options.codec.decryptString(
              Buffer.from(ciphertext),
            );
            if (Buffer.byteLength(plaintext, "utf8") > maximumPlaintextBytes)
              throw failure();
            const record = parseRecord(JSON.parse(plaintext));
            if (record === null) throw failure();
            generation = record.generation;
            requiresRecovery = false;
            loaded = true;
            return { kind: "ready", record };
          } catch {
            requiresRecovery = true;
            targetedOnly = true;
            loaded = true;
            return { kind: "recovery_required", generation };
          }
        });
      } catch {
        return { kind: "unavailable" };
      }
    },
    commitDurably(expectedGeneration, successor) {
      return exclusive(async () => {
        if (
          !loaded ||
          requiresRecovery ||
          mustReopen ||
          handle === null ||
          generation !== expectedGeneration ||
          generation === Number.MAX_SAFE_INTEGER ||
          !options.codec.isEncryptionAvailable()
        )
          throw failure();
        const record = parseRecord({
          ...successor,
          generation: generation + 1,
        });
        if (record === null) throw failure();
        if (
          targetedOnly &&
          (record.current !== null ||
            record.pending?.kind !== "join" ||
            record.pending.admissionMode !== "readmission")
        )
          throw failure();
        const plaintext = JSON.stringify(record);
        if (Buffer.byteLength(plaintext, "utf8") > maximumPlaintextBytes)
          throw failure();
        const ciphertext = options.codec.encryptString(plaintext);
        if (
          !Buffer.isBuffer(ciphertext) ||
          ciphertext.byteLength === 0 ||
          ciphertext.byteLength > maximumCiphertextBytes
        )
          throw failure();
        try {
          await handle.replaceEncryptedRecord(Buffer.from(ciphertext));
        } catch {
          // Publication may already have occurred. Loading the owned slot after
          // reopening recovers its high-water value; only a NEW durable write
          // may authorize another egress, never readback or counter rollback.
          loaded = false;
          mustReopen = true;
          throw failure();
        }
        generation = record.generation;
        targetedOnly = false;
        return record;
      });
    },
    preserveForTargetedRecovery(expectedGeneration) {
      return exclusive(async () => {
        if (
          !loaded ||
          mustReopen ||
          handle === null ||
          generation !== expectedGeneration ||
          generation === Number.MAX_SAFE_INTEGER
        )
          throw failure();
        try {
          await handle.quarantineEncryptedRecord();
        } catch {
          loaded = false;
          mustReopen = true;
          throw failure();
        }
        // This in-memory fence also prevents a late old-record promotion. The
        // next write stores its successor; a crash before it leaves quarantine.
        generation += 1;
        requiresRecovery = false;
        targetedOnly = true;
        return generation;
      });
    },
    async close() {
      if (closed) return;
      await exclusive(async () => {
        await handle?.close();
        handle = null;
        closed = true;
        loaded = false;
      });
    },
  };
}

/** Fixed main-relative addon; paths and descriptors are never IPC inputs. */
export function openNativeStudentRecordStore(
  ownedDirectory: string,
): Promise<NativeStudentRecordHandle> {
  if (process.platform !== "darwin") return Promise.reject(failure());
  try {
    const addon: unknown = createRequire(import.meta.url)(
      "./native/durable-record.node",
    );
    if (
      typeof addon !== "object" ||
      addon === null ||
      !("openStore" in addon) ||
      typeof addon.openStore !== "function"
    )
      return Promise.reject(failure());
    return addon.openStore(
      ownedDirectory,
    ) as Promise<NativeStudentRecordHandle>;
  } catch {
    return Promise.reject(failure());
  }
}
