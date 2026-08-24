import { describe, expect, it } from "vitest";

import {
  backupDeletionMaximumAdditionalDays,
  calculatorStateMaximumHoursAfterTestEnd,
  retentionMaximumDays,
} from "../src/index.js";

describe("accepted retention boundary", () => {
  it("keeps the foundation constants aligned with the product contract", () => {
    expect(calculatorStateMaximumHoursAfterTestEnd).toBe(24);
    expect(retentionMaximumDays.studentRecord).toBe(30);
    expect(retentionMaximumDays.invitation).toBe(90);
    expect(retentionMaximumDays.testMetadata).toBe(365);
    expect(retentionMaximumDays.workspaceAudit).toBe(365);
    expect(backupDeletionMaximumAdditionalDays).toBe(35);
  });
});
