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
import { fileURLToPath } from "node:url";

// Exact, test-only source mapping: no product/dist build and no addon load.
const identitySource = new URL(
  "../../packages/contracts/src/build-identity.ts",
  import.meta.url,
).href;
const exactSource = new URL(
  "../../packages/contracts/src/exact-record.ts",
  import.meta.url,
).href;
const moduleSource = new URL(
  "../../scripts/unsigned-artifact-evidence.mjs",
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
  openUnsignedArtifactEvidence,
  openUnsignedArtifactEvidenceForTesting,
  unsignedEvidenceCaseIds,
  unsignedEvidenceLimits,
  unsignedEvidenceNativePath,
  pendingPhysicalCaseIds,
} = await import(moduleSource);
hooks.deregister();

const runId = "10000000-0000-4000-8000-000000000001";
const identity = Object.freeze({
  schemaVersion: 1,
  sourceRepository: "danielholguin31/desmoslock",
  sourceCommit: "1".repeat(40),
  sourceTree: "2".repeat(40),
  packageLockSha256: "3".repeat(64),
  buildId: "4".repeat(64),
});
const nativeAcceptanceEnabled =
  process.env.DESMOSLOCK_UNSIGNED_EVIDENCE_NATIVE_ACCEPTANCE === "1";
const acceptedNativeSha256 =
  "999ea7c02879075bef29e09db02ee99a425e95d454ece0b79f842ce01f7160be";
