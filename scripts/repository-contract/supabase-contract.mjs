import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fail, readText, requireEqual } from "./shared.mjs";

export const expectedMigrationFiles = Object.freeze([
  "20260824000100_v2_foundation.sql",
  "20260828000100_internal_release_backend.sql",
  "20260903000100_staff_auth_lifecycle.sql",
  "20260903000200_staff_auth_generation_4.sql",
  "20260907000100_staff_auth_callback_completion.sql",
  "20260907000200_runtime_owner_bootstrap.sql",
  "20260907000300_membership_revocation_authority.sql",
  "20260907000400_membership_administration.sql",
  "20260908000100_school_display_name.sql",
  "20260908000200_test_workspace.sql",
]);
export const expectedMigrationSetSha256 =
  "5cf17174bf44e491a6bd78fe540326d8bdee169518d75c8082e5bd9b833f3f62";

const currentAttestationFile = "20260908000200_test_workspace.sql";
export const expectedMigrationAttestations = Object.freeze({
  "20260828000100_internal_release_backend.sql": Object.freeze({
    migrationSetSha256:
      "06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49",
    rawSha256:
      "1a60d2fb308a8e2cfad102f9c218c319bacd95c33a40801d5b0b731119434f2f",
  }),
  "20260903000200_staff_auth_generation_4.sql": Object.freeze({
    migrationSetSha256:
      "ce79427901195258897e0b75c80acfb7b50699eb223af5289cf5d5d59958f2b7",
    rawSha256:
      "4e7321c8d9d6d3e4c27e07ab38d75252a8922868842c40c0723c349c251cac44",
  }),
  "20260907000100_staff_auth_callback_completion.sql": Object.freeze({
    migrationSetSha256:
      "1b499b73aca1ff812cbc244f9eb9908e8dad839ecc6befbcb1a496865a2d5f52",
    rawSha256:
      "79ab31e822b4f04f4148c50bb98446210a37d975a646119b42d78fe1349a8862",
  }),
  "20260907000200_runtime_owner_bootstrap.sql": Object.freeze({
    migrationSetSha256:
      "8d5fd99304ce8bbf9524dfb788080f890ab84565c096a8e6d4faf437a9b734dc",
    rawSha256:
      "43527d889ae0823057bba8ab7b4ed97eb9603220658c59c56cfda70889af75c9",
  }),
  "20260907000300_membership_revocation_authority.sql": Object.freeze({
    migrationSetSha256:
      "e1a9a879948a685a263f24fad98e7fc9a30817fe6ce9461e32fc121080d00a4a",
    rawSha256:
      "9c59c0192b4f960f925db8c64be1c7b2aa6843591d6214a98b29c2bac5a326ad",
  }),
  "20260907000400_membership_administration.sql": Object.freeze({
    migrationSetSha256:
      "7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56",
    rawSha256:
      "078a886cc923b0d9349eca992ebf1d74b06e4bbd302ee165828b4003ca3326a5",
  }),
  "20260908000100_school_display_name.sql": Object.freeze({
    migrationSetSha256:
      "9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538",
    rawSha256:
      "96febd78bbec6859771cb26ae095458553e19ddd75dbc438e99b54ee86549e18",
  }),
  [currentAttestationFile]: Object.freeze({
    migrationSetSha256: expectedMigrationSetSha256,
    rawSha256:
      "233123dd9038740ef724432715cc17e32a5adc2be68160466fa11f5b2dfb865c",
  }),
});
const attestedMigrationFiles = Object.freeze(
  Object.keys(expectedMigrationAttestations),
);
const migrationDigestBegin = "-- desmoslock-migration-set-sha256:begin";
const migrationDigestEnd = "-- desmoslock-migration-set-sha256:end";
const migrationDigestLiteral = /select '([0-9a-f]{64})'::text;/gu;

const expectedAssignments = [
  ["auth", "site_url", '"https://desmoslock.invalid"'],
  ["auth", "additional_redirect_urls", "[]"],
  ["auth", "enable_signup", "false"],
  ["auth", "enable_anonymous_sign_ins", "false"],
  ["auth.email", "enable_confirmations", "true"],
  ["auth.email", "max_frequency", '"1m"'],
  ["auth.email", "otp_length", "8"],
  ["auth.mfa.totp", "enroll_enabled", "true"],
  ["auth.mfa.totp", "verify_enabled", "true"],
];

function sha256(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readSection(configuration, sectionName) {
  const headerPattern = new RegExp(
    `^\\[${escapeRegExp(sectionName)}\\]\\s*$`,
    "mu",
  );
  const header = headerPattern.exec(configuration);
  if (header === null) {
    fail(`Supabase configuration is missing [${sectionName}]`);
  }

  const bodyStart = header.index + header[0].length;
  const remainder = configuration.slice(bodyStart);
  const nextSection = /^\s*\[[^\]]+\]\s*$/mu.exec(remainder);
  return remainder.slice(0, nextSection?.index);
}

