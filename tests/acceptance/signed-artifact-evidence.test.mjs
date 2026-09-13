import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

// Exact positive-source aliases; no dist build, addon, signing, account, or
// notary operation. The adapter below proves protocol behavior, not durability.
const moduleSource = new URL(
  "../../scripts/unsigned-artifact-evidence.mjs",
  import.meta.url,
).href;
const identitySource = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactSource = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL === moduleSource &&
      specifier === "../packages/contracts/dist/build-identity.js"
    )
      return { url: identitySource, shortCircuit: true };
    if (
      context.parentURL === identitySource &&
      specifier === "./exact-record.js"
    )
      return { url: exactSource, shortCircuit: true };
    return next(specifier, context);
  },
});
const {
  openSignedArtifactEvidenceForTesting,
  openUnsignedArtifactEvidenceForTesting,
  signedEvidenceStageIds,
  unsignedEvidenceLimits,
  pendingPhysicalCaseIds,
} = await import(moduleSource);
hooks.deregister();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const runId = "10000000-0000-4000-8000-000000000001";
const id = "10000000-0000-1000-0000-000000000002"; // no UUID-version assumption
const artifactIdentity = {
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: "1".repeat(40),
  sourceTree: "2".repeat(40),
  packageLockSha256: "3".repeat(64),
  buildId: "4".repeat(64),
};
const originalInventory = Buffer.from("original admitted unsigned inventory");
const plan = {
  sha256: hash("canonical full signing plan"),
  policySha256: hash("closed signing policy"),
  unsignedCheckpointSha256: hash("original unsigned checkpoint"),
  unsignedAppTreeSha256: hash("unsigned tree"),
  unsignedAppInventorySha256: hash(originalInventory),
  toolingProvenanceSha256: hash("later independent reviewed tooling"),
  signingStepSha256s: [hash("child step"), hash("outer bundle step")],
};
const outputStages = new Set([
  "input-validation",
  "custody-copies",
  "sign-code",
  "signed-app-verification",
  "dmg-create",
  "dmg-sign",
  "dmg-staple",
]);
const schedule = signedEvidenceStageIds.flatMap((stageId) =>
  stageId === "sign-code"
    ? plan.signingStepSha256s.map((_, signingIndex) => ({
        stageId,
        signingIndex,
      }))
    : [{ stageId, signingIndex: null }],
);
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function hashOnly(artifact) {
  return artifact.kind === "app-tree"
    ? { kind: "app-tree", treeSha256: artifact.treeSha256 }
    : { kind: "dmg-file", sha256: artifact.sha256, bytes: artifact.bytes };
}
async function fixture(t, selectedPlan = plan) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "desmoslock-signed-evidence-"),
  );
  await fs.chmod(root, 0o700);
  const options = {
    mode: "create",
    runRoot: path.join(root, "signed-artifact-runs", runId),
    runId,
    identity: artifactIdentity,
    nativeModule: null,
    plan: selectedPlan,
  };
  let bytes = null;
  const owners = [];
  const releases = [];
  const state = {
    writes: 0,
    closes: 0,
    locked: false,
    beforeWrite: null,
    writeFailure: null,
    closeFailure: false,
  };
  const native = {
    maximumRecordBytes: 65536,
    async openStore() {
      assert.equal(state.locked, false);
      state.locked = true;
      return {
        async loadEncryptedRecord() {
          return bytes === null ? null : Buffer.from(bytes);
        },
        async replaceEncryptedRecord(value) {
          state.writes += 1;
          const copy = Buffer.from(value);
          await state.beforeWrite?.(copy);
          const failure = state.writeFailure;
          state.writeFailure = null;
          if (failure !== "unpublished") bytes = copy;
          if (failure !== null) throw new Error("private unavailable storage");
        },
        async quarantineEncryptedRecord() {
          assert.fail("no quarantine or automatic recovery");
        },
        async close() {
          state.closes += 1;
          if (state.closeFailure) throw new Error("private close unavailable");
          state.locked = false;
        },
      };
    },
  };
  t.after(async () => {
    state.closeFailure = false;
    state.beforeWrite = null;
    for (const release of releases) release();
    for (const owner of owners)
      assert.equal(await owner.close({ timeoutMs: 1000 }), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    options,
    state,
    native,
    releases,
    stored: () => JSON.parse(bytes),
    replace: (value) => {
      bytes = Buffer.from(JSON.stringify(value));
    },
    async open(patch = {}) {
      const owner = await openSignedArtifactEvidenceForTesting(
        { ...options, ...patch },
        native,
      );
      owners.push(owner);
      return owner;
    },
  };
}
function inputFor(snapshot, stageId) {
  if (["notary-reconcile", "dmg-staple"].includes(stageId))
    return hashOnly(snapshot.candidates.submittedDmg);
  if (["dmg-verification", "inspection-copy-mount"].includes(stageId))
    return hashOnly(snapshot.candidates.finalDmg);
  const latest = snapshot.attempts.findLast(
    (attempt) =>
      attempt.state === "observed-pass" && attempt.outputArtifact !== null,
  );
  return latest
    ? hashOnly(latest.outputArtifact)
    : { kind: "app-tree", treeSha256: snapshot.plan.unsignedAppTreeSha256 };
}
async function resultFor(
  scope,
  request,
  { status = "accepted", state = "observed-pass" } = {},
) {
  const inventory = await scope.writeEvidence(
    request.stageId === "input-validation"
      ? originalInventory
      : Buffer.from(
          `observation ${request.stageId} ${request.signingIndex} ${status}`,
        ),
  );
  let outputArtifact = null;
  if (outputStages.has(request.stageId) && state === "observed-pass") {
    if (["dmg-create", "dmg-sign", "dmg-staple"].includes(request.stageId))
      outputArtifact = {
        kind: "dmg-file",
        sha256: hash(request.stageId),
        bytes: 512 * 1024 * 1024,
        inventory,
      };
    else
      outputArtifact = {
        kind: "app-tree",
        treeSha256:
          request.stageId === "sign-code"
            ? hash(`signed app ${request.signingIndex}`)
            : request.inputArtifact.treeSha256,
        inventory,
      };
  }
  return {
    state,
    evidence: [inventory],
    outputArtifact,
    submission:
      request.stageId === "notary-submit" && state === "observed-pass"
        ? { id, submittedDmgSha256: request.inputArtifact.sha256 }
        : null,
    notaryStatus: request.stageId === "notary-reconcile" ? status : null,
  };
}
async function stage(
  owner,
  stageId,
  { signingIndex = null, work, patch = {}, status, state } = {},
) {
  const snapshot = await owner.readSnapshot();
  const request = {
    expectedRevision: snapshot.revision,
    stageId,
    signingIndex,
    inputArtifact: inputFor(snapshot, stageId),
    reservation: Buffer.from(`pre-command ${stageId} ${signingIndex}`),
    ...patch,
  };
  return owner.recordStage(request, (scope) =>
    work ? work(scope, request) : resultFor(scope, request, { status, state }),
  );
}
async function before(owner, target) {
  for (const entry of schedule) {
    if (entry.stageId === target) return;
    await stage(owner, entry.stageId, entry);
  }
  assert.fail("unknown target");
}

function settledNotaryCommand(
  scope,
  { code = 1, signal = null, childError = false, streamError = false } = {},
) {
  return scope.own(
    () =>
      new Promise((resolve) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        void scope.trackChild(child);
        void scope.trackStream(child.stdout);
        void scope.trackStream(child.stderr);
        child.stdout.resume();
        child.stderr.resume();
        queueMicrotask(() => {
          if (childError)
            child.emit("error", new Error("synthetic spawn error"));
          if (streamError)
            child.stdout.destroy(new Error("synthetic stream error"));
          else child.stdout.end();
          child.stderr.end();
          child.emit("close", code, signal);
          resolve({ exitCode: code });
        });
      }),
  );
}

