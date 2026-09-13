import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { NativeEvidenceOriginBuild } from "@desmoslock/contracts";

import {
  createStudentSessionCoordinator,
  type PreflightReportReceipt,
} from "../../../apps/desktop/src/main/student-session-coordinator.js";
import { createStudentSessionCrypto } from "../../../apps/desktop/src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  openNativeStudentRecordStore,
  type ProtectionTransition,
} from "../../../apps/desktop/src/main/student-session-store.js";
import { createStudentSessionTransport } from "../../../apps/desktop/src/main/student-session-transport.js";

export { createStudentSessionCrypto } from "../../../apps/desktop/src/main/student-session-crypto.js";
export {
  encodeStudentProofEnvelope,
  encodeStudentEvidenceProof,
  parseStudentEvidenceRequest,
} from "@desmoslock/contracts";

export const syntheticPrefix = "SYNTHETIC_PRIVATE_BOUNDARY_ONLY:";
export const syntheticOriginBuild: NativeEvidenceOriginBuild = {
  kind: "build",
  identity: {
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    packageLockSha256: "c".repeat(64),
    buildId: "d".repeat(64),
  },
};
const confirmed = {
  aac: { status: "confirmed", code: "none" },
  shortcuts: { status: "confirmed", code: "none" },
  applications: { status: "confirmed", code: "none" },
  persistence: { status: "confirmed", code: "none" },
  windowNetwork: { status: "confirmed", code: "none" },
} as const;

