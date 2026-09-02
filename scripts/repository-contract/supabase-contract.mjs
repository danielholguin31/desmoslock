import { fail, readText } from "./shared.mjs";

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

export function verifySupabaseContract(repositoryRoot) {
  assertSupabaseAuthConfiguration(
    readText(repositoryRoot, "supabase/config.toml"),
  );
}