// Explicit child driver for the separately authorized native-only acceptance
// window. Default test execution neither starts this driver nor loads an addon.
if (process.argv[2] === "--unsigned-evidence-native-worker") {
  assert.equal(nativeAcceptanceEnabled, true);
  const options = {
    mode: "resume",
    runRoot: process.argv[4],
    runId,
    identity,
    nativeModule: {
      path: unsignedEvidenceNativePath,
      sha256: acceptedNativeSha256,
    },
  };
  if (process.argv[3] === "locked") {
    await assert.rejects(openUnsignedArtifactEvidence(options), {
      code: "OPEN_FAILED",
    });
    await new Promise((resolve) =>
      process.send({ kind: "lock-rejected" }, resolve),
    );
    process.exit(0);
  }
  assert.equal(process.argv[3], "pending");
  const owner = await openUnsignedArtifactEvidence(options);
  const snapshot = await owner.readSnapshot();
  await owner.recordCase(
    { expectedRevision: snapshot.revision, caseId: "checkpoint-readback" },
    async () => {
      process.send({ kind: "pending", revision: snapshot.revision + 1 });
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await new Promise(() => {});
      } finally {
        clearInterval(keepAlive);
      }
    },
  );
  assert.fail(
    "The crash driver must be terminated while its pending case owns the lock",
  );
}
const errorCode = (code) => (error) => {
  assert.equal(error.name, "UnsignedArtifactEvidenceError");
  assert.equal(error.message, "Unsigned artifact evidence is unavailable");
  assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(error), /sensitive|private-source/);
  return true;
};
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(
      await fs.realpath(os.tmpdir()),
      "desmoslock-unsigned-checkpoint-",
    ),
  );
  await fs.chmod(root, 0o700);
  const runRoot = path.join(root, "unsigned-artifact-runs", runId);
  const records = new Map();
  const native = {
    maximumRecordBytes: 65536,
    async openStore(directory) {
      if (state.locked) throw new Error("sensitive lock state");
      state.opens += 1;
      if (state.openFailure) {
        state.openFailure = false;
        throw new Error("sensitive reopen failure");
      }
      state.locked = true;
      if (state.afterOpen) await state.afterOpen(directory);
      let closed = false;
      return {
        async loadEncryptedRecord() {
          state.loads += 1;
          if (state.loadFailure) throw new Error("sensitive private-source");
          return records.has(directory)
            ? Buffer.from(records.get(directory))
            : null;
        },
        async replaceEncryptedRecord(bytes) {
          assert.equal(closed, false);
          state.writes += 1;
          const copy = Buffer.from(bytes);
          if (state.beforeWrite) await state.beforeWrite(copy);
          const failure = state.writeFailure;
          state.writeFailure = null;
          if (failure === null || failure === "published")
            records.set(directory, copy);
          if (failure !== null)
            throw Object.assign(new Error("sensitive private-source"), {
              publication:
                failure === "published"
                  ? "possibly-published"
                  : "not-published",
            });
        },
        async quarantineEncryptedRecord() {
          assert.fail("Quarantine is not a log or automatic recovery");
        },
        async close() {
          state.closes += 1;
          state.beforeClose?.();
          if (state.closeFailure) throw new Error("sensitive close failure");
          closed = true;
          state.locked = false;
        },
      };
    },
  };
  const state = {
    opens: 0,
    loads: 0,
    writes: 0,
    closes: 0,
    locked: false,
    writeFailure: null,
    beforeWrite: null,
    beforeClose: null,
    afterOpen: null,
    loadFailure: false,
    closeFailure: false,
    openFailure: false,
  };
  const owners = [];
  const completions = [];
  const options = {
    mode: "create",
    runRoot,
    runId,
    identity,
    nativeModule: null,
  };
  t.after(async () => {
    state.closeFailure = false;
    for (const complete of completions) complete();
    for (const owner of owners)
      assert.equal(await owner.close({ timeoutMs: 1000 }), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    runRoot,
    state,
    options,
    native,
    completions,
    async open(patch = {}) {
      const owner = await openUnsignedArtifactEvidenceForTesting(
        { ...options, ...patch },
        native,
      );
      owners.push(owner);
      return owner;
    },
    stored() {
      return JSON.parse(
        records.get(path.join(runRoot, "checkpoint")).toString(),
      );
    },
    replaceStored(value) {
      records.set(
        path.join(runRoot, "checkpoint"),
        Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
      );
    },
    forgetStored() {
      records.delete(path.join(runRoot, "checkpoint"));
    },
  };
}
async function record(
  owner,
  caseId = "source-inputs",
  text = "observed synthetic input",
) {
  const snapshot = await owner.readSnapshot();
  return owner.recordCase(
    { expectedRevision: snapshot.revision, caseId },
    async (scope) => {
      const ref = await scope.writeEvidence(Buffer.from(text));
      return { state: "observed-pass", evidence: [ref] };
    },
  );
}

async function runSyntheticUncertainWorker() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "desmoslock-unsigned-uncertain-"),
  );
  await fs.chmod(root, 0o700);
  const runRoot = path.join(root, "unsigned-artifact-runs", runId);
  let stored = null;
  let writes = 0;
  let closes = 0;
  const native = {
    maximumRecordBytes: 65536,
    async openStore() {
      return {
        async loadEncryptedRecord() {
          return stored === null ? null : Buffer.from(stored);
        },
        async replaceEncryptedRecord(bytes) {
          writes += 1;
          stored = Buffer.from(bytes);
        },
        async quarantineEncryptedRecord() {
          assert.fail("No quarantine");
        },
        async close() {
          closes += 1;
        },
      };
    },
  };
  try {
    const options = {
      mode: "create",
      runRoot,
      runId,
      identity,
      nativeModule: null,
    };
    const owner = await openUnsignedArtifactEvidenceForTesting(options, native);
    const entered = deferred();
    const mark = deferred();
    const marked = deferred();
    const knownWork = deferred();
    let captured;
    let operationSettled = false;
    const operation = owner.recordCase(
      { expectedRevision: 1, caseId: "distribution-inventory" },
      async (scope) => {
        captured = scope;
        void scope.track(knownWork.promise);
        entered.resolve();
        await mark.promise;
        scope.markOutputSettlementUncertain();
        marked.resolve();
        throw new Error(
          "sensitive direct-child timeout with unknown descendant settlement",
        );
      },
    );
    const rejected = assert.rejects(
      operation,
      errorCode("OUTPUT_SETTLEMENT_UNCERTAIN"),
    );
    void operation.then(
      () => {
        operationSettled = true;
      },
      () => {
        operationSettled = true;
      },
    );
    await entered.promise;
    const closing = owner.close({ timeoutMs: 1000 });
    mark.resolve();
    await marked.promise;
    assert.equal(operationSettled, false);
    assert.equal(writes, 2);
    assert.equal(closes, 0);
    assert.equal(JSON.parse(stored).attempts[0].state, "pending");
    let lateStarted = false;
    await assert.rejects(
      captured.own(() => {
        lateStarted = true;
      }),
      errorCode("CLOSED"),
    );
    await assert.rejects(
      captured.writeEvidence(Buffer.from("must not publish")),
      errorCode("CLOSED"),
    );
    assert.equal(lateStarted, false);
    knownWork.resolve();
    await rejected;
    assert.equal(await closing, false);
    for (const command of [
      () => owner.readSnapshot(),
      () => owner.revalidate({ expectedRevision: 2 }),
      () =>
        owner.recordCase(
          { expectedRevision: 2, caseId: "source-inputs" },
          () => {},
        ),
      () => owner.recoverAfterUncertainWrite(),
    ])
      await assert.rejects(command(), errorCode("OUTPUT_SETTLEMENT_UNCERTAIN"));
    await assert.rejects(
      openUnsignedArtifactEvidenceForTesting(
        { ...options, mode: "resume" },
        native,
      ),
      errorCode("BUSY"),
    );
    assert.equal(await owner.close(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 2);
    assert.equal(closes, 0);
    const pending = JSON.parse(stored);
    assert.equal(pending.revision, 2);
    assert.equal(pending.attempts[0].state, "pending");
    assert.deepEqual(pending.attempts[0].evidence, []);
    assert.equal(pending.attempts[0].failure, null);
    assert.deepEqual(await fs.readdir(path.join(runRoot, "evidence")), []);
    return {
      kind: "synthetic-output-uncertain",
      state: "pending",
      writes,
      closes,
    };
  } finally {
    // This driver has only a synthetic native adapter. The retained process
    // owner is deliberately released solely by the child process ending.
    await fs.rm(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--unsigned-evidence-synthetic-uncertain-worker") {
  const result = await runSyntheticUncertainWorker();
  await new Promise((resolve) => process.send(result, resolve));
  process.exit(0);
}

test("creates an isolated bounded checkpoint and commits pending before callback work", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const initial = await owner.readSnapshot();
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.identity, identity);
  assert.equal(initial.candidate, null);
  assert.deepEqual(initial.pendingPhysicalCaseIds, pendingPhysicalCaseIds);
  assert.equal(Object.isFrozen(initial.pendingPhysicalCaseIds), true);
  const result = await owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      assert.equal(f.stored().revision, 2);
      assert.equal(f.stored().attempts[0].state, "pending");
      const ref = await scope.writeEvidence(
        Buffer.from("synthetic observed bytes"),
      );
      return { state: "observed-pass", evidence: [ref] };
    },
  );
  assert.equal(result.revision, 3);
  assert.equal(result.attempts[0].state, "observed-pass");
  assert.equal(result.attempts[0].candidateTreeSha256, null);
  assert.deepEqual(await fs.readdir(path.join(f.runRoot, "evidence")), [
    result.attempts[0].evidence[0].sha256,
  ]);
  assert.equal(
    Buffer.byteLength(JSON.stringify(f.stored())) <= 60 * 1024,
    true,
  );
  assert.equal(f.state.writes, 3);
});

