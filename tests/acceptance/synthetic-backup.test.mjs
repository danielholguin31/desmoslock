import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CURRENT_MIGRATION_FILES,
  CURRENT_MIGRATION_SET_SHA256,
  SYNTHETIC_TABLES,
  SyntheticBackupRefusal,
  exportSyntheticBackup,
  restoreSyntheticBackup,
} from "../../scripts/synthetic-backup/operator.mjs";

const FIXTURE_DIGEST =
  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201";
const MIGRATION_ATTESTATIONS = Object.freeze({
  "20260828000100_internal_release_backend.sql": Object.freeze({
    migrationSetSha256:
      "06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49",
    rawSha256:
      "1a60d2fb308a8e2cfad102f9c218c319bacd95c33a40801d5b0b731119434f2f",
  }),
  "20260903000200_staff_auth_generation_4.sql": Object.freeze({
    migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
    rawSha256:
      "bf55012c9edae81c191e241eee806a09918cc34211b3a0ac3eacbb9f1d6ff321",
  }),
});
const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sourceObservation() {
  return {
    applicationState: "synthetic-baseline",
    environment: "staging",
    fixture: {
      counts: {
        baselineFixtureState: 1,
        foundationSeed: 1,
        memberships: 6,
        profiles: 6,
        studentSessions: 2,
        tests: 2,
        workspaces: 2,
      },
      dataClass: "synthetic-only",
      digest: FIXTURE_DIGEST,
      version: "internal-baseline-v2",
    },
    identity: "staging-instance-001",
    migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
    schemaGeneration: 4,
  };
}

function safeArchiveInventory() {
  return {
    entries: SYNTHETIC_TABLES.map((table) => ({
      kind: "TABLE DATA",
      name: table,
      schema: "desmoslock_v2",
    })),
    fixture: sourceObservation().fixture,
    format: "postgres-custom-data-only",
  };
}

function emptyLocalObservation() {
  return {
    applicationState: "empty",
    environment: "local",
    fixture: null,
    identity: "local-instance-001",
    migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
    schemaGeneration: 4,
  };
}

async function createBackup(context) {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const archive = Buffer.from("synthetic custom-format archive fixture");
  const receipt = await exportSyntheticBackup(
    {
      backupName: "staging-baseline",
      backupRoot,
      databaseAlias: "staging",
      expectedDatabaseIdentity: "staging-instance-001",
    },
    {
      async dumpSyntheticData() {
        return archive;
      },
      async inspectDump() {
        return safeArchiveInventory();
      },
      async observeDatabase() {
        return sourceObservation();
      },
    },
  );
  return { archive, backupRoot, receipt };
}

async function assertRefusal(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof SyntheticBackupRefusal, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

async function assertBackupRootRefusedBeforeAdapters(backupRoot) {
  const calls = [];
  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async observeDatabase() {
            calls.push("observeDatabase");
            throw new Error("adapter boundary must remain untouched");
          },
        },
      ),
    "BACKUP_ROOT_INVALID",
  );
  assert.deepEqual(calls, []);
  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: "0".repeat(64),
        },
        new Proxy(
          {},
          {
            get(_target, property) {
              calls.push(String(property));
              throw new Error("adapter boundary must remain untouched");
            },
          },
        ),
      ),
    "BACKUP_ROOT_INVALID",
  );
  assert.deepEqual(calls, []);
}

test("refuses a private backup root contained in the repository", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(REPOSITORY_ROOT, ".desmoslock-backup-root-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));

  await assertBackupRootRefusedBeforeAdapters(backupRoot);
});

test("refuses a wrong-owner private backup root", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-root-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const actualUid = process.geteuid?.();
  if (!Number.isSafeInteger(actualUid)) {
    context.skip("effective user identity is unavailable");
    return;
  }
  context.mock.method(process, "geteuid", () => actualUid + 1);
  await assertBackupRootRefusedBeforeAdapters(backupRoot);
});

test("refuses a current-user backup root with shared permissions", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-root-test-"),
  );
  await fs.chmod(backupRoot, 0o750);
  context.after(async () => {
    await fs.chmod(backupRoot, 0o700);
    await fs.rm(backupRoot, { force: true, recursive: true });
  });

  await assertBackupRootRefusedBeforeAdapters(backupRoot);
});