export function assertSupabaseAuthConfiguration(configuration) {
  for (const [sectionName, key, expectedValue] of expectedAssignments) {
    const section = readSection(configuration, sectionName);
    const assignmentPattern = new RegExp(
      `^${escapeRegExp(key)}\\s*=\\s*${escapeRegExp(expectedValue)}\\s*$`,
      "gmu",
    );
    if ([...section.matchAll(assignmentPattern)].length !== 1) {
      fail(
        `Supabase [${sectionName}].${key} must be explicitly ${expectedValue}`,
      );
    }
  }
}

function normalizeAttestedMigration(fileName, source) {
  const beginIndex = source.indexOf(migrationDigestBegin);
  const endIndex = source.indexOf(migrationDigestEnd);
  if ((beginIndex === -1) !== (endIndex === -1)) {
    fail(`${fileName} has an incomplete migration-set attestation block`);
  }
  if (beginIndex === -1) return { attested: false, source };
  if (
    beginIndex >= endIndex ||
    source.indexOf(
      migrationDigestBegin,
      beginIndex + migrationDigestBegin.length,
    ) !== -1 ||
    source.indexOf(migrationDigestEnd, endIndex + migrationDigestEnd.length) !==
      -1
  ) {
    fail(`${fileName} has an ambiguous migration-set attestation block`);
  }

  const block = source.slice(beginIndex, endIndex + migrationDigestEnd.length);
  const literals = [...block.matchAll(migrationDigestLiteral)];
  if (literals.length !== 1) {
    fail(`${fileName} must attest exactly one migration-set digest`);
  }
  const expectedAttestation = expectedMigrationAttestations[fileName];
  if (expectedAttestation === undefined) {
    fail(`${fileName} has an unexpected migration-set attestation block`);
  }
  const attestedMigrationSetSha256 = literals[0][1];
  if (attestedMigrationSetSha256 !== expectedAttestation.migrationSetSha256) {
    fail(
      fileName === currentAttestationFile
        ? `${fileName} does not attest the current migration set`
        : `${fileName} does not preserve its historical migration-set attestation`,
    );
  }
  if (sha256(source) !== expectedAttestation.rawSha256) {
    fail(`${fileName} raw migration SHA-256 changed`);
  }

  return {
    attested: true,
    attestedMigrationSetSha256,
    source: `${source.slice(0, beginIndex)}${block.replace(
      attestedMigrationSetSha256,
      "0".repeat(64),
    )}${source.slice(endIndex + migrationDigestEnd.length)}`,
  };
}

export function assertMigrationSetAttestation(migrations) {
  const orderedMigrations = [...migrations].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  requireEqual(
    orderedMigrations.map(([fileName]) => fileName),
    expectedMigrationFiles,
    "Supabase migration files",
  );

  const attested = [];
  const currentAttested = [];
  const inventory = orderedMigrations.map(([fileName, source]) => {
    const normalized = normalizeAttestedMigration(fileName, source);
    if (normalized.attested) {
      attested.push(fileName);
      if (
        normalized.attestedMigrationSetSha256 === expectedMigrationSetSha256
      ) {
        currentAttested.push(fileName);
      }
    }
    return `supabase/migrations/${fileName}\n${crypto
      .createHash("sha256")
      .update(normalized.source, "utf8")
      .digest("hex")}`;
  });
  requireEqual(
    attested,
    attestedMigrationFiles,
    "Supabase migration attestation history",
  );
  requireEqual(
    currentAttested,
    [currentAttestationFile],
    "Supabase current migration-set attestation",
  );

  const observedMigrationSetSha256 = crypto
    .createHash("sha256")
    .update(inventory.join("\n"), "utf8")
    .digest("hex");
  if (observedMigrationSetSha256 !== expectedMigrationSetSha256) {
    fail("Supabase normalized migration-set digest changed");
  }
}

export function verifySupabaseContract(repositoryRoot) {
  assertSupabaseAuthConfiguration(
    readText(repositoryRoot, "supabase/config.toml"),
  );
  const migrationsRoot = path.join(repositoryRoot, "supabase", "migrations");
  assertMigrationSetAttestation(
    fs
      .readdirSync(migrationsRoot)
      .filter((fileName) => fileName.endsWith(".sql"))
      .map((fileName) => [
        fileName,
        fs.readFileSync(path.join(migrationsRoot, fileName), "utf8"),
      ]),
  );
}
