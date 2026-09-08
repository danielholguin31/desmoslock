import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accepted,
  check,
  commitStaffWhileHolding,
  createStudentHarness,
  currentSession,
  deniedResult,
  holdStudentLock,
  installStudentAuditFailure,
  observeStudentWait,
  same,
  transitionCount,
  unavailableResult,
  withoutAttemptMetadata,
} from "./student-session-harness.mjs";
import {
  client,
  createRuntimeHealthCheck,
  openDisposableStack,
} from "./staff-auth-loopback.mjs";

// Every waiter below is the actual Node transport -> Deno HTTP handler ->
// PostgREST production RPC. A distinct psql connection owns the exact blocker
// row; pg_stat_activity/pg_locks must observe the wait before it is released.
export async function runStudentSessionLocks(t, runtime) {
  const harness = await createStudentHarness(runtime);
  try {
    await t.test(
      "Student locks: parent end wins against an observed joining handler",
      async () => {
        const target = await harness.test();
        const material = await harness.issue(target);
        const intent = await harness.prepareJoin(material);
        const blocker = await holdStudentLock(target);
        const pending = intent.transport.join(
          intent.request,
          intent.logicalOperationDigest,
        );
        void pending.catch(() => {});
        try {
          await observeStudentWait(
            blocker,
            "commit_student_session_join",
            "tests",
          );
          await commitStaffWhileHolding(blocker, harness, target, "end");
          deniedResult(await pending);
          const final = harness.snapshot(target);
          check(
            final.test.lifecycle === "ended" &&
              final.sessions.length === 0 &&
              final.bindings.length === 0 &&
              transitionCount(final, "student_session_admitted") === 0 &&
              transitionCount(final, "test_ended") === 1,
            "Join admitted a Student after the observed parent end",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled([pending]);
        }
      },
    );

    await t.test(
      "Student locks: live removal defeats an observed own-read session wait",
      async () => {
        const target = await harness.test();
        const joined = await harness.join(await harness.issue(target));
        accepted(joined.result);
        const blocker = await holdStudentLock(
          target,
          joined.result.scope.studentSessionId,
        );
        const pending = harness.send(
          joined,
          harness.maintenance(joined, "read", 1),
        );
        void pending.catch(() => {});
        try {
          await observeStudentWait(
            blocker,
            "read_student_maintenance_key",
            "student_sessions",
          );
          await commitStaffWhileHolding(
            blocker,
            harness,
            target,
            "remove",
            joined,
          );
          deniedResult(await pending);
          const final = harness.snapshot(target);
          const row = currentSession(
            final,
            joined.result.scope.studentSessionId,
          );
          check(
            row.state === "removed" &&
              row.revision === 2 &&
              row.epoch === 2 &&
              row.last_accepted_proof_counter === 0 &&
              row.maintenance_accepted_at.length === 0 &&
              row.capability_digest === null &&
              row.reconnect_digest === null &&
              transitionCount(final, "student_session_removed") === 1,
            "Read survived removal or consumed the new inactive epoch allowance",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled([pending]);
        }
      },
    );

    await t.test(
      "Student locks: live end defeats an observed reconnect parent wait",
      async () => {
        const target = await harness.test();
        const joined = await harness.join(await harness.issue(target));
        accepted(joined.result);
        const before = harness.snapshot(target);
        const blocker = await holdStudentLock(target);
        const pending = harness.send(
          joined,
          harness.maintenance(joined, "reconnect", 1, {
            next: harness.candidates(),
          }),
        );
        void pending.catch(() => {});
        try {
          await observeStudentWait(
            blocker,
            "read_student_maintenance_key",
            "tests",
          );
          await commitStaffWhileHolding(blocker, harness, target, "end");
          deniedResult(await pending);
          const final = harness.snapshot(target);
          same(
            final.sessions,
            before.sessions,
            "End-losing reconnect changed child tuple, counter or credentials",
          );
          same(
            final.bindings,
            before.bindings,
            "End-losing reconnect changed permanent binding",
          );
          check(
            final.test.lifecycle === "ended" &&
              transitionCount(final, "student_session_reconnected") === 0,
            "Reconnect wrote a domain event after end",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled([pending]);
        }
      },
    );

    await t.test(
      "Student locks: concurrent exact initial requests resolve one canonical identity",
      async () => {
        const target = await harness.test();
        const material = await harness.issue(target);
        const device = harness.device();
        const candidates = harness.candidates();
        const requestId = randomUUID();
        const first = await harness.prepareJoin(material, {
          device,
          candidates,
          requestId,
        });
        const second = await harness.prepareJoin(material, {
          device,
          candidates,
          requestId,
        });
        const blocker = await holdStudentLock(target);
        const pending = [first, second].map((intent) =>
          intent.transport.join(intent.request, intent.logicalOperationDigest),
        );
        for (const promise of pending) void promise.catch(() => {});
        try {
          await observeStudentWait(
            blocker,
            "commit_student_session_join",
            "tests",
            2,
          );
          await blocker.query("commit;");
          const results = await Promise.all(pending);
          for (const result of results) accepted(result);
          same(
            withoutAttemptMetadata(results[0]),
            withoutAttemptMetadata(results[1]),
            "Concurrent exact admissions returned different original issuance facts",
          );
          const final = harness.snapshot(target);
          check(
            final.sessions.length === 1 &&
              final.bindings.length === 1 &&
              final.sessions[0].revision === 1 &&
              final.sessions[0].epoch === 1 &&
              final.sessions[0].last_accepted_proof_counter === 0 &&
              transitionCount(final, "student_session_admitted") === 1,
            "Concurrent exact join created duplicate identity, counter or audit",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled(pending);
        }
      },
    );

    await t.test(
      "Student locks: competing targeted claimants choose one device and prepared epoch",
      async () => {
        const target = await harness.test();
        const original = await harness.join(await harness.issue(target));
        accepted(original.result);
        const removed = await harness.remove(target, original);
        const material = await harness.prepare(
          target,
          original,
          removed.session_revision,
        );
        const first = await harness.prepareJoin(material, {
          mode: "readmission",
        });
        const second = await harness.prepareJoin(material, {
          mode: "readmission",
        });
        const blocker = await holdStudentLock(
          target,
          original.result.scope.studentSessionId,
        );
        const pending = [first, second].map((intent) =>
          intent.transport.join(intent.request, intent.logicalOperationDigest),
        );
        for (const promise of pending) void promise.catch(() => {});
        try {
          await observeStudentWait(
            blocker,
            "commit_student_session_join",
            "student_sessions",
            2,
          );
          await blocker.query("commit;");
          const results = await Promise.all(pending);
          const winners = results.filter(
            (result) => result.status === "accepted",
          );
          check(
            winners.length === 1,
            "Targeted material admitted zero or multiple competing devices",
          );
          for (const result of results.filter(
            (candidate) => candidate.status !== "accepted",
          ))
            deniedResult(result);
          const final = harness.snapshot(target);
          const row = currentSession(
            final,
            original.result.scope.studentSessionId,
          );
          check(
            final.sessions.length === 1 &&
              final.bindings.length === 2 &&
              row.state === "active" &&
              row.epoch === 3 &&
              row.revision === 4 &&
              row.last_accepted_proof_counter === 0 &&
              row.device_session_id === winners[0].scope.deviceSessionId &&
              transitionCount(final, "student_session_claimed") === 1 &&
              final.materials
                .filter((entry) => entry.material_kind === "readmission")
                .every((entry) => entry.consumed_at !== null),
            "Competing claim changed prepared identity/epoch or left reusable target material",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled(pending);
        }
      },
    );

    for (const higher of [false, true]) {
      await t.test(
        higher
          ? "Student locks: concurrent higher counter respects the twelfth-call boundary"
          : "Student locks: same counter has one accepted twelfth invocation",
        async () => {
          const target = await harness.test();
          const joined = await harness.join(await harness.issue(target));
          accepted(joined.result);
          for (let counter = 1; counter <= 11; counter += 1) {
            accepted(
              await harness.send(
                joined,
                harness.maintenance(joined, "read", counter),
              ),
              "STUDENT_SESSION_CURRENT",
            );
          }
          const blocker = await holdStudentLock(
            target,
            joined.result.scope.studentSessionId,
          );
          const intents = [
            harness.maintenance(joined, "read", 12),
            harness.maintenance(joined, "read", higher ? 13 : 12),
          ];
          const pending = intents.map((intent) => harness.send(joined, intent));
          for (const promise of pending) void promise.catch(() => {});
          try {
            await observeStudentWait(
              blocker,
              "read_student_maintenance_key",
              "student_sessions",
              2,
            );
            await blocker.query("commit;");
            const results = await Promise.all(pending);
            const winners = results.filter(
              (result) => result.status === "accepted",
            );
            check(
              winners.length === 1,
              "Counter/quota serialization admitted more than one twelfth invocation",
            );
            for (const result of results.filter(
              (candidate) => candidate.status !== "accepted",
            ))
              deniedResult(result);
            const final = harness.snapshot(target);
            const row = currentSession(
              final,
              joined.result.scope.studentSessionId,
            );
            check(
              row.last_accepted_proof_counter ===
                winners[0].acceptedProofCounter &&
                row.maintenance_accepted_at.length === 12 &&
                row.revision === 1 &&
                row.epoch === 1 &&
                row.capability_digest === joined.candidates.capabilityDigest &&
                row.reconnect_digest === joined.candidates.reconnectDigest &&
                transitionCount(final, "student_session_admitted") === 1 &&
                transitionCount(final, "student_session_reconnected") === 0,
              "Losing concurrent counter changed quota, credential, revision or audit",
            );
            const beforeReplay = harness.snapshot(target);
            deniedResult(
              await harness.send(
                joined,
                harness.maintenance(joined, "read", 100),
              ),
            );
            same(
              harness.snapshot(target),
              beforeReplay,
              "Over-quota higher-counter denial changed the full tuple",
            );
          } finally {
            await blocker.close();
            await Promise.allSettled(pending);
          }
        },
      );
    }

    await t.test(
      "Student locks: real audit failure rolls back a waiting twelfth-call rotation and retry recovers capacity",
      async () => {
        const target = await harness.test();
        const joined = await harness.join(await harness.issue(target));
        accepted(joined.result);
        for (let counter = 1; counter <= 11; counter += 1) {
          accepted(
            await harness.send(
              joined,
              harness.maintenance(joined, "read", counter),
            ),
            "STUDENT_SESSION_CURRENT",
          );
        }
        const next = harness.candidates();
        const requestId = randomUUID();
        const intent = harness.maintenance(joined, "reconnect", 12, {
          next,
          requestId,
        });
        const before = harness.snapshot(target);
        const removeFailure = installStudentAuditFailure(target);
        let removed = false;
        let blocker;
        let pending;
        try {
          blocker = await holdStudentLock(
            target,
            joined.result.scope.studentSessionId,
          );
          pending = harness.send(joined, intent);
          void pending.catch(() => {});
          await observeStudentWait(
            blocker,
            "read_student_maintenance_key",
            "student_sessions",
          );
          await blocker.query("commit;");
          unavailableResult(await pending);
          same(
            harness.snapshot(target),
            before,
            "Audit dependency failure did not roll back all mutation/counter/quota effects",
          );
          removeFailure();
          removed = true;
          const retry = harness.maintenance(joined, "reconnect", 13, {
            next,
            requestId,
          });
          const result = accepted(await harness.send(joined, retry));
          const final = harness.snapshot(target);
          const row = currentSession(
            final,
            joined.result.scope.studentSessionId,
          );
          check(
            result.acceptedProofCounter === 13 &&
              row.last_accepted_proof_counter === 13 &&
              row.maintenance_accepted_at.length === 12 &&
              row.revision === 2 &&
              row.epoch === 1 &&
              row.capability_digest === next.capabilityDigest &&
              row.reconnect_digest === next.reconnectDigest &&
              transitionCount(final, "student_session_reconnected") === 1,
            "Retried rotation could not atomically use the capacity released by rollback",
          );
        } finally {
          if (blocker) await blocker.close();
          if (pending) await Promise.allSettled([pending]);
          if (!removed) removeFailure();
        }
      },
    );
  } finally {
    await harness.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  test(
    "observed real-handler StudentSession SQL serialization",
    { timeout: 180_000 },
    async (t) => {
      const { publishableKey, serviceKey } = openDisposableStack();
      const admin = client(serviceKey);
      await runStudentSessionLocks(t, {
        admin,
        publishableKey,
        serviceKey,
        checkRuntimeHealth: createRuntimeHealthCheck(admin, serviceKey),
      });
    },
  );
}