test("refuses a current-user backup root with permissions for others", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-root-test-"),
  );
  await fs.chmod(backupRoot, 0o701);
  context.after(async () => {
    await fs.chmod(backupRoot, 0o700);
    await fs.rm(backupRoot, { force: true, recursive: true });
  });

  await assertBackupRootRefusedBeforeAdapters(backupRoot);
});

test("refuses a leaf-symlink backup root even with a trailing separator", async (context) => {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-root-test-"),
  );
  const backupRoot = path.join(fixtureRoot, "private-root");
  const symlinkRoot = path.join(fixtureRoot, "root-link");
  await fs.mkdir(backupRoot, { mode: 0o700 });
  await fs.symlink(backupRoot, symlinkRoot, "dir");
  context.after(() => fs.rm(fixtureRoot, { force: true, recursive: true }));

  for (const requestedRoot of [symlinkRoot, `${symlinkRoot}${path.sep}`]) {
    await assertBackupRootRefusedBeforeAdapters(requestedRoot);
  }
});

test("backup contract includes every seeded v2 table", () => {
  assert.deepEqual(SYNTHETIC_TABLES, [
    "baseline_fixture_state",
    "foundation_seed",
    "memberships",
    "profiles",
    "student_sessions",
    "tests",
    "workspaces",
  ]);
});

test("exports a canonical synthetic-only backup and hash receipt", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const archive = Buffer.from("synthetic custom-format archive fixture");
  const calls = [];
  const adapter = {
    async dumpSyntheticData(alias) {
      calls.push(["dumpSyntheticData", alias]);
      return archive;
    },
    async inspectDump(receivedArchive) {
      calls.push(["inspectDump", Buffer.compare(receivedArchive, archive)]);
      return safeArchiveInventory();
    },
    async observeDatabase(alias) {
      calls.push(["observeDatabase", alias]);
      return sourceObservation();
    },
  };

  const receipt = await exportSyntheticBackup(
    {
      backupName: "staging-baseline",
      backupRoot,
      databaseAlias: "staging",
      expectedDatabaseIdentity: "staging-instance-001",
    },
    adapter,
  );

  const backupDirectory = path.join(
    await fs.realpath(backupRoot),
    "staging-baseline",
  );
  const manifestBytes = await fs.readFile(
    path.join(backupDirectory, "manifest.json"),
  );
  const artifactBytes = await fs.readFile(
    path.join(backupDirectory, "data.pgcustom"),
  );
  assert.deepEqual(artifactBytes, archive);
  assert.deepEqual((await fs.readdir(backupDirectory)).sort(), [
    "data.pgcustom",
    "manifest.json",
    "manifest.pending",
  ]);
  const [manifestStat, pendingManifestStat] = await Promise.all([
    fs.lstat(path.join(backupDirectory, "manifest.json")),
    fs.lstat(path.join(backupDirectory, "manifest.pending")),
  ]);
  assert.equal(manifestStat.dev, pendingManifestStat.dev);
  assert.equal(manifestStat.ino, pendingManifestStat.ino);
  assert.equal(manifestStat.nlink, 2);
  assert.equal(pendingManifestStat.nlink, 2);
  assert.equal(
    receipt.manifestSha256,
    crypto.createHash("sha256").update(manifestBytes).digest("hex"),
  );
  assert.equal(receipt.backupDirectory, backupDirectory);
  assert.deepEqual(calls, [
    ["observeDatabase", "staging"],
    ["dumpSyntheticData", "staging"],
    ["inspectDump", 0],
    ["observeDatabase", "staging"],
  ]);
  assert.deepEqual(JSON.parse(manifestBytes), {
    artifact: {
      bytes: archive.byteLength,
      format: "postgres-custom-data-only",
      path: "data.pgcustom",
      sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    },
    dataClass: "synthetic-only",
    fixture: sourceObservation().fixture,
    format: "desmoslock.synthetic-backup/v1",
    schema: {
      generation: 4,
      migrationSetSha256: CURRENT_MIGRATION_SET_SHA256,
      tables: SYNTHETIC_TABLES,
    },
    source: {
      environment: "staging",
      identity: "staging-instance-001",
    },
  });
});

