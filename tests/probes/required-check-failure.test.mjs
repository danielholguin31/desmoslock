import assert from "node:assert/strict";
import test from "node:test";

test("required-check merge-blocking probe", () => {
  assert.fail("DESMOSLOCK_REQUIRED_CHECK_PROBE");
});
