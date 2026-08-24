import { describe, expect, it } from "vitest";

import {
  fingerprintHardwareIdentifier,
  parseTrustedGitHubOrigin,
  verifyGatekeeperAcceptance,
  verifyReleaseProvenance,
} from "@desmoslock/contracts";
import {
  clearStaleLockedState,
  engagePersistedLock,
  releaseRecoveryLock,
  restoreStudentSession,
} from "@desmoslock/domain";

const sourceCommit = "ddcfce456f3cf015ab77d207310140a311c945ab";

interface RedContract {
  readonly id: string;
  readonly assert: () => void | Promise<void>;
}

const lookupError = new Error("controlled unavailable");

const redContracts: readonly RedContract[] = [
  {
    id: "REC-01",
    assert: async () => {
      await expect(restoreStudentSession({ lookupError })).rejects.toThrow(
        /controlled unavailable/,
      );
    },
  },
  {
    id: "REC-02",
    assert: async () => {
      await expect(
        restoreStudentSession({ authError: lookupError }),
      ).rejects.toThrow(/controlled unavailable/);
    },
  },
  {
    id: "REC-03",
    assert: async () => {
      await expect(
        restoreStudentSession({ studentError: lookupError }),
      ).rejects.toThrow(/controlled unavailable/);
    },
  },
  {
    id: "REC-04",
    assert: async () => {
      await expect(
        restoreStudentSession({ testError: lookupError }),
      ).rejects.toThrow(/controlled unavailable/);
    },
  },
  {
    id: "REC-05",
    assert: async () => {
      await expect(
        restoreStudentSession({ students: [], test: null }),
      ).resolves.toBeNull();
    },
  },
  {
    id: "REC-06",
    assert: async () => {
      await expect(
        engagePersistedLock({ before: "stalled-calculator-load" }),
      ).resolves.toBe("locked");
    },
  },
  {
    id: "REC-07",
    assert: async () => {
      await expect(
        engagePersistedLock({ before: "never-resolving-restore" }),
      ).resolves.toBe("locked");
    },
  },
  {
    id: "REC-08",
    assert: async () => {
      await expect(clearStaleLockedState()).resolves.toBe("unlocked");
    },
  },
  {
    id: "REC-09",
    assert: async () => {
      await expect(
        releaseRecoveryLock({ session: "authoritative-missing" }),
      ).resolves.toBeNull();
    },
  },
  {
    id: "PROV-01",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          packageManager:
            "npm@11.12.1+sha512.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ).not.toThrow();
    },
  },
  {
    id: "PROV-02",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({ vendorRebuildJobs: ["build-windows"] }),
      ).toThrow(/canonical/);
    },
  },
  {
    id: "PROV-03",
    assert: () => {
      expect(
        parseTrustedGitHubOrigin(
          "git@github.com:danielholguin31/desmoslock.git",
        ),
      ).toEqual({ owner: "danielholguin31", name: "desmoslock" });
    },
  },
  {
    id: "PROV-04",
    assert: () => {
      expect(() =>
        parseTrustedGitHubOrigin(
          "https://evil.example/danielholguin31/desmoslock",
        ),
      ).toThrow(/ambiguous|redirect|credential|host/i);
    },
  },
  {
    id: "PROV-05",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          sourceRepository: "new-owner/desmoslock",
        }),
      ).not.toThrow();
    },
  },
  {
    id: "PROV-06",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          platform: "windows",
          sourceRepository: "danielholguin31/desmoslock",
          workflowRepository: "danielholguin31/desmoslock",
        }),
      ).not.toThrow();
    },
  },
  {
    id: "PROV-07",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          builtAtUtc: "not-a-date",
          nodeVersion: "latest",
        }),
      ).toThrow(/malformed|utc|version/i);
    },
  },
  {
    id: "PROV-08",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          sourceRepository: "danielholguin31/desmoslock",
          workflowRepository: "other/repo",
        }),
      ).toThrow(/mismatched|identity/i);
    },
  },
  {
    id: "PROV-09",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          runner: { environment: "self-hosted", requestedLabel: "untrusted" },
        }),
      ).toThrow(/untrusted|runner/i);
    },
  },
  {
    id: "PROV-10",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          platform: "macos",
          sourceRepository: "danielholguin31/desmoslock",
        }),
      ).not.toThrow();
    },
  },
  {
    id: "PROV-11",
    assert: () => {
      expect(() => verifyReleaseProvenance({ xcodeSdk: "16.4" })).not.toThrow();
    },
  },
  {
    id: "PROV-12",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({
          platform: "macos",
          sourceRepository: "unrelated/repo",
        }),
      ).toThrow(/macos|malformed|source/i);
    },
  },
  {
    id: "PROV-13",
    assert: () => {
      expect(() =>
        verifyReleaseProvenance({ builtAtUtc: "2026-08-13T12:34:56.789Z" }),
      ).toThrow(/second-precision|utc/i);
    },
  },
  {
    id: "GK-01",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({ role: "mini", scope: "macbook" }),
      ).toThrow(/scope|role/i);
    },
  },
  {
    id: "GK-02",
    assert: () => {
      const fingerprint = fingerprintHardwareIdentifier("serial-ABC-123");
      expect(fingerprint).not.toMatch(/serial-ABC-123/);
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/i);
    },
  },
  {
    id: "GK-03",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          role: "mini",
          hardwareFamily: "windows-pc",
        }),
      ).toThrow(/hardware|mac/i);
    },
  },
  {
    id: "GK-04",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          draftUrl: "https://github.com/example/tokenized",
        }),
      ).toThrow(/credential-free|draft|url/i);
    },
  },
  {
    id: "GK-05",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          draft: { assets: [], hashes: [] },
        }),
      ).toThrow(/asset|hash|size/i);
    },
  },
  {
    id: "GK-06",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          releaseNotes: "disable Gatekeeper and skip Open Anyway",
        }),
      ).toThrow(/disclosure|bypass/i);
    },
  },
  {
    id: "GK-07",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          draft: { draft: true, private: true },
        }),
      ).not.toThrow();
    },
  },
  {
    id: "GK-08",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          draft: { id: "not-numeric" },
        }),
      ).toThrow(/malformed|identity|asset/i);
    },
  },
  {
    id: "GK-09",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          receipts: [{ dialog: false, openAnyway: false, relaunch: false }],
        }),
      ).toThrow(/witnessed|Open Anyway|relaunch/i);
    },
  },
  {
    id: "GK-10",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          checksumText: "out of order",
        }),
      ).toThrow(/checksum|order/i);
    },
  },
  {
    id: "GK-11",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          receipts: [
            { role: "mini", arch: "arm64" },
            { role: "macbook", arch: "arm64", rosetta: true },
          ],
        }),
      ).not.toThrow();
    },
  },
  {
    id: "GK-12",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          receipts: [{ role: "macbook", rosetta: false, launched: false }],
        }),
      ).toThrow(/scope|Rosetta|unwitnessed/i);
    },
  },
  {
    id: "GK-13",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          receipts: [
            { role: "mini", host: "same-mac" },
            { role: "macbook", host: "same-mac" },
          ],
        }),
      ).toThrow(/reused|host/i);
    },
  },
  {
    id: "GK-14",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({
          receipts: [
            { manifestSha256: "aaa", assetSha256: "bbb" },
            { manifestSha256: "ccc", assetSha256: "ddd" },
          ],
        }),
      ).toThrow(/mismatch|hash|manifest|asset/i);
    },
  },
  {
    id: "GK-15",
    assert: () => {
      expect(() =>
        verifyGatekeeperAcceptance({ quarantineMutated: true }),
      ).toThrow(/quarantine|receipt/i);
    },
  },
];

describe(`v2 public-seam red contracts from ${sourceCommit}`, () => {
  it("fails closed for every retained behavior before it is ported", async () => {
    const failedIds: string[] = [];
    const passedIds: string[] = [];

    for (const contract of redContracts) {
      try {
        await contract.assert();
        passedIds.push(contract.id);
      } catch {
        failedIds.push(contract.id);
      }
    }

    expect(
      passedIds,
      "no retained behavior may pass before it is ported",
    ).toEqual([]);
    expect(failedIds).toEqual(redContracts.map((contract) => contract.id));
    expect(failedIds).toHaveLength(37);
  });
});