test("refuses a stale generation-3 internal-baseline-v1 manifest before adapter use", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const manifestPath = path.join(receipt.backupDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.fixture.digest =
    "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca";
  manifest.fixture.version = "internal-baseline-v1";
  manifest.schema.generation = 3;
  const staleManifestBytes = Buffer.from(
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
  await fs.writeFile(manifestPath, staleManifestBytes);
  const calls = [];

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: crypto
            .createHash("sha256")
            .update(staleManifestBytes)
            .digest("hex"),
        },
        {
          async inspectDump() {
            calls.push("inspectDump");
          },
          async observeDatabase() {
            calls.push("observeDatabase");
          },
          async restoreVerifiedEmptyDatabase() {
            calls.push("restoreVerifiedEmptyDatabase");
          },
        },
      ),
    "MANIFEST_INVALID",
  );
  assert.deepEqual(calls, []);
});

test("restores the verified bytes only into the independently identified empty local target", async (context) => {
  const { archive, backupRoot, receipt } = await createBackup(context);
  const calls = [];
  let restored = false;
  const adapter = {
    async inspectDump(receivedArchive) {
      calls.push(["inspectDump", Buffer.compare(receivedArchive, archive)]);
      return safeArchiveInventory();
    },
    async observeDatabase(alias) {
      calls.push(["observeDatabase", alias]);
      return restored
        ? {
            ...sourceObservation(),
            environment: "local",
            identity: "local-instance-001",
          }
        : emptyLocalObservation();
    },
    async restoreVerifiedEmptyDatabase(target, receivedArchive) {
      calls.push([
        "restoreVerifiedEmptyDatabase",
        target.databaseAlias,
        Buffer.compare(receivedArchive, archive),
      ]);
      restored = true;
    },
  };

  const restoreReceipt = await restoreSyntheticBackup(
    {
      backupName: "staging-baseline",
      backupRoot,
      databaseAlias: "local-restore",
      expectedDatabaseIdentity: "local-instance-001",
      expectedManifestSha256: receipt.manifestSha256,
    },
    adapter,
  );

  assert.deepEqual(restoreReceipt, {
    artifactSha256: receipt.artifactSha256,
    fixtureDigest: FIXTURE_DIGEST,
    postRestoreSyntheticFixtureVerified: true,
    sourceIdentity: "staging-instance-001",
    targetIdentity: "local-instance-001",
  });
  assert.deepEqual(calls, [
    ["inspectDump", 0],
    ["observeDatabase", "local-restore"],
    ["restoreVerifiedEmptyDatabase", "local-restore", 0],
    ["observeDatabase", "local-restore"],
  ]);
});

test("never lets a mutating archive inspector change the restored verified bytes", async (context) => {
  const { archive, backupRoot, receipt } = await createBackup(context);
  let observations = 0;
  let restoredArchive;

  await restoreSyntheticBackup(
    {
      backupName: "staging-baseline",
      backupRoot,
      databaseAlias: "local-restore",
      expectedDatabaseIdentity: "local-instance-001",
      expectedManifestSha256: receipt.manifestSha256,
    },
    {
      async inspectDump(receivedArchive) {
        receivedArchive.fill(0);
        return safeArchiveInventory();
      },
      async observeDatabase() {
        observations += 1;
        return observations === 1
          ? emptyLocalObservation()
          : {
              ...sourceObservation(),
              environment: "local",
              identity: "local-instance-001",
            };
      },
      async restoreVerifiedEmptyDatabase(_target, receivedArchive) {
        restoredArchive = Buffer.from(receivedArchive);
      },
    },
  );

  assert.deepEqual(restoredArchive, archive);
});

test("refuses a manifest hash mismatch before inspecting or observing anything", async (context) => {
  const { backupRoot } = await createBackup(context);
  const calls = [];

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: "0".repeat(64),
        },
        {
          async inspectDump() {
            calls.push("inspectDump");
          },
          async observeDatabase() {
            calls.push("observeDatabase");
          },
          async restoreVerifiedEmptyDatabase() {
            calls.push("restoreVerifiedEmptyDatabase");
          },
        },
      ),
    "MANIFEST_HASH_MISMATCH",
  );
  assert.deepEqual(calls, []);
});

