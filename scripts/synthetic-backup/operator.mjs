import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_MIGRATION_SET_SHA256 =
  "80c2720ff352c721298e5814715374bf9e2a9c1152bbf2d2761ad781265f8701";
export const CURRENT_MIGRATION_FILES = Object.freeze([
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
  "20260908000300_student_session_admission.sql",
  "20260908000400_student_protection_evidence.sql",
]);
export const CURRENT_MIGRATION_VERSIONS = Object.freeze(
  CURRENT_MIGRATION_FILES.map((fileName) => fileName.slice(0, 14)),
);
export const SYNTHETIC_TABLES = Object.freeze([
  "baseline_fixture_state",
  "foundation_seed",
  "memberships",
  "profiles",
  "student_sessions",
  "tests",
  "workspaces",
]);

const FIXTURE_DIGEST =
  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201";
const FIXTURE_COUNTS = Object.freeze({
  baselineFixtureState: 1,
  foundationSeed: 1,
  memberships: 6,
  profiles: 6,
  studentSessions: 2,
  tests: 2,
  workspaces: 2,
});
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PUBLICATION_STATUS_BYTES = 64;
const PUBLICATION_TIMEOUT_MS = 30_000;
const PUBLICATION_WORKER_PATH = fileURLToPath(
  new URL("./publication-worker.mjs", import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOT_DESCRIPTOR_LAUNCHER =
  "import os,sys; os.fchdir(3); os.execv(sys.argv[1], sys.argv[1:])";
const ROOT_DESCRIPTOR_LAUNCHER_PATH = "/usr/bin/python3";

export class SyntheticBackupRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "SyntheticBackupRefusal";
  }
}

function refuse(code) {
  throw new SyntheticBackupRefusal(code);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactUniqueStrings(observed, expected) {
  if (
    !Array.isArray(observed) ||
    observed.length !== expected.length ||
    observed.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const observedSet = new Set(observed);
  return (
    observedSet.size === observed.length &&
    expected.every((value) => observedSet.has(value))
  );
}

function hasExactKeys(value, keys) {
  return isRecord(value) && hasExactUniqueStrings(Object.keys(value), keys);
}

function isSafeOpaqueIdentifier(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}

function isPrivateOwnedDirectory(stat, ownerUid) {
  return (
    stat.isDirectory() &&
    stat.uid === ownerUid &&
    (stat.mode & 0o7777) === 0o700
  );
}

function parseExportSpec(spec) {
  if (
    !hasExactKeys(spec, [
      "backupName",
      "backupRoot",
      "databaseAlias",
      "expectedDatabaseIdentity",
    ]) ||
    typeof spec.backupRoot !== "string" ||
    !path.isAbsolute(spec.backupRoot) ||
    typeof spec.backupName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(spec.backupName) ||
    typeof spec.databaseAlias !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.databaseAlias) ||
    !isSafeOpaqueIdentifier(spec.expectedDatabaseIdentity)
  ) {
    refuse("SPEC_INVALID");
  }
  return spec;
}

function parseRestoreSpec(spec) {
  if (
    !hasExactKeys(spec, [
      "backupName",
      "backupRoot",
      "databaseAlias",
      "expectedDatabaseIdentity",
      "expectedManifestSha256",
    ]) ||
    typeof spec.backupRoot !== "string" ||
    !path.isAbsolute(spec.backupRoot) ||
    typeof spec.backupName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(spec.backupName) ||
    typeof spec.databaseAlias !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.databaseAlias) ||
    !isSafeOpaqueIdentifier(spec.expectedDatabaseIdentity) ||
    typeof spec.expectedManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(spec.expectedManifestSha256)
  ) {
    refuse("SPEC_INVALID");
  }
  return spec;
}