async function unavailableNotaryRead(scope) {
  const result = await settledNotaryCommand(scope);
  assert.equal(result.exitCode, 1);
  return scope.notaryReadUnavailable();
}

if (process.argv[2] === "--synthetic-signed-uncertainty") {
  const f = await fixture({ after() {} });
  const owner = await f.open();
  await assert.rejects(
    stage(owner, "input-validation", {
      work(scope) {
        scope.markOutputSettlementUncertain();
        throw new Error("synthetic unknown descendant");
      },
    }),
    { code: "OUTPUT_SETTLEMENT_UNCERTAIN" },
  );
  assert.equal(f.stored().attempts.at(-1).state, "pending");
  const writes = f.state.writes;
  await assert.rejects(owner.recoverAfterUncertainWrite(), {
    code: "OUTPUT_SETTLEMENT_UNCERTAIN",
  });
  await assert.rejects(owner.readSnapshot(), {
    code: "OUTPUT_SETTLEMENT_UNCERTAIN",
  });
  assert.equal(await owner.close({ timeoutMs: 0 }), false);
  await assert.rejects(f.open(), { code: "BUSY" });
  assert.equal(f.state.writes, writes);
  assert.equal(f.state.locked, true);
  await fs.rm(f.root, { recursive: true, force: true });
  await new Promise((resolve) =>
    process.send(
      { kind: "retained-signed-uncertainty", pending: true, closed: false },
      resolve,
    ),
  );
  // There is deliberately no owner-reset API. Only this synthetic child exits.
  process.exit(0);
}