async function worker() {
  const directory = process.argv[3];
  const url = process.argv[4];
  if (directory === undefined || url === undefined)
    throw new Error("Synthetic worker arguments missing");
  const configuration = { environment: "local" as const, url };
  const ignoreAbort = process.argv[5] === "ignore-abort";
  const crypto = createStudentSessionCrypto(configuration);
  let elapsed = 0;
  let writes = 0;
  let closes = 0;
  let blockNextWrite = false;
  let failNextWrite = false;
  let releaseWrite: (() => void) | undefined;
  const store = createStudentSessionStore({
    apiOrigin: configuration.url,
    async openNativeStore() {
      const native = await openNativeStudentRecordStore(directory);
      return {
        loadEncryptedRecord: () => native.loadEncryptedRecord(),
        quarantineEncryptedRecord: () => native.quarantineEncryptedRecord(),
        async replaceEncryptedRecord(bytes: Buffer) {
          writes += 1;
          await native.replaceEncryptedRecord(bytes);
          if (failNextWrite) {
            failNextWrite = false;
            // Inject only a return-path error after a REAL successful native barrier.
            throw new Error("Synthetic lost native completion");
          }
          if (blockNextWrite) {
            blockNextWrite = false;
            const blocked = new Promise<void>((resolve) => {
              releaseWrite = resolve;
            });
            send({ event: "published-return-blocked" });
            await blocked;
          }
        },
        async close() {
          await native.close();
          closes += 1;
        },
      };
    },
    // Intentionally NOT encryption: this fixture never invokes OS key storage.
    codec: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`${syntheticPrefix}${value}`),
      decryptString: (value) => {
        const text = value.toString();
        if (!text.startsWith(syntheticPrefix))
          throw new Error("Synthetic codec rejected artifact");
        return text.slice(syntheticPrefix.length);
      },
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  });
  const transport = createStudentSessionTransport(
    configuration,
    ignoreAbort
      ? (input, init) => fetch(input, { ...init, signal: null })
      : fetch,
  );
  const coordinator = createStudentSessionCoordinator({
    apiOrigin: configuration.url,
    store,
    crypto,
    transport,
    monotonicNow: () => elapsed,
    drainTimeoutMs: 1_000,
    originBuild:
      process.argv[6] === "replacement-build" &&
      syntheticOriginBuild.kind === "build"
        ? {
            ...syntheticOriginBuild,
            identity: {
              ...syntheticOriginBuild.identity,
              buildId: "e".repeat(64),
            },
          }
        : syntheticOriginBuild,
  });
  type PreflightFailureCommand = Extract<
    ProtectionTransition,
    { kind: "preflight_failure" }
  >;
  // One private reservation per worker; neither receipt nor admission is serialized.
  let reservedPreflight: {
    readonly attemptId: string;
    readonly receipt: PreflightReportReceipt;
    readonly expectedProtectionRevision: number;
    observed: PreflightFailureCommand | null;
  } | null = null;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      const command = JSON.parse(line) as {
        id: number;
        operation: string;
        code?: string;
        ms?: number;
      };
      try {
        let result: unknown;
        switch (command.operation) {
          case "initialize":
            await coordinator.initialize();
            break;
          case "join":
            await coordinator.joinInitial(command.code ?? "");
            break;
          case "retry":
            await coordinator.retryPending();
            break;
          case "refresh":
            await coordinator.refresh();
            break;
          case "flush":
            await coordinator.flushEvidence();
            break;
          case "fresh": {
            const admission = coordinator.readProtectionContext().admission;
            result =
              admission === null
                ? "unavailable"
                : (await coordinator.readFreshAdmission(admission)).status;
            break;
          }
          case "reserve-preflight": {
            if (reservedPreflight !== null)
              throw new Error("Synthetic preflight already reserved");
            const admission = coordinator.readProtectionContext().admission;
            if (admission === null)
              throw new Error("Synthetic admission unavailable");
            const read = await coordinator.readFreshAdmission(admission);
            if (read.status !== "fresh")
              throw new Error("Synthetic fresh read unavailable");
            const expectedProtectionRevision =
              coordinator.readProtectionContext().protection?.revision ?? 0;
            const attemptId = randomUUID();
            const receipt = coordinator.reservePreflightReport(
              read.authority,
              attemptId,
            );
            if (receipt === null)
              throw new Error("Synthetic preflight reservation unavailable");
            reservedPreflight = {
              attemptId,
              receipt,
              expectedProtectionRevision,
              observed: null,
            };
            result = { status: "reserved", attemptId };
            break;
          }
          case "preflight-application-failure":
          case "preflight-shortcut-failure": {
            const reservation = reservedPreflight;
            if (reservation === null)
              throw new Error("Synthetic preflight reservation missing");
            const cause =
              command.operation === "preflight-application-failure"
                ? "application_policy"
                : "shortcut_unavailable";
            if (reservation.observed === null) {
              // Capture once BEFORE the real write can block or lose its reply.
              // These are synthetic observations; this worker never invokes AAC.
              reservation.observed = Object.freeze({
                kind: "preflight_failure",
                attemptId: reservation.attemptId,
                expectedProtectionRevision:
                  reservation.expectedProtectionRevision,
                receipt: reservation.receipt,
                cause,
                categories: Object.freeze({
                  aac: Object.freeze({
                    status: "pending",
                    code: "awaiting_native_begin",
                  }),
                  applications: Object.freeze(
                    cause === "application_policy"
                      ? { status: "failed", code: "prohibited_application" }
                      : { status: "confirmed", code: "none" },
                  ),
                  shortcuts: Object.freeze(
                    cause === "shortcut_unavailable"
                      ? {
                          status: "failed",
                          code: "emergency_shortcut_unavailable",
                        }
                      : { status: "confirmed", code: "none" },
                  ),
                  persistence: Object.freeze({
                    status: "confirmed",
                    code: "none",
                  }),
                  windowNetwork: Object.freeze({
                    status: "confirmed",
                    code: "none",
                  }),
                }),
              });
            } else if (reservation.observed.cause !== cause) {
              throw new Error("Synthetic preflight cause cannot change");
            }
            result = {
              attemptId: reservation.attemptId,
              ...(await coordinator.commitProtectionTransition(
                reservation.observed,
              )),
            };
            break;
          }
          case "synthetic-preflight-cleanup": {
            const reservation = reservedPreflight;
            const context = coordinator.readProtectionContext();
            if (
              reservation?.observed == null ||
              context.protection?.latestAttempt?.attemptId !==
                reservation.attemptId
            )
              throw new Error(
                "Synthetic reported preflight attempt unavailable",
              );
            // Synthetic disposal proof only: no AAC invocation or native event.
            result = {
              attemptId: reservation.attemptId,
              synthetic: true,
              ...(await coordinator.commitProtectionTransition({
                kind: "disposed_without_terminal_observation",
                attemptId: reservation.attemptId,
                expectedProtectionRevision: context.protection.revision,
              })),
            };
            break;
          }
          case "engaging": {
            const admission = coordinator.readProtectionContext().admission;
            if (admission === null)
              throw new Error("Synthetic admission unavailable");
            const read = await coordinator.readFreshAdmission(admission);
            if (read.status !== "fresh")
              throw new Error("Synthetic fresh read unavailable");
            const context = coordinator.readProtectionContext();
            const attemptId = randomUUID();
            result = {
              attemptId,
              ...(await coordinator.commitProtectionTransition({
                kind: "engaging",
                attemptId,
                expectedProtectionRevision: context.protection?.revision ?? 0,
                authority: read.authority,
                categories: {
                  ...confirmed,
                  aac: { status: "pending", code: "awaiting_native_begin" },
                },
              })),
            };
            break;
          }
          case "began":
          case "terminal":
          case "cleanup":
          case "failure": {
            const context = coordinator.readProtectionContext();
            const attempt = context.protection?.latestAttempt;
            if (attempt == null || context.protection === null)
              throw new Error("Synthetic attempt unavailable");
            const base = {
              attemptId: attempt.attemptId,
              expectedProtectionRevision: context.protection.revision,
            };
            result = await coordinator.commitProtectionTransition(
              command.operation === "began"
                ? {
                    ...base,
                    kind: "began",
                    event: {
                      type: "did_begin",
                      attemptId: attempt.attemptId,
                      sequence: (attempt.nativeSequence ?? 0) + 1,
                      code: "none",
                    },
                  }
                : command.operation === "terminal"
                  ? {
                      ...base,
                      kind: "native_terminal",
                      event: {
                        type: "did_end",
                        attemptId: attempt.attemptId,
                        sequence: (attempt.nativeSequence ?? 0) + 1,
                        code: "none",
                      },
                    }
                  : command.operation === "cleanup"
                    ? { ...base, kind: "cleanup", outcome: "complete" }
                    : {
                        ...base,
                        kind: "failure",
                        cause: "shortcut_unavailable",
                      },
            );
            break;
          }
          case "forfeit":
            await coordinator.forfeit(coordinator.readView().revision);
            break;
          case "targeted":
            await coordinator.beginTargetedReadmission(
              command.code ?? "",
              coordinator.readView().revision,
            );
            break;
          case "advance":
            elapsed += command.ms ?? 0;
            break;
          case "block-next-write":
            blockNextWrite = true;
            break;
          case "fail-next-write":
            failNextWrite = true;
            break;
          case "release-write":
            releaseWrite?.();
            releaseWrite = undefined;
            break;
          case "quarantine-only":
            // Synthetic crash-state preparation: stop between the two real store calls.
            result = await store.preserveForTargetedRecovery(0);
            break;
          case "dispose":
            result = await coordinator.dispose();
            break;
          case "state":
            break;
          default:
            throw new Error("Unknown synthetic command");
        }
        send({
          id: command.id,
          result,
          view: coordinator.readView(),
          writes,
          closes,
          idle: transport.isIdle(),
          protection: coordinator.readProtectionContext().protection,
          delivery: coordinator.readProtectionContext().delivery,
          observationSequence:
            coordinator.readProtectionContext().observationSequence,
        });
      } catch {
        send({ id: command.id, failed: true });
      }
    })();
  });
  send({ event: "ready" });
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
if (process.argv[2] === "--worker") await worker();
