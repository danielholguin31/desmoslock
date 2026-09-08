import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseStudentJoinCode,
  parseStudentSecret,
  type StudentLogicalOperation,
  type NativeProtectionFact,
  type NativeEvidenceOriginBuild,
} from "@desmoslock/contracts";
import {
  createStudentSessionCrypto,
  type StudentBootstrapSigningInput,
  type StudentMaintenanceSigningInput,
} from "../src/main/student-session-crypto.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:54321",
} as const;
const crypto = createStudentSessionCrypto(configuration);
const requestId = "10000000-0000-4000-8000-000000000001";
const challengeId = "60000000-0000-4000-8000-000000000001";
const fixedDeviceId = "20000000-0000-4000-8000-000000000001";
const scope = {
  schoolId: "30000000-0000-4000-8000-000000000001",
  testId: "40000000-0000-4000-8000-000000000001",
  studentSessionId: "50000000-0000-4000-8000-000000000001",
  deviceSessionId: fixedDeviceId,
  epoch: 3,
};

function evidenceFact(deviceSessionId: string): NativeProtectionFact {
  return {
    sequence: 1,
    eventId: "80000000-0000-4000-8000-000000000001",
    attemptId: "90000000-0000-4000-8000-000000000001",
    scope: { ...scope, deviceSessionId },
    policyVersion: 1,
    slot: "engaging",
    phase: "engaging",
    nativeEvent: null,
    nativeSequence: null,
    categories: {
      aac: { status: "pending", code: "awaiting_native_begin" },
      shortcuts: { status: "confirmed", code: "none" },
      applications: { status: "confirmed", code: "none" },
      persistence: { status: "confirmed", code: "none" },
      windowNetwork: { status: "confirmed", code: "none" },
    },
    cause: "none",
  };
}

