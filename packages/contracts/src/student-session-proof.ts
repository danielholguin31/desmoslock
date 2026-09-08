import { parsePublicBackendConfiguration } from "./backend-observation.js";
import { parseExactRecord } from "./exact-record.js";
import {
  parseStudentCounter,
  parseStudentDigest,
  parseStudentJoinCode,
  parseStudentPublicKey,
  parseStudentSecret,
  parseStudentSessionScope,
  parseStudentUuid,
  type StudentAdmissionMode,
  type StudentSessionScope,
} from "./student-session.js";

export const STUDENT_AUTHORITY_DIGEST_DOMAINS = Object.freeze({
  capability: "desmoslock/student-capability-digest/v1",
  reconnectGrant: "desmoslock/student-reconnect-grant-digest/v1",
  joinMaterial: "desmoslock/student-join-material-digest/v1",
  logicalOperation: "desmoslock/student-logical-operation-digest/v1",
} as const);

export type StudentMaintenanceOperation = "read" | "reconnect" | "forfeit";
export type StudentLogicalOperation =
  | {
      readonly kind: "join";
      readonly admissionMode: StudentAdmissionMode;
      readonly requestId: string;
      readonly deviceSessionId: string;
      readonly joinMaterialDigest: string;
      readonly capabilityDigest: string;
      readonly reconnectDigest: string;
    }
  | {
      readonly kind: "reconnect";
      readonly requestId: string;
      readonly scope: StudentSessionScope;
      readonly expectedSessionRevision: number;
      readonly reconnectDigest: string;
      readonly nextCapabilityDigest: string;
      readonly nextReconnectDigest: string;
    }
  | {
      readonly kind: "read";
      readonly requestId: string;
      readonly scope: StudentSessionScope;
      readonly capabilityDigest: string;
    }
  | {
      readonly kind: "forfeit";
      readonly requestId: string;
      readonly scope: StudentSessionScope;
      readonly expectedSessionRevision: number;
      readonly capabilityDigest: string;
    };

export interface StudentBootstrapEnvelope {
  readonly kind: "bootstrap";
  readonly apiOrigin: string;
  readonly requestId: string;
  readonly deviceSessionId: string;
  readonly keyThumbprint: string;
  readonly logicalOperationDigest: string;
  readonly challengeId: string;
  readonly expiresAtMs: number;
}

export interface StudentMaintenanceEnvelope {
  readonly kind: "maintenance";
  readonly apiOrigin: string;
  readonly operation: StudentMaintenanceOperation;
  readonly requestId: string;
  readonly scope: StudentSessionScope;
  readonly keyThumbprint: string;
  readonly logicalOperationDigest: string;
  readonly counter: number;
}

const encoder = new TextEncoder();
const joinKeys = [
  "kind",
  "admissionMode",
  "requestId",
  "deviceSessionId",
  "joinMaterialDigest",
  "capabilityDigest",
  "reconnectDigest",
] as const;
const reconnectKeys = [
  "kind",
  "requestId",
  "scope",
  "expectedSessionRevision",
  "reconnectDigest",
  "nextCapabilityDigest",
  "nextReconnectDigest",
] as const;
const readKeys = ["kind", "requestId", "scope", "capabilityDigest"] as const;
const forfeitKeys = [...readKeys, "expectedSessionRevision"] as const;
const bootstrapEnvelopeKeys = [
  "kind",
  "apiOrigin",
  "requestId",
  "deviceSessionId",
  "keyThumbprint",
  "logicalOperationDigest",
  "challengeId",
  "expiresAtMs",
] as const;
const maintenanceEnvelopeKeys = [
  "kind",
  "apiOrigin",
  "operation",
  "requestId",
  "scope",
  "keyThumbprint",
  "logicalOperationDigest",
  "counter",
] as const;

function scopeArray(scope: StudentSessionScope): readonly (string | number)[] {
  return [
    scope.schoolId,
    scope.testId,
    scope.studentSessionId,
    scope.deviceSessionId,
    scope.epoch,
  ];
}

function prefixedBytes(domain: string, value: Uint8Array): Uint8Array {
  const prefix = encoder.encode(domain);
  const result = new Uint8Array(prefix.length + 1 + value.length);
  result.set(prefix);
  result.set(value, prefix.length + 1);
  return result;
}

function logicalBytes(array: readonly unknown[]): Uint8Array {
  return prefixedBytes(
    STUDENT_AUTHORITY_DIGEST_DOMAINS.logicalOperation,
    encoder.encode(JSON.stringify(array)),
  );
}

export function parseStudentProofOrigin(value: unknown): string | null {
  const record = parseExactRecord(value, ["environment", "url"]);
  if (record === null) return null;
  const parsed = parsePublicBackendConfiguration(record);
  return parsed !== null && parsed.url === record.url ? parsed.url : null;
}

function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return parseStudentProofOrigin({
    environment: value.startsWith("http:") ? "local" : "staging",
    url: value,
  });
}