test("signed profile keeps original artifact identity separate from newer tooling and preserves closed methods", async (t) => {
  const f = await fixture(t);
  let owner = await f.open();
  let snapshot = await owner.readSnapshot();
  assert.deepEqual(
    Object.keys(owner).sort(),
    [
      "close",
      "readSnapshot",
      "recordStage",
      "recoverAfterUncertainWrite",
      "revalidate",
    ].sort(),
  );
  assert.deepEqual(snapshot.identity, artifactIdentity);
  assert.deepEqual(snapshot.plan, plan);
  assert.deepEqual(snapshot.pendingPhysicalCaseIds, pendingPhysicalCaseIds);
  assert.deepEqual(snapshot.candidates, {
    signedApp: null,
    submittedDmg: null,
    finalDmg: null,
  });
  assert.equal(Object.isFrozen(snapshot.plan.signingStepSha256s), true);
  assert.equal(await owner.close(), true);
  await assert.rejects(
    f.open({
      mode: "resume",
      plan: { ...plan, toolingProvenanceSha256: hash("changed tooling") },
    }),
    { code: "OPEN_FAILED" },
  );
  owner = await f.open({ mode: "resume" });
  snapshot = await owner.readSnapshot();
  assert.equal(snapshot.identity.sourceCommit, artifactIdentity.sourceCommit);
  assert.equal(snapshot.revision, 2);
});

test("reservation bytes and pending barrier are acknowledged before callback; held publication never starts work", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  f.state.beforeWrite = async (bytes) => {
    const value = JSON.parse(bytes);
    if (value.attempts.at(-1)?.state === "pending") {
      entered.resolve(value);
      await release.promise;
    }
  };
  const reservation = Buffer.from("immutable pre-command reservation");
  const original = Buffer.from(reservation);
  let calls = 0;
  const work = stage(owner, "input-validation", {
    patch: { reservation },
    work: async (scope, request) => {
      calls += 1;
      const pending = f.stored().attempts.at(-1);
      assert.equal(pending.state, "pending");
      assert.deepEqual(pending.evidence, []);
      assert.equal(pending.reservation.sha256, hash(original));
      assert.deepEqual(
        await fs.readFile(
          path.join(f.options.runRoot, "evidence", pending.reservation.sha256),
        ),
        original,
      );
      return resultFor(scope, request);
    },
  });
  await entered.promise;
  reservation.fill(0);
  assert.equal(calls, 0);
  await assert.rejects(owner.readSnapshot(), { code: "BUSY" });
  release.resolve();
  const complete = await work;
  assert.equal(calls, 1);
  assert.equal(complete.attempts[0].state, "observed-pass");
});

test("full fixed schedule binds sign steps, immutable signed app, known submission and two honest DMG hashes", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  for (const entry of schedule) {
    const snapshot = await stage(owner, entry.stageId, entry);
    const last = snapshot.attempts.at(-1);
    assert.equal(
      last.state,
      "observed-pass",
      `${entry.stageId}: ${last.failure}`,
    );
    assert.equal(
      last.signingStepSha256,
      entry.signingIndex === null
        ? null
        : plan.signingStepSha256s[entry.signingIndex],
    );
    if (entry.stageId === "notary-submit") {
      assert.equal(last.outputArtifact, null);
      assert.equal(snapshot.submission.id, id);
      assert.deepEqual(
        snapshot.candidates.submittedDmg,
        snapshot.attempts.find((a) => a.stageId === "dmg-sign").outputArtifact,
      );
    }
  }
  const snapshot = await owner.readSnapshot();
  assert.equal(snapshot.candidates.signedApp.kind, "app-tree");
  assert.equal(snapshot.candidates.submittedDmg.kind, "dmg-file");
  assert.equal(snapshot.candidates.finalDmg.kind, "dmg-file");
  assert.notEqual(
    snapshot.candidates.submittedDmg.sha256,
    snapshot.candidates.finalDmg.sha256,
  );
  assert.equal(
    Object.hasOwn(snapshot.candidates.finalDmg, "treeSha256"),
    false,
  );
  assert.equal(
    snapshot.candidates.finalDmg.bytes > unsignedEvidenceLimits.sidecarBytes,
    true,
  );
  assert.deepEqual(snapshot.pendingPhysicalCaseIds, pendingPhysicalCaseIds);
  assert.equal(await owner.close(), true);
  assert.deepEqual(
    (await (await f.open({ mode: "resume" })).readSnapshot()).candidates,
    snapshot.candidates,
  );
});

