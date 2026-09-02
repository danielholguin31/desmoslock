import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";

import { publishFromBoundRoot } from "../../scripts/synthetic-backup/publication-worker.mjs";

const [canonicalRoot, failurePoint] = process.argv.slice(2);
const archive = Buffer.from("synthetic archive for publication failure");
const manifest = Buffer.from('{"synthetic":"manifest"}\n');
const rootHandle = await fs.open(
  ".",
  constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0),
);
const rootStat = await rootHandle.stat();
const fail = async () => {
  throw new Error("private injected publication failure");
};
const hooks = {
  ...(failurePoint === "backup-directory-sync"
    ? { afterArchiveDurable: fail }
    : {}),
  ...(failurePoint === "manifest-link" ? { beforeManifestLink: fail } : {}),
  ...(failurePoint === "backup-root-sync" ? { beforeRootSync: fail } : {}),
};

try {
  await publishFromBoundRoot(
    {
      archive,
      archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"),
      backupName: "staging-baseline",
      manifest,
      manifestSha256: crypto
        .createHash("sha256")
        .update(manifest)
        .digest("hex"),
      rootFileDescriptor: rootHandle.fd,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      rootPath: canonicalRoot,
    },
    hooks,
  );
  process.stdout.write("UNEXPECTED_SUCCESS\n");
} catch {
  process.stdout.write("BACKUP_WRITE_FAILED\n");
} finally {
  await rootHandle.close();
}
