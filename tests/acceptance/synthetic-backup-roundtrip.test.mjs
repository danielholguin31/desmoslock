import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runBackupRoundtrip } from "./synthetic-backup-runtime.mjs";

test(
  "real synthetic export preserves Test metadata across distinct session timezones before the complete staff Auth suite",
  { timeout: 1_800_000 },
  async (context) => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const receipt = await runBackupRoundtrip(repositoryRoot, context.signal);
    assert.equal(receipt.distinctSessionTimezones, true);
    assert.equal(receipt.testMetadataPreserved, true);
    // Hashes and static boolean results only; never print database/CLI responses.
    context.diagnostic(JSON.stringify(receipt));
  },
);