test("stage order, current artifact, stale revision and signing index mismatches reject before work or barrier", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let calls = 0;
  const work = () => {
    calls += 1;
  };
  for (const [stageId, patch] of [
    ["dmg-sign", {}],
    ["input-validation", { inputArtifact: null }],
    [
      "input-validation",
      { inputArtifact: { kind: "app-tree", treeSha256: hash("different") } },
    ],
    ["input-validation", { signingIndex: 0 }],
    ["input-validation", { expectedRevision: 2 }],
  ]) {
    const writes = f.state.writes;
    await assert.rejects(stage(owner, stageId, { patch, work }));
    assert.equal(f.state.writes, writes);
  }
  await before(owner, "sign-code");
  await assert.rejects(stage(owner, "sign-code", { signingIndex: 1, work }));
  await stage(owner, "sign-code", { signingIndex: 0 });
  await assert.rejects(stage(owner, "sign-code", { signingIndex: 0, work }));
  assert.equal(calls, 0);
});

test("observational verification cannot replace its input tree or promote an arbitrary inventory", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "signed-app-verification");
  const snapshot = await stage(owner, "signed-app-verification", {
    work: async (scope, request) => {
      const result = await resultFor(scope, request);
      result.outputArtifact.treeSha256 = hash("unobserved replacement");
      return result;
    },
  });
  assert.equal(snapshot.attempts.at(-1).failure, "observation_failed");
  assert.equal(snapshot.candidates.signedApp, null);
  await assert.rejects(stage(owner, "dmg-create"), { code: "STAGE_INVALID" });
});

for (const failedStage of [
  "custody-copies",
  "sign-code",
  "dmg-create",
  "dmg-sign",
  "notary-submit",
  "dmg-staple",
  "inspection-copy-mount",
]) {
  test(`settled ${failedStage} failure survives resume and refuses replay or forward mutation`, async (t) => {
    const f = await fixture(t);
    let owner = await f.open();
    await before(owner, failedStage);
    const signingIndex = failedStage === "sign-code" ? 0 : null;
    const failed = await stage(owner, failedStage, {
      signingIndex,
      work: () => {
        throw new Error("private failed mutation");
      },
    });
    assert.equal(failed.attempts.at(-1).failure, "operation_failed");
    assert.equal(await owner.close(), true);
    owner = await f.open({ mode: "resume" });
    let calls = 0;
    await assert.rejects(
      stage(owner, failedStage, {
        signingIndex,
        work: () => {
          calls += 1;
        },
      }),
      { code: "STAGE_INVALID" },
    );
    assert.equal(calls, 0);
    assert.equal(
      (await stage(owner, "checkpoint-readback")).attempts.at(-1).state,
      "observed-pass",
    );
  });
}

test("known-ID reconciliation repeats without advancing on in-progress; unavailable status can retry; rejection cannot staple", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "notary-reconcile");
  const submitted = f.stored().submission;
  for (let i = 0; i < 2; i += 1) {
    const snapshot = await stage(owner, "notary-reconcile", {
      status: "in-progress",
    });
    assert.deepEqual(snapshot.submission, submitted);
    await assert.rejects(stage(owner, "dmg-staple"), { code: "STAGE_INVALID" });
  }
  const unavailable = await stage(owner, "notary-reconcile", {
    work: unavailableNotaryRead,
  });
  assert.equal(unavailable.notaryStatus, "in-progress");
  const rejected = await stage(owner, "notary-reconcile", {
    status: "rejected",
    state: "observed-fail",
  });
  assert.equal(rejected.notaryStatus, "rejected");
  await assert.rejects(stage(owner, "dmg-staple"), { code: "STAGE_INVALID" });
});

test("accepted exact submitted bytes permit staple while wrong DMG and status regression never do", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "notary-reconcile");
  await stage(owner, "notary-reconcile", { status: "in-progress" });
  await stage(owner, "notary-reconcile");
  await assert.rejects(
    stage(owner, "dmg-staple", {
      patch: {
        inputArtifact: {
          kind: "dmg-file",
          sha256: hash("other image"),
          bytes: 1,
        },
      },
    }),
    { code: "STAGE_INVALID" },
  );
  const snapshot = await stage(owner, "dmg-staple");
  assert.equal(snapshot.candidates.finalDmg.sha256, hash("dmg-staple"));
  const wrong = await stage(owner, "notary-reconcile", {
    status: "in-progress",
  });
  assert.equal(wrong.attempts.at(-1).failure, "observation_failed");
  assert.equal(wrong.notaryStatus, "accepted");
});

