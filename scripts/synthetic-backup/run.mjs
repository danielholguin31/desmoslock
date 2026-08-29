import {
  exportSyntheticBackup,
  restoreSyntheticBackup,
  SyntheticBackupRefusal,
} from "./operator.mjs";
import {
  createPostgresBackupAdapter,
  loadPostgresAdapterConfiguration,
} from "./postgres-adapter.mjs";

function argumentsInvalid() {
  throw new SyntheticBackupRefusal("OPERATOR_ARGUMENTS_INVALID");
}

async function run() {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0];
  const isExport = command === "export" && arguments_.length === 4;
  const isRestore = command === "restore" && arguments_.length === 5;
  if (!isExport && !isRestore) argumentsInvalid();
  const configuration = loadPostgresAdapterConfiguration(
    process.env,
    isExport ? "staging" : "local-restore",
  );
  const adapter = createPostgresBackupAdapter(configuration);

  if (isExport) {
    const [, backupRoot, backupName, expectedDatabaseIdentity] = arguments_;
    return await exportSyntheticBackup(
      {
        backupName,
        backupRoot,
        databaseAlias: "staging",
        expectedDatabaseIdentity,
      },
      adapter,
    );
  }
  if (isRestore) {
    const [
      ,
      backupRoot,
      backupName,
      expectedDatabaseIdentity,
      expectedManifestSha256,
    ] = arguments_;
    return await restoreSyntheticBackup(
      {
        backupName,
        backupRoot,
        databaseAlias: "local-restore",
        expectedDatabaseIdentity,
        expectedManifestSha256,
      },
      adapter,
    );
  }
  argumentsInvalid();
}

try {
  const receipt = await run();
  process.stdout.write(`${JSON.stringify({ receipt, status: "verified" })}\n`);
} catch (error) {
  const code =
    error instanceof SyntheticBackupRefusal ? error.code : "OPERATOR_FAILED";
  process.stderr.write(`${JSON.stringify({ code, status: "refused" })}\n`);
  process.exitCode = 1;
}
