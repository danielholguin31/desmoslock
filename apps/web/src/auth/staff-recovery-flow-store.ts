import type {
  StaffRecoveryFlowConsumeResult,
  StaffRecoveryFlowStore,
} from "./staff-auth-callback.js";

const flowIdPattern = /^[A-Za-z0-9_-]{22}$/;
const bindingPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumFlows = 16;
const maximumLifetimeMilliseconds = 5 * 60 * 1000;
const storageKey = "desmoslock.staff-auth.recovery-flows.v1";

interface ActiveFlow {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly flowId: string;
  readonly kind: "active";
  readonly state: string;
  readonly verifier: string;
}

interface ConsumedFlow {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly flowId: string;
  readonly kind: "consumed";
}

type StoredFlow = ActiveFlow | ConsumedFlow;

export interface StaffRecoveryFlowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Creates the origin-local PKCE store used by the controller. Operations are
 * serialized so a consume removes verifier bytes before its promise resolves.
 */
export function createStaffRecoveryFlowStore(dependencies: {
  readonly clock: { readonly now: () => number };
  readonly crypto: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly storage: StaffRecoveryFlowStorage;
}): StaffRecoveryFlowStore {
  let tail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    create() {
      return serialize(async () => {
        const now = readTime(dependencies.clock);
        const flows = readFlows(dependencies.storage).filter(
          (flow) => flow.expiresAt > now,
        );
        const flowId = randomBase64Url(dependencies.crypto, 16);
        const verifier = randomBase64Url(dependencies.crypto, 32);
        const state = randomBase64Url(dependencies.crypto, 32);
        if (
          !flowIdPattern.test(flowId) ||
          !bindingPattern.test(verifier) ||
          !bindingPattern.test(state) ||
          flows.some((flow) => flow.flowId === flowId)
        ) {
          throw new Error("recovery flow generation unavailable");
        }
        const digest = await dependencies.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        );
        const codeChallenge = encodeBase64Url(new Uint8Array(digest));
        if (!bindingPattern.test(codeChallenge)) {
          throw new Error("recovery challenge generation unavailable");
        }
        const record: ActiveFlow = {
          createdAt: now,
          expiresAt: now + maximumLifetimeMilliseconds,
          flowId,
          kind: "active",
          state,
          verifier,
        };
        writeFlows(
          dependencies.storage,
          [...flows, record].slice(-maximumFlows),
        );
        return { codeChallenge, flowId, state };
      });
    },
    consume(flowId) {
      return serialize(() => {
        if (!flowIdPattern.test(flowId)) {
          return { status: "invalid" } as const;
        }
        const now = readTime(dependencies.clock);
        const flows = readFlows(dependencies.storage);
        const index = flows.findIndex((flow) => flow.flowId === flowId);
        if (index < 0) {
          writeFlows(
            dependencies.storage,
            flows.filter((flow) => flow.expiresAt > now),
          );
          return { status: "invalid" } as const;
        }
        const selected = flows[index];
        if (selected === undefined) {
          throw new Error("recovery flow unavailable");
        }
        if (selected.kind === "consumed") {
          writeFlows(
            dependencies.storage,
            flows.filter((flow) => flow.expiresAt > now),
          );
          return { status: "replayed" } as const;
        }
        const consumed: ConsumedFlow = {
          createdAt: selected.createdAt,
          expiresAt: selected.expiresAt,
          flowId: selected.flowId,
          kind: "consumed",
        };
        const remaining = flows
          .map((flow, flowIndex) => (flowIndex === index ? consumed : flow))
          .filter((flow) => flow.expiresAt > now || flow.flowId === flowId);
        writeFlows(dependencies.storage, remaining);
        const result: StaffRecoveryFlowConsumeResult = {
          expiresAt: selected.expiresAt,
          state: selected.state,
          status: "accepted",
          verifier: selected.verifier,
        };
        return result;
      });
    },
  };
}

function readTime(clock: { readonly now: () => number }): number {
  const now = clock.now();
  if (!Number.isFinite(now)) {
    throw new Error("recovery clock unavailable");
  }
  return now;
}

function readFlows(storage: StaffRecoveryFlowStorage): StoredFlow[] {
  const serialized = storage.getItem(storageKey);
  if (serialized === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("recovery flow storage unavailable");
  }
  if (!Array.isArray(value) || value.length > maximumFlows) {
    throw new Error("recovery flow storage unavailable");
  }
  const decoded = value.map(decodeStoredFlow);
  if (decoded.some((flow) => flow === null)) {
    throw new Error("recovery flow storage unavailable");
  }
  const flows = decoded as StoredFlow[];
  if (new Set(flows.map((flow) => flow.flowId)).size !== flows.length) {
    throw new Error("recovery flow storage unavailable");
  }
  return flows;
}

function writeFlows(
  storage: StaffRecoveryFlowStorage,
  flows: readonly StoredFlow[],
): void {
  storage.setItem(storageKey, JSON.stringify(flows));
}

function decodeStoredFlow(value: unknown): StoredFlow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= record.createdAt ||
    record.expiresAt - record.createdAt > maximumLifetimeMilliseconds ||
    typeof record.flowId !== "string" ||
    !flowIdPattern.test(record.flowId)
  ) {
    return null;
  }
  if (record.kind === "consumed") {
    return keys.length === 4 &&
      ["createdAt", "expiresAt", "flowId", "kind"].every((key) =>
        keys.includes(key),
      )
      ? {
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          flowId: record.flowId,
          kind: "consumed",
        }
      : null;
  }
  if (
    record.kind !== "active" ||
    keys.length !== 6 ||
    !["createdAt", "expiresAt", "flowId", "kind", "state", "verifier"].every(
      (key) => keys.includes(key),
    ) ||
    typeof record.state !== "string" ||
    !bindingPattern.test(record.state) ||
    typeof record.verifier !== "string" ||
    !bindingPattern.test(record.verifier)
  ) {
    return null;
  }
  return {
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    flowId: record.flowId,
    kind: "active",
    state: record.state,
    verifier: record.verifier,
  };
}

function randomBase64Url(
  crypto: Pick<Crypto, "getRandomValues">,
  byteLength: number,
): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >> 18) & 63] ?? "";
    output += alphabet[(combined >> 12) & 63] ?? "";
    output +=
      second === undefined ? "=" : (alphabet[(combined >> 6) & 63] ?? "");
    output += third === undefined ? "=" : (alphabet[combined & 63] ?? "");
  }
  return output.replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}