test("pins only packaged-inventory's measured candidate and binds subsequent results", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const selected = await owner.recordCase(
    { expectedRevision: 1, caseId: "packaged-inventory" },
    async (scope) => {
      const inventory = await scope.writeEvidence(
        Buffer.from('{"synthetic":"inventory"}'),
      );
      return {
        state: "observed-pass",
        evidence: [inventory],
        candidate: {
          kind: "unsigned-native-app",
          treeSha256: "a".repeat(64),
          inventory,
        },
      };
    },
  );
  assert.equal(selected.candidate.treeSha256, "a".repeat(64));
  assert.equal(
    selected.attempts[0].candidateTreeSha256,
    selected.candidate.treeSha256,
  );
  const subsequent = await record(owner, "native-inventory");
  assert.equal(
    subsequent.attempts[1].candidateTreeSha256,
    selected.candidate.treeSha256,
  );
  const rejected = await owner.recordCase(
    { expectedRevision: subsequent.revision, caseId: "packaged-inventory" },
    async (scope) => {
      const inventory = await scope.writeEvidence(
        Buffer.from("different synthetic inventory"),
      );
      return {
        state: "observed-pass",
        evidence: [inventory],
        candidate: {
          kind: "unsigned-native-app",
          treeSha256: "b".repeat(64),
          inventory,
        },
      };
    },
  );
  assert.deepEqual(rejected.candidate, selected.candidate);
  assert.equal(rejected.attempts[2].state, "observed-fail");
  assert.equal(rejected.attempts[2].failure, "operation_failed");
});

test("rejects physical promotion, forged refs, extra result fields and raw errors", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let callbacks = 0;
  for (const caseId of [...pendingPhysicalCaseIds, "generic-pass"])
    await assert.rejects(
      owner.recordCase({ expectedRevision: 1, caseId }, () => {
        callbacks += 1;
      }),
      errorCode("INVALID"),
    );
  assert.equal(callbacks, 0);
  const bodies = [
    () => ({
      state: "observed-pass",
      evidence: [{ sha256: "a".repeat(64), bytes: 1 }],
    }),
    async (scope) => ({
      state: "observed-pass",
      evidence: [await scope.writeEvidence(Buffer.from("actual bytes"))],
      physicalPass: true,
    }),
    () => {
      throw new Error("sensitive private-source");
    },
  ];
  for (const work of bodies) {
    const before = await owner.readSnapshot();
    const result = await owner.recordCase(
      { expectedRevision: before.revision, caseId: "source-inputs" },
      work,
    );
    assert.equal(result.attempts.at(-1).state, "observed-fail");
    assert.equal(result.attempts.at(-1).failure, "operation_failed");
    assert.doesNotMatch(
      JSON.stringify(result),
      /sensitive|private-source|physicalPass/,
    );
  }
  assert.deepEqual(
    (await owner.readSnapshot()).pendingPhysicalCaseIds,
    pendingPhysicalCaseIds,
  );
});

