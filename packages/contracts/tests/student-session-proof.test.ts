import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  webcrypto,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  decodeStudentSecretBytes,
  encodeStudentLogicalOperation,
  encodeStudentMaterialDigestInput,
  encodeStudentProofBytes,
  encodeStudentProofEnvelope,
  parseStudentProofOrigin,
} from "../src/student-session-proof.js";

const requestId = "10000000-0000-4000-8000-000000000001";
const deviceSessionId = "20000000-0000-4000-8000-000000000001";
const scope = {
  schoolId: "30000000-0000-4000-8000-000000000001",
  testId: "40000000-0000-4000-8000-000000000001",
  studentSessionId: "50000000-0000-4000-8000-000000000001",
  deviceSessionId,
  epoch: 3,
};
const join = {
  kind: "join",
  admissionMode: "initial",
  requestId,
  deviceSessionId,
  joinMaterialDigest: "a".repeat(64),
  capabilityDigest: "b".repeat(64),
  reconnectDigest: "c".repeat(64),
};
const read = {
  kind: "read",
  requestId,
  scope,
  capabilityDigest: "b".repeat(64),
};
const maintenance = {
  kind: "maintenance",
  apiOrigin: "https://example.com",
  operation: "read",
  requestId,
  scope,
  keyThumbprint: "A".repeat(43),
  logicalOperationDigest: "b".repeat(64),
  counter: 7,
};

function hash(bytes: Uint8Array | null): string {
  if (bytes === null) throw new Error("Expected canonical test bytes");
  return createHash("sha256").update(bytes).digest("hex");
}

