import assert from "node:assert/strict";
import test from "node:test";
import { runLocalSupabase } from "../../scripts/run-local-supabase.mjs";

test("local stack startup keeps generated credentials out of success diagnostics", () => {
  const calls = [];
  const result = runLocalSupabase("start-full", (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "SYNTHETIC_PRIVATE_KEY", stderr: "" };
  });
  assert.equal(result, "Supabase start-full completed.");
  assert.equal(calls[0].options.stdio, "pipe");
  assert.deepEqual(calls[0].args, ["start"]);
});

test("local stack failures retain useful categories without raw credential output", () => {
  assert.throws(
    () =>
      runLocalSupabase("reset", () => ({
        status: 1,
        stdout: "SYNTHETIC_PRIVATE_KEY",
        stderr:
          "SQLSTATE 42601 migration failed at statement 12 SYNTHETIC_PRIVATE_KEY",
      })),
    (error) => {
      assert.match(
        error.message,
        /migration or database command failed.*exit 1; SQLSTATE 42601; statement 12/u,
      );
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_KEY/u);
      return true;
    },
  );
});

test("local stack runner refuses unsupported commands without subprocess egress", () => {
  let called = false;
  assert.throws(
    () =>
      runLocalSupabase("status", () => {
        called = true;
      }),
    /Unsupported/u,
  );
  assert.equal(called, false);
});