test("snapshots strict inputs without accessors and rejects stale CAS or reentrant work", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let getters = 0;
  await assert.rejects(
    owner.recordCase(
      {
        expectedRevision: 1,
        get caseId() {
          getters += 1;
          return "source-inputs";
        },
      },
      () => {},
    ),
    errorCode("INVALID"),
  );
  assert.equal(getters, 0);
  assert.equal(f.state.writes, 1);
  const after = await owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      await assert.rejects(
        owner.recordCase(
          { expectedRevision: 2, caseId: "native-inventory" },
          () => {},
        ),
        errorCode("BUSY"),
      );
      return {
        state: "observed-pass",
        evidence: [await scope.writeEvidence(Buffer.from("one operation"))],
      };
    },
  );
  await assert.rejects(
    owner.recordCase(
      { expectedRevision: 1, caseId: "source-inputs" },
      () => {},
    ),
    errorCode("STALE_REVISION"),
  );
  assert.equal(after.attempts.length, 1);
  assert.equal(f.state.writes, 3);
});

test("copies sidecar buffers before awaiting, deduplicates exact bytes and rejects shared backing", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const bytes = Buffer.from("original synthetic bytes");
  const original = Buffer.from(bytes);
  const result = await owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      const publishing = scope.writeEvidence(bytes);
      bytes.fill(1);
      const first = await publishing;
      const second = await scope.writeEvidence(original);
      assert.deepEqual(first, second);
      assert.throws(
        () => scope.writeEvidence(Buffer.from(new SharedArrayBuffer(16))),
        errorCode("INVALID"),
      );
      return { state: "observed-pass", evidence: [first] };
    },
  );
  const ref = result.attempts[0].evidence[0];
  assert.equal(ref.sha256, createHash("sha256").update(original).digest("hex"));
  assert.deepEqual(
    await fs.readFile(path.join(f.runRoot, "evidence", ref.sha256)),
    original,
  );
});

test("drains ignored work plus child and stream settlement before completion or close", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const entered = deferred();
  const child = new EventEmitter();
  const stream = new PassThrough();
  stream.resume();
  const owned = deferred();
  f.completions.push(() => {
    child.emit("close", 0);
    stream.end();
    owned.resolve();
  });
  const operation = owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      void scope.trackChild(child);
      void scope.trackStream(stream);
      void scope.track(owned.promise);
      const ref = await scope.writeEvidence(Buffer.from("work is still owned"));
      entered.resolve();
      return { state: "observed-pass", evidence: [ref] };
    },
  );
  await entered.promise;
  assert.equal(await owner.close({ timeoutMs: 1 }), false);
  assert.equal(f.state.closes, 0);
  assert.equal(f.stored().attempts[0].state, "pending");
  child.emit("close", 0);
  stream.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.closes, 0);
  assert.equal(f.stored().attempts[0].state, "pending");
  owned.resolve();
  assert.equal((await operation).attempts[0].state, "observed-pass");
  assert.equal(
    f.state.closes,
    0,
    "timed close must never later unlock by itself",
  );
  assert.equal(await owner.close({ timeoutMs: 100 }), true);
  assert.equal(f.state.closes, 1);
});

test("callback rejection still drains ignored work before recording failure", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const entered = deferred();
  const pending = deferred();
  f.completions.push(pending.resolve);
  const operation = owner.recordCase(
    { expectedRevision: 1, caseId: "distribution-inventory" },
    (scope) => {
      void scope.track(pending.promise);
      entered.resolve();
      throw new Error("sensitive private-source");
    },
  );
  await entered.promise;
  assert.equal(f.stored().attempts[0].state, "pending");
  assert.equal(await owner.close({ timeoutMs: 1 }), false);
  pending.resolve();
  const result = await operation;
  assert.equal(result.attempts[0].state, "observed-fail");
  assert.equal(f.state.closes, 0);
});

test("a retained scoped helper cannot start filesystem work after settlement", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let retained;
  await owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      retained = scope;
      return {
        state: "observed-pass",
        evidence: [await scope.writeEvidence(Buffer.from("captured"))],
      };
    },
  );
  await assert.rejects(
    retained.writeEvidence(Buffer.from("late write")),
    errorCode("CLOSED"),
  );
  let invoked = false;
  await assert.rejects(
    retained.own(() => {
      invoked = true;
    }),
    errorCode("CLOSED"),
  );
  assert.equal(invoked, false);
  assert.throws(
    () => retained.markOutputSettlementUncertain(),
    errorCode("CLOSED"),
  );
  assert.equal((await owner.readSnapshot()).attempts[0].state, "observed-pass");
  assert.equal((await fs.readdir(path.join(f.runRoot, "evidence"))).length, 1);
});