test("refuses artifact tampering before target observation or mutation", async (context) => {
  const { archive, backupRoot, receipt } = await createBackup(context);
  const artifactPath = path.join(receipt.backupDirectory, "data.pgcustom");
  const tampered = Buffer.from(archive);
  tampered[0] ^= 0xff;
  await fs.writeFile(artifactPath, tampered);
  const calls = [];

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: receipt.manifestSha256,
        },
        {
          async inspectDump() {
            calls.push("inspectDump");
          },
          async observeDatabase() {
            calls.push("observeDatabase");
          },
          async restoreVerifiedEmptyDatabase() {
            calls.push("restoreVerifiedEmptyDatabase");
          },
        },
      ),
    "ARTIFACT_HASH_MISMATCH",
  );
  assert.deepEqual(calls, []);
});

test("sanitizes a manifest handle finalizer failure", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const openFile = fs.open.bind(fs);
  let openCount = 0;
  context.mock.method(fs, "open", async (...arguments_) => {
    const handle = await openFile(...arguments_);
    openCount += 1;
    if (openCount !== 1) return handle;
    return {
      close: async () => {
        await handle.close();
        throw new Error("native finalizer path must remain private");
      },
      readFile: handle.readFile.bind(handle),
      stat: handle.stat.bind(handle),
    };
  });

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: receipt.manifestSha256,
        },
        {},
      ),
    "MANIFEST_INVALID",
  );
});

test("sanitizes a root descriptor finalizer failure without destructive cleanup", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const openFile = fs.open.bind(fs);
  let openCount = 0;
  context.mock.method(fs, "open", async (...arguments_) => {
    const handle = await openFile(...arguments_);
    openCount += 1;
    if (openCount !== 1) return handle;
    return {
      close: async () => {
        await handle.close();
        throw new Error("native finalizer path must remain private");
      },
      fd: handle.fd,
      stat: handle.stat.bind(handle),
    };
  });

  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async dumpSyntheticData() {
            return Buffer.from("synthetic archive");
          },
          async inspectDump() {
            return safeArchiveInventory();
          },
          async observeDatabase() {
            return sourceObservation();
          },
        },
      ),
    "BACKUP_WRITE_FAILED",
  );
  assert.deepEqual(
    (await fs.readdir(path.join(backupRoot, "staging-baseline"))).sort(),
    ["data.pgcustom", "manifest.json", "manifest.pending"],
  );
});

test("publishes a backup only after crash-durable directory and manifest sealing", async (context) => {
  const failurePoints = [
    "backup-directory-sync",
    "manifest-link",
    "backup-root-sync",
  ];
  for (const failurePoint of failurePoints) {
    await context.test(failurePoint, async (subcontext) => {
      const backupRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "desmoslock-backup-test-"),
      );
      subcontext.after(() =>
        fs.rm(backupRoot, { force: true, recursive: true }),
      );
      const canonicalRoot = await fs.realpath(backupRoot);
      const backupDirectory = path.join(canonicalRoot, "staging-baseline");
      const fixturePath = path.resolve(
        "tests/fixtures/bound-publication-failure.mjs",
      );
      const { stderr, stdout } = await execFileAsync(
        process.execPath,
        [fixturePath, canonicalRoot, failurePoint],
        { cwd: canonicalRoot, maxBuffer: 4 * 1024 },
      );
      assert.equal(stderr, "");
      assert.equal(stdout, "BACKUP_WRITE_FAILED\n");
      const expectedQuarantineEntries = {
        "backup-directory-sync": ["data.pgcustom"],
        "backup-root-sync": [
          "data.pgcustom",
          "manifest.json",
          "manifest.pending",
        ],
        "manifest-link": ["data.pgcustom", "manifest.pending"],
      };
      assert.deepEqual(
        (await fs.readdir(backupDirectory)).sort(),
        expectedQuarantineEntries[failurePoint],
      );
    });
  }
});

