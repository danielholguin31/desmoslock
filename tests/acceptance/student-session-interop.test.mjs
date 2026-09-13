import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createStudentSessionCrypto } from "../../apps/desktop/src/main/student-session-crypto.ts";
import {
  accepted,
  check,
  createStudentHarness,
  currentSession,
  deniedResult,
  same,
  transitionCount,
  unavailableResult,
  withoutAttemptMetadata,
} from "./student-session-harness.mjs";
import {
  client,
  code,
  createRuntimeHealthCheck,
  openDisposableStack,
  rpc,
  rpcRows,
} from "./staff-auth-loopback.mjs";

// This exported hook runs inside the existing restored-target composed test.
// Its runtime object is already provisioned; never call openDisposableStack
// again after the prior provider groups have populated Auth and immutable audit.
export async function runStudentSessionInterop(t, runtime) {
  const harness = await createStudentHarness(runtime);
  let target;
  let material;
  let joined;
  let rotated;
  let claimed;
  try {
    await t.test(
      "Student: live staff issues a private code and exact retry preserves expiry",
      async () => {
        target = await harness.test();
        material = await harness.issue(target);
        const replay = await harness.staffMutation(
          "issue_test_join_code",
          material.request,
          "join_code_already_issued",
        );
        same(
          { ...replay, code: "join_code_issued" },
          material.result,
          "Exact issuance retry changed the original grant metadata",
        );
        const before = harness.snapshot(target);
        code(
          await rpc(
            harness.foreignTeacher.client,
            "issue_test_join_code",
            material.request,
          ),
          "membership_inactive",
        );
        same(
          harness.snapshot(target),
          before,
          "Foreign staff issuance changed target state",
        );
        for (const relation of [
          "student_sessions",
          "student_join_materials",
          "student_device_bindings",
          "student_bootstrap_challenges",
          "student_bootstrap_limits",
          "student_device_proof_state",
          "student_protection_events",
        ]) {
          let result;
          try {
            result = await harness.teacher.client
              .schema("desmoslock_v2")
              .from(relation)
              .select("*")
              .limit(1);
          } catch {
            throw new Error(
              "Direct-table denial could not be observed; details withheld",
            );
          }
          check(
            result.error !== null && result.data === null,
            "Staff could bypass the exact Student RPC surface through direct table access",
          );
        }
      },
    );

    await t.test(
      "Student: colleague Owner and Administrator require live AAL2 for code issuance",
      async () => {
        for (const role of ["owner", "admin"]) {
          const staff = await harness.actor(role, harness.schoolId, role, true);
          const privateCode = harness.crypto.createJoinCode();
          const detail = await rpc(staff.client, "current_school_test", {
            workspace_id: target.schoolId,
            test_id: target.testId,
          });
          const request = {
            workspace_id: target.schoolId,
            test_id: target.testId,
            expected_test_revision: detail.test_revision,
            issuance_request_id: randomUUID(),
            join_material_digest: harness.crypto.digestJoinCode(privateCode),
          };
          const before = harness.snapshot(target);
          const refusal = await rpc(
            staff.aal1Client,
            "issue_test_join_code",
            request,
          );
          check(
            refusal.code === "step_up_required" &&
              Object.entries(refusal).every(
                ([key, value]) => key === "code" || value === null,
              ),
            "Privileged staff AAL1 issuance did not fail with exact null authority fields",
          );
          same(
            harness.snapshot(target),
            before,
            "Insufficient-assurance staff modified code authority",
          );
          await harness.staffMutation(
            "issue_test_join_code",
            request,
            "join_code_issued",
            staff,
          );
        }
        material = await harness.issue(target);
      },
    );

    await t.test(
      "Student: actual Node signature reaches Deno and SQL; lost join response retries the exact intent",
      async () => {
        let droppedResult;
        const lossTransport = harness.transport(async (input, init) => {
          const response = await fetch(input, init);
          if (
            new URL(
              input instanceof Request ? input.url : input,
            ).pathname.endsWith("student-session-join") &&
            response.status === 200
          ) {
            droppedResult = await response.clone().json();
            accepted(droppedResult);
            await response.body?.cancel();
            throw new Error(
              "Synthetic response loss after observed real join commit",
            );
          }
          return response;
        });
        const lost = await harness.join(material, { transport: lossTransport });
        unavailableResult(lost.result);
        check(
          droppedResult !== undefined,
          "Join loss injection did not observe a real accepted backend response",
        );
        const committed = harness.snapshot(target);
        check(
          committed.sessions.length === 1 &&
            committed.bindings.length === 1 &&
            transitionCount(committed, "student_session_admitted") === 1,
          "Lost response did not leave one atomic server identity and event",
        );
        joined = await harness.join(material, {
          requestId: lost.request.requestId,
          device: lost.device,
          candidates: lost.candidates,
        });
        accepted(joined.result);
        same(
          withoutAttemptMetadata(joined.result),
          withoutAttemptMetadata(droppedResult),
          "Join recovery changed the original scope, revision or expiry",
        );
        const row = currentSession(
          harness.snapshot(target),
          joined.result.scope.studentSessionId,
        );
        check(
          row.revision === 1 &&
            row.epoch === 1 &&
            row.last_accepted_proof_counter === 0 &&
            row.maintenance_accepted_at.length === 0,
          "Bootstrap allocated admitted maintenance counter or quota",
        );
        const replay = await harness.raw("join", joined.request);
        check(replay.status === 403, "Consumed bootstrap proof was reused");
        deniedResult(replay.result);
      },
    );

    await t.test(
      "Student: mode and candidate substitution cannot adopt the current join receipt",
      async () => {
        const before = harness.snapshot(target);
        const changed = await harness.join(material, {
          requestId: joined.request.requestId,
          device: joined.device,
          candidates: harness.candidates(),
        });
        deniedResult(changed.result);
        const switched = await harness.join(material, {
          requestId: joined.request.requestId,
          device: joined.device,
          candidates: joined.candidates,
          mode: "readmission",
        });
        deniedResult(switched.result);
        same(
          harness.snapshot(target),
          before,
          "Mismatched exact-join recovery altered persisted authority",
        );
      },
    );

    await t.test(
      "Student: signed own read, replay and signature/scope/key/operation substitutions",
      async () => {
        const first = harness.maintenance(joined, "read", 1);
        accepted(await harness.send(joined, first), "STUDENT_SESSION_CURRENT");
        const before = harness.snapshot(target);
        deniedResult(await harness.send(joined, first));
        same(
          harness.snapshot(target),
          before,
          "Same-counter replay changed the proof window or tuple",
        );
        const valid = harness.maintenance(joined, "read", 2);
        const signature = Buffer.from(
          valid.request.deviceProof.signature,
          "base64url",
        );
        signature[0] ^= 1;
        const modifiedSignature = {
          ...valid.request,
          deviceProof: {
            ...valid.request.deviceProof,
            signature: signature.toString("base64url"),
          },
        };
        deniedResult((await harness.raw("read", modifiedSignature)).result);
        const foreignScope = {
          ...valid.request,
          scope: { ...valid.request.scope, schoolId: harness.foreignSchoolId },
        };
        deniedResult((await harness.raw("read", foreignScope)).result);
        const attacker = {
          ...harness.device(),
          deviceSessionId: joined.device.deviceSessionId,
        };
        const copiedToken = harness.maintenance(joined, "read", 3, {
          device: attacker,
        });
        deniedResult((await harness.raw("read", copiedToken.request)).result);
        const wrongOriginCrypto = createStudentSessionCrypto({
          environment: "local",
          url: "http://127.0.0.1:1",
        });
        const wrongOrigin = {
          ...valid.request,
          deviceProof: wrongOriginCrypto.signMaintenance(joined.device, {
            kind: "maintenance",
            operation: "read",
            requestId: valid.request.requestId,
            scope: valid.request.scope,
            logicalOperationDigest: valid.logicalOperationDigest,
            counter: 2,
          }),
        };
        deniedResult((await harness.raw("read", wrongOrigin)).result);
        const wrongOperation = {
          ...valid.request,
          deviceProof: harness.crypto.signMaintenance(joined.device, {
            kind: "maintenance",
            operation: "forfeit",
            requestId: valid.request.requestId,
            scope: valid.request.scope,
            logicalOperationDigest: valid.logicalOperationDigest,
            counter: 2,
          }),
        };
        deniedResult((await harness.raw("read", wrongOperation)).result);
        for (const counter of [0, Number.MAX_SAFE_INTEGER + 1]) {
          deniedResult(
            (
              await harness.raw("read", {
                ...valid.request,
                deviceProof: { ...valid.request.deviceProof, counter },
              })
            ).result,
          );
        }
        deniedResult(
          (
            await harness.raw("read", {
              ...valid.request,
              deviceProof: {
                ...valid.request.deviceProof,
                publicKey: attacker.publicKey,
              },
            })
          ).result,
        );
        same(
          harness.snapshot(target),
          before,
          "Forgery, malformed proof or foreign scope charged victim capacity",
        );
        accepted(
          await harness.send(joined, harness.maintenance(joined, "read", 7)),
          "STUDENT_SESSION_CURRENT",
        );
        const row = currentSession(
          harness.snapshot(target),
          joined.result.scope.studentSessionId,
        );
        check(
          row.revision === 1 &&
            row.last_accepted_proof_counter === 7 &&
            row.maintenance_accepted_at.length === 2,
          "Accepted counter gap changed domain revision or failed to charge exactly one invocation",
        );
      },
    );

    await t.test(
      "Student: exact lost reconnect response recovers consumed grant and original expiry",
      async () => {
        const next = harness.candidates();
        const requestId = randomUUID();
        const intent = harness.maintenance(joined, "reconnect", 8, {
          next,
          requestId,
        });
        let committedResult;
        const lossTransport = harness.transport(async (input, init) => {
          const response = await fetch(input, init);
          if (response.status === 200) {
            committedResult = await response.clone().json();
            accepted(committedResult);
            await response.body?.cancel();
            throw new Error(
              "Synthetic response loss after observed real rotation commit",
            );
          }
          return response;
        });
        unavailableResult(await harness.send(joined, intent, lossTransport));
        check(
          committedResult !== undefined,
          "Rotation loss injection did not observe the real commit",
        );
        const retry = harness.maintenance(joined, "reconnect", 9, {
          next,
          requestId,
        });
        const result = accepted(await harness.send(joined, retry));
        same(
          withoutAttemptMetadata(result),
          withoutAttemptMetadata(committedResult),
          "Consumed-grant receipt changed original issuance facts",
        );
        check(
          result.acceptedProofCounter === 9,
          "Receipt recovery failed to acknowledge this attempt's greater counter",
        );
        rotated = { ...joined, candidates: next, result };
        const snapshot = harness.snapshot(target);
        const row = currentSession(snapshot, result.scope.studentSessionId);
        check(
          row.revision === 2 &&
            row.epoch === 1 &&
            row.last_accepted_proof_counter === 9 &&
            row.maintenance_accepted_at.length === 4 &&
            transitionCount(snapshot, "student_session_reconnected") === 1,
          "Reconnect retry duplicated a transition or reset proof accounting",
        );
        const mismatch = harness.maintenance(joined, "reconnect", 10, {
          next: harness.candidates(),
          requestId,
        });
        deniedResult(await harness.send(joined, mismatch));
        same(
          harness.snapshot(target),
          snapshot,
          "Changed rotation candidates stole an existing receipt",
        );
      },
    );

    await t.test(
      "Student: staff remove and targeted recovery preserve identity and permanent device exclusion",
      async () => {
        const removed = await harness.remove(target, rotated);
        const prepared = await harness.prepare(
          target,
          rotated,
          removed.session_revision,
        );
        const replay = await harness.staffMutation(
          "prepare_student_readmission",
          prepared.request,
          "student_readmission_already_prepared",
        );
        same(
          { ...replay, code: "student_readmission_prepared" },
          prepared.result,
          "Prepare retry changed original targeted expiry",
        );
        deniedResult(
          await harness.send(rotated, harness.maintenance(rotated, "read", 20)),
        );
        const wrongMode = await harness.join(prepared, { mode: "initial" });
        deniedResult(wrongMode.result);
        claimed = await harness.join(prepared, { mode: "readmission" });
        accepted(claimed.result);
        check(
          claimed.result.scope.studentSessionId ===
            joined.result.scope.studentSessionId &&
            claimed.result.syntheticDisplayName ===
              joined.result.syntheticDisplayName &&
            claimed.result.scope.epoch === 3 &&
            claimed.result.sessionRevision === 5,
          "Targeted recovery changed identity, prepared epoch or revision accounting",
        );
        const before = harness.snapshot(target);
        check(
          before.bindings.length === 2,
          "Rebinding erased the old permanent device mapping",
        );
        const oldDevice = await harness.join(material, {
          device: joined.device,
        });
        deniedResult(oldDevice.result);
        same(
          harness.snapshot(target),
          before,
          "Old device binding created or revived another identity",
        );
        const rows = await rpcRows(
          harness.teacher.client,
          "current_test_student_sessions",
          {
            workspace_id: target.schoolId,
            test_id: target.testId,
            before_created_at: null,
            before_session_id: null,
          },
        );
        check(
          rows.length === 1 &&
            rows[0].session_id === claimed.result.scope.studentSessionId &&
            rows[0].state === "active" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(
              rows[0].created_at,
            ) &&
            Object.keys(rows[0]).sort().join(",") ===
              [
                "code",
                "session_id",
                "school_id",
                "test_id",
                "synthetic_display_name",
                "state",
                "epoch",
                "session_revision",
                "created_at",
                "evidence_summary",
              ]
                .sort()
                .join(","),
          "Staff roster disclosed authority fields or lost exact timestamp precision",
        );
      },
    );

    await t.test(
      "Student: forfeit acknowledges backend admission only and end denies existing authority",
      async () => {
        accepted(
          await harness.send(
            claimed,
            harness.maintenance(claimed, "forfeit", 1),
          ),
          "STUDENT_SESSION_FORFEITED",
        );
        const snapshot = harness.snapshot(target);
        const row = currentSession(
          snapshot,
          claimed.result.scope.studentSessionId,
        );
        check(
          row.state === "forfeited" &&
            row.epoch === 4 &&
            row.revision === 6 &&
            row.capability_digest === null &&
            row.reconnect_digest === null &&
            row.last_accepted_proof_counter === 0 &&
            row.maintenance_accepted_at.length === 0 &&
            transitionCount(snapshot, "student_session_forfeited") === 1,
          "Forfeit did not atomically invalidate the current device epoch",
        );
        deniedResult(
          await harness.send(
            claimed,
            harness.maintenance(claimed, "forfeit", 2),
          ),
        );
        const other = await harness.join(material);
        accepted(other.result);
        await harness.end(target);
        const ended = harness.snapshot(target);
        deniedResult(
          await harness.send(other, harness.maintenance(other, "read", 1)),
        );
        deniedResult((await harness.join(material)).result);
        same(
          harness.snapshot(target),
          ended,
          "Parent end allowed a fresh admission, read or domain mutation",
        );
      },
    );
    await t.test(
      "Evidence: original-key reports and live maintenance serialize one counter with separate allowances",
      async () => {
        const target = await harness.test();
        const joined = await harness.join(await harness.issue(target));
        accepted(joined.result);
        const intent = harness.evidence(joined, 1);
        const initial = accepted(
          await harness.sendEvidence(intent),
          "STUDENT_EVIDENCE_ACCEPTED",
        );
        const beforeReplay = harness.snapshot(target);
        deniedResult(
          await harness.send(joined, harness.maintenance(joined, "read", 1)),
        );
        same(
          harness.snapshot(target),
          beforeReplay,
          "Shared-counter denial mutated proof, report or live tuple",
        );
        accepted(
          await harness.send(joined, harness.maintenance(joined, "read", 2)),
          "STUDENT_SESSION_CURRENT",
        );
        const retry = harness.evidence(joined, 3, {
          facts: intent.request.facts,
        });
        const replay = accepted(
          await harness.sendEvidence(retry),
          "STUDENT_EVIDENCE_ACCEPTED",
        );
        same(
          initial.acknowledged,
          replay.acknowledged,
          "Duplicate report changed original receipt time or content",
        );
        const state = harness.snapshot(target);
        const proof = state.proofs[0];
        const session = currentSession(
          state,
          joined.result.scope.studentSessionId,
        );
        check(
          state.evidence.length === 1 &&
            proof.last_accepted_proof_counter === 3 &&
            proof.maintenance_accepted_at.length === 1 &&
            proof.evidence_accepted_at.length === 2 &&
            session.last_accepted_proof_counter === 3 &&
            session.maintenance_accepted_at.length === 1 &&
            session.revision === 1,
          "Evidence and live maintenance diverged common counter, quota or compatibility mirror",
        );
        const first = intent.request.facts[0];
        const failure = {
          ...first,
          eventId: randomUUID(),
          sequence: 2,
          slot: "failure",
          phase: "failed",
          categories: {
            ...first.categories,
            aac: { status: "unavailable", code: "native_unavailable" },
          },
          cause: "native_failure",
        };
        const append = harness.evidence(joined, 4, { facts: [first, failure] });
        const appended = accepted(
          await harness.sendEvidence(append),
          "STUDENT_EVIDENCE_ACCEPTED",
        );
        same(
          appended.acknowledged.find((ack) => ack.eventId === first.eventId),
          initial.acknowledged[0],
          "Late original-attempt fact rewrote acknowledged prefix",
        );
        const beforeConflict = harness.snapshot(target);
        const conflict = harness.evidence(joined, 5, {
          facts: [first, { ...failure, cause: "backend_unavailable" }],
        });
        deniedResult(await harness.sendEvidence(conflict));
        same(
          harness.snapshot(target),
          beforeConflict,
          "Content conflict committed a partial batch or consumed shared counter/quota",
        );
        const historyArgs = {
          workspace_id: target.schoolId,
          test_id: target.testId,
          student_session_id: joined.result.scope.studentSessionId,
          before_received_at: null,
          before_event_id: null,
        };
        const history = await rpcRows(
          harness.teacher.client,
          "current_student_protection_events",
          historyArgs,
        );
        check(
          history.length === 2 &&
            history.every(
              (row) =>
                Object.keys(row).sort().join(",") ===
                  [
                    "code",
                    "fact",
                    "origin_build",
                    "content_digest",
                    "received_at",
                  ]
                    .sort()
                    .join(",") &&
                row.code === "ok" &&
                row.fact.scope.epoch === 1 &&
                row.origin_build.kind === "unverified_build" &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(
                  row.received_at,
                ),
            ),
          "Teacher history lost closed historical report metadata or timestamp precision",
        );
        code(
          await rpc(
            harness.foreignTeacher.client,
            "current_student_protection_events",
            historyArgs,
          ),
          "membership_inactive",
        );
        const roster = await rpcRows(
          harness.teacher.client,
          "current_test_student_sessions",
          {
            workspace_id: target.schoolId,
            test_id: target.testId,
            before_created_at: null,
            before_session_id: null,
          },
        );
        const summary = roster[0]?.evidence_summary;
        check(
          summary?.reportCount === 2 &&
            summary.failureCount === 1 &&
            summary.latestReportedEpoch === 1 &&
            summary.latestReceivedAt === history[0].received_at,
          "Teacher summary treated historical reports as current authority or lost failure accounting",
        );
      },
    );

    for (const cause of ["application_policy", "shortcut_unavailable"]) {
      await t.test(
        `Evidence: ${cause} preflight report survives forfeit and reaches Teacher history without native claims`,
        async () => {
          const target = await harness.test();
          const joined = await harness.join(await harness.issue(target));
          accepted(joined.result);
          const original = harness.evidence(joined, 1).request.facts[0];
          const failure = {
            ...original,
            slot: "failure",
            phase: "failed",
            cause,
            categories: {
              ...original.categories,
              ...(cause === "application_policy"
                ? {
                    applications: {
                      status: "unavailable",
                      code: "application_observation_unavailable",
                    },
                  }
                : {
                    shortcuts: {
                      status: "unavailable",
                      code: "emergency_shortcut_unavailable",
                    },
                  }),
            },
          };
          const first = accepted(
            await harness.sendEvidence(
              harness.evidence(joined, 1, { facts: [failure] }),
            ),
            "STUDENT_EVIDENCE_ACCEPTED",
          );
          accepted(
            await harness.send(
              joined,
              harness.maintenance(joined, "forfeit", 2),
            ),
            "STUDENT_SESSION_FORFEITED",
          );
          const cleanup = {
            ...failure,
            sequence: failure.sequence + 1,
            eventId: randomUUID(),
            slot: "cleanup",
            cause: "none",
          };
          const facts = [failure, cleanup];
          const appended = accepted(
            await harness.sendEvidence(harness.evidence(joined, 3, { facts })),
            "STUDENT_EVIDENCE_ACCEPTED",
          );
          same(
            appended.acknowledged.find(
              (ack) => ack.eventId === failure.eventId,
            ),
            first.acknowledged[0],
            "Preflight cleanup rewrote the original failure receipt",
          );
          const replay = accepted(
            await harness.sendEvidence(harness.evidence(joined, 4, { facts })),
            "STUDENT_EVIDENCE_ACCEPTED",
          );
          same(
            replay.acknowledged,
            appended.acknowledged,
            "Preflight retry changed exact acknowledged history",
          );
          const history = await rpcRows(
            harness.teacher.client,
            "current_student_protection_events",
            {
              workspace_id: target.schoolId,
              test_id: target.testId,
              student_session_id: joined.result.scope.studentSessionId,
              before_received_at: null,
              before_event_id: null,
            },
          );
          check(
            history.length === 2 &&
              history.every(
                (row) =>
                  row.code === "ok" &&
                  row.fact.phase === "failed" &&
                  row.fact.nativeEvent === null &&
                  row.fact.nativeSequence === null &&
                  row.fact.categories.aac.status === "pending" &&
                  row.fact.scope.epoch === joined.result.scope.epoch &&
                  row.origin_build.kind === "unverified_build",
              ),
            "Teacher history acquired native or replacement-authority claims from a preflight report",
          );
          same(
            history.find((row) => row.fact.slot === "failure")?.fact,
            failure,
            "Teacher history lost the actual preflight failure category or cause",
          );
          const roster = await rpcRows(
            harness.teacher.client,
            "current_test_student_sessions",
            {
              workspace_id: target.schoolId,
              test_id: target.testId,
              before_created_at: null,
              before_session_id: null,
            },
          );
          check(
            roster[0]?.state === "forfeited" &&
              roster[0]?.evidence_summary?.reportCount === 2 &&
              roster[0]?.evidence_summary?.failureCount === 1,
            "Preflight evidence reopened admission or failed Teacher summary accounting",
          );
        },
      );
    }

    await t.test(
      "Evidence: an actual committed lost HTTP response recovers exact receipts without retry inside the transport",
      async () => {
        const target = await harness.test();
        const joined = await harness.join(await harness.issue(target));
        accepted(joined.result);
        const intent = harness.evidence(joined, 1);
        let observed;
        let calls = 0;
        const losing = harness.transport(async (input, init) => {
          calls += 1;
          const response = await fetch(input, init);
          if (response.status === 200) observed = await response.clone().json();
          throw new Error("Synthetic post-commit response loss");
        });
        unavailableResult(await harness.sendEvidence(intent, losing));
        check(
          calls === 1 && observed?.code === "STUDENT_EVIDENCE_ACCEPTED",
          "Lost response fixture never observed the actual committed evidence result or retried",
        );
        const retry = harness.evidence(joined, 2, {
          facts: intent.request.facts,
        });
        const result = accepted(
          await harness.sendEvidence(retry),
          "STUDENT_EVIDENCE_ACCEPTED",
        );
        same(
          result.acknowledged,
          observed.acknowledged,
          "Lost response recovery invented fresh receipt timestamps",
        );
        const state = harness.snapshot(target);
        check(
          state.evidence.length === 1 &&
            state.proofs[0].last_accepted_proof_counter === 2 &&
            state.proofs[0].evidence_accepted_at.length === 2,
          "Exact recovery duplicated reports or failed to advance common counter",
        );
      },
    );

    for (const transition of ["removed", "forfeited", "ended", "rebound"]) {
      await t.test(
        `Evidence: ${transition} keeps original report-only permission without renewed admission`,
        async () => {
          const target = await harness.test();
          const joined = await harness.join(await harness.issue(target));
          accepted(joined.result);
          const intent = harness.evidence(joined, 2);
          let successor;
          if (transition === "ended") await harness.end(target);
          else if (transition === "forfeited")
            accepted(
              await harness.send(
                joined,
                harness.maintenance(joined, "forfeit", 1),
              ),
              "STUDENT_SESSION_FORFEITED",
            );
          else {
            const removed = await harness.remove(target, joined);
            if (transition === "rebound") {
              const material = await harness.prepare(
                target,
                joined,
                removed.session_revision,
              );
              successor = await harness.join(material, { mode: "readmission" });
              accepted(successor.result);
            }
          }
          const before = harness.snapshot(target);
          const result = accepted(
            await harness.sendEvidence(intent),
            "STUDENT_EVIDENCE_ACCEPTED",
          );
          check(
            result.scope.epoch === joined.result.scope.epoch &&
              result.scope.deviceSessionId === joined.device.deviceSessionId,
            "Historical report was relabeled to uploader or current admission",
          );
          const after = harness.snapshot(target);
          same(
            after.audit,
            before.audit,
            "Report ingestion mutated staff admission audit",
          );
          same(
            after.bindings,
            before.bindings,
            "Report ingestion changed immutable admission binding",
          );
          const originalBefore = currentSession(
            before,
            joined.result.scope.studentSessionId,
          );
          const originalAfter = currentSession(
            after,
            joined.result.scope.studentSessionId,
          );
          for (const field of [
            "state",
            "epoch",
            "revision",
            "device_session_id",
            "capability_digest",
            "reconnect_digest",
            "capability_expires_at",
            "reconnect_expires_at",
          ])
            same(
              originalAfter[field],
              originalBefore[field],
              "Report ingestion renewed or replaced admission authority",
            );
          deniedResult(
            await harness.send(joined, harness.maintenance(joined, "read", 3)),
          );
          if (successor) {
            accepted(
              await harness.send(
                successor,
                harness.maintenance(successor, "read", 1),
              ),
              "STUDENT_SESSION_CURRENT",
            );
            const successorEvidence = harness.evidence(successor, 2);
            accepted(
              await harness.sendEvidence(successorEvidence),
              "STUDENT_EVIDENCE_ACCEPTED",
            );
            const final = harness.snapshot(target);
            check(
              final.proofs.length === 2 &&
                final.evidence.length === 2 &&
                final.proofs.every(
                  (proof) => proof.last_accepted_proof_counter === 2,
                ),
              "Retired original counter overwrote or blocked fresh binding counter",
            );
          }
        },
      );
    }
  } finally {
    await harness.close();
  }
}

// Standalone debug command requires a fresh already-running disposable stack.
// The composed/restored chain imports the hook above and passes its live context.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  test(
    "real Node/Deno/PostgREST StudentSession interoperability",
    { timeout: 180_000 },
    async (t) => {
      const { publishableKey, serviceKey } = openDisposableStack();
      const admin = client(serviceKey);
      await runStudentSessionInterop(t, {
        admin,
        publishableKey,
        serviceKey,
        checkRuntimeHealth: createRuntimeHealthCheck(admin, serviceKey),
      });
    },
  );
}
