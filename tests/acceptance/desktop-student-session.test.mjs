import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(
  repository,
  "tests/acceptance/fixtures/desktop-student-session-worker.ts",
);
const code = "0123456789AB";
const recordName = "student-session.record";
const lockName = "student-session.lock";
const macOnly = { skip: process.platform !== "darwin", timeout: 25_000 };
const fingerprint = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
function check(condition, message) {
  assert.ok(condition, message);
}
function same(a, b, message) {
  assert.equal(fingerprint(a), fingerprint(b), message);
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "desmoslock-student-private-"),
  );
  const directory = path.join(root, "owned-store");
  const bundle = path.join(root, "worker.mjs");
  const children = [];
  const requests = [];
  const failures = [];
  const receipts = new Map();
  const evidenceReceipts = new Map();
  const bindings = new Map();
  const challenges = new Map();
  const drops = new Set();
  const holds = new Set();
  const held = [];
  let elapsed = 0;
  let server;
  let api;
  let origin;
  let crypto;
  const highestCounters = new Map();
  let omitEvidenceAck = false;
  t.after(async () => {
    for (const child of children) await child.kill();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(path.join(root, "native"));
  const native = await fs.readFile(
    path.join(repository, "apps/desktop/dist/native/durable-record.node"),
  );
  await fs.writeFile(path.join(root, "native/durable-record.node"), native);
  same(
    await fs.readFile(path.join(root, "native/durable-record.node")),
    native,
    "Copied native module differs from the selected production output",
  );
  await build({
    entryPoints: [source],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    alias: {
      "@desmoslock/contracts": path.join(
        repository,
        "packages/contracts/src/index.ts",
      ),
    },
    logLevel: "silent",
  });
  api = await import(pathToFileURL(bundle).href);
  const readRecord = async () => {
    const bytes = await fs.readFile(path.join(directory, recordName));
    check(
      bytes.length <= 65_536 &&
        bytes.toString().startsWith(api.syntheticPrefix),
      "HTTP boundary lacks a bounded synthetic durable record",
    );
    return JSON.parse(bytes.toString().slice(api.syntheticPrefix.length));
  };
  function logical(route, body, record) {
    if (route === "join") {
      check(
        record.pending?.kind === "join",
        "Join egress preceded durable join intent",
      );
      same(
        body.admissionMode,
        record.pending.admissionMode,
        "Join changed retained admission mode",
      );
      same(
        body.joinCode,
        record.pending.joinCode,
        "Join changed retained code",
      );
      same(
        body.capabilityDigest,
        record.pending.candidates.capabilityDigest,
        "Join changed retained candidate digest",
      );
      same(
        body.reconnectDigest,
        record.pending.candidates.reconnectDigest,
        "Join changed retained reconnect digest",
      );
      same(
        body.deviceSessionId,
        record.device.deviceSessionId,
        "Join changed retained device identity",
      );
      return crypto.digestLogicalOperation({
        kind: "join",
        admissionMode: body.admissionMode,
        requestId: body.requestId,
        deviceSessionId: body.deviceSessionId,
        joinMaterialDigest: crypto.digestJoinCode(body.joinCode),
        capabilityDigest: body.capabilityDigest,
        reconnectDigest: body.reconnectDigest,
      });
    }
    const base = { kind: route, requestId: body.requestId, scope: body.scope };
    if (route === "reconnect") {
      check(
        record.pending?.kind === "reconnect",
        "Rotation has no durable pending intent",
      );
      same(
        body.reconnectGrant,
        record.current.reconnectGrant,
        "Rotation changed retained authority",
      );
      same(
        body.expectedSessionRevision,
        record.pending.expectedSessionRevision,
        "Rotation changed retained revision",
      );
      same(
        body.nextCapabilityDigest,
        record.pending.candidates.capabilityDigest,
        "Rotation changed retained successor digest",
      );
      same(
        body.nextReconnectDigest,
        record.pending.candidates.reconnectDigest,
        "Rotation changed retained reconnect successor",
      );
      return crypto.digestLogicalOperation({
        ...base,
        expectedSessionRevision: body.expectedSessionRevision,
        reconnectDigest: crypto.digestReconnectGrant(body.reconnectGrant),
        nextCapabilityDigest: body.nextCapabilityDigest,
        nextReconnectDigest: body.nextReconnectDigest,
      });
    }
    same(
      body.capabilityToken,
      record.current.capabilityToken,
      "Maintenance changed retained capability",
    );
    if (route === "forfeit")
      same(
        body.expectedSessionRevision,
        record.pending.expectedSessionRevision,
        "Forfeit changed retained revision",
      );
    return crypto.digestLogicalOperation({
      ...base,
      ...(route === "forfeit"
        ? { expectedSessionRevision: body.expectedSessionRevision }
        : {}),
      capabilityDigest: crypto.digestCapability(body.capabilityToken),
    });
  }
  function verifyProof(route, body, record, digest) {
    const proof = body.deviceProof;
    const bootstrap = route === "join";
    const envelope = bootstrap
      ? {
          kind: "bootstrap",
          apiOrigin: origin,
          requestId: body.requestId,
          deviceSessionId: body.deviceSessionId,
          keyThumbprint: record.device.keyThumbprint,
          logicalOperationDigest: digest,
          challengeId: proof.challengeId,
          expiresAtMs: proof.expiresAtMs,
        }
      : {
          kind: "maintenance",
          apiOrigin: origin,
          operation: route,
          requestId: body.requestId,
          scope: body.scope,
          keyThumbprint: record.device.keyThumbprint,
          logicalOperationDigest: digest,
          counter: proof.counter,
        };
    const bytes = api.encodeStudentProofEnvelope(envelope);
    check(bytes !== null, "HTTP proof envelope was not canonical");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(record.device.publicKey, "base64url"),
      ]),
      type: "spki",
      format: "der",
    });
    check(
      verify(null, bytes, publicKey, Buffer.from(proof.signature, "base64url")),
      "Actual HTTP device signature failed verification",
    );
    if (bootstrap) {
      const challenge = challenges.get(proof.challengeId);
      check(
        challenge?.digest === digest &&
          challenge.expiresAtMs === proof.expiresAtMs &&
          challenge.device === body.deviceSessionId,
        "Join did not bind its issued challenge",
      );
      same(
        proof.publicKey,
        record.device.publicKey,
        "Bootstrap key differs from retained enrollment",
      );
    } else {
      check(
        proof.counter === record.lastReservedCounter &&
          proof.counter >
            (highestCounters.get(record.device.keyThumbprint) ?? 0),
        "Actual HTTP preceded durable greater-counter reservation",
      );
      highestCounters.set(record.device.keyThumbprint, proof.counter);
      same(
        body.scope,
        record.current?.scope,
        "Maintenance scope differs from durable authority",
      );
    }
  }
  function acceptEvidence(body, record) {
    check(
      api.parseStudentEvidenceRequest(body) !== null,
      "Evidence request failed exact finite parsing",
    );
    const key = createHash("sha256")
      .update(Buffer.from(body.publicKey, "base64url"))
      .digest("base64url");
    const signer =
      record.device.keyThumbprint === key
        ? {
            device: record.device,
            lastReservedCounter: record.lastReservedCounter,
          }
        : record.evidence.retiredSigners.find(
            (entry) => entry.device.keyThumbprint === key,
          );
    check(
      signer !== undefined,
      "Evidence egress lacks its durably retained original signer",
    );
    const binding = bindings.get(key);
    check(
      binding !== undefined,
      "Evidence signer has no prior admitted binding",
    );
    same(body.scope, binding.scope, "Evidence changed original admitted scope");
    same(
      body.publicKey,
      binding.publicKey,
      "Evidence changed original binding key",
    );
    const attemptId = body.facts[0].attemptId;
    const originEntry = record.evidence.origins.find(
      (entry) => entry.attemptId === attemptId,
    );
    check(
      originEntry?.originalKeyThumbprint === key,
      "Evidence relabeled the attempt signer",
    );
    same(
      body.originBuild,
      originEntry.originBuild,
      "Evidence replaced original build provenance",
    );
    const pending = record.evidence.pendingBatches.find(
      (entry) => entry.originalKeyThumbprint === key,
    );
    check(
      pending !== undefined && pending.attemptId === attemptId,
      "Evidence preceded immutable pending publication",
    );
    const retained = record.nativeProtection.facts
      .filter((fact) => fact.attemptId === attemptId)
      .slice(0, pending.events.length);
    same(
      body.facts,
      retained,
      "Evidence did not use the exact coordinator-authored immutable prefix",
    );
    const digested = crypto.digestEvidence(signer.device, {
      scope: body.scope,
      originBuild: body.originBuild,
      facts: body.facts,
    });
    same(
      body.batchDigest,
      digested.batchDigest,
      "Evidence batch digest differs from canonical original content",
    );
    same(
      body.batchDigest,
      pending.batchDigest,
      "Evidence changed the durable pending digest",
    );
    same(
      pending.events,
      body.facts.map((fact, index) => ({
        eventId: fact.eventId,
        contentDigest: digested.contentDigests[index],
      })),
      "Evidence pending references differ from exact content digests",
    );
    const counter = body.deviceProof.counter;
    check(
      counter === signer.lastReservedCounter &&
        counter > (highestCounters.get(key) ?? 0),
      "Evidence HTTP preceded durable greater common-counter reservation",
    );
    check(
      record.evidence.lastAttemptedSigner === key,
      "Evidence fairness cursor was not durable before HTTP",
    );
    const bytes = api.encodeStudentEvidenceProof({
      apiOrigin: origin,
      originalKeyThumbprint: key,
      scope: body.scope,
      batchDigest: body.batchDigest,
      counter,
    });
    check(bytes !== null, "Evidence proof bytes were not canonical");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(body.publicKey, "base64url"),
      ]),
      type: "spki",
      format: "der",
    });
    check(
      verify(
        null,
        bytes,
        publicKey,
        Buffer.from(body.deviceProof.signature, "base64url"),
      ),
      "Original device Ed25519 evidence signature failed actual verification",
    );
    for (const [index, fact] of body.facts.entries()) {
      const existing = evidenceReceipts.get(fact.eventId);
      if (existing)
        same(
          existing.contentDigest,
          digested.contentDigests[index],
          "Retry changed previously committed event content",
        );
    }
    const acknowledged = body.facts.map(
      (fact, index) =>
        evidenceReceipts.get(fact.eventId) ?? {
          eventId: fact.eventId,
          contentDigest: digested.contentDigests[index],
          receivedAt: "2026-09-08T14:00:00.123456Z",
        },
    );
    highestCounters.set(key, counter);
    acknowledged.forEach((ack) => evidenceReceipts.set(ack.eventId, ack));
    return {
      status: "accepted",
      code: "STUDENT_EVIDENCE_ACCEPTED",
      scope: body.scope,
      batchDigest: body.batchDigest,
      acceptedProofCounter: counter,
      acknowledged,
    };
  }
  server = createServer((request, response) => {
    void (async () => {
      check(
        request.method === "POST" &&
          request.url?.startsWith("/functions/v1/student-session-"),
        "Unexpected loopback request",
      );
      const route = request.url.slice("/functions/v1/student-session-".length);
      let size = 0;
      const parts = [];
      for await (const part of request) {
        size += part.length;
        check(
          size <= (route === "evidence" ? 16384 : 8192),
          "Loopback request exceeded contract bound",
        );
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString());
      const record = await readRecord();
      const now = 1_000_000 + elapsed;
      let result;
      let digest;
      if (route === "challenge") {
        check(
          record.pending?.kind === "join",
          "Challenge preceded durable pending intent",
        );
        same(
          body.requestId,
          record.pending.requestId,
          "Challenge changed retained request identity",
        );
        same(
          body.publicKey,
          record.device.publicKey,
          "Challenge changed retained public key",
        );
        result = { challengeId: randomUUID(), expiresAtMs: now + 15_000 };
        challenges.set(result.challengeId, {
          digest: body.logicalOperationDigest,
          expiresAtMs: result.expiresAtMs,
          device: body.deviceSessionId,
        });
      } else if (route === "evidence") {
        result = acceptEvidence(body, record);
        digest = result.batchDigest;
      } else {
        digest = logical(route, body, record);
        verifyProof(route, body, record, digest);
        if (route !== "read") {
          check(
            record.pending?.kind === route,
            "Mutation egress preceded its durable intent",
          );
          same(
            body.requestId,
            record.pending.requestId,
            "Mutation changed retained request identity",
          );
        }
        const key = `${route}:${body.requestId}`;
        const prior = receipts.get(key);
        if (prior)
          same(
            digest,
            prior.digest,
            "Exact receipt retry changed logical intent",
          );
        if (route === "join" || route === "reconnect") {
          const issued = prior?.result ?? {
            status: "accepted",
            code: "STUDENT_SESSION_ACCEPTED",
            requestId: body.requestId,
            logicalOperationDigest: digest,
            scope:
              route === "join"
                ? {
                    schoolId: "30000000-0000-4000-8000-000000000001",
                    testId: "40000000-0000-4000-8000-000000000001",
                    studentSessionId: "50000000-0000-4000-8000-000000000001",
                    deviceSessionId: body.deviceSessionId,
                    epoch: body.admissionMode === "initial" ? 1 : 3,
                  }
                : body.scope,
            sessionRevision:
              route === "join"
                ? body.admissionMode === "initial"
                  ? 1
                  : 4
                : body.expectedSessionRevision + 1,
            syntheticDisplayName: "Student ABC",
            serverNowMs: now,
            capabilityIssuedAtMs: now,
            capabilityExpiresAtMs: now + 300_000,
            reconnectExpiresAtMs: now + 900_000,
            allowedIntents: ["state.read", "session.forfeit"],
          };
          result = {
            ...issued,
            serverNowMs: now,
            ...(route === "reconnect"
              ? { acceptedProofCounter: body.deviceProof.counter }
              : {}),
          };
          if (!prior) receipts.set(key, { result: issued, digest });
          if (route === "join") {
            const binding = {
              scope: issued.scope,
              publicKey: record.device.publicKey,
            };
            const previous = bindings.get(record.device.keyThumbprint);
            if (previous)
              same(
                previous,
                binding,
                "Join receipt changed original device binding",
              );
            bindings.set(record.device.keyThumbprint, binding);
          }
        } else if (route === "forfeit") {
          result = {
            status: "accepted",
            code: "STUDENT_SESSION_FORFEITED",
            requestId: body.requestId,
            acceptedProofCounter: body.deviceProof.counter,
          };
          if (!prior) receipts.set(key, { result, digest });
        } else {
          check(route === "read", "Unexpected maintenance route");
          result = {
            status: "accepted",
            code: "STUDENT_SESSION_CURRENT",
            requestId: body.requestId,
            acceptedProofCounter: body.deviceProof.counter,
            scope: body.scope,
            sessionRevision: record.current.sessionRevision,
            syntheticDisplayName: record.current.syntheticDisplayName,
            testLifecycle: "open",
            state: "active",
            serverNowMs: now,
            capabilityExpiresAtMs: record.current.capabilityExpiresAtMs,
          };
        }
      }
      requests.push({ route, body, record, result, digest });
      const respond = () => {
        if (!response.destroyed) {
          response.writeHead(200, {
            "content-type": "application/json",
            connection: "close",
          });
          if (route === "evidence" && omitEvidenceAck) {
            omitEvidenceAck = false;
            response.end(
              JSON.stringify({
                ...result,
                acknowledged: result.acknowledged.slice(1),
              }),
            );
          } else response.end(JSON.stringify(result));
        }
      };
      if (drops.delete(route)) response.destroy();
      else if (holds.delete(route)) held.push(respond);
      else respond();
    })().catch(() => {
      failures.push("Loopback verification failed; private details withheld");
      if (!response.destroyed) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          '{"status":"unavailable","code":"STUDENT_SESSION_UNAVAILABLE"}',
        );
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  crypto = api.createStudentSessionCrypto({
    environment: "local",
    url: origin,
  });
  async function launch(mode = "normal", buildIdentity = "original-build") {
    const processChild = spawn(
      process.execPath,
      [bundle, "--worker", directory, origin, mode, buildIdentity],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: root,
          LC_ALL: "C",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      },
    );
    let sequence = 0;
    const pending = new Map();
    const events = new Map();
    const waiters = new Map();
    const lines = createInterface({ input: processChild.stdout });
    const exited = new Promise((resolve) => processChild.once("exit", resolve));
    processChild.stderr.resume();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.event) {
        const waiter = waiters.get(message.event);
        if (waiter) {
          waiters.delete(message.event);
          waiter(message);
        } else events.set(message.event, message);
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    const child = {
      async event(name) {
        if (events.has(name)) {
          const value = events.get(name);
          events.delete(name);
          return value;
        }
        return deadline(new Promise((resolve) => waiters.set(name, resolve)));
      },
      async command(operation, values = {}) {
        const id = ++sequence;
        const reply = new Promise((resolve) => pending.set(id, resolve));
        processChild.stdin.write(
          `${JSON.stringify({ id, operation, ...values })}\n`,
        );
        const result = await deadline(reply);
        check(
          !result.failed,
          "Synthetic worker command failed; private details withheld",
        );
        return result;
      },
      async kill() {
        if (processChild.exitCode === null && processChild.signalCode === null)
          processChild.kill("SIGKILL");
        await exited;
      },
    };
    children.push(child);
    await child.event("ready");
    return child;
  }
  return {
    root,
    directory,
    requests,
    receipts,
    evidenceReceipts,
    failures,
    readRecord,
    launch,
    drop: (route) => drops.add(route),
    hold: (route) => holds.add(route),
    release: () => held.splice(0).forEach((respond) => respond()),
    omitNextEvidenceAck: () => {
      omitEvidenceAck = true;
    },
    async advance(child, ms) {
      elapsed += ms;
      await child.command("advance", { ms });
    },
    async corrupt() {
      await fs.writeFile(
        path.join(directory, recordName),
        "EXPLICIT_SYNTHETIC_CORRUPT_RECORD",
        { mode: 0o600 },
      );
    },
  };
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned worker deadline exceeded")),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "real private boundary recovers lost join, reconnect and forfeit receipts across process restart",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    let child = await f.launch();
    assert.equal((await child.command("initialize")).view.phase, "entry");
    f.drop("join");
    assert.equal(
      (await child.command("join", { code })).view.phase,
      "unconfirmed",
    );
    const joinPending = await f.readRecord();
    const lock = await fs.stat(path.join(f.directory, lockName));
    await child.kill();
    child = await f.launch();
    assert.equal((await child.command("initialize")).view.phase, "unconfirmed");
    assert.equal((await child.command("retry")).view.phase, "active");
    const joins = f.requests.filter((request) => request.route === "join");
    assert.equal(joins.length, 2);
    same(
      joins[0].record.device,
      joins[1].record.device,
      "Restart replaced enrollment key material",
    );
    same(
      joins[1].record.pending,
      joinPending.pending,
      "Restart replaced exact pending join",
    );
    check(
      joins[0].body.deviceProof.challengeId !==
        joins[1].body.deviceProof.challengeId,
      "Bootstrap retry reused its old challenge",
    );
    const joined = await f.readRecord();
    same(
      joined.current.capabilityToken,
      joinPending.pending.candidates.capabilityToken,
      "Join promotion replaced its candidate",
    );
    await f.advance(child, 240_000);
    f.drop("reconnect");
    assert.equal((await child.command("refresh")).view.phase, "unconfirmed");
    const rotation = await f.readRecord();
    await child.kill();
    child = await f.launch();
    await child.command("initialize");
    assert.equal((await child.command("retry")).view.phase, "active");
    const reconnects = f.requests.filter(
      (request) => request.route === "reconnect",
    );
    assert.equal(reconnects.length, 2);
    same(
      reconnects[1].record.pending,
      rotation.pending,
      "Reconnect restart changed retained intent",
    );
    check(
      reconnects[1].body.deviceProof.counter >
        reconnects[0].body.deviceProof.counter,
      "Reconnect retry reused its reserved counter",
    );
    same(
      reconnects[0].result.capabilityExpiresAtMs,
      reconnects[1].result.capabilityExpiresAtMs,
      "Exact reconnect receipt extended expiry",
    );
    const rotated = await f.readRecord();
    same(
      rotated.current.capabilityToken,
      rotation.pending.candidates.capabilityToken,
      "Rotation promotion replaced its original candidate",
    );
    f.drop("forfeit");
    assert.equal((await child.command("forfeit")).view.phase, "unconfirmed");
    const forfeit = await f.readRecord();
    await child.kill();
    child = await f.launch();
    await child.command("initialize");
    const final = await child.command("retry");
    assert.equal(final.view.phase, "forfeited");
    const forfeits = f.requests.filter(
      (request) => request.route === "forfeit",
    );
    assert.equal(forfeits.length, 2);
    same(
      forfeits[1].record.pending,
      forfeit.pending,
      "Forfeit restart changed retained intent",
    );
    check(
      forfeits[1].body.deviceProof.counter >
        forfeits[0].body.deviceProof.counter,
      "Forfeit retry reused its reserved counter",
    );
    const terminal = await f.readRecord();
    check(
      terminal.terminal &&
        terminal.current === null &&
        terminal.pending === null,
      "Forfeit acknowledgement did not promote terminal state",
    );
    assert.equal(
      f.receipts.size,
      3,
      "Lost response created duplicate synthetic server transitions",
    );
    assert.equal(
      (await fs.stat(path.join(f.directory, lockName))).ino,
      lock.ino,
    );
    assert.equal(final.view.protection, "unavailable");
    assert.equal(final.view.calculatorEligible, false);
    assert.deepEqual(f.failures, []);
    assert.equal((await child.command("dispose")).result, true);
  },
);