test("possibly published completion poisons and needs a fresh barrier after actual readback", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await assert.rejects(
    owner.recordCase(
      { expectedRevision: 1, caseId: "source-inputs" },
      async (scope) => {
        const ref = await scope.writeEvidence(
          Buffer.from("observed before uncertainty"),
        );
        f.state.writeFailure = "published";
        return { state: "observed-pass", evidence: [ref] };
      },
    ),
    errorCode("CHECKPOINT_UNCERTAIN"),
  );
  assert.equal(f.stored().attempts[0].state, "observed-pass");
  await assert.rejects(owner.readSnapshot(), errorCode("CHECKPOINT_UNCERTAIN"));
  const before = f.state.writes;
  const resumed = await owner.recoverAfterUncertainWrite();
  assert.equal(f.state.writes, before + 1);
  assert.equal(resumed.revision, 4);
  assert.equal(f.state.opens, 2);
  assert.equal(f.state.closes, 1);
});

test("failed fresh recovery barrier stays poisoned and never reports healed readback", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  f.state.writeFailure = "not-published";
  let work = false;
  await assert.rejects(
    owner.recordCase({ expectedRevision: 1, caseId: "source-inputs" }, () => {
      work = true;
    }),
    errorCode("CHECKPOINT_UNCERTAIN"),
  );
  assert.equal(work, false);
  f.state.writeFailure = "published";
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  await assert.rejects(owner.readSnapshot(), errorCode("CHECKPOINT_UNCERTAIN"));
  assert.equal(f.state.writes, 3);
});

test("resume revalidates sidecars and converts a pending attempt to incomplete with a fresh barrier", async (t) => {
  const f = await fixture(t);
  let owner = await f.open();
  const completed = await record(owner);
  await owner.close();
  f.replaceStored({
    ...completed,
    revision: completed.revision + 1,
    attempts: [
      ...completed.attempts,
      {
        sequence: 2,
        caseId: "native-inventory",
        state: "pending",
        candidateTreeSha256: null,
        evidence: [],
        failure: null,
      },
    ],
  });
  const before = f.state.writes;
  owner = await f.open({ mode: "resume" });
  const resumed = await owner.readSnapshot();
  assert.equal(resumed.revision, 5);
  assert.equal(resumed.attempts[1].state, "incomplete");
  assert.equal(resumed.attempts[1].failure, "operation_incomplete");
  assert.equal(f.state.writes, before + 1);
});

test("resume rejects missing or quarantined checkpoint, changed identity and edited physical pending list", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const original = await owner.readSnapshot();
  await owner.close();
  const invalid = [
    { ...original, identity: { ...identity, buildId: "5".repeat(64) } },
    { ...original, pendingPhysicalCaseIds: [] },
    {
      ...original,
      pendingPhysicalCaseIds: [...pendingPhysicalCaseIds, "new-physical-case"],
    },
    { ...original, pendingPhysicalCaseIds: pendingPhysicalCaseIds.slice(1) },
    { ...original, physicalPassed: true },
    Buffer.alloc(unsignedEvidenceLimits.checkpointBytes + 1, 32),
  ];
  for (const value of invalid) {
    f.replaceStored(value);
    await assert.rejects(f.open({ mode: "resume" }), errorCode("OPEN_FAILED"));
  }
  f.forgetStored();
  await assert.rejects(f.open({ mode: "resume" }), errorCode("OPEN_FAILED"));
  f.state.loadFailure = true; // Synthetic native missing-record-plus-quarantine rejection.
  await assert.rejects(f.open({ mode: "resume" }), errorCode("OPEN_FAILED"));
  assert.equal(f.state.writes, 1);
});

for (const corruption of ["missing", "changed", "symlink", "hardlink"]) {
  test(`referenced ${corruption} sidecar invalidates readback and resume`, async (t) => {
    const f = await fixture(t);
    const owner = await f.open();
    const snapshot = await record(owner);
    const ref = snapshot.attempts[0].evidence[0];
    const filename = path.join(f.runRoot, "evidence", ref.sha256);
    if (corruption === "missing") await fs.unlink(filename);
    if (corruption === "changed")
      await fs.writeFile(filename, "corrupt observed bytes", { mode: 0o600 });
    if (corruption === "hardlink")
      await fs.link(filename, path.join(f.root, "owned-hardlink"));
    if (corruption === "symlink") {
      await fs.rename(filename, path.join(f.root, "owned-original"));
      await fs.symlink(path.join(f.root, "owned-original"), filename);
    }
    await assert.rejects(
      owner.revalidate({ expectedRevision: snapshot.revision }),
      errorCode("EVIDENCE_INVALID"),
    );
    await assert.rejects(
      owner.readSnapshot(),
      errorCode("CHECKPOINT_UNCERTAIN"),
    );
    await owner.close();
    await assert.rejects(f.open({ mode: "resume" }), errorCode("OPEN_FAILED"));
  });
}

