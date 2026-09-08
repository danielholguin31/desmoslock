import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  encodeStudentLogicalOperation,
  encodeStudentMaterialDigestInput,
  encodeStudentProofEnvelope,
  parseStudentProofOrigin,
  parseStudentPublicKey,
  parseStudentSecret,
  parseStudentSessionScope,
  parseStudentUuid,
  type PublicBackendConfiguration,
  type StudentBootstrapEnvelope,
  type StudentBootstrapProof,
  type StudentLogicalOperation,
  type StudentMaintenanceEnvelope,
  type StudentMaintenanceProof,
} from "@desmoslock/contracts";

/** Main-only material. The private key belongs exclusively in the encrypted record. */
export interface StudentSessionDevice {
  readonly deviceSessionId: string;
  readonly publicKey: string;
  readonly privateKeyPkcs8: string;
  readonly keyThumbprint: string;
}

export interface StudentSessionCandidates {
  readonly capabilityToken: string;
  readonly reconnectGrant: string;
  readonly capabilityDigest: string;
  readonly reconnectDigest: string;
}

export type StudentBootstrapSigningInput = Omit<
  StudentBootstrapEnvelope,
  "apiOrigin" | "keyThumbprint"
>;
export type StudentMaintenanceSigningInput = Omit<
  StudentMaintenanceEnvelope,
  "apiOrigin" | "keyThumbprint"
>;

export interface StudentSessionCrypto {
  createEnrollment(): StudentSessionDevice;
  createCandidates(): StudentSessionCandidates;
  createJoinCode(): string;
  digestJoinCode(code: string): string;
  digestCapability(token: string): string;
  digestReconnectGrant(grant: string): string;
  digestLogicalOperation(operation: StudentLogicalOperation): string;
  signBootstrap(
    device: StudentSessionDevice,
    envelope: StudentBootstrapSigningInput,
  ): StudentBootstrapProof;
  signMaintenance(
    device: StudentSessionDevice,
    envelope: StudentMaintenanceSigningInput,
  ): StudentMaintenanceProof;
  validateDevice(device: unknown): StudentSessionDevice | null;
  validateCandidates(candidates: unknown): StudentSessionCandidates | null;
}

const privatePrefix = Buffer.from("302e020100300506032b657004220420", "hex");
const publicPrefix = Buffer.from("302a300506032b6570032100", "hex");
const deviceKeys = [
  "deviceSessionId",
  "publicKey",
  "privateKeyPkcs8",
  "keyThumbprint",
] as const;
const candidateKeys = [
  "capabilityToken",
  "reconnectGrant",
  "capabilityDigest",
  "reconnectDigest",
] as const;
const bootstrapKeys = [
  "kind",
  "requestId",
  "deviceSessionId",
  "logicalOperationDigest",
  "challengeId",
  "expiresAtMs",
] as const;
const maintenanceKeys = [
  "kind",
  "operation",
  "requestId",
  "scope",
  "logicalOperationDigest",
  "counter",
] as const;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function invalidInput(): Error {
  // Never include key, credential, envelope or parser exception data.
  return new Error("Student session crypto input is invalid");
}