test(
  "published reservation failure emits no HTTP until a greater counter is durably reserved",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    await f.advance(child, 15_000);
    const count = f.requests.length;
    await child.command("fail-next-write");
    await child.command("refresh");
    assert.equal(
      f.requests.length,
      count,
      "Unconfirmed native return allowed actual HTTP",
    );
    const uncertain = await f.readRecord();
    assert.equal(uncertain.lastReservedCounter, 1);
    assert.equal((await child.command("retry")).view.phase, "active");
    const sent = f.requests.findLast(
      (request) => request.route === "reconnect",
    );
    check(
      sent !== undefined,
      "Controlled retry did not perform the required renewal",
    );
    assert.equal(sent.route, "reconnect");
    assert.equal(
      f.requests.at(-1).route,
      "read",
      "Renewal did not issue the required fresh state read",
    );
    check(
      sent.body.deviceProof.counter > uncertain.lastReservedCounter,
      "Readback cleared uncertainty without a greater durable reservation",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real quarantine crash gap preserves native uncertainty and old bytes without a replacement admission",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    await f.corrupt();
    let child = await f.launch();
    assert.equal(
      (await child.command("initialize")).view.phase,
      "recovery_required",
    );
    await child.command("quarantine-only");
    await child.kill();
    child = await f.launch();
    assert.equal(
      (await child.command("initialize")).view.phase,
      "recovery_required",
    );
    await child.command("join", { code });
    assert.equal(
      f.requests.length,
      0,
      "Preserved artifact permitted initial-admission HTTP",
    );
    assert.equal(
      (await child.command("targeted", { code })).view.phase,
      "recovery_required",
    );
    assert.equal(
      f.requests.length,
      0,
      "Unreadable prior native state permitted a replacement admission",
    );
    assert.equal(
      await fs.readFile(
        path.join(f.directory, "student-session.quarantine.0"),
        "utf8",
      ),
      "EXPLICIT_SYNTHETIC_CORRUPT_RECORD",
    );
    assert.deepEqual(f.failures, []);
  },
);