test("invalid reconciliation after acceptance survives resume and permanently prevents stapling", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "notary-reconcile");
  const accepted = await stage(owner, "notary-reconcile");
  const invalid = await stage(owner, "notary-reconcile", {
    work: () => ({
      state: "observed-fail",
      evidence: [],
      outputArtifact: null,
      submission: null,
      notaryStatus: null,
    }),
  });
  assert.equal(invalid.notaryStatus, "accepted");
  assert.deepEqual(invalid.submission, accepted.submission);
  assert.equal(invalid.attempts.at(-1).notaryStatus, null);
  assert.deepEqual(invalid.attempts.at(-1).evidence, []);
  assert.equal(await owner.close({ timeoutMs: 1000 }), true);
  const resumed = await f.open({ mode: "resume" });
  const retained = await resumed.readSnapshot();
  assert.deepEqual(retained.attempts, invalid.attempts);
  // Read-only known-ID observations remain permitted, but cannot erase a
  // failed observation or restore mutation permission on this same run.
  await stage(resumed, "notary-reconcile");
  const writes = f.state.writes;
  let calls = 0;
  let failure;
  try {
    await stage(resumed, "dmg-staple", {
      work: async (scope, request) => {
        calls += 1;
        return resultFor(scope, request);
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(
    calls,
    0,
    `invalid observation retained as ${invalid.attempts.at(-1).failure} must prevent stapling`,
  );
  assert.equal(failure?.code, "STAGE_INVALID");
  assert.equal(f.state.writes, writes);
  assert.equal(invalid.attempts.at(-1).failure, "observation_failed");
  assert.equal((await resumed.readSnapshot()).candidates.finalDmg, null);
  const readback = await stage(resumed, "checkpoint-readback");
  assert.equal(readback.attempts.at(-1).state, "observed-pass");
  assert.equal(readback.notaryStatus, "accepted");
});

test("unavailable reconciliation after acceptance remains retryable across resume", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "notary-reconcile");
  await stage(owner, "notary-reconcile");
  const unavailable = await stage(owner, "notary-reconcile", {
    work: unavailableNotaryRead,
  });
  assert.equal(unavailable.attempts.at(-1).failure, "operation_failed");
  assert.equal(unavailable.notaryStatus, "accepted");
  assert.equal(await owner.close({ timeoutMs: 1000 }), true);
  const resumed = await f.open({ mode: "resume" });
  await stage(resumed, "notary-reconcile");
  const stapled = await stage(resumed, "dmg-staple");
  assert.equal(stapled.candidates.finalDmg.sha256, hash("dmg-staple"));
});

for (const reason of [
  "returned-regression",
  "malformed-return",
  "generic-throw",
  "marker-without-child",
  "zero-exit",
  "unknown-exit",
  "child-signal",
  "child-error",
  "stream-error",
  "owned-error",
  "sidecar-write-error",
  "invalid-own",
  "invalid-track",
  "invalid-sidecar",
]) {
  test(`notary permanent failure survives valid resume: ${reason}`, async (t) => {
    const f = await fixture(t);
    const owner = await f.open();
    await before(owner, "notary-reconcile");
    const accepted = await stage(owner, "notary-reconcile");
    const failed = await stage(owner, "notary-reconcile", {
      work: async (scope, request) => {
        if (reason === "returned-regression")
          return resultFor(scope, request, { status: "in-progress" });
        if (reason === "malformed-return") return { state: "observed-pass" };
        if (reason === "generic-throw")
          throw new Error("synthetic validation error");
        if (reason === "marker-without-child")
          return scope.notaryReadUnavailable();
        await settledNotaryCommand(scope, {
          code:
            reason === "zero-exit" ? 0 : reason === "unknown-exit" ? null : 1,
          signal: reason === "child-signal" ? "SIGTERM" : null,
          childError: reason === "child-error",
          streamError: reason === "stream-error",
        });
        if (reason === "owned-error")
          await scope
            .own(() => Promise.reject(new Error("synthetic owned error")))
            .catch(() => {});
        if (reason === "sidecar-write-error") {
          const bytes = Buffer.from("synthetic unavailable sidecar");
          await fs.mkdir(path.join(f.options.runRoot, "evidence", hash(bytes)));
          await assert.rejects(scope.writeEvidence(bytes));
        }
        if (reason === "invalid-own") await assert.rejects(scope.own(null));
        if (reason === "invalid-track") assert.throws(() => scope.track(null));
        if (reason === "invalid-sidecar")
          assert.throws(() => scope.writeEvidence(null));
        return scope.notaryReadUnavailable();
      },
    });
    assert.equal(failed.notaryStatus, "accepted");
    assert.deepEqual(failed.submission, accepted.submission);
    assert.equal(await owner.close({ timeoutMs: 1000 }), true);
    const resumed = await f.open({ mode: "resume" });
    await stage(resumed, "notary-reconcile");
    let calls = 0;
    let refusal;
    try {
      await stage(resumed, "dmg-staple", {
        work: (scope, request) => {
          calls += 1;
          return resultFor(scope, request);
        },
      });
    } catch (error) {
      refusal = error;
    }
    assert.equal(calls, 0, `${reason} must not permit a later staple`);
    assert.equal(refusal?.code, "STAGE_INVALID");
    assert.equal(failed.attempts.at(-1).failure, "observation_failed");
    assert.equal(failed.attempts.at(-1).notaryStatus, null);
  });
}