function fixtureMatches(fixture) {
  return (
    hasExactKeys(fixture, ["counts", "dataClass", "digest", "version"]) &&
    fixture.dataClass === "synthetic-only" &&
    fixture.digest === FIXTURE_DIGEST &&
    fixture.version === "internal-baseline-v2" &&
    hasExactKeys(fixture.counts, Object.keys(FIXTURE_COUNTS)) &&
    Object.entries(FIXTURE_COUNTS).every(
      ([key, count]) => fixture.counts[key] === count,
    )
  );
}

function sourceMatches(observation, expectedIdentity) {
  return (
    hasExactKeys(observation, [
      "applicationState",
      "environment",
      "fixture",
      "identity",
      "migrationSetSha256",
      "schemaGeneration",
    ]) &&
    observation.applicationState === "synthetic-baseline" &&
    observation.environment === "staging" &&
    observation.identity === expectedIdentity &&
    observation.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256 &&
    observation.schemaGeneration === 4 &&
    fixtureMatches(observation.fixture)
  );
}

function emptyTargetMatches(observation, expectedIdentity, sourceIdentity) {
  return (
    hasExactKeys(observation, [
      "applicationState",
      "environment",
      "fixture",
      "identity",
      "migrationSetSha256",
      "schemaGeneration",
    ]) &&
    observation.applicationState === "empty" &&
    observation.environment === "local" &&
    observation.fixture === null &&
    observation.identity === expectedIdentity &&
    observation.identity !== sourceIdentity &&
    observation.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256 &&
    observation.schemaGeneration === 4
  );
}

function restoredTargetMatches(observation, expectedIdentity) {
  return (
    hasExactKeys(observation, [
      "applicationState",
      "environment",
      "fixture",
      "identity",
      "migrationSetSha256",
      "schemaGeneration",
    ]) &&
    observation.applicationState === "synthetic-baseline" &&
    observation.environment === "local" &&
    observation.identity === expectedIdentity &&
    observation.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256 &&
    observation.schemaGeneration === 4 &&
    fixtureMatches(observation.fixture)
  );
}

function archiveInventoryMatches(inventory) {
  if (
    !hasExactKeys(inventory, ["entries", "fixture", "format"]) ||
    inventory.format !== "postgres-custom-data-only" ||
    !Array.isArray(inventory.entries) ||
    inventory.entries.length !== SYNTHETIC_TABLES.length ||
    !fixtureMatches(inventory.fixture)
  ) {
    return false;
  }
  const expectedNames = new Set(SYNTHETIC_TABLES);
  const observedNames = new Set();
  for (const entry of inventory.entries) {
    if (
      !hasExactKeys(entry, ["kind", "name", "schema"]) ||
      entry.kind !== "TABLE DATA" ||
      entry.schema !== "desmoslock_v2" ||
      typeof entry.name !== "string" ||
      !expectedNames.has(entry.name) ||
      observedNames.has(entry.name)
    ) {
      return false;
    }
    observedNames.add(entry.name);
  }
  return observedNames.size === expectedNames.size;
}

async function resolveBackupRoot(backupRoot) {
  let rootStat;
  let requestedRootStat;
  let canonicalRoot;
  let canonicalRepositoryRoot;
  const currentUid = process.geteuid?.();
  try {
    const normalizedRoot = path.resolve(backupRoot);
    requestedRootStat = await fs.lstat(normalizedRoot);
    canonicalRoot = await fs.realpath(normalizedRoot);
    canonicalRepositoryRoot = await fs.realpath(REPOSITORY_ROOT);
    rootStat = await fs.lstat(canonicalRoot);
  } catch {
    refuse("BACKUP_ROOT_INVALID");
  }
  const repositoryRelativePath = path.relative(
    canonicalRepositoryRoot,
    canonicalRoot,
  );
  const isInsideRepository =
    repositoryRelativePath === "" ||
    (repositoryRelativePath !== ".." &&
      !repositoryRelativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(repositoryRelativePath));
  if (
    !Number.isSafeInteger(currentUid) ||
    !requestedRootStat.isDirectory() ||
    requestedRootStat.isSymbolicLink() ||
    rootStat.isSymbolicLink() ||
    !sameIdentity(requestedRootStat, {
      dev: rootStat.dev,
      ino: rootStat.ino,
    }) ||
    !isPrivateOwnedDirectory(rootStat, currentUid) ||
    isInsideRepository
  ) {
    refuse("BACKUP_ROOT_INVALID");
  }
  return {
    identity: { dev: rootStat.dev, ino: rootStat.ino },
    ownerUid: currentUid,
    path: canonicalRoot,
  };
}

