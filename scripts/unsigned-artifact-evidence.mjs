import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { isPromise, isSharedArrayBuffer } from "node:util/types";

import { parseClientBuildIdentity } from "../packages/contracts/dist/build-identity.js";

export const unsignedEvidenceLimits = Object.freeze({
  checkpointBytes: 60 * 1024,
  attempts: 64,
  referencesPerAttempt: 32,
  sidecarBytes: 64 * 1024 * 1024,
});
export const unsignedEvidenceCaseIds = Object.freeze([
  "source-inputs",
  "distribution-inventory",
  "packaged-inventory",
  "packaged-fuses",
  "native-inventory",
  "checkpoint-readback",
]);
export const pendingPhysicalCaseIds = Object.freeze([
  "universal-execution",
  "developer-id-gatekeeper",
  "install-uninstall-rollback",
  "two-clean-macs",
  "synthetic-staff-student-journey",
  "cross-school-rejection",
  "acknowledged-event-visibility",
  "native-aac-categories",
  "network-backend-loss",
  "crash-reboot-corruption",
  "display-prohibited-app",
  "emergency-teacher-test-end",
  "calculator-adversarial",
  "protected-graphing",
]);
export const unsignedEvidenceNativePath = fileURLToPath(
  new URL(
    "../artifacts/unsigned-artifact-tools/durable-record.node",
    import.meta.url,
  ),
);

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^(?!0{64}$)[0-9a-f]{64}$/;
const require = createRequire(import.meta.url);
let processOwner = null;