test("notary availability marker requires complete drain and stays local to one operation", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await before(owner, "notary-reconcile");
  const entered = deferred();
  const heldStream = new PassThrough();
  heldStream.resume();
  f.releases.push(() => heldStream.end());
  let marker;
  let factory;
  const pending = stage(owner, "notary-reconcile", {
    work: async (scope) => {
      void scope.trackStream(heldStream);
      await settledNotaryCommand(scope);
      factory = scope.notaryReadUnavailable;
      marker = factory();
      entered.resolve();
      return marker;
    },
  });
  await entered.promise;
  assert.equal(await owner.close({ timeoutMs: 0 }), false);
  assert.equal(f.stored().attempts.at(-1).state, "pending");
  heldStream.end();
  const unavailable = await pending;
  assert.equal(unavailable.attempts.at(-1).failure, "operation_failed");
  assert.equal(unavailable.notaryStatus, null);
  assert.throws(factory, { code: "CLOSED" });
  assert.equal(await owner.close({ timeoutMs: 1000 }), true);
  const resumed = await f.open({ mode: "resume" });
  const stale = await stage(resumed, "notary-reconcile", {
    work: async (scope) => {
      await settledNotaryCommand(scope);
      return marker;
    },
  });
  assert.equal(stale.attempts.at(-1).failure, "observation_failed");
});

test("notary availability factory is absent from other signed and original unsigned scopes", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await stage(owner, "input-validation", {
    work: (scope, request) => {
      assert.equal(Object.hasOwn(scope, "notaryReadUnavailable"), false);
      return resultFor(scope, request);
    },
  });
  assert.equal(await owner.close({ timeoutMs: 1000 }), true);
  const other = await fixture(t);
  const unsigned = await openUnsignedArtifactEvidenceForTesting(
    {
      mode: "create",
      runRoot: path.join(other.root, "unsigned-artifact-runs", runId),
      runId,
      identity: artifactIdentity,
      nativeModule: null,
    },
    other.native,
  );
  t.after(() => unsigned.close({ timeoutMs: 1000 }));
  const snapshot = await unsigned.readSnapshot();
  const recorded = await unsigned.recordCase(
    { expectedRevision: snapshot.revision, caseId: "distribution-inventory" },
    async (scope) => {
      assert.equal(Object.hasOwn(scope, "notaryReadUnavailable"), false);
      const evidence = await scope.writeEvidence(
        Buffer.from("synthetic source"),
      );
      return { state: "observed-pass", evidence: [evidence] };
    },
  );
  assert.equal(recorded.attempts.at(-1).state, "observed-pass");
  assert.equal(await unsigned.close({ timeoutMs: 1000 }), true);
});

for (const published of [false, true]) {
  test(`uncertain submit completion (${published ? "published" : "lost"}) never fabricates or repeats submission`, async (t) => {
    const f = await fixture(t);
    const owner = await f.open();
    await before(owner, "notary-submit");
    await assert.rejects(
      stage(owner, "notary-submit", {
        work: async (scope, request) => {
          const result = await resultFor(scope, request);
          f.state.writeFailure = published ? "published" : "unpublished";
          return result;
        },
      }),
      { code: "CHECKPOINT_UNCERTAIN" },
    );
    await assert.rejects(owner.readSnapshot(), {
      code: "CHECKPOINT_UNCERTAIN",
    });
    const recovered = await owner.recoverAfterUncertainWrite();
    assert.equal(recovered.submission?.id ?? null, published ? id : null);
    assert.equal(
      recovered.attempts.at(-1).state,
      published ? "observed-pass" : "incomplete",
    );
    let calls = 0;
    await assert.rejects(
      stage(owner, "notary-submit", {
        work: () => {
          calls += 1;
        },
      }),
      { code: "STAGE_INVALID" },
    );
    assert.equal(calls, 0);
    if (published)
      assert.equal(
        (await stage(owner, "notary-reconcile")).notaryStatus,
        "accepted",
      );
    else {
      const snapshot = await owner.readSnapshot();
      await assert.rejects(
        owner.recordStage(
          {
            expectedRevision: snapshot.revision,
            stageId: "notary-reconcile",
            signingIndex: null,
            inputArtifact: null,
            reservation: Buffer.from("missing id"),
          },
          () => {
            calls += 1;
          },
        ),
        { code: "STAGE_INVALID" },
      );
      assert.equal(calls, 0);
    }
  });
}