function buildManifest(source, archive) {
  return {
    artifact: {
      bytes: archive.byteLength,
      format: "postgres-custom-data-only",
      path: "data.pgcustom",
      sha256: sha256(archive),
    },
    dataClass: "synthetic-only",
    fixture: source.fixture,
    format: "desmoslock.synthetic-backup/v1",
    schema: {
      generation: 4,
      migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
      tables: SYNTHETIC_TABLES,
    },
    source: {
      environment: source.environment,
      identity: source.identity,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

function manifestMatches(manifest) {
  return (
    hasExactKeys(manifest, [
      "artifact",
      "dataClass",
      "fixture",
      "format",
      "schema",
      "source",
    ]) &&
    manifest.format === "desmoslock.synthetic-backup/v1" &&
    manifest.dataClass === "synthetic-only" &&
    hasExactKeys(manifest.artifact, ["bytes", "format", "path", "sha256"]) &&
    Number.isSafeInteger(manifest.artifact.bytes) &&
    manifest.artifact.bytes > 0 &&
    manifest.artifact.bytes <= MAX_ARCHIVE_BYTES &&
    manifest.artifact.format === "postgres-custom-data-only" &&
    manifest.artifact.path === "data.pgcustom" &&
    typeof manifest.artifact.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(manifest.artifact.sha256) &&
    fixtureMatches(manifest.fixture) &&
    hasExactKeys(manifest.schema, [
      "generation",
      "migrationSetSha256",
      "tables",
    ]) &&
    manifest.schema.generation === 4 &&
    manifest.schema.migrationSetSha256 === CURRENT_MIGRATION_SET_SHA256 &&
    Array.isArray(manifest.schema.tables) &&
    manifest.schema.tables.length === SYNTHETIC_TABLES.length &&
    manifest.schema.tables.every(
      (table, index) => table === SYNTHETIC_TABLES[index],
    ) &&
    hasExactKeys(manifest.source, ["environment", "identity"]) &&
    manifest.source.environment === "staging" &&
    isSafeOpaqueIdentifier(manifest.source.identity)
  );
}

async function readHeldRegularFile(
  filePath,
  maximumBytes,
  refusalCode,
  expectedLinkCount = 1,
) {
  let handle;
  let bytes;
  let identity;
  let operationError;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== expectedLinkCount ||
      stat.size <= 0 ||
      stat.size > maximumBytes
    ) {
      refuse(refusalCode);
    }
    identity = { dev: stat.dev, ino: stat.ino };
    bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) refuse(refusalCode);
  } catch (error) {
    operationError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      if (operationError === undefined) refuse(refusalCode);
    }
  }
  if (operationError !== undefined) {
    if (operationError instanceof SyntheticBackupRefusal) throw operationError;
    refuse(refusalCode);
  }
  return { bytes, identity };
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

async function assertDirectoryIdentity(directoryPath, identity, refusalCode) {
  try {
    const stat = await fs.lstat(directoryPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(stat, identity)
    ) {
      refuse(refusalCode);
    }
  } catch (error) {
    if (error instanceof SyntheticBackupRefusal) throw error;
    refuse(refusalCode);
  }
}

function destroyPublicationPipe(stream) {
  try {
    stream?.destroy();
  } catch {
    // Native details stay behind the stable publication refusal boundary.
  }
}