test("preserves incomplete and failed history, stops at 64 attempts without pruning", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  for (let index = 0; index < unsignedEvidenceLimits.attempts; index += 1)
    await record(
      owner,
      unsignedEvidenceCaseIds[index % unsignedEvidenceCaseIds.length] ===
        "packaged-inventory"
        ? "source-inputs"
        : unsignedEvidenceCaseIds[index % unsignedEvidenceCaseIds.length],
      "bounded reusable evidence",
    );
  const full = await owner.readSnapshot();
  let called = false;
  await assert.rejects(
    owner.recordCase(
      { expectedRevision: full.revision, caseId: "source-inputs" },
      () => {
        called = true;
      },
    ),
    errorCode("CAPACITY"),
  );
  assert.equal(called, false);
  assert.equal((await owner.readSnapshot()).attempts.length, 64);
  assert.equal(f.stored().attempts[0].sequence, 1);
});

test("refuses redirected run ancestors, suffix mismatches and existing create roots before native open", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "owned-other"), { mode: 0o700 });
  await fs.symlink(
    path.join(f.root, "owned-other"),
    path.join(f.root, "unsigned-artifact-runs"),
  );
  await assert.rejects(f.open(), errorCode("OPEN_FAILED"));
  assert.deepEqual(await fs.readdir(path.join(f.root, "owned-other")), []);
  assert.equal(f.state.opens, 0);
  await fs.unlink(path.join(f.root, "unsigned-artifact-runs"));
  await assert.rejects(
    f.open({ runId: "20000000-0000-4000-8000-000000000002" }),
    errorCode("OPEN_FAILED"),
  );
  const owner = await f.open();
  await owner.close();
  await assert.rejects(f.open(), errorCode("OPEN_FAILED"));
  assert.equal(f.state.opens, 1);
});

test("holds the process owner across failed close and excludes a second initializer", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  await assert.rejects(f.open(), errorCode("BUSY"));
  assert.equal(f.state.opens, 1);
  f.state.closeFailure = true;
  assert.equal(await owner.close(), false);
  await assert.rejects(f.open({ mode: "resume" }), errorCode("BUSY"));
  assert.equal(f.state.locked, true);
  f.state.closeFailure = false;
  assert.equal(await owner.close(), true);
  const resumed = await f.open({ mode: "resume" });
  assert.equal((await resumed.readSnapshot()).revision, 2);
});

test("60KiB limit preserves prior results and leaves room to checkpoint interruption", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let stopped = false;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const snapshot = await owner.readSnapshot();
    try {
      await owner.recordCase(
        { expectedRevision: snapshot.revision, caseId: "source-inputs" },
        async (scope) => {
          const evidence = [];
          for (let index = 0; index < 32; index += 1)
            evidence.push(
              await scope.writeEvidence(
                Buffer.from(`bounded reference ${index}`),
              ),
            );
          return { state: "observed-pass", evidence };
        },
      );
    } catch (error) {
      errorCode("CAPACITY")(error);
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(f.stored())) <= 60 * 1024,
    true,
  );
  assert.equal(f.stored().attempts[0].state, "observed-pass");
  assert.equal(f.stored().attempts.at(-1).state, "pending");
  const recovered = await owner.recoverAfterUncertainWrite();
  assert.equal(recovered.attempts.at(-1).state, "incomplete");
  assert.equal(Buffer.byteLength(JSON.stringify(recovered)) <= 60 * 1024, true);
  assert.equal((await fs.readdir(path.join(f.runRoot, "evidence"))).length, 32);
});

test("recovery refuses rollback or an unrelated checkpoint written during reopen", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const original = await owner.readSnapshot();
  const acknowledged = await record(owner);
  f.state.writeFailure = "not-published";
  await assert.rejects(
    owner.recordCase(
      { expectedRevision: acknowledged.revision, caseId: "source-inputs" },
      () => {},
    ),
    errorCode("CHECKPOINT_UNCERTAIN"),
  );
  f.replaceStored(original);
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  assert.equal(f.state.writes, 4);
  f.replaceStored({ ...acknowledged, revision: acknowledged.revision + 10 });
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  assert.equal(f.state.writes, 4);
});