for (const resultCase of [
  "null",
  "extra",
  "foreign-ref",
  "fifth-ref",
  "wrong-output-kind",
  "fake-submission",
]) {
  test(`malformed ${resultCase} result records finite failure without unowned output`, async (t) => {
    const f = await fixture(t);
    const owner = await f.open();
    const snapshot = await stage(owner, "input-validation", {
      work: async (scope, request) => {
        if (resultCase === "null") return null;
        const result = await resultFor(scope, request);
        if (resultCase === "extra") result.raw = "private";
        if (resultCase === "foreign-ref")
          result.evidence = [{ sha256: hash("forged"), bytes: 1 }];
        if (resultCase === "fifth-ref")
          for (let i = 0; i < 4; i += 1)
            await scope.writeEvidence(Buffer.from(`extra ${i}`));
        if (resultCase === "wrong-output-kind")
          result.outputArtifact = {
            kind: "dmg-file",
            sha256: hash("wrong"),
            bytes: 1,
            inventory: result.evidence[0],
          };
        if (resultCase === "fake-submission")
          result.submission = { id, submittedDmgSha256: hash("fake") };
        return result;
      },
    });
    assert.equal(
      snapshot.attempts.at(-1).failure,
      resultCase === "fifth-ref" ? "operation_failed" : "observation_failed",
    );
    assert.equal(snapshot.attempts.at(-1).outputArtifact, null);
    assert.equal(snapshot.attempts.at(-1).submission, null);
    assert.equal(snapshot.attempts.at(-1).evidence.length <= 4, true);
  });
}

test("whole-schedule capacity refuses oversized plans before any mutation; bounded status observations retain completion headroom", async (t) => {
  const oversized = {
    ...plan,
    signingStepSha256s: Array.from({ length: 50 }, (_, i) => hash(`step ${i}`)),
  };
  const f = await fixture(t, oversized);
  await assert.rejects(f.open(), { code: "OPEN_FAILED" });
  assert.equal(f.state.writes, 0);
  const other = await fixture(t);
  const owner = await other.open();
  await before(owner, "notary-reconcile");
  let calls = 0;
  let capacity = false;
  for (let i = 0; i < 64; i += 1) {
    const writes = other.state.writes;
    try {
      await stage(owner, "notary-reconcile", {
        work: async (scope, request) => {
          calls += 1;
          return resultFor(scope, request, { status: "in-progress" });
        },
      });
    } catch (error) {
      assert.equal(error.code, "CAPACITY");
      assert.equal(other.state.writes, writes);
      capacity = true;
      break;
    }
  }
  assert.equal(capacity, true);
  assert.equal(calls > 1 && calls < 64, true);
  const snapshot = await owner.readSnapshot();
  assert.equal(
    Buffer.byteLength(JSON.stringify(snapshot)) <
      unsignedEvidenceLimits.checkpointBytes,
    true,
  );
  assert.equal(
    snapshot.attempts.length < unsignedEvidenceLimits.attempts,
    true,
  );
  // The required remaining schedule still fits; status observations cannot
  // consume the capacity reserved for the admitted mutation outcome.
  assert.equal(snapshot.submission.id, id);
});

test("signed callback drains owned child, stream and ignored work; a close timeout retains the one owner", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const entered = deferred();
  const held = deferred();
  const child = new EventEmitter();
  const stream = new PassThrough();
  stream.resume();
  f.releases.push(() => {
    held.resolve();
    child.emit("close", 0, null);
    stream.end();
  });
  const recording = stage(owner, "input-validation", {
    work: async (scope, request) => {
      void scope.track(held.promise);
      void scope.trackChild(child);
      void scope.trackStream(stream);
      entered.resolve();
      return resultFor(scope, request);
    },
  });
  await entered.promise;
  assert.equal(await owner.close({ timeoutMs: 0 }), false);
  await assert.rejects(
    openUnsignedArtifactEvidenceForTesting(
      {
        ...f.options,
        runRoot: path.join(f.root, "unsigned-artifact-runs", runId),
      },
      f.native,
    ),
    { code: "BUSY" },
  );
  assert.equal(f.state.locked, true);
  held.resolve();
  child.emit("close", 0, null);
  stream.end();
  assert.equal((await recording).attempts[0].state, "observed-pass");
  assert.equal(f.state.locked, true);
  assert.equal(await owner.close(), true);
});