function runBoundPublication({
  archive,
  backupName,
  manifestBytes,
  root,
  rootHandle,
}) {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      reject(new SyntheticBackupRefusal("BACKUP_WRITE_FAILED"));
      return;
    }

    let child;
    try {
      child = spawn(
        ROOT_DESCRIPTOR_LAUNCHER_PATH,
        [
          "-I",
          "-c",
          ROOT_DESCRIPTOR_LAUNCHER,
          process.execPath,
          PUBLICATION_WORKER_PATH,
          "--publish-from-bound-root",
          backupName,
          root.path,
          String(root.identity.dev),
          String(root.identity.ino),
          String(archive.byteLength),
          sha256(archive),
          String(manifestBytes.byteLength),
          sha256(manifestBytes),
        ],
        {
          detached: true,
          env: { LANG: "C", LC_ALL: "C" },
          shell: false,
          stdio: ["pipe", "pipe", "pipe", rootHandle.fd],
        },
      );
    } catch {
      reject(new SyntheticBackupRefusal("BACKUP_WRITE_FAILED"));
      return;
    }

    let settled = false;
    let statusBytes = 0;
    let errorBytes = 0;
    const statusChunks = [];
    let timer;
    const terminate = () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child handle.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Pipe destruction still bounds the caller if termination fails.
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate();
      destroyPublicationPipe(child.stdin);
      destroyPublicationPipe(child.stdout);
      destroyPublicationPipe(child.stderr);
      try {
        child.unref?.();
      } catch {
        // Native child details remain private.
      }
      reject(new SyntheticBackupRefusal("BACKUP_WRITE_FAILED"));
    };

    child.on("error", abort);
    child.stdin.on("error", abort);
    child.stdout.on("error", abort);
    child.stderr.on("error", abort);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      statusBytes += bytes.byteLength;
      if (statusBytes > MAX_PUBLICATION_STATUS_BYTES) {
        abort();
        return;
      }
      statusChunks.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      errorBytes += Buffer.byteLength(chunk);
      if (errorBytes > MAX_PUBLICATION_STATUS_BYTES) abort();
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null || errorBytes !== 0) {
        abort();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const status = Buffer.concat(statusChunks).toString("utf8");
      if (status === "BACKUP_PUBLISHED\n") {
        resolve();
        return;
      }
      reject(
        new SyntheticBackupRefusal(
          status === "BACKUP_EXISTS\n"
            ? "BACKUP_EXISTS"
            : "BACKUP_WRITE_FAILED",
        ),
      );
    });
    timer = setTimeout(abort, PUBLICATION_TIMEOUT_MS);
    try {
      child.stdin.end(Buffer.concat([archive, manifestBytes]));
    } catch {
      abort();
    }
  });
}