async function engageEvidence(child) {
  const start = await child.command("engaging");
  assert.equal(start.result.status, "committed");
  assert.equal((await child.command("began")).result.status, "committed");
  assert.equal((await child.command("failure")).result.status, "committed");
  return start.result.attemptId;
}

test(
  "real native evidence survives lost reply and restart with original content, signer, receipts and greater shared counter",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    let child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    const attemptId = await engageEvidence(child);
    const original = await f.readRecord();
    f.drop("evidence");
    await child.command("flush");
    const pending = await f.readRecord();
    assert.equal(pending.evidence.pendingBatches.length, 1);
    assert.equal(pending.evidence.acknowledgments.length, 0);
    assert.equal(f.evidenceReceipts.size, 3);
    await child.kill();
    child = await f.launch("normal", "replacement-build");
    await child.command("initialize");
    await child.command("flush");
    const accepted = await f.readRecord();
    const exchanges = f.requests.filter(
      (request) => request.route === "evidence",
    );
    assert.equal(exchanges.length, 2);
    same(
      exchanges[0].body.facts,
      exchanges[1].body.facts,
      "Restart changed original immutable prefix",
    );
    same(
      exchanges[0].body.originBuild,
      exchanges[1].body.originBuild,
      "Uploader upgrade relabeled original build",
    );
    same(
      exchanges[1].body.originBuild,
      original.evidence.origins[0].originBuild,
      "Original engaging build was not retained",
    );
    same(
      exchanges[0].body.publicKey,
      exchanges[1].body.publicKey,
      "Retry replaced the original signer",
    );
    same(
      exchanges[0].body.batchDigest,
      exchanges[1].body.batchDigest,
      "Counter-only retry changed batch identity",
    );
    check(
      exchanges[1].body.deviceProof.counter >
        exchanges[0].body.deviceProof.counter,
      "Retry reused common counter",
    );
    same(
      exchanges[0].result.acknowledged,
      exchanges[1].result.acknowledged,
      "Lost reply recovery replaced receipt times",
    );
    assert.equal(accepted.evidence.pendingBatches.length, 0);
    assert.equal(accepted.evidence.acknowledgments.length, 3);
    same(
      accepted.nativeProtection.facts,
      original.nativeProtection.facts,
      "Acknowledgment pruned retained latest facts",
    );
    assert.equal(accepted.nativeProtection.latestAttempt.attemptId, attemptId);
    assert.equal(f.evidenceReceipts.size, 3);
    await child.kill();
    child = await f.launch();
    await child.command("initialize");
    await child.command("flush");
    assert.equal(
      f.requests.filter((request) => request.route === "evidence").length,
      2,
      "Durable ACK was lost on restart",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real native evidence retains the frozen prefix on partial ACK and authors later terminal facts outside it",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    await engageEvidence(child);
    f.omitNextEvidenceAck();
    await child.command("flush");
    const unconfirmed = await f.readRecord();
    assert.equal(unconfirmed.evidence.acknowledgments.length, 0);
    const frozen = unconfirmed.evidence.pendingBatches[0];
    assert.equal((await child.command("terminal")).result.status, "committed");
    assert.equal((await child.command("cleanup")).result.status, "committed");
    const extended = await f.readRecord();
    same(
      extended.evidence.pendingBatches[0],
      frozen,
      "Late native facts replaced a pending prefix",
    );
    assert.equal(extended.nativeProtection.facts.length, 5);
    await f.advance(child, 15_000);
    await child.command("refresh");
    await child.command("flush");
    let exchanges = f.requests.filter(
      (request) => request.route === "evidence",
    );
    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[1].body.facts.length, 3);
    same(
      exchanges[1].body.batchDigest,
      exchanges[0].body.batchDigest,
      "Partial ACK retry changed frozen content",
    );
    await f.advance(child, 15_000);
    await child.command("refresh");
    await child.command("flush");
    exchanges = f.requests.filter((request) => request.route === "evidence");
    assert.equal(exchanges.length, 3);
    assert.equal(exchanges[2].body.facts.length, 5);
    assert.equal((await f.readRecord()).evidence.acknowledgments.length, 5);
    assert.equal(f.evidenceReceipts.size, 5);
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real targeted replacement retains the old evidence owner and binds new facts to the new admitted device",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    let child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    const oldAttempt = await engageEvidence(child);
    await child.command("terminal");
    await child.command("cleanup");
    await child.command("forfeit");
    const old = await f.readRecord();
    await child.command("targeted", { code });
    const replaced = await f.readRecord();
    check(
      replaced.device.deviceSessionId !== old.device.deviceSessionId,
      "Targeted recovery reused old device",
    );
    same(
      replaced.evidence.retiredSigners[0].device,
      old.device,
      "Targeted replacement lost original encrypted signer",
    );
    assert.equal(
      replaced.evidence.retiredSigners[0].lastReservedCounter,
      old.lastReservedCounter,
    );
    await child.kill();
    child = await f.launch("normal", "replacement-build");
    await child.command("initialize");
    await child.command("retry");
    const newAttempt = await engageEvidence(child);
    await child.command("flush");
    await f.advance(child, 15_000);
    await child.command("refresh");
    await child.command("flush");
    const exchanges = f.requests.filter(
      (request) => request.route === "evidence",
    );
    assert.equal(exchanges.length, 2);
    const oldReport = exchanges.find(
      (request) => request.body.facts[0].attemptId === oldAttempt,
    );
    const newReport = exchanges.find(
      (request) => request.body.facts[0].attemptId === newAttempt,
    );
    check(
      oldReport !== undefined && newReport !== undefined,
      "Bounded signer scheduling starved an original owner",
    );
    same(
      oldReport.body.publicKey,
      old.device.publicKey,
      "Replacement key signed historical facts",
    );
    same(
      oldReport.body.scope,
      old.nativeProtection.latestAttempt.scope,
      "Old evidence adopted replacement scope",
    );
    same(
      oldReport.body.originBuild,
      old.evidence.origins[0].originBuild,
      "Old evidence adopted replacement build",
    );
    same(
      newReport.body.publicKey,
      replaced.device.publicKey,
      "New facts did not use current admitted key",
    );
    check(
      newReport.body.scope.epoch !== oldReport.body.scope.epoch,
      "Readmission did not separate evidence epochs",
    );
    check(
      newReport.body.originBuild.identity.buildId !==
        oldReport.body.originBuild.identity.buildId,
      "Fresh attempt did not capture current build",
    );
    const final = await f.readRecord();
    assert.equal(final.nativeProtection.latestAttempt.attemptId, newAttempt);
    check(
      final.nativeProtection.facts.every(
        (fact) => fact.attemptId === newAttempt,
      ),
      "Exactly acknowledged completed history was not wholly pruned",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real native lost ACK publication is reconciled after restart without losing receipts or latest facts",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    let child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    await engageEvidence(child);
    const original = await f.readRecord();
    f.hold("evidence");
    const uploading = child.command("flush");
    await eventually(async () =>
      f.requests.some((request) => request.route === "evidence"),
    );
    await child.command("fail-next-write");
    f.release();
    await uploading;
    const published = await f.readRecord();
    assert.equal(published.evidence.acknowledgments.length, 3);
    assert.equal(published.evidence.pendingBatches.length, 0);
    same(
      published.nativeProtection.facts,
      original.nativeProtection.facts,
      "Uncertain ACK write altered latest facts",
    );
    check(
      (await child.command("state")).view.phase !== "active",
      "Unknown native return was presented as successful authority",
    );
    await child.kill();
    child = await f.launch();
    await child.command("initialize");
    await child.command("flush");
    assert.equal(
      f.requests.filter((request) => request.route === "evidence").length,
      1,
      "Published exact ACK was not recovered",
    );
    same(
      (await f.readRecord()).evidence.acknowledgments,
      published.evidence.acknowledgments,
      "Restart altered original receipts",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "evidence waits for the actual native return barrier and a held upload preserves queued terminal facts",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch();
    await child.command("initialize");
    await child.command("join", { code });
    await engageEvidence(child);
    const count = f.requests.length;
    await child.command("block-next-write");
    f.hold("evidence");
    const uploading = child.command("flush");
    await child.event("published-return-blocked");
    const reserved = await f.readRecord();
    assert.equal(reserved.evidence.pendingBatches.length, 1);
    assert.equal(
      f.requests.length,
      count,
      "Physical publication without native return permitted evidence HTTP",
    );
    const contender = await f.launch();
    assert.equal(
      (await contender.command("initialize")).view.phase,
      "unavailable",
    );
    await child.command("release-write");
    await eventually(async () => f.requests.length === count + 1);
    const terminal = child.command("terminal");
    await child.command("state");
    same(
      (await f.readRecord()).nativeProtection.facts,
      reserved.nativeProtection.facts,
      "Queued terminal transition overwrote the active evidence owner",
    );
    f.release();
    await uploading;
    assert.equal((await terminal).result.status, "committed");
    const after = await f.readRecord();
    assert.equal(after.evidence.acknowledgments.length, 3);
    assert.equal(after.evidence.pendingBatches.length, 0);
    assert.equal(after.nativeProtection.facts.at(-1).nativeEvent, "did_end");
    assert.equal(after.nativeProtection.facts.length, 4);
    assert.equal(after.lastReservedCounter, reserved.lastReservedCounter);
    assert.deepEqual(f.failures, []);
  },
);

test(
  "held real evidence upload keeps the native owner through timeout, queued terminal work and failed shutdown drain",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch("ignore-abort");
    await child.command("initialize");
    await child.command("join", { code });
    await engageEvidence(child);
    f.hold("evidence");
    const uploading = child.command("flush");
    await eventually(async () =>
      f.requests.some((request) => request.route === "evidence"),
    );
    const reserved = await f.readRecord();
    const terminal = child.command("terminal");
    assert.equal((await child.command("state")).closes, 0);
    const contender = await f.launch();
    assert.equal(
      (await contender.command("initialize")).view.phase,
      "unavailable",
    );
    assert.equal((await child.command("dispose")).result, false);
    await uploading;
    assert.equal((await terminal).result.status, "unavailable");
    assert.equal((await child.command("state")).closes, 0);
    same(
      await f.readRecord(),
      reserved,
      "Stopped upload published ACK or queued terminal facts",
    );
    f.release();
    await eventually(async () => (await child.command("state")).idle);
    assert.equal(
      (await child.command("state")).closes,
      0,
      "Failed drain released ownership after a late response",
    );
    same(
      await f.readRecord(),
      reserved,
      "Late settled response published after disposal",
    );
    await child.kill();
    const successor = await f.launch();
    assert.equal(
      (await successor.command("initialize")).view.phase,
      "unconfirmed",
    );
    await successor.command("flush");
    assert.equal((await f.readRecord()).evidence.pendingBatches.length, 0);
    assert.deepEqual(f.failures, []);
  },
);