test("binds the published backup to the exact fsynced root descriptor", async (context) => {
  for (const scenario of ["decoy", "transplant", "symlink-back"]) {
    await context.test(scenario, async (subcontext) => {
      const requestedRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "desmoslock-backup-test-"),
      );
      const canonicalRoot = await fs.realpath(requestedRoot);
      const originalRootAway = `${canonicalRoot}-bound-original`;
      subcontext.after(async () => {
        await Promise.all(
          [canonicalRoot, originalRootAway].map((target) =>
            fs.rm(target, { force: true, recursive: true }),
          ),
        );
      });

      const fixturePath = path.resolve(
        "tests/fixtures/bound-publication-root-swap.mjs",
      );
      const { stderr, stdout } = await execFileAsync(
        process.execPath,
        [fixturePath, canonicalRoot, originalRootAway, scenario],
        { cwd: canonicalRoot, maxBuffer: 4 * 1024 },
      );

      assert.equal(stderr, "");
      assert.equal(stdout, "BACKUP_WRITE_FAILED\n");
      const sealedBackupRoot =
        scenario === "decoy" ? originalRootAway : canonicalRoot;
      assert.deepEqual(
        (
          await fs.readdir(path.join(sealedBackupRoot, "staging-baseline"))
        ).sort(),
        ["data.pgcustom", "manifest.json", "manifest.pending"],
      );
      if (scenario === "decoy") {
        assert.deepEqual(
          await fs.readdir(path.join(canonicalRoot, "staging-baseline")),
          [],
        );
      }
    });
  }
});

test("refuses every unsealed crash leftover before adapter use", async (context) => {
  const leftovers = [
    ["data.pgcustom"],
    ["data.pgcustom", "manifest.pending"],
    ["data.pgcustom", "manifest.json"],
    ["data.pgcustom", "manifest.json", "manifest.pending", "unexpected"],
  ];
  for (const entries of leftovers) {
    await context.test(entries.join("+"), async (subcontext) => {
      const backupRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "desmoslock-backup-test-"),
      );
      subcontext.after(() =>
        fs.rm(backupRoot, { force: true, recursive: true }),
      );
      const backupDirectory = path.join(backupRoot, "staging-baseline");
      await fs.mkdir(backupDirectory, { mode: 0o700 });
      for (const entry of entries) {
        await fs.writeFile(path.join(backupDirectory, entry), "unsealed");
      }
      const calls = [];
      await assertRefusal(
        () =>
          restoreSyntheticBackup(
            {
              backupName: "staging-baseline",
              backupRoot,
              databaseAlias: "local-restore",
              expectedDatabaseIdentity: "local-instance-001",
              expectedManifestSha256: "0".repeat(64),
            },
            {
              async inspectDump() {
                calls.push("inspectDump");
              },
              async observeDatabase() {
                calls.push("observeDatabase");
              },
              async restoreVerifiedEmptyDatabase() {
                calls.push("restoreVerifiedEmptyDatabase");
              },
            },
          ),
        "MANIFEST_INVALID",
      );
      assert.deepEqual(calls, []);
    });
  }
});

test("refuses symlinked and multiply linked archive files before adapter use", async (context) => {
  for (const linkKind of ["symlink", "hardlink"]) {
    await context.test(`artifact ${linkKind}`, async (subcontext) => {
      const { archive, backupRoot, receipt } = await createBackup(subcontext);
      const artifactPath = path.join(receipt.backupDirectory, "data.pgcustom");
      const alternatePath = path.join(backupRoot, `${linkKind}-archive`);
      if (linkKind === "symlink") {
        await fs.writeFile(alternatePath, archive);
        await fs.unlink(artifactPath);
        await fs.symlink(alternatePath, artifactPath);
      } else {
        await fs.link(artifactPath, alternatePath);
      }
      const calls = [];

      await assertRefusal(
        () =>
          restoreSyntheticBackup(
            {
              backupName: "staging-baseline",
              backupRoot,
              databaseAlias: "local-restore",
              expectedDatabaseIdentity: "local-instance-001",
              expectedManifestSha256: receipt.manifestSha256,
            },
            {
              async inspectDump() {
                calls.push("inspectDump");
              },
              async observeDatabase() {
                calls.push("observeDatabase");
              },
              async restoreVerifiedEmptyDatabase() {
                calls.push("restoreVerifiedEmptyDatabase");
              },
            },
          ),
        "ARTIFACT_INVALID",
      );
      assert.deepEqual(calls, []);
    });
  }
});