describe("StudentSession canonical digest inputs", () => {
  // Independent Python hashlib/json compact-array vectors, not encoder output.
  it.each([
    [join, "0575f8cd2bd0c017b343feafe38d4b08289b9e7838cdc5c15839cd197779ea6f"],
    [
      { ...join, admissionMode: "readmission" },
      "56734a3511fd17ec5fcd5c87238c6b53cf1d748f62cae9669c0c14760f81466d",
    ],
    [read, "7578c34f88b34cbb9087e91194532b4d5dbd10fcf609e625c0851f09b5760e8b"],
    [
      {
        kind: "reconnect",
        requestId,
        scope,
        expectedSessionRevision: 7,
        reconnectDigest: "c".repeat(64),
        nextCapabilityDigest: "d".repeat(64),
        nextReconnectDigest: "e".repeat(64),
      },
      "2915db38f8e19596b7b4caef8d39c13bac4ee99e0628e22ee819203e8ac4e8e4",
    ],
    [
      { ...read, kind: "forfeit", expectedSessionRevision: 7 },
      "b7d90cb1f489775e2d53509c7fc0a460cd9fe42b0c81757f2d5a567c7e946b84",
    ],
  ])("preserves the frozen logical commitment %j", (input, expected) => {
    expect(hash(encodeStudentLogicalOperation(input))).toBe(expected);
  });

  it("hashes decoded secret bytes and separates capability and reconnect domains", () => {
    const syntheticSecret = "A".repeat(43);
    expect(
      hash(encodeStudentMaterialDigestInput("capability", syntheticSecret)),
    ).toBe("f03707f0b808210c4ed2d14af5de53727f6bcf7f57bccc773fd6d33c244ac883");
    expect(
      hash(encodeStudentMaterialDigestInput("reconnectGrant", syntheticSecret)),
    ).toBe("450182271829acb83b7f2d94fa4b785050be6e845f28bc21afbda0cdd1f6e243");
    expect(
      hash(encodeStudentMaterialDigestInput("joinMaterial", "0123456789AB")),
    ).toBe("5c4b9f4b01ced1ab28a3e7971770f230c4c959b103e07120c9537c54c47f205e");
  });

  it.each([
    { ...join, counter: 1 },
    { ...join, deviceProof: {} },
    { ...join, admissionMode: undefined },
    { ...join, admissionMode: "automatic" },
    { ...join, joinMaterialDigest: "A".repeat(64) },
    { ...read, scope: { ...scope, epoch: 0 } },
    { ...read, scope: { ...scope, extra: true } },
    {
      ...read,
      kind: "forfeit",
      expectedSessionRevision: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("rejects malformed or attempt-dependent commitment fields %j", (input) => {
    expect(encodeStudentLogicalOperation(input)).toBeNull();
  });

  it("does not execute input accessors", () => {
    const getter = vi.fn(() => "initial");
    const poisoned = { ...join };
    Object.defineProperty(poisoned, "admissionMode", {
      enumerable: true,
      get: getter,
    });
    expect(encodeStudentLogicalOperation(poisoned)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("StudentSession fixed proof encoding", () => {
  it("keeps nested scope and the exact safe-integer counter in the signed array", () => {
    const bytes = encodeStudentProofEnvelope({
      ...maintenance,
      counter: Number.MAX_SAFE_INTEGER,
    });
    expect(bytes).not.toBeNull();
    const text = new TextDecoder().decode(bytes ?? undefined);
    expect(text).toBe(
      '["desmoslock/student-maintenance-proof/v1","https://example.com","read",' +
        '"10000000-0000-4000-8000-000000000001",["30000000-0000-4000-8000-000000000001",' +
        '"40000000-0000-4000-8000-000000000001","50000000-0000-4000-8000-000000000001",' +
        '"20000000-0000-4000-8000-000000000001",3],"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",' +
        '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",9007199254740991]',
    );
  });

  it("binds bootstrap proof to its challenge, operation and software device before a session exists", () => {
    const envelope = {
      kind: "bootstrap",
      apiOrigin: "https://example.com",
      requestId,
      deviceSessionId,
      keyThumbprint: "A".repeat(43),
      logicalOperationDigest: "b".repeat(64),
      challengeId: "60000000-0000-4000-8000-000000000001",
      expiresAtMs: 123456789,
    };
    const bytes = encodeStudentProofEnvelope(envelope);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes ?? undefined)).toContain(
      '"https://example.com","join","10000000-0000-4000-8000-000000000001",' +
        '"20000000-0000-4000-8000-000000000001"',
    );
    expect(encodeStudentProofEnvelope({ ...envelope, scope })).toBeNull();
    expect(
      hash(encodeStudentProofEnvelope({ ...envelope, expiresAtMs: 123456790 })),
    ).not.toBe(hash(bytes));
  });

  it.each([
    { ...maintenance, counter: 0 },
    { ...maintenance, counter: "7" },
    { ...maintenance, counter: 1.5 },
    { ...maintenance, counter: Number.MAX_SAFE_INTEGER + 1 },
    { ...maintenance, operation: "release" },
    { ...maintenance, keyThumbprint: "A".repeat(42) + "B" },
    { ...maintenance, challengeId: requestId },
    { ...maintenance, apiOrigin: "https://example.com/" },
    { ...maintenance, apiOrigin: "http://example.com" },
    { ...maintenance, apiOrigin: "https://example.com?token=synthetic" },
  ])("rejects noncanonical, broadened or mixed proof fields %j", (input) => {
    expect(encodeStudentProofEnvelope(input)).toBeNull();
  });

  it("uses the selected exact local numeric-loopback exception and staging HTTPS policy", () => {
    expect(
      parseStudentProofOrigin({
        environment: "local",
        url: "http://127.0.0.1:54321",
      }),
    ).toBe("http://127.0.0.1:54321");
    expect(
      parseStudentProofOrigin({
        environment: "local",
        url: "http://[::1]:54321",
      }),
    ).toBe("http://[::1]:54321");
    expect(
      parseStudentProofOrigin({
        environment: "local",
        url: "http://localhost:54321",
      }),
    ).toBeNull();
    expect(
      parseStudentProofOrigin({
        environment: "staging",
        url: "http://127.0.0.1:54321",
      }),
    ).toBeNull();
    expect(
      parseStudentProofOrigin({
        environment: "staging",
        url: "https://example.com",
      }),
    ).toBe("https://example.com");
    expect(
      parseStudentProofOrigin({
        environment: "staging",
        url: "https://example.com:443",
      }),
    ).toBeNull();
  });

  it("round-trips canonical bytes while rejecting alternate trailing bits and padding", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const text = encodeStudentProofBytes(bytes);
    expect(text).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(decodeStudentSecretBytes(text)).toEqual(bytes);
    expect(decodeStudentSecretBytes(`${text}=`)).toBeNull();
    expect(decodeStudentSecretBytes("A".repeat(42) + "B")).toBeNull();
    expect(encodeStudentProofBytes(new Uint8Array(31))).toBeNull();
  });

  it("interoperates between actual Node Ed25519 and Web Crypto and rejects changed authority", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const envelope = encodeStudentProofEnvelope(maintenance);
    if (envelope === null) throw new Error("Expected maintenance envelope");
    const signature = sign(null, envelope, privateKey);
    const spki = publicKey.export({ type: "spki", format: "der" });
    const verifier = await webcrypto.subtle.importKey(
      "spki",
      spki,
      "Ed25519",
      false,
      ["verify"],
    );
    expect(
      await webcrypto.subtle.verify("Ed25519", verifier, signature, envelope),
    ).toBe(true);
    for (const changed of [
      { ...maintenance, counter: 8 },
      { ...maintenance, operation: "reconnect" },
      { ...maintenance, apiOrigin: "https://other.example.com" },
      { ...maintenance, scope: { ...scope, epoch: 4 } },
    ]) {
      const changedEnvelope = encodeStudentProofEnvelope(changed);
      if (changedEnvelope === null)
        throw new Error("Expected changed canonical envelope");
      expect(verify(null, changedEnvelope, publicKey, signature)).toBe(false);
    }
  });
});