function exactSnapshot(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function rawPublicKey(privateKey: KeyObject): Buffer {
  const encoded = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  if (
    encoded.length !== 44 ||
    !encoded.subarray(0, publicPrefix.length).equals(publicPrefix)
  )
    throw invalidInput();
  return encoded.subarray(publicPrefix.length);
}

function importDevice(value: unknown): {
  device: StudentSessionDevice;
  privateKey: KeyObject;
} | null {
  const row = exactSnapshot(value, deviceKeys);
  if (row === null) return null;
  const deviceSessionId = parseStudentUuid(row.deviceSessionId);
  const publicKey = parseStudentPublicKey(row.publicKey);
  const keyThumbprint = parseStudentPublicKey(row.keyThumbprint);
  const encoded = row.privateKeyPkcs8;
  if (
    deviceSessionId === null ||
    publicKey === null ||
    keyThumbprint === null ||
    typeof encoded !== "string" ||
    encoded.length !== 64 ||
    !/^[A-Za-z0-9_-]{64}$/u.test(encoded)
  )
    return null;
  try {
    // Bound and check this one canonical Ed25519 seed encoding before import.
    const der = Buffer.from(encoded, "base64url");
    if (
      der.length !== 48 ||
      !der.subarray(0, privatePrefix.length).equals(privatePrefix) ||
      der.toString("base64url") !== encoded
    )
      return null;
    const privateKey = createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const raw = rawPublicKey(privateKey);
    if (
      raw.toString("base64url") !== publicKey ||
      createHash("sha256").update(raw).digest("base64url") !== keyThumbprint
    )
      return null;
    return {
      device: Object.freeze({
        deviceSessionId,
        publicKey,
        privateKeyPkcs8: encoded,
        keyThumbprint,
      }),
      privateKey,
    };
  } catch {
    return null;
  }
}

function digest(bytes: Uint8Array | null): string {
  if (bytes === null) throw invalidInput();
  return createHash("sha256").update(bytes).digest("hex");
}

export function createStudentSessionCrypto(
  configuration: PublicBackendConfiguration,
): StudentSessionCrypto {
  const apiOrigin = parseStudentProofOrigin(configuration);
  if (apiOrigin === null)
    throw new Error("Student session backend configuration is invalid");

  return Object.freeze({
    createEnrollment() {
      const { privateKey } = generateKeyPairSync("ed25519");
      const publicKey = rawPublicKey(privateKey);
      return Object.freeze({
        deviceSessionId: randomUUID(),
        publicKey: publicKey.toString("base64url"),
        privateKeyPkcs8: privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64url"),
        keyThumbprint: createHash("sha256")
          .update(publicKey)
          .digest("base64url"),
      });
    },
    createCandidates() {
      const capabilityToken = randomBytes(32).toString("base64url");
      const reconnectGrant = randomBytes(32).toString("base64url");
      if (capabilityToken === reconnectGrant)
        throw new Error("Student session crypto is unavailable");
      return Object.freeze({
        capabilityToken,
        reconnectGrant,
        capabilityDigest: digest(
          encodeStudentMaterialDigestInput("capability", capabilityToken),
        ),
        reconnectDigest: digest(
          encodeStudentMaterialDigestInput("reconnectGrant", reconnectGrant),
        ),
      });
    },
    createJoinCode() {
      // Every symbol receives exactly eight of 256 byte values: no modulo bias.
      return Array.from(randomBytes(12), (byte) => alphabet[byte & 31]).join(
        "",
      );
    },
    digestJoinCode(code: string) {
      return digest(encodeStudentMaterialDigestInput("joinMaterial", code));
    },
    digestCapability(token: string) {
      return digest(encodeStudentMaterialDigestInput("capability", token));
    },
    digestReconnectGrant(grant: string) {
      return digest(encodeStudentMaterialDigestInput("reconnectGrant", grant));
    },
    digestLogicalOperation(operation: StudentLogicalOperation) {
      return digest(encodeStudentLogicalOperation(operation));
    },
    signBootstrap(
      device: StudentSessionDevice,
      envelope: StudentBootstrapSigningInput,
    ) {
      const imported = importDevice(device);
      const input = exactSnapshot(envelope, bootstrapKeys);
      if (
        imported === null ||
        input === null ||
        input.deviceSessionId !== imported.device.deviceSessionId
      )
        throw invalidInput();
      const bytes = encodeStudentProofEnvelope({
        ...input,
        apiOrigin,
        keyThumbprint: imported.device.keyThumbprint,
      });
      if (bytes === null || input.kind !== "bootstrap") throw invalidInput();
      return Object.freeze({
        challengeId: String(input.challengeId),
        expiresAtMs: Number(input.expiresAtMs),
        publicKey: imported.device.publicKey,
        signature: sign(null, bytes, imported.privateKey).toString("base64url"),
      });
    },
    signMaintenance(
      device: StudentSessionDevice,
      envelope: StudentMaintenanceSigningInput,
    ) {
      const imported = importDevice(device);
      const input = exactSnapshot(envelope, maintenanceKeys);
      if (imported === null || input === null) throw invalidInput();
      const scope = parseStudentSessionScope(input.scope);
      if (
        scope === null ||
        scope.deviceSessionId !== imported.device.deviceSessionId
      )
        throw invalidInput();
      const bytes = encodeStudentProofEnvelope({
        ...input,
        scope,
        apiOrigin,
        keyThumbprint: imported.device.keyThumbprint,
      });
      if (bytes === null || input.kind !== "maintenance") throw invalidInput();
      return Object.freeze({
        counter: Number(input.counter),
        signature: sign(null, bytes, imported.privateKey).toString("base64url"),
      });
    },
    validateDevice(device: unknown) {
      return importDevice(device)?.device ?? null;
    },
    validateCandidates(candidates: unknown) {
      const input = exactSnapshot(candidates, candidateKeys);
      if (input === null) return null;
      const capabilityToken = parseStudentSecret(input.capabilityToken);
      const reconnectGrant = parseStudentSecret(input.reconnectGrant);
      if (
        capabilityToken === null ||
        reconnectGrant === null ||
        capabilityToken === reconnectGrant
      )
        return null;
      const capabilityDigest = digest(
        encodeStudentMaterialDigestInput("capability", capabilityToken),
      );
      const reconnectDigest = digest(
        encodeStudentMaterialDigestInput("reconnectGrant", reconnectGrant),
      );
      if (
        capabilityDigest !== input.capabilityDigest ||
        reconnectDigest !== input.reconnectDigest
      )
        return null;
      return Object.freeze({
        capabilityToken,
        reconnectGrant,
        capabilityDigest,
        reconnectDigest,
      });
    },
  });
}