test("refuses noncanonical or extended manifests even with an updated out-of-band hash", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const manifestPath = path.join(receipt.backupDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.connection = "privileged-field-must-never-be-accepted";
  const tamperedManifest = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(manifestPath, tamperedManifest);
  const updatedHash = crypto
    .createHash("sha256")
    .update(tamperedManifest)
    .digest("hex");
  const calls = [];

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: updatedHash,
        },
        {
          async inspectDump() {
            calls.push("inspectDump");
          },
          async observeDatabase() {
            calls.push("observeDatabase");
          },
          async restoreVerifiedEmptyDatabase() {
            calls.push("restoreVerifiedEmptyDatabase");
          },
        },
      ),
    "MANIFEST_INVALID",
  );
  assert.deepEqual(calls, []);
});

test("refuses a key-reordered manifest even when its fields and hash are otherwise valid", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const manifestPath = path.join(receipt.backupDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const reorderedManifest = {
    source: manifest.source,
    schema: manifest.schema,
    format: manifest.format,
    fixture: manifest.fixture,
    dataClass: manifest.dataClass,
    artifact: manifest.artifact,
  };
  const bytes = Buffer.from(`${JSON.stringify(reorderedManifest)}\n`, "utf8");
  await fs.writeFile(manifestPath, bytes);

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: crypto
            .createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
        {},
      ),
    "MANIFEST_INVALID",
  );
});

test("refuses a nested-key-reordered manifest with a recomputed receipt hash", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const manifestPath = path.join(receipt.backupDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.fixture.counts = {
    workspaces: manifest.fixture.counts.workspaces,
    tests: manifest.fixture.counts.tests,
    studentSessions: manifest.fixture.counts.studentSessions,
    profiles: manifest.fixture.counts.profiles,
    memberships: manifest.fixture.counts.memberships,
    foundationSeed: manifest.fixture.counts.foundationSeed,
    baselineFixtureState: manifest.fixture.counts.baselineFixtureState,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(manifestPath, bytes);

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: crypto
            .createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
        {},
      ),
    "MANIFEST_INVALID",
  );
});

test("refuses unsafe archive entries before observing the target", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const calls = [];

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: receipt.manifestSha256,
        },
        {
          async inspectDump() {
            calls.push("inspectDump");
            return {
              entries: [
                ...safeArchiveInventory().entries,
                { kind: "TABLE DATA", name: "users", schema: "auth" },
              ],
              fixture: safeArchiveInventory().fixture,
              format: "postgres-custom-data-only",
            };
          },
          async observeDatabase() {
            calls.push("observeDatabase");
          },
          async restoreVerifiedEmptyDatabase() {
            calls.push("restoreVerifiedEmptyDatabase");
          },
        },
      ),
    "ARCHIVE_INVALID",
  );
  assert.deepEqual(calls, ["inspectDump"]);
});

test("refuses wrong, nonempty, nonlocal, or source-colliding targets with zero writes", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  const cases = [
    {
      expectedIdentity: "local-instance-001",
      label: "wrong identity",
      target: { ...emptyLocalObservation(), identity: "local-instance-999" },
    },
    {
      expectedIdentity: "local-instance-001",
      label: "nonempty target",
      target: {
        ...sourceObservation(),
        environment: "local",
        identity: "local-instance-001",
      },
    },
    {
      expectedIdentity: "local-instance-001",
      label: "nonlocal target",
      target: { ...emptyLocalObservation(), environment: "staging" },
    },
    {
      expectedIdentity: "staging-instance-001",
      label: "source collision",
      target: {
        ...emptyLocalObservation(),
        identity: "staging-instance-001",
      },
    },
  ];

  for (const scenario of cases) {
    const writes = [];
    await assertRefusal(
      () =>
        restoreSyntheticBackup(
          {
            backupName: "staging-baseline",
            backupRoot,
            databaseAlias: "local-restore",
            expectedDatabaseIdentity: scenario.expectedIdentity,
            expectedManifestSha256: receipt.manifestSha256,
          },
          {
            async inspectDump() {
              return safeArchiveInventory();
            },
            async observeDatabase() {
              return scenario.target;
            },
            async restoreVerifiedEmptyDatabase() {
              writes.push("restoreVerifiedEmptyDatabase");
            },
          },
        ),
      "TARGET_REFUSED",
    );
    assert.deepEqual(writes, [], scenario.label);
  }
});

