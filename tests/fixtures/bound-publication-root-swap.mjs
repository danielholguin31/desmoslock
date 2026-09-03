import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { publishFromBoundRoot } from "../../scripts/synthetic-backup/publication-worker.mjs";

const [canonicalRoot, originalRootAway, scenario] = process.argv.slice(2);
const archive = Buffer.from("synthetic archive for bound publication");
const manifest = Buffer.from('{"synthetic":"manifest"}\n');
const rootHandle = await fs.open(
  ".",
  constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0),
);
const rootStat = await rootHandle.stat();

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
    {
      async afterBackupDirectoryBound() {
        await fs.rename(canonicalRoot, originalRootAway);
        if (scenario === "symlink-back") {
          await fs.symlink(originalRootAway, canonicalRoot);
        } else {
          await fs.mkdir(canonicalRoot, { mode: 0o700 });
          if (scenario === "transplant") {
            await fs.rename(
              path.join(originalRootAway, "staging-baseline"),
              path.join(canonicalRoot, "staging-baseline"),
            );
          } else {
            await fs.mkdir(path.join(canonicalRoot, "staging-baseline"), {
              mode: 0o700,
            });
          }
        }
      },
    },
  );
  process.stdout.write("UNEXPECTED_SUCCESS\n");
} catch {
  process.stdout.write("BACKUP_WRITE_FAILED\n");
} finally {
  await rootHandle.close();
}