test("production loader is fixed outside dist and rejects arbitrary path before loading any addon", async (t) => {
  const f = await fixture(t);
  assert.match(
    unsignedEvidenceNativePath,
    /\/artifacts\/unsigned-artifact-tools\/durable-record\.node$/,
  );
  assert.doesNotMatch(unsignedEvidenceNativePath, /\/dist\//);
  await assert.rejects(
    openUnsignedArtifactEvidence({
      ...f.options,
      nativeModule: {
        path: path.join(f.root, "never-load.node"),
        sha256: "a".repeat(64),
      },
    }),
    errorCode("OPEN_FAILED"),
  );
  assert.equal(f.state.opens, 0);
});

test("recovery retries a failed native reopen and still requires a fresh barrier", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  f.state.writeFailure = "published";
  await assert.rejects(record(owner), errorCode("CHECKPOINT_UNCERTAIN"));
  f.state.openFailure = true;
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  assert.equal(f.state.locked, false);
  assert.equal(f.state.closes, 1);
  await assert.rejects(f.open({ mode: "resume" }), errorCode("BUSY"));
  await assert.rejects(owner.readSnapshot(), errorCode("CHECKPOINT_UNCERTAIN"));
  const writes = f.state.writes;
  const recovered = await owner.recoverAfterUncertainWrite();
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.writes, writes + 1);
  assert.equal(recovered.attempts[0].state, "incomplete");
  assert.equal(f.state.locked, true);
});

test("failed unpublished recovery barrier may retry validated readback without authorizing it", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  f.state.writeFailure = "published";
  await assert.rejects(record(owner), errorCode("CHECKPOINT_UNCERTAIN"));
  f.state.writeFailure = "not-published";
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  await assert.rejects(owner.readSnapshot(), errorCode("CHECKPOINT_UNCERTAIN"));
  const writes = f.state.writes;
  const recovered = await owner.recoverAfterUncertainWrite();
  assert.equal(f.state.writes, writes + 1);
  assert.equal(recovered.attempts[0].state, "incomplete");
});

test("permits owned artifacts at 0755 while creating private evidence directories", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.root, 0o755);
  const owner = await f.open();
  assert.equal((await owner.readSnapshot()).revision, 1);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o755);
  for (const directory of [
    path.dirname(f.runRoot),
    f.runRoot,
    path.join(f.runRoot, "checkpoint"),
    path.join(f.runRoot, "evidence"),
  ])
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test("tracks immediately closing resources and marks a failed child as an operation failure", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const result = await owner.recordCase(
    { expectedRevision: 1, caseId: "source-inputs" },
    async (scope) => {
      const child = new EventEmitter();
      void scope.trackChild(child);
      child.emit("close", 1, null);
      const stream = new PassThrough();
      stream.resume();
      void scope.trackStream(stream);
      stream.destroy(new Error("sensitive resource failure"));
      return {
        state: "observed-pass",
        evidence: [
          await scope.writeEvidence(
            Buffer.from("actual captured synthetic bytes"),
          ),
        ],
      };
    },
  );
  assert.equal(result.attempts[0].state, "observed-fail");
  assert.equal(result.attempts[0].failure, "operation_failed");
});

test("a reentrant native close joins the same close and never releases twice", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  let nested;
  f.state.beforeClose = () => {
    nested = owner.close();
  };
  const closing = owner.close();
  assert.equal(nested, closing);
  assert.equal(await closing, true);
  assert.equal(f.state.closes, 1);
});

test("a substituted checkpoint directory poisons the owner without reopening its new path", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  const checkpointDirectory = path.join(f.runRoot, "checkpoint");
  const retainedDirectory = path.join(f.runRoot, "checkpoint-preserved");
  await fs.rename(checkpointDirectory, retainedDirectory);
  await fs.mkdir(checkpointDirectory, { mode: 0o700 });
  await assert.rejects(owner.readSnapshot(), errorCode("EVIDENCE_INVALID"));
  let called = false;
  await assert.rejects(
    owner.recordCase({ expectedRevision: 1, caseId: "source-inputs" }, () => {
      called = true;
    }),
    errorCode("CHECKPOINT_UNCERTAIN"),
  );
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  assert.equal(called, false);
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.locked, true);
  assert.deepEqual(await fs.readdir(checkpointDirectory), []);
  await fs.rmdir(checkpointDirectory);
  await fs.rename(retainedDirectory, checkpointDirectory);
  const recovered = await owner.recoverAfterUncertainWrite();
  assert.equal(recovered.revision, 2);
  assert.equal(f.state.writes, 2);
});

test("checkpoint substitution during native acquisition fails before reading or writing", async (t) => {
  const f = await fixture(t);
  f.state.afterOpen = async (directory) => {
    await fs.rename(directory, path.join(f.runRoot, "checkpoint-preserved"));
    await fs.mkdir(directory, { mode: 0o700 });
  };
  await assert.rejects(f.open(), errorCode("OPEN_FAILED"));
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.loads, 0);
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.locked, false);
});