test("reports post-restore mismatch without issuing a second mutation", async (context) => {
  const { backupRoot, receipt } = await createBackup(context);
  let observations = 0;
  let writes = 0;

  await assertRefusal(
    () =>
      restoreSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "local-restore",
          expectedDatabaseIdentity: "local-instance-001",
          expectedManifestSha256: receipt.manifestSha256,
        },
        {
          async inspectDump() {
            return safeArchiveInventory();
          },
          async observeDatabase() {
            observations += 1;
            return observations === 1
              ? emptyLocalObservation()
              : {
                  ...sourceObservation(),
                  environment: "local",
                  fixture: {
                    ...sourceObservation().fixture,
                    digest: "0".repeat(64),
                  },
                  identity: "local-instance-001",
                };
          },
          async restoreVerifiedEmptyDatabase() {
            writes += 1;
          },
        },
      ),
    "RESTORE_VERIFICATION_FAILED",
  );
  assert.equal(writes, 1);
  assert.equal(observations, 2);
});

test("refuses an unverified export source before dumping or writing", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const calls = [];

  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async dumpSyntheticData() {
            calls.push("dumpSyntheticData");
          },
          async inspectDump() {
            calls.push("inspectDump");
          },
          async observeDatabase() {
            calls.push("observeDatabase");
            return { ...sourceObservation(), environment: "production" };
          },
        },
      ),
    "SOURCE_REFUSED",
  );
  assert.deepEqual(calls, ["observeDatabase"]);
  await assert.rejects(
    () => fs.lstat(path.join(backupRoot, "staging-baseline")),
    { code: "ENOENT" },
  );
});

test("refuses an export if the source observation changes across the dump", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  let observations = 0;

  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async dumpSyntheticData() {
            return Buffer.from("synthetic archive");
          },
          async inspectDump() {
            return safeArchiveInventory();
          },
          async observeDatabase() {
            observations += 1;
            return observations === 1
              ? sourceObservation()
              : {
                  ...sourceObservation(),
                  fixture: {
                    ...sourceObservation().fixture,
                    digest: "0".repeat(64),
                  },
                };
          },
        },
      ),
    "SOURCE_CHANGED",
  );
  await assert.rejects(
    () => fs.lstat(path.join(backupRoot, "staging-baseline")),
    { code: "ENOENT" },
  );
});

test("refuses an archive whose attested rows differ from unchanged source observations", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));

  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "staging-baseline",
          backupRoot,
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async dumpSyntheticData() {
            return Buffer.from("internally consistent but wrong snapshot");
          },
          async inspectDump() {
            return {
              ...safeArchiveInventory(),
              fixture: {
                ...sourceObservation().fixture,
                digest: "0".repeat(64),
              },
            };
          },
          async observeDatabase() {
            return sourceObservation();
          },
        },
      ),
    "ARCHIVE_INVALID",
  );
  await assert.rejects(
    () => fs.lstat(path.join(backupRoot, "staging-baseline")),
    { code: "ENOENT" },
  );
});

test("canonical observation comparison tolerates key insertion order only", async (context) => {
  const backupRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-backup-test-"),
  );
  context.after(() => fs.rm(backupRoot, { force: true, recursive: true }));
  const source = sourceObservation();
  const reorderedSource = {
    schemaGeneration: source.schemaGeneration,
    migrationSetSha256: source.migrationSetSha256,
    identity: source.identity,
    fixture: {
      version: source.fixture.version,
      digest: source.fixture.digest,
      dataClass: source.fixture.dataClass,
      counts: {
        workspaces: source.fixture.counts.workspaces,
        tests: source.fixture.counts.tests,
        studentSessions: source.fixture.counts.studentSessions,
        profiles: source.fixture.counts.profiles,
        memberships: source.fixture.counts.memberships,
        foundationSeed: source.fixture.counts.foundationSeed,
        baselineFixtureState: source.fixture.counts.baselineFixtureState,
      },
    },
    environment: source.environment,
    applicationState: source.applicationState,
  };
  let observations = 0;

  await exportSyntheticBackup(
    {
      backupName: "staging-baseline",
      backupRoot,
      databaseAlias: "staging",
      expectedDatabaseIdentity: "staging-instance-001",
    },
    {
      async dumpSyntheticData() {
        return Buffer.from("synthetic archive");
      },
      async inspectDump() {
        return {
          ...safeArchiveInventory(),
          entries: [...safeArchiveInventory().entries].reverse(),
        };
      },
      async observeDatabase() {
        observations += 1;
        return observations === 1 ? source : reorderedSource;
      },
    },
  );
});