export class UnsignedArtifactEvidenceError extends Error {
  constructor(code) {
    super("Unsigned artifact evidence is unavailable");
    this.name = "UnsignedArtifactEvidenceError";
    this.code = code;
  }
}
function fail(code = "INVALID") {
  throw new UnsignedArtifactEvidenceError(code);
}
function exact(value, keys, enumerable = true) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((key) => !keys.includes(key)))
    fail();
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      (enumerable && !descriptor.enumerable)
    )
      fail();
    copy[key] = descriptor.value;
  }
  return copy;
}
function dense(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail();
  if (value.length > limit) fail("CAPACITY");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    return descriptor.value;
  });
}
function identity(value) {
  const parsed = parseClientBuildIdentity(value);
  if (parsed === null || parsed === undefined) fail();
  return parsed;
}
function frozen(value) {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function reference(value) {
  const row = exact(value, ["sha256", "bytes"]);
  if (
    typeof row.sha256 !== "string" ||
    !digest.test(row.sha256) ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 1 ||
    row.bytes > unsignedEvidenceLimits.sidecarBytes
  )
    fail();
  return { sha256: row.sha256, bytes: row.bytes };
}
function references(value) {
  const rows = dense(value, unsignedEvidenceLimits.referencesPerAttempt).map(
    reference,
  );
  if (new Set(rows.map((row) => row.sha256)).size !== rows.length) fail();
  return rows;
}
function candidate(value) {
  const row = exact(value, ["kind", "treeSha256", "inventory"]);
  if (
    row.kind !== "unsigned-native-app" ||
    typeof row.treeSha256 !== "string" ||
    !digest.test(row.treeSha256)
  )
    fail();
  return {
    kind: "unsigned-native-app",
    treeSha256: row.treeSha256,
    inventory: reference(row.inventory),
  };
}
function parseCheckpoint(bytes, expected) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > unsignedEvidenceLimits.checkpointBytes
  )
    fail("INVALID_CHECKPOINT");
  const row = exact(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    [
      "schemaVersion",
      "kind",
      "runId",
      "revision",
      "identity",
      "candidate",
      "attempts",
      "pendingPhysicalCaseIds",
    ],
  );
  if (
    row.schemaVersion !== 1 ||
    row.kind !== "desmoslock-unsigned-artifact-evidence" ||
    row.runId !== expected.runId ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !same(identity(row.identity), expected.identity) ||
    !same(
      dense(row.pendingPhysicalCaseIds, pendingPhysicalCaseIds.length),
      pendingPhysicalCaseIds,
    )
  )
    fail("INVALID_CHECKPOINT");
  const boundCandidate =
    row.candidate === null ? null : candidate(row.candidate);
  let established = null;
  const attempts = dense(row.attempts, unsignedEvidenceLimits.attempts).map(
    (value, index) => {
      const attempt = exact(value, [
        "sequence",
        "caseId",
        "state",
        "candidateTreeSha256",
        "evidence",
        "failure",
      ]);
      if (
        attempt.sequence !== index + 1 ||
        !unsignedEvidenceCaseIds.includes(attempt.caseId) ||
        !["pending", "observed-pass", "observed-fail", "incomplete"].includes(
          attempt.state,
        ) ||
        (attempt.state === "pending" && index !== row.attempts.length - 1) ||
        (attempt.state === "pending" || attempt.state === "observed-pass"
          ? attempt.failure !== null
          : ![
              "observation_failed",
              "operation_failed",
              "operation_incomplete",
            ].includes(attempt.failure))
      )
        fail("INVALID_CHECKPOINT");
      const evidence = references(attempt.evidence);
      if (attempt.state === "observed-pass" && evidence.length === 0)
        fail("INVALID_CHECKPOINT");
      if (
        attempt.caseId === "packaged-inventory" &&
        attempt.state === "observed-pass"
      ) {
        if (
          boundCandidate === null ||
          !evidence.some((item) => same(item, boundCandidate.inventory))
        )
          fail("INVALID_CHECKPOINT");
        established = boundCandidate.treeSha256;
      }
      if (attempt.candidateTreeSha256 !== established)
        fail("INVALID_CHECKPOINT");
      return {
        sequence: attempt.sequence,
        caseId: attempt.caseId,
        state: attempt.state,
        candidateTreeSha256: attempt.candidateTreeSha256,
        evidence,
        failure: attempt.failure,
      };
    },
  );
  if ((boundCandidate?.treeSha256 ?? null) !== established)
    fail("INVALID_CHECKPOINT");
  if (
    row.revision <
    1 +
      attempts.length +
      attempts.filter((attempt) => attempt.state !== "pending").length
  )
    fail("INVALID_CHECKPOINT");
  return frozen({
    schemaVersion: 1,
    kind: "desmoslock-unsigned-artifact-evidence",
    runId: row.runId,
    revision: row.revision,
    identity: expected.identity,
    candidate: boundCandidate,
    attempts,
    pendingPhysicalCaseIds: [...pendingPhysicalCaseIds],
  });
}
function encode(checkpoint) {
  const bytes = Buffer.from(JSON.stringify(checkpoint));
  if (bytes.length > unsignedEvidenceLimits.checkpointBytes) fail("CAPACITY");
  return bytes;
}
function nextRevision(checkpoint) {
  if (checkpoint.revision >= Number.MAX_SAFE_INTEGER) fail("CAPACITY");
  return checkpoint.revision + 1;
}
function absolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes("\0") ||
    value.endsWith("/")
  )
    fail();
  return value;
}
async function directoryChain(filename, privateLeaf = true) {
  let current = path.parse(filename).root;
  let status;
  for (const component of filename.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    status = await fs.lstat(current);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (status.uid !== 0 && status.uid !== process.geteuid()) ||
      ((status.mode & 0o022) !== 0 &&
        !(status.uid === 0 && (status.mode & 0o1000) !== 0))
    )
      fail("PATH_INVALID");
  }
  if (
    privateLeaf &&
    (status.uid !== process.geteuid() || (status.mode & 0o077) !== 0)
  )
    fail("PATH_INVALID");
  return status;
}
async function privateDirectory(filename, create) {
  await directoryChain(path.dirname(filename), false);
  if (create) {
    try {
      await fs.mkdir(filename, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return directoryChain(filename);
}
async function checkedFile(filename, expected, privateFile = true) {
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.geteuid() ||
      before.nlink !== 1 ||
      (privateFile && (before.mode & 0o077) !== 0) ||
      before.size !== expected.bytes
    )
      fail("EVIDENCE_INVALID");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (size <= expected.bytes) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.bytes - size + 1),
        null,
      );
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const named = await fs.lstat(filename);
    if (
      size !== expected.bytes ||
      hash.digest("hex") !== expected.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink()
    )
      fail("EVIDENCE_INVALID");
  } finally {
    await handle.close();
  }
}
function binding(value) {
  const row = exact(value, ["openStore", "maximumRecordBytes"]);
  if (row.maximumRecordBytes !== 65536 || typeof row.openStore !== "function")
    fail("NATIVE_INVALID");
  return (directory) => Reflect.apply(row.openStore, value, [directory]);
}
function storeMethods(value) {
  const names = [
    "loadEncryptedRecord",
    "replaceEncryptedRecord",
    "quarantineEncryptedRecord",
    "close",
  ];
  const row = exact(value, names, false);
  if (names.some((name) => typeof row[name] !== "function"))
    fail("NATIVE_INVALID");
  return Object.freeze({
    load: () => Reflect.apply(row.loadEncryptedRecord, value, []),
    replace: (bytes) =>
      Reflect.apply(row.replaceEncryptedRecord, value, [bytes]),
    close: () => Reflect.apply(row.close, value, []),
  });
}
function nativeOptions(options) {
  const selected = exact(options, ["path", "sha256"]);
  if (
    selected.path !== unsignedEvidenceNativePath ||
    typeof selected.sha256 !== "string" ||
    !digest.test(selected.sha256)
  )
    fail("NATIVE_INVALID");
  return Object.freeze({ path: selected.path, sha256: selected.sha256 });
}
async function loadNative(selected) {
  if (process.platform !== "darwin" || process.versions.node !== "24.20.0")
    fail("NATIVE_INVALID");
  await directoryChain(path.dirname(selected.path), false);
  const status = await fs.lstat(selected.path);
  await checkedFile(
    selected.path,
    { sha256: selected.sha256, bytes: status.size },
    false,
  );
  return binding(require(selected.path));
}