test("checkpoint substitution during a native barrier cannot acknowledge detached bytes", async (t) => {
  const f = await fixture(t);
  const owner = await f.open();
  f.state.beforeWrite = async () => {
    const directory = path.join(f.runRoot, "checkpoint");
    await fs.rename(directory, path.join(f.runRoot, "checkpoint-preserved"));
    await fs.mkdir(directory, { mode: 0o700 });
  };
  let called = false;
  await assert.rejects(
    owner.recordCase({ expectedRevision: 1, caseId: "source-inputs" }, () => {
      called = true;
    }),
    errorCode("CHECKPOINT_UNCERTAIN"),
  );
  await assert.rejects(owner.readSnapshot(), errorCode("CHECKPOINT_UNCERTAIN"));
  await assert.rejects(
    owner.recoverAfterUncertainWrite(),
    errorCode("RECOVERY_REQUIRED"),
  );
  assert.equal(called, false);
  assert.equal(f.state.writes, 2);
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.locked, true);
});

test("uncertain output settlement preserves pending evidence and retains the process owner", async (t) => {
  // A separate synthetic process is necessary: the contract intentionally has
  // no in-process reset or unlock for this permanent uncertainty marker.
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--unsigned-evidence-synthetic-uncertain-worker"],
    {
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      outputBytes += bytes.length;
      if (outputBytes > 8192) child.kill("SIGKILL");
    });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Synthetic ownership driver deadline"));
    }, 10_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic ownership driver closed before evidence"));
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic ownership driver unavailable"));
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  assert.deepEqual(await result, {
    kind: "synthetic-output-uncertain",
    state: "pending",
    writes: 2,
    closes: 0,
  });
  assert.deepEqual(await closed, { code: 0, signal: null });
});

test(
  "actual accepted helper owns a two-process lock and recovers a crash-pending checkpoint",
  {
    skip:
      !nativeAcceptanceEnabled &&
      "Pending separately authorized native runtime window",
  },
  async (t) => {
    assert.equal(process.platform, "darwin");
    assert.equal(process.versions.node, "24.20.0");
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "desmoslock-unsigned-native-"),
    );
    await fs.chmod(root, 0o700);
    const runRoot = path.join(root, "unsigned-artifact-runs", runId);
    const options = {
      mode: "create",
      runRoot,
      runId,
      identity,
      nativeModule: {
        path: unsignedEvidenceNativePath,
        sha256: acceptedNativeSha256,
      },
    };
    const owners = [];
    const children = [];
    function startWorker(mode) {
      const child = fork(
        fileURLToPath(import.meta.url),
        ["--unsigned-evidence-native-worker", mode, runRoot],
        {
          execPath: process.execPath,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let outputBytes = 0;
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (bytes) => {
          outputBytes += bytes.length;
          if (outputBytes > 8192) child.kill("SIGKILL");
        });
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      void closed.catch(() => {});
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Native acceptance child deadline"));
        }, 10_000);
        child.once("message", (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error("Native acceptance child closed before evidence"));
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Native acceptance child unavailable"));
        });
      });
      const result = { child, ready, closed };
      children.push(result);
      return result;
    }
    t.after(async () => {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
      }
      for (const owner of owners)
        assert.equal(await owner.close({ timeoutMs: 1000 }), true);
      await fs.rm(root, { recursive: true, force: true });
    });
    const owner = await openUnsignedArtifactEvidence(options);
    owners.push(owner);
    const recorded = await record(
      owner,
      "source-inputs",
      "actual native checkpoint; synthetic source identity and evidence",
    );
    const lockPath = path.join(runRoot, "checkpoint", "student-session.lock");
    const originalLock = await fs.stat(lockPath);
    const competing = startWorker("locked");
    assert.deepEqual(await competing.ready, { kind: "lock-rejected" });
    assert.deepEqual(await competing.closed, { code: 0, signal: null });
    assert.equal(await owner.close(), true);
    const crashing = startWorker("pending");
    const ready = await crashing.ready;
    assert.equal(ready.kind, "pending");
    assert.equal(ready.revision, recorded.revision + 2);
    crashing.child.kill("SIGKILL");
    assert.deepEqual(await crashing.closed, { code: null, signal: "SIGKILL" });
    const resumed = await openUnsignedArtifactEvidence({
      ...options,
      mode: "resume",
    });
    owners.push(resumed);
    const snapshot = await resumed.readSnapshot();
    assert.equal(snapshot.revision, ready.revision + 1);
    assert.equal(snapshot.attempts[0].state, "observed-pass");
    assert.equal(snapshot.attempts[1].state, "incomplete");
    assert.equal((await fs.stat(lockPath)).ino, originalLock.ino);
    assert.deepEqual(snapshot.pendingPhysicalCaseIds, pendingPhysicalCaseIds);
    const complete = await record(
      resumed,
      "checkpoint-readback",
      "actual fresh native barrier after crash",
    );
    assert.equal(complete.attempts[2].state, "observed-pass");
    assert.equal(await resumed.close(), true);
  },
);
