import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fail, readText, requireEqual } from "./shared.mjs";

export const expectedMigrationFiles = Object.freeze([
  "20260824000100_v2_foundation.sql",
  "20260828000100_internal_release_backend.sql",
  "20260903000100_staff_auth_lifecycle.sql",
  "20260903000200_staff_auth_generation_4.sql",
]);
export const expectedMigrationSetSha256 =
  "0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66";

const attestedMigrationFiles = Object.freeze([
  "20260828000100_internal_release_backend.sql",
  "20260903000200_staff_auth_generation_4.sql",
]);
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
  if (literals[0][1] !== expectedMigrationSetSha256) {
    fail(`${fileName} does not attest the current migration set`);
  }

  return {
    attested: true,
    source: `${source.slice(0, beginIndex)}${block.replace(
      literals[0][1],
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
  const inventory = orderedMigrations.map(([fileName, source]) => {
    const normalized = normalizeAttestedMigration(fileName, source);
    if (normalized.attested) attested.push(fileName);
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