export function decodeStudentSecretBytes(value: unknown): Uint8Array | null {
  const secret = parseStudentSecret(value);
  if (secret === null) return null;
  try {
    const binary = atob(`${secret.replaceAll("-", "+").replaceAll("_", "/")}=`);
    if (binary.length !== 32) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeStudentProofBytes(value: Uint8Array): string | null {
  if (
    !(value instanceof Uint8Array) ||
    (value.length !== 32 && value.length !== 64)
  )
    return null;
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function encodeStudentMaterialDigestInput(
  purpose: "capability" | "reconnectGrant" | "joinMaterial",
  value: unknown,
): Uint8Array | null {
  if (purpose === "joinMaterial") {
    const code = parseStudentJoinCode(value);
    return code === null
      ? null
      : prefixedBytes(
          STUDENT_AUTHORITY_DIGEST_DOMAINS.joinMaterial,
          encoder.encode(code),
        );
  }
  if (purpose !== "capability" && purpose !== "reconnectGrant") return null;
  const bytes = decodeStudentSecretBytes(value);
  return bytes === null
    ? null
    : prefixedBytes(STUDENT_AUTHORITY_DIGEST_DOMAINS[purpose], bytes);
}

/** Exact digest input; proof attempts never become logical operation fields. */
export function encodeStudentLogicalOperation(
  value: unknown,
): Uint8Array | null {
  const join = parseExactRecord(value, joinKeys);
  if (join !== null && join.kind === "join") {
    const requestId = parseStudentUuid(join.requestId);
    const deviceSessionId = parseStudentUuid(join.deviceSessionId);
    const material = parseStudentDigest(join.joinMaterialDigest);
    const capability = parseStudentDigest(join.capabilityDigest);
    const reconnect = parseStudentDigest(join.reconnectDigest);
    if (
      (join.admissionMode !== "initial" &&
        join.admissionMode !== "readmission") ||
      requestId === null ||
      deviceSessionId === null ||
      material === null ||
      capability === null ||
      reconnect === null
    )
      return null;
    return logicalBytes([
      "join",
      join.admissionMode,
      requestId,
      deviceSessionId,
      material,
      capability,
      reconnect,
    ]);
  }

  const reconnect = parseExactRecord(value, reconnectKeys);
  if (reconnect !== null && reconnect.kind === "reconnect") {
    const requestId = parseStudentUuid(reconnect.requestId);
    const scope = parseStudentSessionScope(reconnect.scope);
    const revision = parseStudentCounter(reconnect.expectedSessionRevision);
    const prior = parseStudentDigest(reconnect.reconnectDigest);
    const capability = parseStudentDigest(reconnect.nextCapabilityDigest);
    const successor = parseStudentDigest(reconnect.nextReconnectDigest);
    if (
      requestId === null ||
      scope === null ||
      revision === null ||
      prior === null ||
      capability === null ||
      successor === null
    )
      return null;
    return logicalBytes([
      "reconnect",
      requestId,
      scopeArray(scope),
      revision,
      prior,
      capability,
      successor,
    ]);
  }

  const read = parseExactRecord(value, readKeys);
  if (read !== null && read.kind === "read") {
    const requestId = parseStudentUuid(read.requestId);
    const scope = parseStudentSessionScope(read.scope);
    const capability = parseStudentDigest(read.capabilityDigest);
    if (requestId === null || scope === null || capability === null)
      return null;
    return logicalBytes(["read", requestId, scopeArray(scope), capability]);
  }

  const forfeit = parseExactRecord(value, forfeitKeys);
  if (forfeit !== null && forfeit.kind === "forfeit") {
    const requestId = parseStudentUuid(forfeit.requestId);
    const scope = parseStudentSessionScope(forfeit.scope);
    const revision = parseStudentCounter(forfeit.expectedSessionRevision);
    const capability = parseStudentDigest(forfeit.capabilityDigest);
    if (
      requestId === null ||
      scope === null ||
      revision === null ||
      capability === null
    )
      return null;
    return logicalBytes([
      "forfeit",
      requestId,
      scopeArray(scope),
      revision,
      capability,
    ]);
  }
  return null;
}

/** Only these two fixed envelopes can reach the main-owned signing adapter. */
export function encodeStudentProofEnvelope(value: unknown): Uint8Array | null {
  const bootstrap = parseExactRecord(value, bootstrapEnvelopeKeys);
  if (bootstrap !== null && bootstrap.kind === "bootstrap") {
    const origin = canonicalOrigin(bootstrap.apiOrigin);
    const requestId = parseStudentUuid(bootstrap.requestId);
    const deviceSessionId = parseStudentUuid(bootstrap.deviceSessionId);
    const key = parseStudentPublicKey(bootstrap.keyThumbprint);
    const digest = parseStudentDigest(bootstrap.logicalOperationDigest);
    const challengeId = parseStudentUuid(bootstrap.challengeId);
    const expiry = parseStudentCounter(bootstrap.expiresAtMs);
    if (
      origin === null ||
      requestId === null ||
      deviceSessionId === null ||
      key === null ||
      digest === null ||
      challengeId === null ||
      expiry === null
    )
      return null;
    return encoder.encode(
      JSON.stringify([
        "desmoslock/student-device-proof/v1",
        origin,
        "join",
        requestId,
        deviceSessionId,
        key,
        digest,
        challengeId,
        expiry,
      ]),
    );
  }
  const maintenance = parseExactRecord(value, maintenanceEnvelopeKeys);
  if (
    maintenance === null ||
    maintenance.kind !== "maintenance" ||
    (maintenance.operation !== "read" &&
      maintenance.operation !== "reconnect" &&
      maintenance.operation !== "forfeit")
  )
    return null;
  const origin = canonicalOrigin(maintenance.apiOrigin);
  const requestId = parseStudentUuid(maintenance.requestId);
  const scope = parseStudentSessionScope(maintenance.scope);
  const key = parseStudentPublicKey(maintenance.keyThumbprint);
  const digest = parseStudentDigest(maintenance.logicalOperationDigest);
  const counter = parseStudentCounter(maintenance.counter);
  if (
    origin === null ||
    requestId === null ||
    scope === null ||
    key === null ||
    digest === null ||
    counter === null
  )
    return null;
  return encoder.encode(
    JSON.stringify([
      "desmoslock/student-maintenance-proof/v1",
      origin,
      maintenance.operation,
      requestId,
      scopeArray(scope),
      key,
      digest,
      counter,
    ]),
  );
}