test("refuses path traversal and privileged connection fields before adapter use", async () => {
  const calls = [];
  await assertRefusal(
    () =>
      exportSyntheticBackup(
        {
          backupName: "../escape",
          backupRoot: "/tmp",
          connectionUrl: "not-accepted",
          databaseAlias: "staging",
          expectedDatabaseIdentity: "staging-instance-001",
        },
        {
          async observeDatabase() {
            calls.push("observeDatabase");
          },
        },
      ),
    "SPEC_INVALID",
  );
  assert.deepEqual(calls, []);
});

test("pins the operator migration digest to the exact migration file set", async () => {
  const discoveredMigrations = (
    await fs.readdir(new URL("../../supabase/migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(discoveredMigrations, CURRENT_MIGRATION_FILES);
  const inventory = [];
  const attestedMigrations = [];
  const currentAttestedMigrations = [];
  for (const migrationName of discoveredMigrations) {
    const source = await fs.readFile(
      new URL(`../../supabase/migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    const beginMarker = "-- desmoslock-migration-set-sha256:begin";
    const endMarker = "-- desmoslock-migration-set-sha256:end";
    const beginIndex = source.indexOf(beginMarker);
    const endIndex = source.indexOf(endMarker);
    assert.equal(
      beginIndex === -1,
      endIndex === -1,
      `${migrationName} has a complete migration-attestation marker pair`,
    );
    let normalizedSource = source;
    if (beginIndex !== -1) {
      assert.equal(
        source.indexOf(beginMarker, beginIndex + beginMarker.length),
        -1,
        `${migrationName} has one migration-attestation begin marker`,
      );
      assert.equal(
        source.indexOf(endMarker, endIndex + endMarker.length),
        -1,
        `${migrationName} has one migration-attestation end marker`,
      );
      assert.ok(
        beginIndex < endIndex,
        `${migrationName} orders its migration-attestation markers`,
      );
      const attestationBlock = source.slice(
        beginIndex,
        endIndex + endMarker.length,
      );
      const literals = [
        ...attestationBlock.matchAll(/select '([0-9a-f]{64})'::text;/gu),
      ];
      assert.equal(
        literals.length,
        1,
        `${migrationName} has one delimited migration-set digest literal`,
      );
      const expectedAttestation = MIGRATION_ATTESTATIONS[migrationName];
      assert.notEqual(
        expectedAttestation,
        undefined,
        `${migrationName} has a pinned migration attestation`,
      );
      assert.equal(
        crypto.createHash("sha256").update(source, "utf8").digest("hex"),
        expectedAttestation.rawSha256,
        `${migrationName} preserves its exact published bytes`,
      );
      assert.equal(
        literals[0][1],
        expectedAttestation.migrationSetSha256,
        `${migrationName} preserves its pinned migration-set digest literal`,
      );
      if (literals[0][1] === CURRENT_MIGRATION_SET_SHA256) {
        currentAttestedMigrations.push(migrationName);
      }
      normalizedSource = `${source.slice(0, beginIndex)}${attestationBlock.replace(
        literals[0][1],
        "0".repeat(64),
      )}${source.slice(endIndex + endMarker.length)}`;
      attestedMigrations.push(migrationName);
    }
    inventory.push(
      `supabase/migrations/${migrationName}\n${crypto
        .createHash("sha256")
        .update(normalizedSource, "utf8")
        .digest("hex")}`,
    );
  }
  assert.deepEqual(attestedMigrations, [
    "20260828000100_internal_release_backend.sql",
    "20260903000200_staff_auth_generation_4.sql",
  ]);
  assert.deepEqual(currentAttestedMigrations, [
    "20260903000200_staff_auth_generation_4.sql",
  ]);
  assert.equal(
    crypto.createHash("sha256").update(inventory.join("\n")).digest("hex"),
    CURRENT_MIGRATION_SET_SHA256,
  );
  const healthFunction = await fs.readFile(
    new URL("../../supabase/functions/health/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    healthFunction,
    new RegExp(
      `const INTERNAL_MIGRATION_SET_SHA256 =\\s*\\n?\\s*"${CURRENT_MIGRATION_SET_SHA256}";`,
      "u",
    ),
  );
});