async function readVerifiedBackup(spec) {
  const canonicalRoot = await resolveBackupRoot(spec.backupRoot);
  await assertDirectoryIdentity(
    canonicalRoot.path,
    canonicalRoot.identity,
    "BACKUP_ROOT_INVALID",
  );
  const backupDirectory = path.join(canonicalRoot.path, spec.backupName);
  let backupStat;
  let canonicalBackupDirectory;
  try {
    backupStat = await fs.lstat(backupDirectory);
    canonicalBackupDirectory = await fs.realpath(backupDirectory);
  } catch {
    refuse("MANIFEST_INVALID");
  }
  if (
    !backupStat.isDirectory() ||
    backupStat.isSymbolicLink() ||
    canonicalBackupDirectory !== backupDirectory
  ) {
    refuse("MANIFEST_INVALID");
  }
  const backupIdentity = { dev: backupStat.dev, ino: backupStat.ino };
  let entries;
  try {
    entries = await fs.readdir(backupDirectory);
  } catch {
    refuse("MANIFEST_INVALID");
  }
  if (
    !hasExactUniqueStrings(entries, [
      "data.pgcustom",
      "manifest.json",
      "manifest.pending",
    ])
  ) {
    refuse("MANIFEST_INVALID");
  }
  await assertDirectoryIdentity(
    backupDirectory,
    backupIdentity,
    "MANIFEST_INVALID",
  );

  const heldManifest = await readHeldRegularFile(
    path.join(backupDirectory, "manifest.json"),
    MAX_MANIFEST_BYTES,
    "MANIFEST_INVALID",
    2,
  );
  const heldPendingManifest = await readHeldRegularFile(
    path.join(backupDirectory, "manifest.pending"),
    MAX_MANIFEST_BYTES,
    "MANIFEST_INVALID",
    2,
  );
  if (
    !sameIdentity(heldManifest.identity, heldPendingManifest.identity) ||
    !heldManifest.bytes.equals(heldPendingManifest.bytes)
  ) {
    refuse("MANIFEST_INVALID");
  }
  const manifestBytes = heldManifest.bytes;
  await assertDirectoryIdentity(
    backupDirectory,
    backupIdentity,
    "MANIFEST_INVALID",
  );
  if (sha256(manifestBytes) !== spec.expectedManifestSha256) {
    refuse("MANIFEST_HASH_MISMATCH");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    refuse("MANIFEST_INVALID");
  }
  if (
    !manifestMatches(manifest) ||
    !canonicalManifestBytes(manifest).equals(manifestBytes)
  ) {
    refuse("MANIFEST_INVALID");
  }

  const artifactPath = path.resolve(backupDirectory, manifest.artifact.path);
  if (
    path.dirname(artifactPath) !== backupDirectory ||
    path.basename(artifactPath) !== manifest.artifact.path
  ) {
    refuse("ARTIFACT_INVALID");
  }
  const { bytes: archive } = await readHeldRegularFile(
    artifactPath,
    MAX_ARCHIVE_BYTES,
    "ARTIFACT_INVALID",
  );
  await assertDirectoryIdentity(
    backupDirectory,
    backupIdentity,
    "ARTIFACT_INVALID",
  );
  if (archive.byteLength !== manifest.artifact.bytes) {
    refuse("ARTIFACT_INVALID");
  }
  if (sha256(archive) !== manifest.artifact.sha256) {
    refuse("ARTIFACT_HASH_MISMATCH");
  }
  return { archive, manifest };
}