/** CLI-owned only. Loads the separately pinned storage addon, never AAC or a product codec. */
export function openUnsignedArtifactEvidence(options) {
  return openOwner(options, loadNative);
}

/** Explicit synthetic seam; these adapters do not establish native durability evidence. */
export function openUnsignedArtifactEvidenceForTesting(options, native) {
  return openOwner(options, async () => binding(native));
}

async function openOwner(input, loader) {
  if (processOwner !== null) fail("BUSY");
  const token = {};
  processOwner = token;
  let store = null;
  let openStore;
  let options;
  let checkpoint;
  let rootStatus;
  let checkpointStatus;
  let evidenceStatus;
  let active = null;
  let busy = false;
  let stopping = false;
  let closed = false;
  let poisoned = false;
  let outputSettlementUncertain = false;
  let uncertainTarget = null;
  let recoveryReadback = null;
  let closeWork = null;
  let closingSetup = false;
  let initializing = true;

  async function checkDirectories() {
    const root = await directoryChain(options.runRoot);
    const checkpointDirectory = await directoryChain(
      path.join(options.runRoot, "checkpoint"),
    );
    if (
      root.dev !== rootStatus.dev ||
      root.ino !== rootStatus.ino ||
      checkpointDirectory.dev !== checkpointStatus.dev ||
      checkpointDirectory.ino !== checkpointStatus.ino
    )
      fail("PATH_INVALID");
    if (evidenceStatus !== undefined) {
      const evidence = await directoryChain(
        path.join(options.runRoot, "evidence"),
      );
      if (
        evidence.dev !== evidenceStatus.dev ||
        evidence.ino !== evidenceStatus.ino
      )
        fail("PATH_INVALID");
    }
  }
  async function checkReferences(value) {
    await checkDirectories();
    const all = new Map();
    for (const attempt of value.attempts)
      for (const ref of attempt.evidence) {
        if (all.has(ref.sha256) && all.get(ref.sha256).bytes !== ref.bytes)
          fail("EVIDENCE_INVALID");
        all.set(ref.sha256, ref);
      }
    if (value.candidate !== null)
      all.set(value.candidate.inventory.sha256, value.candidate.inventory);
    for (const ref of all.values())
      await checkedFile(
        path.join(options.runRoot, "evidence", ref.sha256),
        ref,
      );
  }
  async function commit(value) {
    const bytes = encode(value);
    const parsed = parseCheckpoint(bytes, options);
    uncertainTarget = bytes;
    try {
      await checkDirectories();
      await store.replace(bytes);
      await checkDirectories();
    } catch {
      poisoned = true;
      fail("CHECKPOINT_UNCERTAIN");
    }
    checkpoint = parsed;
    uncertainTarget = null;
    recoveryReadback = null;
  }
  async function loadedRecovery() {
    await checkDirectories();
    const loaded = parseCheckpoint(await store.load(), options);
    const baseline = recoveryReadback ?? checkpoint;
    if (baseline !== undefined) {
      if (
        loaded.revision < baseline.revision ||
        (loaded.revision === baseline.revision && !same(loaded, baseline)) ||
        (loaded.revision > baseline.revision &&
          (uncertainTarget === null ||
            !same(loaded, parseCheckpoint(uncertainTarget, options))))
      )
        fail("INVALID_CHECKPOINT");
      if (
        baseline.candidate !== null &&
        !same(loaded.candidate, baseline.candidate)
      )
        fail("INVALID_CHECKPOINT");
    }
    await checkReferences(loaded);
    // This baseline permits another recovery attempt if its barrier fails. It
    // never becomes the acknowledged checkpoint or clears the poisoned fence.
    recoveryReadback = loaded;
    // Readback never heals an uncertain publication. A new acknowledged barrier
    // records recovery, including interruption of any previously pending case.
    await commit({
      ...loaded,
      revision: nextRevision(loaded),
      attempts: loaded.attempts.map((attempt) =>
        attempt.state === "pending"
          ? { ...attempt, state: "incomplete", failure: "operation_incomplete" }
          : attempt,
      ),
    });
    poisoned = false;
  }
  function exclusive(work, recovery = false) {
    if (outputSettlementUncertain)
      return Promise.reject(
        new UnsignedArtifactEvidenceError("OUTPUT_SETTLEMENT_UNCERTAIN"),
      );
    if (initializing || busy)
      return Promise.reject(new UnsignedArtifactEvidenceError("BUSY"));
    if (closed || stopping)
      return Promise.reject(new UnsignedArtifactEvidenceError("CLOSED"));
    if (poisoned && !recovery)
      return Promise.reject(
        new UnsignedArtifactEvidenceError("CHECKPOINT_UNCERTAIN"),
      );
    // Reserve before invoking any caller reflection, callback, or asynchronous hook.
    busy = true;
    let resolve;
    let reject;
    const operation = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    active = operation;
    void (async () => {
      try {
        const result = await work();
        active = null;
        busy = false;
        resolve(result);
      } catch (error) {
        active = null;
        busy = false;
        reject(
          error instanceof UnsignedArtifactEvidenceError
            ? error
            : new UnsignedArtifactEvidenceError("UNAVAILABLE"),
        );
      }
    })();
    return operation;
  }
  function expectedRevision(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail();
    if (value !== checkpoint.revision) fail("STALE_REVISION");
  }
  async function publishSidecar(bytes) {
    await checkDirectories();
    const ref = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    const filename = path.join(options.runRoot, "evidence", ref.sha256);
    let file;
    try {
      file = await fs.open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (file !== undefined) {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    // This is verified external evidence, not a claim of F_FULLFSYNC durability.
    await checkedFile(filename, ref);
    return frozen(ref);
  }
  function scopeForOperation() {
    const pending = new Set();
    const evidence = new Map();
    let accepting = true;
    let failed = false;
    function own(work) {
      if (!accepting)
        return Promise.reject(new UnsignedArtifactEvidenceError("CLOSED"));
      if (typeof work !== "function")
        return Promise.reject(new UnsignedArtifactEvidenceError("INVALID"));
      const result = Promise.resolve().then(work);
      const settlement = result.then(
        () => undefined,
        () => {
          failed = true;
        },
      );
      pending.add(settlement);
      void settlement.then(() => pending.delete(settlement));
      return result;
    }
    function trackStarted(start) {
      if (!accepting)
        return Promise.reject(new UnsignedArtifactEvidenceError("CLOSED"));
      let result;
      try {
        result = start();
      } catch (error) {
        result = Promise.reject(error);
      }
      return own(() => result);
    }
    const scope = Object.freeze({
      own,
      markOutputSettlementUncertain() {
        if (!accepting) fail("CLOSED");
        outputSettlementUncertain = true;
        poisoned = true;
        accepting = false;
      },
      track(promise) {
        if (!isPromise(promise)) fail();
        return own(() => promise);
      },
      trackChild(child) {
        return trackStarted(
          () =>
            new Promise((resolve) => {
              // A child 'close' event follows stdio closure. An exit/abort race is
              // insufficient; callers must also track any separately owned descendants.
              let error = false;
              child.once("error", () => {
                error = true;
              });
              child.once("close", (code, signal) => {
                if (
                  error ||
                  code !== 0 ||
                  (signal !== null && signal !== undefined)
                )
                  failed = true;
                resolve();
              });
            }),
        );
      },
      trackStream(stream) {
        return trackStarted(() => finished(stream, { cleanup: true }));
      },
      writeEvidence(value) {
        if (!accepting)
          return Promise.reject(new UnsignedArtifactEvidenceError("CLOSED"));
        if (
          !Buffer.isBuffer(value) ||
          isSharedArrayBuffer(value.buffer) ||
          value.length < 1 ||
          value.length > unsignedEvidenceLimits.sidecarBytes
        )
          fail();
        const bytes = Buffer.from(value);
        return own(async () => {
          const ref = await publishSidecar(bytes);
          if (
            !evidence.has(ref.sha256) &&
            evidence.size >= unsignedEvidenceLimits.referencesPerAttempt
          )
            fail("CAPACITY");
          evidence.set(ref.sha256, ref);
          return ref;
        });
      },
    });
    return {
      scope,
      async drain() {
        while (pending.size > 0) await Promise.all([...pending]);
        accepting = false;
        return !failed;
      },
      evidence: () => [...evidence.values()],
    };
  }

  try {
    const row = exact(input, [
      "mode",
      "runRoot",
      "runId",
      "identity",
      "nativeModule",
    ]);
    const runRoot = absolute(row.runRoot);
    if (
      typeof row.runId !== "string" ||
      !uuid.test(row.runId) ||
      path.basename(runRoot) !== row.runId ||
      path.basename(path.dirname(runRoot)) !== "unsigned-artifact-runs" ||
      !["create", "resume"].includes(row.mode)
    )
      fail();
    options = {
      mode: row.mode,
      runRoot,
      runId: row.runId,
      identity: identity(row.identity),
    };
    const selectedNative =
      loader === loadNative ? nativeOptions(row.nativeModule) : null;
    await directoryChain(path.dirname(path.dirname(runRoot)), false);
    await privateDirectory(path.dirname(runRoot), options.mode === "create");
    if (options.mode === "create") await fs.mkdir(runRoot, { mode: 0o700 });
    rootStatus = await directoryChain(runRoot);
    const checkpointDirectory = path.join(runRoot, "checkpoint");
    checkpointStatus = await privateDirectory(
      checkpointDirectory,
      options.mode === "create",
    );
    openStore = await loader(selectedNative);
    await checkDirectories();
    store = storeMethods(await openStore(checkpointDirectory));
    await checkDirectories();
    evidenceStatus = await privateDirectory(
      path.join(runRoot, "evidence"),
      options.mode === "create",
    );
    if (options.mode === "create") {
      await checkDirectories();
      if ((await store.load()) !== null) fail("INVALID_CHECKPOINT");
      await commit({
        schemaVersion: 1,
        kind: "desmoslock-unsigned-artifact-evidence",
        runId: options.runId,
        revision: 1,
        identity: options.identity,
        candidate: null,
        attempts: [],
        pendingPhysicalCaseIds: [...pendingPhysicalCaseIds],
      });
    } else await loadedRecovery();
    initializing = false;
  } catch {
    if (store !== null) {
      try {
        await store.close();
        store = null;
      } catch {
        /* Native retains its owner and lock; initialization cannot manufacture closure. */
      }
    }
    if (store === null && processOwner === token) processOwner = null;
    fail("OPEN_FAILED");
  }

  return Object.freeze({
    readSnapshot() {
      return exclusive(async () => {
        try {
          await checkReferences(checkpoint);
          return checkpoint;
        } catch {
          poisoned = true;
          fail("EVIDENCE_INVALID");
        }
      });
    },
    revalidate(input) {
      return exclusive(async () => {
        const row = exact(input, ["expectedRevision"]);
        expectedRevision(row.expectedRevision);
        try {
          await checkReferences(checkpoint);
          return checkpoint;
        } catch {
          poisoned = true;
          fail("EVIDENCE_INVALID");
        }
      });
    },
    recordCase(input, work) {
      return exclusive(async () => {
        const row = exact(input, ["expectedRevision", "caseId"]);
        expectedRevision(row.expectedRevision);
        if (
          !unsignedEvidenceCaseIds.includes(row.caseId) ||
          typeof work !== "function"
        )
          fail();
        if (checkpoint.attempts.length >= unsignedEvidenceLimits.attempts)
          fail("CAPACITY");
        try {
          await checkReferences(checkpoint);
        } catch {
          poisoned = true;
          fail("EVIDENCE_INVALID");
        }
        const pending = {
          sequence: checkpoint.attempts.length + 1,
          caseId: row.caseId,
          state: "pending",
          candidateTreeSha256: checkpoint.candidate?.treeSha256 ?? null,
          evidence: [],
          failure: null,
        };
        const pendingCheckpoint = {
          ...checkpoint,
          revision: nextRevision(checkpoint),
          attempts: [...checkpoint.attempts, pending],
        };
        // Reserve room for a recoverable incomplete result before starting work.
        encode({
          ...pendingCheckpoint,
          revision: nextRevision(pendingCheckpoint),
          attempts: [
            ...checkpoint.attempts,
            {
              ...pending,
              state: "incomplete",
              failure: "operation_incomplete",
            },
          ],
        });
        await commit(pendingCheckpoint);
        const owned = scopeForOperation();
        let result;
        let failed = false;
        try {
          result = await work(owned.scope);
        } catch {
          failed = true;
        }
        if (!(await owned.drain())) failed = true;
        // The CLI's persistent checkout lease governs unknown compiler/packager
        // descendants across processes. Keep this pending checkpoint and native
        // owner intact; known Promise settlement cannot establish output safety.
        if (outputSettlementUncertain) fail("OUTPUT_SETTLEMENT_UNCERTAIN");
        let observed;
        let boundCandidate = checkpoint.candidate;
        if (!failed) {
          try {
            const keys =
              row.caseId === "packaged-inventory"
                ? ["state", "evidence", "candidate"]
                : ["state", "evidence"];
            const value = exact(result, keys);
            if (!["observed-pass", "observed-fail"].includes(value.state))
              fail();
            const refs = references(value.evidence);
            const captured = owned.evidence();
            if (
              refs.some((ref) => !captured.some((item) => same(item, ref))) ||
              (value.state === "observed-pass" && refs.length === 0)
            )
              fail();
            if (row.caseId === "packaged-inventory") {
              if (value.state === "observed-pass") {
                const selected = candidate(value.candidate);
                if (
                  !refs.some((ref) => same(ref, selected.inventory)) ||
                  (boundCandidate !== null && !same(selected, boundCandidate))
                )
                  fail();
                boundCandidate = selected;
              } else if (value.candidate !== null) fail();
            }
            observed = {
              ...pending,
              state: value.state,
              candidateTreeSha256: boundCandidate?.treeSha256 ?? null,
              evidence: refs,
              failure:
                value.state === "observed-fail" ? "observation_failed" : null,
            };
          } catch {
            failed = true;
          }
        }
        if (failed)
          observed = {
            ...pending,
            state: "observed-fail",
            evidence: owned.evidence(),
            failure: "operation_failed",
          };
        const complete = {
          ...checkpoint,
          revision: nextRevision(checkpoint),
          candidate: boundCandidate,
          attempts: [...checkpoint.attempts.slice(0, -1), observed],
        };
        try {
          await checkReferences(complete);
          await commit(complete);
        } catch (error) {
          poisoned = true;
          throw error;
        }
        return checkpoint;
      });
    },
    recoverAfterUncertainWrite() {
      return exclusive(async () => {
        if (!poisoned) fail();
        try {
          await checkDirectories();
          if (store !== null) {
            await store.close();
            store = null;
          }
          await checkDirectories();
          store = storeMethods(
            await openStore(path.join(options.runRoot, "checkpoint")),
          );
          await checkDirectories();
          await loadedRecovery();
          return checkpoint;
        } catch {
          poisoned = true;
          fail("RECOVERY_REQUIRED");
        }
      }, true);
    },
    close(input = { timeoutMs: 5000 }) {
      if (outputSettlementUncertain) return Promise.resolve(false);
      if (closingSetup)
        return Promise.reject(new UnsignedArtifactEvidenceError("BUSY"));
      if (busy && active === null)
        return Promise.reject(new UnsignedArtifactEvidenceError("BUSY"));
      if (closeWork !== null) return closeWork;
      if (closed) return Promise.resolve(true);
      closingSetup = true;
      let timeoutMs;
      try {
        timeoutMs = exact(input, ["timeoutMs"]).timeoutMs;
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > 60_000
        )
          fail();
      } catch {
        closingSetup = false;
        return Promise.reject(new UnsignedArtifactEvidenceError("INVALID"));
      }
      stopping = true;
      let settle;
      closeWork = new Promise((resolve) => {
        settle = resolve;
      });
      closingSetup = false;
      const closing = closeWork;
      const run = async () => {
        if (active !== null) {
          let timer;
          const settled = await Promise.race([
            active.then(
              () => true,
              () => true,
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), timeoutMs);
            }),
          ]);
          clearTimeout(timer);
          if (!settled) return false; // No delayed continuation may unlock after this timeout.
        }
        if (outputSettlementUncertain) return false;
        try {
          if (store !== null) await store.close();
        } catch {
          return false;
        }
        store = null;
        closed = true;
        if (processOwner === token) processOwner = null;
        return true;
      };
      void run().then(
        (result) => {
          closeWork = null;
          settle(result);
        },
        () => {
          closeWork = null;
          settle(false);
        },
      );
      return closing;
    },
  });
}