test("lost pending reservation barrier cannot start work or heal through unacknowledged recovery", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  f.state.writeFailure = "published";
  let calls = 0;
  await assert.rejects(
    stage(owner, "input-validation", {
      work: () => {
        calls += 1;
      },
    }),
    { code: "CHECKPOINT_UNCERTAIN" },
  );
  assert.equal(calls, 0);
  f.state.writeFailure = "unpublished";
  await assert.rejects(owner.recoverAfterUncertainWrite(), {
    code: "RECOVERY_REQUIRED",
  });
  await assert.rejects(owner.readSnapshot(), { code: "CHECKPOINT_UNCERTAIN" });
  const recovered = await owner.recoverAfterUncertainWrite();
  assert.equal(recovered.attempts[0].state, "incomplete");
  await assert.rejects(stage(owner, "custody-copies"), {
    code: "STAGE_INVALID",
  });
});

test("reservation sidecars remain checked on readback and resume independently of completion evidence", async (t) => {
  const f = await fixture(t);
  let owner = await f.open();
  const snapshot = await stage(owner, "input-validation");
  const ref = snapshot.attempts[0].reservation;
  await fs.writeFile(
    path.join(f.options.runRoot, "evidence", ref.sha256),
    "tampered",
  );
  await assert.rejects(owner.readSnapshot(), { code: "EVIDENCE_INVALID" });
  assert.equal(await owner.close(), true);
  await assert.rejects(f.open({ mode: "resume" }), { code: "OPEN_FAILED" });
});

for (const corruption of [
  "candidate",
  "step",
  "input",
  "plan",
  "status",
  "kind",
  "reference",
]) {
  test(`resume rejects ${corruption} substitution with no repair write`, async (t) => {
    const f = await fixture(t);
    const owner = await f.open();
    await before(owner, "dmg-create");
    assert.equal(await owner.close(), true);
    const altered = f.stored();
    if (corruption === "candidate")
      altered.candidates.signedApp.treeSha256 = hash("other app");
    if (corruption === "step")
      altered.attempts.find(
        (a) => a.stageId === "sign-code",
      ).signingStepSha256 = hash("other step");
    if (corruption === "input")
      altered.attempts[1].inputArtifact.treeSha256 = hash("other input");
    if (corruption === "plan")
      altered.plan.unsignedCheckpointSha256 = hash("other origin");
    if (corruption === "status") altered.notaryStatus = "accepted";
    if (corruption === "kind")
      altered.kind = "desmoslock-unsigned-universal-artifact-evidence";
    if (corruption === "reference") altered.attempts[0].reservation.bytes += 1;
    f.replace(altered);
    const writes = f.state.writes;
    await assert.rejects(f.open({ mode: "resume" }), { code: "OPEN_FAILED" });
    assert.equal(f.state.writes, writes);
  });
}

test("signed output settlement uncertainty keeps pending and retains ownership without recovery or blind replay", async (t) => {
  const child = fork(
    new URL(import.meta.url),
    ["--synthetic-signed-uncertainty"],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 8192) child.kill("SIGKILL");
    });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  const receipt = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Synthetic child deadline"));
    }, 5000);
    child.once("message", resolve);
    child.once("error", reject);
    child.once("close", () =>
      reject(new Error("Synthetic child closed without receipt")),
    );
  });
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  assert.deepEqual(await receipt, {
    kind: "retained-signed-uncertainty",
    pending: true,
    closed: false,
  });
  clearTimeout(timer);
  assert.deepEqual(await closed, { code: 0, signal: null });
});

test("reservation substitution during the pending barrier prevents the command callback", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let calls = 0;
  f.state.beforeWrite = async (bytes) => {
    const attempt = JSON.parse(bytes).attempts.at(-1);
    if (attempt?.state === "pending") {
      await fs.writeFile(
        path.join(f.options.runRoot, "evidence", attempt.reservation.sha256),
        "substituted before acknowledgment",
      );
    }
  };
  await assert.rejects(
    stage(owner, "input-validation", {
      work: async (scope, request) => {
        calls += 1;
        return resultFor(scope, request);
      },
    }),
    { code: "EVIDENCE_INVALID" },
  );
  assert.equal(calls, 0);
  assert.equal(f.stored().attempts.at(-1).state, "pending");
});