export async function exportSyntheticBackup(specification, adapter) {
  const spec = parseExportSpec(specification);
  const canonicalRoot = await resolveBackupRoot(spec.backupRoot);
  const backupDirectory = path.join(canonicalRoot.path, spec.backupName);

  let source;
  try {
    source = await adapter.observeDatabase(spec.databaseAlias);
  } catch {
    refuse("SOURCE_UNAVAILABLE");
  }
  if (!sourceMatches(source, spec.expectedDatabaseIdentity)) {
    refuse("SOURCE_REFUSED");
  }

  let archive;
  try {
    const dumpedArchive = await adapter.dumpSyntheticData(spec.databaseAlias);
    archive = Buffer.isBuffer(dumpedArchive)
      ? Buffer.from(dumpedArchive)
      : dumpedArchive;
  } catch {
    refuse("SOURCE_UNAVAILABLE");
  }
  if (
    !Buffer.isBuffer(archive) ||
    archive.byteLength === 0 ||
    archive.byteLength > MAX_ARCHIVE_BYTES
  ) {
    refuse("ARCHIVE_INVALID");
  }

  let inventory;
  try {
    inventory = await adapter.inspectDump(Buffer.from(archive));
  } catch {
    refuse("ARCHIVE_INVALID");
  }
  if (!archiveInventoryMatches(inventory)) refuse("ARCHIVE_INVALID");
  if (canonicalJson(inventory.fixture) !== canonicalJson(source.fixture)) {
    refuse("SOURCE_CHANGED");
  }

  let verifiedSource;
  try {
    verifiedSource = await adapter.observeDatabase(spec.databaseAlias);
  } catch {
    refuse("SOURCE_UNAVAILABLE");
  }
  if (
    !sourceMatches(verifiedSource, spec.expectedDatabaseIdentity) ||
    canonicalJson(verifiedSource) !== canonicalJson(source) ||
    canonicalJson(inventory.fixture) !== canonicalJson(verifiedSource.fixture)
  ) {
    refuse("SOURCE_CHANGED");
  }

  const manifest = buildManifest(verifiedSource, archive);
  const manifestBytes = canonicalManifestBytes(manifest);
  let rootHandle;
  let publicationError;
  try {
    rootHandle = await fs.open(
      canonicalRoot.path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const rootStat = await rootHandle.stat();
    if (
      !sameIdentity(rootStat, canonicalRoot.identity) ||
      !isPrivateOwnedDirectory(rootStat, canonicalRoot.ownerUid)
    ) {
      refuse("BACKUP_WRITE_FAILED");
    }
    await runBoundPublication({
      archive,
      backupName: spec.backupName,
      manifestBytes,
      root: canonicalRoot,
      rootHandle,
    });
  } catch (error) {
    publicationError = error;
  }
  if (rootHandle !== undefined) {
    try {
      await rootHandle.close();
    } catch {
      publicationError ??= new SyntheticBackupRefusal("BACKUP_WRITE_FAILED");
    }
  }
  if (publicationError !== undefined) {
    if (
      publicationError instanceof SyntheticBackupRefusal &&
      publicationError.code === "BACKUP_EXISTS"
    ) {
      refuse("BACKUP_EXISTS");
    }
    refuse("BACKUP_WRITE_FAILED");
  }

  return {
    artifactSha256: manifest.artifact.sha256,
    backupDirectory,
    manifestSha256: sha256(manifestBytes),
    sourceIdentity: verifiedSource.identity,
  };
}

export async function restoreSyntheticBackup(specification, adapter) {
  const spec = parseRestoreSpec(specification);
  const { archive, manifest } = await readVerifiedBackup(spec);
  const verifiedArchiveSha256 = manifest.artifact.sha256;

  let inventory;
  try {
    inventory = await adapter.inspectDump(Buffer.from(archive));
  } catch {
    refuse("ARCHIVE_INVALID");
  }
  if (
    !archiveInventoryMatches(inventory) ||
    canonicalJson(inventory.fixture) !== canonicalJson(manifest.fixture) ||
    sha256(archive) !== verifiedArchiveSha256
  ) {
    refuse("ARCHIVE_INVALID");
  }

  let target;
  try {
    target = await adapter.observeDatabase(spec.databaseAlias);
  } catch {
    refuse("TARGET_UNAVAILABLE");
  }
  if (
    !emptyTargetMatches(
      target,
      spec.expectedDatabaseIdentity,
      manifest.source.identity,
    )
  ) {
    refuse("TARGET_REFUSED");
  }

  try {
    if (sha256(archive) !== verifiedArchiveSha256) {
      refuse("ARTIFACT_HASH_MISMATCH");
    }
    await adapter.restoreVerifiedEmptyDatabase(
      {
        databaseAlias: spec.databaseAlias,
        expectedDatabaseIdentity: spec.expectedDatabaseIdentity,
        expectedMigrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
        expectedSchemaGeneration: 4,
        sourceDatabaseIdentity: manifest.source.identity,
      },
      Buffer.from(archive),
    );
  } catch {
    refuse("RESTORE_FAILED");
  }

  let restoredTarget;
  try {
    restoredTarget = await adapter.observeDatabase(spec.databaseAlias);
  } catch {
    refuse("RESTORE_VERIFICATION_FAILED");
  }
  if (!restoredTargetMatches(restoredTarget, spec.expectedDatabaseIdentity)) {
    refuse("RESTORE_VERIFICATION_FAILED");
  }

  return {
    artifactSha256: manifest.artifact.sha256,
    fixtureDigest: manifest.fixture.digest,
    postRestoreSyntheticFixtureVerified: true,
    sourceIdentity: manifest.source.identity,
    targetIdentity: restoredTarget.identity,
  };
}