describe("original-binding evidence crypto", () => {
  it("matches independent v2 fact and batch arrays for each original build variant", () => {
    const device = crypto.createEnrollment();
    const fact = evidenceFact(device.deviceSessionId);
    const scopeArray = [
      scope.schoolId,
      scope.testId,
      scope.studentSessionId,
      device.deviceSessionId,
      scope.epoch,
    ];
    const origins: readonly NativeEvidenceOriginBuild[] = [
      { kind: "unverified_build" },
      { kind: "legacy_unknown" },
      {
        kind: "build",
        identity: {
          schemaVersion: 1,
          sourceRepository: "danielholguin31/desmoslock",
          sourceCommit: "a".repeat(40),
          sourceTree: "b".repeat(40),
          packageLockSha256: "c".repeat(64),
          buildId: "d".repeat(64),
        },
      },
    ];
    const digests = new Set<string>();
    for (const originBuild of origins) {
      const build =
        originBuild.kind === "build"
          ? [
              "build",
              1,
              "danielholguin31/desmoslock",
              "a".repeat(40),
              "b".repeat(40),
              "c".repeat(64),
              "d".repeat(64),
            ]
          : [originBuild.kind];
      const contentDigest = createHash("sha256")
        .update("desmoslock/native-protection-fact/v1\0")
        .update(
          JSON.stringify([
            1,
            configuration.url,
            device.keyThumbprint,
            scopeArray,
            build,
            [
              1,
              1,
              fact.eventId,
              fact.attemptId,
              "engaging",
              "engaging",
              null,
              null,
              [
                ["pending", "awaiting_native_begin"],
                ["confirmed", "none"],
                ["confirmed", "none"],
                ["confirmed", "none"],
                ["confirmed", "none"],
              ],
              "none",
            ],
          ]),
        )
        .digest("hex");
      const batchDigest = createHash("sha256")
        .update("desmoslock/native-protection-batch/v1\0")
        .update(
          JSON.stringify([
            1,
            configuration.url,
            device.keyThumbprint,
            scopeArray,
            build,
            fact.attemptId,
            [[fact.eventId, contentDigest]],
          ]),
        )
        .digest("hex");
      const result = crypto.digestEvidence(device, {
        scope: fact.scope,
        originBuild,
        facts: [fact],
      });
      expect(result).toEqual({ batchDigest, contentDigests: [contentDigest] });
      expect(Object.isFrozen(result.contentDigests)).toBe(true);
      digests.add(result.batchDigest);
    }
    expect(digests.size).toBe(3);
  });

  it("signs only the original device's domain-separated batch and advances proof independently of content", async () => {
    const device = crypto.createEnrollment();
    const fact = evidenceFact(device.deviceSessionId);
    const input = {
      scope: fact.scope,
      originBuild: { kind: "unverified_build" } as const,
      facts: [fact],
    };
    const content = crypto.digestEvidence(device, input);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(device.publicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    let firstSignature = "";
    for (const counter of [1, 2, Number.MAX_SAFE_INTEGER]) {
      const proof = crypto.signEvidence(device, {
        scope: fact.scope,
        batchDigest: content.batchDigest,
        counter,
      });
      const bytes = Buffer.from(
        JSON.stringify([
          "desmoslock/student-evidence-proof/v1",
          configuration.url,
          "evidence.ingest",
          [
            scope.schoolId,
            scope.testId,
            scope.studentSessionId,
            device.deviceSessionId,
            scope.epoch,
          ],
          device.keyThumbprint,
          content.batchDigest,
          counter,
        ]),
      );
      expect(
        verify(
          null,
          bytes,
          publicKey,
          Buffer.from(proof.signature, "base64url"),
        ),
      ).toBe(true);
      const key = await webcrypto.subtle.importKey(
        "raw",
        Buffer.from(device.publicKey, "base64url"),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      expect(
        await webcrypto.subtle.verify(
          "Ed25519",
          key,
          Buffer.from(proof.signature, "base64url"),
          bytes,
        ),
      ).toBe(true);
      expect(
        verify(
          null,
          Buffer.concat([Buffer.from([0]), bytes]),
          publicKey,
          Buffer.from(proof.signature, "base64url"),
        ),
      ).toBe(false);
      if (firstSignature === "") firstSignature = proof.signature;
      else expect(proof.signature).not.toBe(firstSignature);
      expect(crypto.digestEvidence(device, input)).toEqual(content);
    }
    const replacement = crypto.createEnrollment();
    expect(() =>
      crypto.signEvidence(replacement, {
        scope: fact.scope,
        batchDigest: content.batchDigest,
        counter: 3,
      }),
    ).toThrow("input is invalid");
    expect(() => crypto.digestEvidence(replacement, input)).toThrow(
      "input is invalid",
    );
    for (const counter of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        crypto.signEvidence(device, {
          scope: fact.scope,
          batchDigest: content.batchDigest,
          counter,
        }),
      ).toThrow("input is invalid");
  });

  it("rejects nonfinite content and accessor-backed prefixes without signing or invoking getters", () => {
    const device = crypto.createEnrollment();
    const fact = evidenceFact(device.deviceSessionId);
    const input = {
      scope: fact.scope,
      originBuild: { kind: "unverified_build" } as const,
      facts: [fact],
    };
    const getter = vi.fn(() => fact);
    const accessor = [fact];
    Object.defineProperty(accessor, 0, { get: getter });
    for (const facts of [
      [],
      [fact, fact],
      accessor,
      Object.assign([fact], { extra: true }),
    ])
      expect(() => crypto.digestEvidence(device, { ...input, facts })).toThrow(
        "input is invalid",
      );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      crypto.digestEvidence(device, {
        ...input,
        facts: [{ ...fact, phase: "locked" }],
      }),
    ).toThrow("input is invalid");
  });
});

describe("StudentSession main crypto", () => {
  it("generates and reloads an actual canonical Ed25519 keypair without changing identity", () => {
    const device = crypto.createEnrollment();
    const restored = crypto.validateDevice(JSON.parse(JSON.stringify(device)));
    expect(restored !== null).toBe(true);
    expect(restored?.deviceSessionId).toBe(device.deviceSessionId);
    expect(restored?.publicKey).toBe(device.publicKey);
    expect(restored?.privateKeyPkcs8 === device.privateKeyPkcs8).toBe(true);
    expect(Buffer.from(device.privateKeyPkcs8, "base64url").byteLength).toBe(
      48,
    );
    expect(device.keyThumbprint).toBe(
      createHash("sha256")
        .update(Buffer.from(device.publicKey, "base64url"))
        .digest("base64url"),
    );
    expect(Object.isFrozen(restored)).toBe(true);
    expect(crypto.createEnrollment().publicKey === device.publicKey).toBe(
      false,
    );
  });

  it("rejects corrupt, oversized, noncanonical and mismatched persisted key material before use", () => {
    const device = crypto.createEnrollment();
    const other = crypto.createEnrollment();
    for (const invalid of [
      { ...device, privateKeyPkcs8: `${device.privateKeyPkcs8}=` },
      { ...device, privateKeyPkcs8: "A".repeat(100_000) },
      { ...device, privateKeyPkcs8: "A".repeat(64) },
      { ...device, publicKey: other.publicKey },
      { ...device, keyThumbprint: other.keyThumbprint },
      { ...device, deviceSessionId: device.deviceSessionId.toUpperCase() },
      { ...device, extra: true },
    ])
      expect(crypto.validateDevice(invalid) === null).toBe(true);
    let getterCalls = 0;
    const accessor = { ...device };
    Object.defineProperty(accessor, "privateKeyPkcs8", {
      get() {
        getterCalls += 1;
        return device.privateKeyPkcs8;
      },
    });
    expect(crypto.validateDevice(accessor)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it("creates independent 32-byte candidates and uses decoded-byte domain-separated digests", () => {
    const candidates = crypto.createCandidates();
    expect(parseStudentSecret(candidates.capabilityToken) !== null).toBe(true);
    expect(parseStudentSecret(candidates.reconnectGrant) !== null).toBe(true);
    expect(candidates.capabilityToken === candidates.reconnectGrant).toBe(
      false,
    );
    const expected = createHash("sha256")
      .update("desmoslock/student-capability-digest/v1\0")
      .update(Buffer.from(candidates.capabilityToken, "base64url"))
      .digest("hex");
    expect(candidates.capabilityDigest).toBe(expected);
    expect(crypto.digestCapability(candidates.capabilityToken)).toBe(expected);
    expect(crypto.digestReconnectGrant(candidates.reconnectGrant)).toBe(
      candidates.reconnectDigest,
    );
    expect(candidates.reconnectDigest).toBe(
      createHash("sha256")
        .update("desmoslock/student-reconnect-grant-digest/v1\0")
        .update(Buffer.from(candidates.reconnectGrant, "base64url"))
        .digest("hex"),
    );
    expect(crypto.digestJoinCode("0123456789AB")).toBe(
      "5c4b9f4b01ced1ab28a3e7971770f230c4c959b103e07120c9537c54c47f205e",
    );
    expect(() => crypto.digestJoinCode("0123456789ab")).toThrow(
      "input is invalid",
    );
    for (let index = 0; index < 32; index += 1)
      expect(parseStudentJoinCode(crypto.createJoinCode()) !== null).toBe(true);
  });

  it("validates persisted candidates against both exact domain commitments", () => {
    const candidates = crypto.createCandidates();
    expect(crypto.validateCandidates(candidates) !== null).toBe(true);
    for (const invalid of [
      { ...candidates, capabilityDigest: candidates.reconnectDigest },
      {
        ...candidates,
        reconnectGrant: candidates.capabilityToken,
        reconnectDigest: crypto.digestReconnectGrant(
          candidates.capabilityToken,
        ),
      },
      { ...candidates, reconnectGrant: `${candidates.reconnectGrant}=` },
      { ...candidates, capabilityToken: "A".repeat(100_000) },
      { ...candidates, extra: true },
    ])
      expect(crypto.validateCandidates(invalid)).toBeNull();
  });

  it("matches independent canonical logical-operation vectors and rejects attempt fields", () => {
    const join: StudentLogicalOperation = {
      kind: "join",
      admissionMode: "initial",
      requestId,
      deviceSessionId: fixedDeviceId,
      joinMaterialDigest: "a".repeat(64),
      capabilityDigest: "b".repeat(64),
      reconnectDigest: "c".repeat(64),
    };
    expect(crypto.digestLogicalOperation(join)).toBe(
      "0575f8cd2bd0c017b343feafe38d4b08289b9e7838cdc5c15839cd197779ea6f",
    );
    expect(
      crypto.digestLogicalOperation({ ...join, admissionMode: "readmission" }),
    ).toBe("56734a3511fd17ec5fcd5c87238c6b53cf1d748f62cae9669c0c14760f81466d");
    expect(
      crypto.digestLogicalOperation({
        kind: "read",
        requestId,
        scope,
        capabilityDigest: "b".repeat(64),
      }),
    ).toBe("7578c34f88b34cbb9087e91194532b4d5dbd10fcf609e625c0851f09b5760e8b");
    expect(() =>
      crypto.digestLogicalOperation({
        ...join,
        counter: 1,
      } as StudentLogicalOperation),
    ).toThrow("input is invalid");
  });

  it("signs the independent bootstrap array and verifies using real Node and WebCrypto", async () => {
    const device = crypto.createEnrollment();
    const input: StudentBootstrapSigningInput = {
      kind: "bootstrap",
      requestId,
      deviceSessionId: device.deviceSessionId,
      logicalOperationDigest: "a".repeat(64),
      challengeId,
      expiresAtMs: 1_800_000_015_000,
    };
    const proof = crypto.signBootstrap(device, input);
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        "desmoslock/student-device-proof/v1",
        configuration.url,
        "join",
        requestId,
        device.deviceSessionId,
        device.keyThumbprint,
        input.logicalOperationDigest,
        challengeId,
        input.expiresAtMs,
      ]),
    );
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(device.publicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(
      verify(null, bytes, publicKey, Buffer.from(proof.signature, "base64url")),
    ).toBe(true);
    const webKey = await webcrypto.subtle.importKey(
      "raw",
      Uint8Array.from(Buffer.from(device.publicKey, "base64url")),
      "Ed25519",
      false,
      ["verify"],
    );
    expect(
      await webcrypto.subtle.verify(
        "Ed25519",
        webKey,
        Uint8Array.from(Buffer.from(proof.signature, "base64url")),
        bytes,
      ),
    ).toBe(true);
    expect(proof.publicKey).toBe(device.publicKey);
    expect(() =>
      crypto.signBootstrap(device, {
        ...input,
        deviceSessionId: fixedDeviceId,
      }),
    ).toThrow("input is invalid");
    expect(() =>
      crypto.signBootstrap(device, {
        ...input,
        apiOrigin: "https://other.invalid",
      } as StudentBootstrapSigningInput),
    ).toThrow("input is invalid");
  });

  it("binds maintenance signatures to stored key, exact origin, operation, scope, epoch and counter", () => {
    const device = crypto.createEnrollment();
    const ownScope = { ...scope, deviceSessionId: device.deviceSessionId };
    const input: StudentMaintenanceSigningInput = {
      kind: "maintenance",
      operation: "read",
      requestId,
      scope: ownScope,
      logicalOperationDigest: "b".repeat(64),
      counter: Number.MAX_SAFE_INTEGER,
    };
    const proof = crypto.signMaintenance(device, input);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(device.publicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    const base: unknown[] = [
      "desmoslock/student-maintenance-proof/v1",
      configuration.url,
      "read",
      requestId,
      [
        ownScope.schoolId,
        ownScope.testId,
        ownScope.studentSessionId,
        ownScope.deviceSessionId,
        ownScope.epoch,
      ],
      device.keyThumbprint,
      input.logicalOperationDigest,
      Number.MAX_SAFE_INTEGER,
    ];
    const check = (array: unknown[]) =>
      verify(
        null,
        Buffer.from(JSON.stringify(array)),
        publicKey,
        Buffer.from(proof.signature, "base64url"),
      );
    expect(check(base)).toBe(true);
    for (const [index, replacement] of [
      [1, "https://other.invalid"],
      [2, "forfeit"],
      [7, 1],
      [5, crypto.createEnrollment().keyThumbprint],
    ] as const) {
      const changed = [...base];
      changed[index] = replacement;
      expect(check(changed)).toBe(false);
    }
    const changedEpoch = [...base];
    changedEpoch[4] = [
      ownScope.schoolId,
      ownScope.testId,
      ownScope.studentSessionId,
      ownScope.deviceSessionId,
      4,
    ];
    expect(check(changedEpoch)).toBe(false);
    expect(() =>
      crypto.signMaintenance(device, { ...input, counter: 0 }),
    ).toThrow("input is invalid");
    expect(() => crypto.signMaintenance(device, { ...input, scope })).toThrow(
      "input is invalid",
    );
  });

  it("captures exact configuration and rejects downgrade, normalization and caller-selected routes", () => {
    for (const configuration of [
      { environment: "local", url: "http://localhost:54321" },
      { environment: "local", url: "http://127.0.0.1:54321/" },
      { environment: "staging", url: "http://api.example.invalid" },
      {
        environment: "staging",
        url: "https://api.example.invalid/functions/v1",
      },
      { environment: "staging", url: "https://user:pass@api.example.invalid" },
    ] as const)
      expect(() => createStudentSessionCrypto(configuration)).toThrow(
        "configuration is invalid",
      );
  });
});