test(
  "whole-intent shutdown retains the actual lock across the durable-return to transport gap",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch();
    await child.command("initialize");
    await child.command("block-next-write");
    const joining = child.command("join", { code });
    await child.event("published-return-blocked");
    const disposal = child.command("dispose");
    assert.equal((await child.command("state")).closes, 0);
    const contender = await f.launch();
    assert.equal(
      (await contender.command("initialize")).view.phase,
      "unavailable",
    );
    assert.equal(f.requests.length, 0);
    await child.command("release-write");
    await joining;
    assert.equal((await disposal).result, true);
    assert.equal((await child.command("state")).closes, 1);
    assert.equal(
      f.requests.length,
      0,
      "Stopped intent continued into actual transport",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "unsettled abort-ignoring real HTTP prevents retries, store reopening and lock release",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch("ignore-abort");
    await child.command("initialize");
    f.hold("challenge");
    assert.equal(
      (await child.command("join", { code })).view.phase,
      "unconfirmed",
    );
    const before = await child.command("state");
    check(
      !before.idle,
      "Real held exchange was incorrectly marked settled at caller timeout",
    );
    const record = await f.readRecord();
    await child.command("fail-next-write");
    await child.command("retry");
    await child.command("refresh");
    await child.command("targeted", { code });
    const blocked = await child.command("state");
    assert.equal(blocked.writes, before.writes);
    assert.equal(blocked.closes, 0);
    same(
      await f.readRecord(),
      record,
      "Unsettled HTTP allowed store mutation/reopen",
    );
    assert.equal(f.requests.length, 1);
    const contender = await f.launch();
    assert.equal(
      (await contender.command("initialize")).view.phase,
      "unavailable",
    );
    f.release();
    await eventually(async () => (await child.command("state")).idle);
    await child.command("retry"); // Only settled HTTP permits the queued synthetic return failure.
    assert.equal((await child.command("state")).closes, 0);
    assert.equal((await child.command("retry")).view.phase, "active");
    check(
      (await child.command("state")).closes > 0,
      "Settled transport did not permit controlled native reopen",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "failed real HTTP shutdown drain keeps the native lock until owner process exit",
  macOnly,
  async (t) => {
    const f = await fixture(t);
    const child = await f.launch("ignore-abort");
    await child.command("initialize");
    f.hold("challenge");
    const joining = child.command("join", { code });
    await eventually(async () => f.requests.length === 1);
    assert.equal((await child.command("dispose")).result, false);
    await joining;
    assert.equal((await child.command("state")).closes, 0);
    const contender = await f.launch();
    assert.equal(
      (await contender.command("initialize")).view.phase,
      "unavailable",
    );
    f.release();
    await eventually(async () => (await child.command("state")).idle);
    assert.equal(
      (await child.command("state")).closes,
      0,
      "A failed shutdown later released ownership implicitly",
    );
    await child.kill();
    const successor = await f.launch();
    assert.equal(
      (await successor.command("initialize")).view.phase,
      "unconfirmed",
    );
    assert.deepEqual(f.failures, []);
  },
);

async function eventually(predicate) {
  const until = performance.now() + 2_000;
  while (!(await predicate())) {
    check(performance.now() < until, "Owned boundary did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
