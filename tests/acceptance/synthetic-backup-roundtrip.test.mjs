import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  runBackupRoundtrip,
  StaffSuiteCommandFailure,
} from "./synthetic-backup-runtime.mjs";

test(
  "real synthetic export preserves Test and StudentSession metadata with empty runtime stores across distinct session timezones before the complete staff Auth suite",
  { timeout: 1_800_000 },
  async (context) => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    let receipt;
    try {
      receipt = await runBackupRoundtrip(repositoryRoot, context.signal);
    } catch (error) {
      // runBackupRoundtrip has completed cleanup before returning this closed,
      // staff-suite-only projection. Never render nested names/errors/output.
      if (error instanceof StaffSuiteCommandFailure)
        context.diagnostic(
          JSON.stringify({
            staffSuiteFailure: error.code,
            diagnostics: error.diagnostics,
          }),
        );
      throw error;
    }
    assert.equal(receipt.distinctSessionTimezones, true);
    assert.equal(receipt.testMetadataPreserved, true);
    assert.equal(receipt.studentMetadataPreserved, true);
    assert.equal(receipt.studentRuntimeStoresEmpty, true);
    // Hashes and static boolean results only; never print database/CLI responses.
    context.diagnostic(JSON.stringify(receipt));
  },
);
