import { describe, expect, it, vi } from "vitest";

import {
  parseIssueTestJoinCodeRequest,
  parseIssueTestJoinCodeRpcResult,
  parseNativeProtectionEvidenceSummary,
  parsePrepareStudentReadmissionRequest,
  parsePrepareStudentReadmissionRpcResult,
  parseReadStudentSessionsRequest,
  parseReadStudentSessionsRpcResult,
  parseRemoveStudentSessionRequest,
  parseRemoveStudentSessionRpcResult,
  parseStaffStudentSession,
  parseStaffStudentSessionPage,
  parseStudentBootstrapProof,
  parseStudentChallengeRequest,
  parseStudentChallengeResult,
  parseStudentCounter,
  parseStudentDigest,
  parseStudentForfeitRequest,
  parseStudentForfeitResult,
  parseStudentJoinCode,
  parseStudentJoinRequest,
  parseStudentJoinResult,
  parseStudentMaintenanceProof,
  parseStudentPublicKey,
  parseStudentReadRequest,
  parseStudentReadResult,
  parseStudentReconnectRequest,
  parseStudentReconnectResult,
  parseStudentSecret,
  parseStudentSessionFailure,
  parseStudentSessionPageCursor,
  parseStudentSessionScope,
  parseStudentSessionViewState,
  parseStudentSignature,
  parseStudentTimestamp,
  parseStudentUuid,
} from "../src/student-session.js";
import type {
  IssueTestJoinCodeRequest,
  PrepareStudentReadmissionRequest,
  ReadStudentSessionsRequest,
  RemoveStudentSessionRequest,
  StaffStudentSession,
  StudentForfeitRequest,
  StudentJoinAccepted,
  StudentJoinRequest,
  StudentReadAccepted,
  StudentReadRequest,
  StudentReconnectRequest,
  StudentSessionScope,
  StudentSessionViewState,
} from "../src/student-session.js";

const uuid = (index: number): string =>
  `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const requestId = uuid(1);
const schoolId = uuid(2);
const testId = uuid(3);
const studentSessionId = uuid(4);
const deviceSessionId = uuid(5);
const challengeId = uuid(6);
const secret = "A".repeat(43);
const signature = "A".repeat(86);
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const joinCode = "0123456789AB";
const createdAt = "2026-09-08T10:20:30.123456Z";
const scope: StudentSessionScope = {
  schoolId,
  testId,
  studentSessionId,
  deviceSessionId,
  epoch: 1,
};
const bootstrap = {
  challengeId,
  expiresAtMs: 15_000,
  publicKey: secret,
  signature,
};
const proof = { counter: 1, signature };
const join: StudentJoinRequest = {
  admissionMode: "initial",
  requestId,
  deviceSessionId,
  joinCode,
  capabilityDigest: digest,
  reconnectDigest: otherDigest,
  deviceProof: bootstrap,
};
const read: StudentReadRequest = {
  requestId,
  scope,
  capabilityToken: secret,
  deviceProof: proof,
};
const reconnect: StudentReconnectRequest = {
  requestId,
  scope,
  expectedSessionRevision: 1,
  reconnectGrant: secret,
  nextCapabilityDigest: digest,
  nextReconnectDigest: otherDigest,
  deviceProof: proof,
};
const forfeit: StudentForfeitRequest = { ...read, expectedSessionRevision: 1 };
const accepted: StudentJoinAccepted = {
  status: "accepted",
  code: "STUDENT_SESSION_ACCEPTED",
  requestId,
  logicalOperationDigest: digest,
  scope,
  sessionRevision: 1,
  syntheticDisplayName: "Student A1",
  serverNowMs: 1_000,
  capabilityIssuedAtMs: 1_000,
  capabilityExpiresAtMs: 301_000,
  reconnectExpiresAtMs: 901_000,
  allowedIntents: ["state.read", "session.forfeit"],
};
const current: StudentReadAccepted = {
  status: "accepted",
  code: "STUDENT_SESSION_CURRENT",
  requestId,
  acceptedProofCounter: 1,
  scope,
  sessionRevision: 1,
  syntheticDisplayName: "Student A1",
  testLifecycle: "open",
  state: "active",
  serverNowMs: 1_000,
  capabilityExpiresAtMs: 301_000,
};
const list: ReadStudentSessionsRequest = { schoolId, testId, before: null };
const issue: IssueTestJoinCodeRequest = {
  schoolId,
  testId,
  expectedTestRevision: 1,
  issuanceRequestId: requestId,
  joinMaterialDigest: digest,
};
const remove: RemoveStudentSessionRequest = {
  schoolId,
  testId,
  studentSessionId,
  expectedSessionRevision: 1,
};
const prepare: PrepareStudentReadmissionRequest = {
  ...remove,
  issuanceRequestId: requestId,
  joinMaterialDigest: digest,
};
const staffSession: StaffStudentSession = {
  id: studentSessionId,
  schoolId,
  testId,
  syntheticDisplayName: "Student A1",
  state: "active",
  epoch: 1,
  revision: 1,
  createdAt,
  evidenceSummary: {
    reportCount: 0,
    failureCount: 0,
    latestReceivedAt: null,
    latestReportedEpoch: null,
  },
};
const view: StudentSessionViewState = {
  revision: 0,
  phase: "entry",
  session: null,
  protection: "unavailable",
  calculatorEligible: false,
  pendingOperation: null,
};

describe("historical native evidence summary", () => {
  it("requires an exact honest empty or received-report summary", () => {
    const empty = staffSession.evidenceSummary;
    expect(parseNativeProtectionEvidenceSummary(empty)).toEqual(empty);
    const received = {
      reportCount: 3,
      failureCount: 2,
      latestReceivedAt: createdAt,
      latestReportedEpoch: 1,
    };
    expect(
      parseStaffStudentSession({
        ...staffSession,
        epoch: 2,
        evidenceSummary: received,
      })?.evidenceSummary,
    ).toEqual(received);
    expect(
      parseStaffStudentSession({
        ...staffSession,
        evidenceSummary: { ...received, latestReportedEpoch: 2 },
      }),
    ).toBeNull();
    for (const invalid of [
      { ...empty, reportCount: -0 },
      { ...empty, reportCount: -1 },
      { ...empty, failureCount: 1 },
      { ...empty, latestReceivedAt: createdAt },
      { ...empty, latestReportedEpoch: 1 },
      { ...received, reportCount: 0 },
      { ...received, failureCount: 4 },
      { ...received, reportCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...received, latestReceivedAt: null },
      { ...received, latestReportedEpoch: null },
      { ...received, protected: true },
    ])
      expect(parseNativeProtectionEvidenceSummary(invalid)).toBeNull();
    expect(
      parseStaffStudentSession({ ...staffSession, evidenceSummary: undefined }),
    ).toBeNull();
  });
});

function sqlRow(
  session: StaffStudentSession = staffSession,
): Record<string, unknown> {
  return {
    code: "ok",
    session_id: session.id,
    school_id: session.schoolId,
    test_id: session.testId,
    synthetic_display_name: session.syntheticDisplayName,
    state: session.state,
    epoch: session.epoch,
    session_revision: session.revision,
    created_at: session.createdAt,
    evidence_summary: session.evidenceSummary,
  };
}
function mutationRow(
  code: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    test_id: null,
    session_id: null,
    session_revision: null,
    test_revision: null,
    epoch: null,
    expires_at: null,
    ...fields,
  };
}
function listFailure(code: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(sqlRow()).map((key) => [key, key === "code" ? code : null]),
  );
}

describe("canonical student scalar boundaries", () => {
  it("accepts only encodings with zero trailing base64url bits", () => {
    for (const last of "AEIMQUYcgkosw048") {
      expect(parseStudentSecret("A".repeat(42) + last)).not.toBeNull();
      expect(parseStudentPublicKey("A".repeat(42) + last)).not.toBeNull();
    }
    for (const last of "AQgw")
      expect(parseStudentSignature("A".repeat(85) + last)).not.toBeNull();
    for (const value of [
      "A".repeat(42) + "B",
      secret + "=",
      secret.slice(1),
      secret + "\n",
      secret.replace("A", "+"),
      secret.replace("A", "/"),
      null,
      1,
      new String(secret),
    ]) {
      expect(parseStudentSecret(value)).toBeNull();
      expect(parseStudentPublicKey(value)).toBeNull();
    }
    for (const value of [
      "A".repeat(85) + "B",
      "A".repeat(85) + "E",
      signature + "==",
      signature + "\n",
      signature.slice(1),
    ])
      expect(parseStudentSignature(value)).toBeNull();
  });
  it("refuses identifier/digest normalization and unsafe numbers", () => {
    expect(parseStudentUuid(uuid(10))).toBe(uuid(10));
    expect(parseStudentDigest(digest)).toBe(digest);
    for (const value of [
      uuid(10).toUpperCase(),
      uuid(10) + "\n",
      "10000000-0000-0000-8000-000000000001",
      "10000000-0000-4000-7000-000000000001",
      null,
    ])
      expect(parseStudentUuid(value)).toBeNull();
    for (const value of [
      digest.toUpperCase(),
      digest + "\n",
      digest.slice(1),
      "g".repeat(64),
      null,
    ])
      expect(parseStudentDigest(value)).toBeNull();
    for (const value of [
      0,
      -0,
      -1,
      1.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      null,
    ])
      expect(parseStudentCounter(value)).toBeNull();
    expect(parseStudentCounter(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it("requires twelve canonical Crockford characters without mode inference", () => {
    expect(parseStudentJoinCode(joinCode)).toBe(joinCode);
    expect(parseStudentJoinCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
    for (const value of [
      joinCode.toLowerCase(),
      "0123456789AI",
      "0123456789AL",
      "0123456789AO",
      "0123456789AU",
      "012345-6789AB",
      "123456",
      joinCode + "\n",
      ` ${joinCode}`,
    ])
      expect(parseStudentJoinCode(value)).toBeNull();
    expect(parseStudentJoinRequest(join)).toEqual(join);
    expect(
      parseStudentJoinRequest({ ...join, admissionMode: "readmission" })
        ?.admissionMode,
    ).toBe("readmission");
    expect(
      parseStudentJoinRequest({ ...join, admissionMode: undefined }),
    ).toBeNull();
    expect(
      parseStudentJoinRequest({ ...join, admissionMode: "automatic" }),
    ).toBeNull();
  });
  it("preserves all timestamp bytes and rejects anchor-newline and calendar aliases", () => {
    expect(parseStudentTimestamp(createdAt)).toBe(createdAt);
    expect(parseStudentTimestamp("2000-02-29T00:00:00.000001Z")).not.toBeNull();
    for (const value of [
      createdAt + "\n",
      createdAt + "\r",
      createdAt + "\u2028",
      createdAt + "\u2029",
      "2026-09-08T10:20:30.123Z",
      "1900-02-29T00:00:00.000000Z",
      "2026-04-31T00:00:00.000000Z",
      "2026-09-08T10:20:30.123456+00:00",
    ])
      expect(parseStudentTimestamp(value)).toBeNull();
  });
});

describe("exact own-data request and projection snapshots", () => {
  const cases = [
    { name: "scope", parse: parseStudentSessionScope, value: scope },
    { name: "bootstrap", parse: parseStudentBootstrapProof, value: bootstrap },
    { name: "maintenance", parse: parseStudentMaintenanceProof, value: proof },
    {
      name: "challenge",
      parse: parseStudentChallengeRequest,
      value: {
        requestId,
        deviceSessionId,
        publicKey: secret,
        logicalOperationDigest: digest,
      },
    },
    { name: "join", parse: parseStudentJoinRequest, value: join },
    { name: "read", parse: parseStudentReadRequest, value: read },
    {
      name: "reconnect",
      parse: parseStudentReconnectRequest,
      value: reconnect,
    },
    { name: "forfeit", parse: parseStudentForfeitRequest, value: forfeit },
    {
      name: "staff session",
      parse: parseStaffStudentSession,
      value: staffSession,
    },
    {
      name: "staff cursor",
      parse: parseStudentSessionPageCursor,
      value: { createdAt, sessionId: studentSessionId },
    },
    { name: "staff list", parse: parseReadStudentSessionsRequest, value: list },
    { name: "staff issue", parse: parseIssueTestJoinCodeRequest, value: issue },
    {
      name: "staff remove",
      parse: parseRemoveStudentSessionRequest,
      value: remove,
    },
    {
      name: "staff prepare",
      parse: parsePrepareStudentReadmissionRequest,
      value: prepare,
    },
    { name: "view", parse: parseStudentSessionViewState, value: view },
  ];
  it.each(cases)(
    "rejects extra/missing/inherited/accessor/hostile properties for $name",
    ({ parse, value }) => {
      expect(parse(value)).toEqual(value);
      expect(parse(Object.assign(Object.create(null), value))).toEqual(value);
      for (const bad of [
        null,
        [],
        { ...value, verified: true },
        { ...value, [Symbol("extra")]: true },
        Object.assign(Object.create({ inherited: true }), value),
      ])
        expect(parse(bad)).toBeNull();
      for (const key of Object.keys(value)) {
        const missing: Record<string, unknown> = { ...value };
        delete missing[key];
        expect(parse(missing)).toBeNull();
        const getter = vi.fn(() => Reflect.get(value, key));
        expect(
          parse(
            Object.defineProperty({ ...value }, key, {
              get: getter,
              enumerable: true,
            }),
          ),
        ).toBeNull();
        expect(getter).not.toHaveBeenCalled();
        expect(
          parse(
            Object.defineProperty({ ...value }, key, { enumerable: false }),
          ),
        ).toBeNull();
      }
      expect(
        parse(
          new Proxy(value, {
            ownKeys() {
              throw new Error("hostile");
            },
          }),
        ),
      ).toBeNull();
      const get = vi.fn(() => {
        throw new Error("property read");
      });
      expect(parse(new Proxy(value, { get }))).toEqual(value);
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("takes detached nested snapshots and does not admit proof or scope substitution fields", () => {
    const input = { ...read, scope: { ...scope }, deviceProof: { ...proof } };
    const result = parseStudentReadRequest(input);
    input.scope.epoch = 2;
    input.deviceProof.counter = 2;
    expect(result).toEqual(read);
    expect(
      parseStudentReadRequest({ ...read, deviceProof: bootstrap }),
    ).toBeNull();
    expect(parseStudentJoinRequest({ ...join, deviceProof: proof })).toBeNull();
    expect(
      parseStudentReadRequest({
        ...read,
        deviceProof: { ...proof, publicKey: secret },
      }),
    ).toBeNull();
    expect(parseStudentJoinRequest({ ...join, schoolId })).toBeNull();
    expect(parseStudentJoinRequest({ ...join, studentSessionId })).toBeNull();
  });
  it("keeps renderer projection nonsecret and never claims protection or calculator eligibility", () => {
    const own = {
      syntheticDisplayName: "Student A1",
      sessionRevision: 1,
      capabilityExpiresAtMs: 301_000,
    };
    expect(
      parseStudentSessionViewState({ ...view, phase: "active", session: own }),
    ).not.toBeNull();
    for (const fields of [
      { protection: "locked" },
      { calculatorEligible: true },
      { phase: "active" },
      { phase: "released" },
      { session: { ...own, scope } },
      { session: { ...own, capabilityToken: secret } },
      { session: { ...own, syntheticDisplayName: "Student A1\n" } },
      { session: { ...own, syntheticDisplayName: "Student A1\u2028" } },
    ])
      expect(parseStudentSessionViewState({ ...view, ...fields })).toBeNull();
  });
});

describe("public result authority bindings", () => {
  it("uses only exact generic denials/dependency failures on every endpoint", () => {
    const parsers = [
      parseStudentChallengeResult,
      (value: unknown) => parseStudentJoinResult(value, join, digest),
      (value: unknown) => parseStudentReadResult(value, read, 301_000),
      (value: unknown) => parseStudentReconnectResult(value, reconnect, digest),
      (value: unknown) => parseStudentForfeitResult(value, forfeit),
    ];
    for (const failure of [
      { status: "denied", code: "STUDENT_SESSION_DENIED" },
      { status: "unavailable", code: "STUDENT_SESSION_UNAVAILABLE" },
    ]) {
      expect(parseStudentSessionFailure(failure)).toEqual(failure);
      for (const parse of parsers) {
        expect(parse(failure)).toEqual(failure);
        expect(parse({ ...failure, scope })).toBeNull();
        expect(parse({ ...failure, reason: "removed" })).toBeNull();
        expect(
          parse({ ...failure, code: failure.code.toLowerCase() }),
        ).toBeNull();
        expect(parse({ ...failure, status: "accepted" })).toBeNull();
      }
    }
    expect(
      parseStudentForfeitResult(
        { status: "denied", code: "STUDENT_SESSION_DENIED" },
        forfeit,
      ),
    ).not.toHaveProperty("released");
  });
  it("validates challenge shape without guessing server age from a local clock", () => {
    expect(
      parseStudentChallengeResult({ challengeId, expiresAtMs: 1 }),
    ).toEqual({ challengeId, expiresAtMs: 1 });
    expect(
      parseStudentChallengeResult({
        challengeId,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toBeNull();
    for (const value of [
      { challengeId, expiresAtMs: 0 },
      { challengeId, expiresAtMs: -1 },
      { challengeId, expiresAtMs: 1.5 },
      { challengeId, expiresAtMs: 1, status: "accepted" },
      { challengeId, expiresAtMs: 1, schoolId },
    ])
      expect(parseStudentChallengeResult(value)).toBeNull();
  });
  it("binds admission receipt request, commitment, device and explicit mode", () => {
    expect(parseStudentJoinResult(accepted, join, digest)).toEqual(accepted);
    for (const fields of [
      { requestId: uuid(7) },
      { logicalOperationDigest: otherDigest },
      { scope: { ...scope, deviceSessionId: uuid(7) } },
      { scope: { ...scope, epoch: 2 } },
      { sessionRevision: 2 },
      { allowedIntents: ["state.read", "session.forfeit", "calculator.write"] },
      { allowedIntents: ["session.forfeit", "state.read"] },
      { allowedIntents: ["state.read"] },
      { code: "student_session_accepted" },
      { capabilityToken: secret },
    ])
      expect(
        parseStudentJoinResult({ ...accepted, ...fields }, join, digest),
      ).toBeNull();
    expect(
      parseStudentJoinResult(
        accepted,
        { ...join, admissionMode: "readmission" },
        digest,
      ),
    ).toBeNull();
    const targeted = {
      ...accepted,
      scope: { ...scope, epoch: 2 },
      sessionRevision: 3,
    };
    expect(
      parseStudentJoinResult(
        targeted,
        { ...join, admissionMode: "readmission" },
        digest,
      ),
    ).toEqual(targeted);
    expect(
      parseStudentJoinResult(
        targeted,
        { ...join, admissionMode: "readmission" },
        otherDigest,
      ),
    ).toBeNull();
    expect(
      parseStudentJoinResult(
        accepted,
        Object.assign({ ...join }, { verified: true }),
        digest,
      ),
    ).toBeNull();
  });
  it("allows original expired access receipts only while original refresh remains live", () => {
    for (const serverNowMs of [301_000, 900_999]) {
      const receipt = { ...accepted, serverNowMs };
      expect(parseStudentJoinResult(receipt, join, digest)).toEqual(receipt);
      expect(
        parseStudentReconnectResult(
          { ...receipt, sessionRevision: 2, acceptedProofCounter: 1 },
          reconnect,
          digest,
        ),
      ).not.toBeNull();
    }
    for (const fields of [
      { serverNowMs: 901_000 },
      { serverNowMs: 999 },
      { capabilityExpiresAtMs: 1_000 },
      { capabilityExpiresAtMs: 301_001 },
      { reconnectExpiresAtMs: 901_001 },
      { reconnectExpiresAtMs: 300_000 },
      { capabilityIssuedAtMs: -1 },
      { serverNowMs: Number.POSITIVE_INFINITY },
      { reconnectExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        parseStudentJoinResult({ ...accepted, ...fields }, join, digest),
      ).toBeNull();
    expect(
      parseStudentReadResult(
        { ...current, serverNowMs: 301_000 },
        read,
        301_000,
      ),
    ).toBeNull();
    expect(
      parseStudentReadResult(
        { ...current, capabilityExpiresAtMs: 301_001 },
        read,
        301_000,
      ),
    ).toBeNull();
  });
  it("binds maintenance replies to all scope fields, request, counter and revision", () => {
    const rotation = {
      ...accepted,
      sessionRevision: 2,
      acceptedProofCounter: 1,
    };
    expect(parseStudentReconnectResult(rotation, reconnect, digest)).toEqual(
      rotation,
    );
    expect(parseStudentReadResult(current, read, 301_000)).toEqual(current);
    for (const key of [
      "schoolId",
      "testId",
      "studentSessionId",
      "deviceSessionId",
      "epoch",
    ]) {
      const changed = { ...scope, [key]: key === "epoch" ? 2 : uuid(20) };
      expect(
        parseStudentReconnectResult(
          { ...rotation, scope: changed },
          reconnect,
          digest,
        ),
      ).toBeNull();
      expect(
        parseStudentReadResult({ ...current, scope: changed }, read, 301_000),
      ).toBeNull();
    }
    for (const fields of [
      { requestId: uuid(20) },
      { acceptedProofCounter: 2 },
      { acceptedProofCounter: 0 },
      { code: "STUDENT_SESSION_FORFEITED" },
    ]) {
      expect(
        parseStudentReadResult({ ...current, ...fields }, read, 301_000),
      ).toBeNull();
      expect(
        parseStudentReconnectResult(
          { ...rotation, ...fields },
          reconnect,
          digest,
        ),
      ).toBeNull();
    }
    expect(
      parseStudentReconnectResult(
        { ...rotation, sessionRevision: 3 },
        reconnect,
        digest,
      ),
    ).toBeNull();
    expect(
      parseStudentReconnectResult(
        rotation,
        { ...reconnect, expectedSessionRevision: Number.MAX_SAFE_INTEGER },
        digest,
      ),
    ).toBeNull();
    expect(
      parseStudentReadResult({ ...current, state: "removed" }, read, 301_000),
    ).toBeNull();
    expect(
      parseStudentReadResult(
        { ...current, testLifecycle: "ended" },
        read,
        301_000,
      ),
    ).toBeNull();
    const acknowledgment = {
      status: "accepted",
      code: "STUDENT_SESSION_FORFEITED",
      requestId,
      acceptedProofCounter: 1,
    };
    expect(parseStudentForfeitResult(acknowledgment, forfeit)).toEqual(
      acknowledgment,
    );
    expect(
      parseStudentForfeitResult(
        { ...acknowledgment, acceptedProofCounter: 2 },
        forfeit,
      ),
    ).toBeNull();
    expect(
      parseStudentForfeitResult(
        { ...acknowledgment, requestId: uuid(20) },
        forfeit,
      ),
    ).toBeNull();
    expect(
      parseStudentForfeitResult({ ...acknowledgment, released: true }, forfeit),
    ).toBeNull();
    expect(
      parseStudentForfeitResult(acknowledgment, {
        ...forfeit,
        expectedSessionRevision: Number.MAX_SAFE_INTEGER,
      }),
    ).toBeNull();
    expect(
      parseStudentForfeitResult(acknowledgment, {
        ...forfeit,
        scope: { ...scope, epoch: Number.MAX_SAFE_INTEGER },
      }),
    ).toBeNull();
  });
});

describe("native-microsecond staff pagination", () => {
  it("uses the fiftieth displayed full tuple and validates the lookahead row", () => {
    const sessions = Array.from(
      { length: 55 },
      (_, index): StaffStudentSession => ({
        ...staffSession,
        id: uuid(100 - index),
        createdAt: `2026-09-08T10:20:30.${String(900 - Math.floor(index / 3)).padStart(6, "0")}Z`,
      }),
    );
    const first = parseReadStudentSessionsRpcResult(
      sessions.slice(0, 51).map(sqlRow),
      list,
    );
    if (!first?.ok) throw new Error("Expected first page");
    expect(first.page.items).toEqual(sessions.slice(0, 50));
    expect(first.page.nextCursor).toEqual({
      createdAt: sessions[49]?.createdAt,
      sessionId: sessions[49]?.id,
    });
    expect(first.page.nextCursor?.createdAt).toBe(sessions[50]?.createdAt);
    expect(parseStaffStudentSessionPage(first.page, list)).toEqual(first.page);
    expect(
      parseStaffStudentSessionPage(
        {
          ...first.page,
          nextCursor: {
            createdAt: sessions[50]?.createdAt,
            sessionId: sessions[50]?.id,
          },
        },
        list,
      ),
    ).toBeNull();
    expect(
      parseStaffStudentSessionPage(
        {
          items: [staffSession],
          nextCursor: { createdAt, sessionId: studentSessionId },
        },
        list,
      ),
    ).toBeNull();
    expect(
      parseStaffStudentSessionPage(
        { ...first.page, capabilityToken: secret },
        list,
      ),
    ).toBeNull();
    const second = parseReadStudentSessionsRpcResult(
      sessions.slice(50).map(sqlRow),
      { ...list, before: first.page.nextCursor },
    );
    if (!second?.ok) throw new Error("Expected second page");
    expect([...first.page.items, ...second.page.items]).toEqual(sessions);
    expect(second.page.nextCursor).toBeNull();
    expect(
      parseReadStudentSessionsRpcResult(
        sessions.slice(0, 52).map(sqlRow),
        list,
      ),
    ).toBeNull();
    const badLookahead = sessions.slice(0, 51).map(sqlRow);
    badLookahead[50] = { ...sqlRow(), school_id: uuid(999) };
    expect(parseReadStudentSessionsRpcResult(badLookahead, list)).toBeNull();
    expect(parseReadStudentSessionsRpcResult([], list)).toEqual({
      ok: true,
      page: { items: [], nextCursor: null },
    });
  });
  it("rejects duplicates, reordered tuples, foreign scope and cursor overlap", () => {
    const older = {
      ...staffSession,
      id: uuid(20),
      createdAt: "2026-09-08T10:20:30.123455Z",
    };
    expect(
      parseReadStudentSessionsRpcResult([sqlRow(older), sqlRow()], list),
    ).toBeNull();
    expect(
      parseReadStudentSessionsRpcResult(
        [sqlRow(), sqlRow({ ...older, id: studentSessionId })],
        list,
      ),
    ).toBeNull();
    expect(
      parseReadStudentSessionsRpcResult(
        [sqlRow(), sqlRow({ ...staffSession, id: uuid(20) })],
        list,
      ),
    ).toBeNull();
    expect(
      parseReadStudentSessionsRpcResult([sqlRow()], {
        ...list,
        before: { createdAt, sessionId: studentSessionId },
      }),
    ).toBeNull();
    expect(
      parseReadStudentSessionsRpcResult([sqlRow(older)], {
        ...list,
        before: { createdAt, sessionId: studentSessionId },
      })?.ok,
    ).toBe(true);
    for (const fields of [
      { school_id: uuid(20) },
      { test_id: uuid(20) },
      { created_at: createdAt + "\n" },
      { state: "created" },
      { state: "ended" },
      { state: "released" },
      { synthetic_display_name: "A real name" },
      { capability_digest: digest },
    ])
      expect(
        parseReadStudentSessionsRpcResult([{ ...sqlRow(), ...fields }], list),
      ).toBeNull();
    expect(
      parseReadStudentSessionsRequest({
        ...list,
        before: { createdAt: createdAt + "\n", sessionId: studentSessionId },
      }),
    ).toBeNull();
  });
  it("requires one exact all-null failure and rejects mixed results", () => {
    for (const code of [
      "email_unverified",
      "forbidden",
      "invalid_request",
      "membership_inactive",
      "session_expired",
      "session_revoked",
      "step_up_required",
      "unauthenticated",
      "dependency_unavailable",
      "test_unavailable",
    ]) {
      const failure = listFailure(code);
      expect(parseReadStudentSessionsRpcResult([failure], list)).toEqual({
        ok: false,
        code,
      });
      for (const key of Object.keys(failure).filter((key) => key !== "code"))
        expect(
          parseReadStudentSessionsRpcResult(
            [{ ...failure, [key]: "retained" }],
            list,
          ),
        ).toBeNull();
      expect(
        parseReadStudentSessionsRpcResult([failure, sqlRow()], list),
      ).toBeNull();
      expect(
        parseReadStudentSessionsRpcResult([sqlRow(), failure], list),
      ).toBeNull();
    }
    for (const code of [
      "unknown",
      "student_session_removed",
      "student_session_revision_conflict",
      "test_revision_conflict",
    ])
      expect(
        parseReadStudentSessionsRpcResult([listFailure(code)], list),
      ).toBeNull();
  });
});

describe("request-bound staff mutation receipts", () => {
  const issueSuccess = mutationRow("join_code_issued", {
    test_id: testId,
    test_revision: 2,
    expires_at: createdAt,
  });
  const removeSuccess = mutationRow("student_session_removed", {
    test_id: testId,
    session_id: studentSessionId,
    session_revision: 2,
    epoch: 2,
  });
  const prepareSuccess = mutationRow("student_readmission_prepared", {
    test_id: testId,
    session_id: studentSessionId,
    session_revision: 2,
    epoch: 2,
    expires_at: createdAt,
  });
  it("requires each seven-column result's exact nullability and target/revision", () => {
    expect(parseIssueTestJoinCodeRpcResult([issueSuccess], issue)).toEqual({
      ok: true,
      code: "join_code_issued",
      testId,
      testRevision: 2,
      expiresAt: createdAt,
    });
    expect(parseRemoveStudentSessionRpcResult([removeSuccess], remove)).toEqual(
      {
        ok: true,
        code: "student_session_removed",
        testId,
        sessionId: studentSessionId,
        sessionRevision: 2,
        epoch: 2,
      },
    );
    expect(
      parsePrepareStudentReadmissionRpcResult([prepareSuccess], prepare),
    ).toEqual({
      ok: true,
      code: "student_readmission_prepared",
      testId,
      sessionId: studentSessionId,
      sessionRevision: 2,
      epoch: 2,
      expiresAt: createdAt,
    });
    const cases = [
      {
        parse: (value: unknown) =>
          parseIssueTestJoinCodeRpcResult(value, issue),
        value: issueSuccess,
      },
      {
        parse: (value: unknown) =>
          parseRemoveStudentSessionRpcResult(value, remove),
        value: removeSuccess,
      },
      {
        parse: (value: unknown) =>
          parsePrepareStudentReadmissionRpcResult(value, prepare),
        value: prepareSuccess,
      },
    ];
    for (const { parse, value } of cases) {
      for (const key of Object.keys(value).filter((key) => key !== "code")) {
        expect(
          parse([
            { ...value, [key]: value[key] === null ? "unexpected" : null },
          ]),
        ).toBeNull();
      }
      expect(parse([{ ...value, test_id: uuid(30) }])).toBeNull();
      expect(parse([{ ...value, extra: true }])).toBeNull();
      expect(parse([value, value])).toBeNull();
      expect(parse([])).toBeNull();
    }
    expect(
      parseIssueTestJoinCodeRpcResult(
        [{ ...issueSuccess, test_revision: 3 }],
        issue,
      ),
    ).toBeNull();
    expect(
      parseRemoveStudentSessionRpcResult(
        [{ ...removeSuccess, session_revision: 3 }],
        remove,
      ),
    ).toBeNull();
    expect(
      parsePrepareStudentReadmissionRpcResult(
        [{ ...prepareSuccess, session_id: uuid(30) }],
        prepare,
      ),
    ).toBeNull();
    expect(
      parsePrepareStudentReadmissionRpcResult(
        [{ ...prepareSuccess, expires_at: createdAt + "\n" }],
        prepare,
      ),
    ).toBeNull();
  });
  it("binds exact issuance receipts to original revisions and permits only matching removed no-op at the maximum", () => {
    expect(
      parseIssueTestJoinCodeRpcResult(
        [{ ...issueSuccess, code: "join_code_already_issued" }],
        issue,
      )?.ok,
    ).toBe(true);
    expect(
      parsePrepareStudentReadmissionRpcResult(
        [{ ...prepareSuccess, code: "student_readmission_already_prepared" }],
        prepare,
      )?.ok,
    ).toBe(true);
    expect(
      parseRemoveStudentSessionRpcResult(
        [
          {
            ...removeSuccess,
            code: "student_session_already_removed",
            session_revision: 1,
          },
        ],
        remove,
      )?.ok,
    ).toBe(true);
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(
      parseRemoveStudentSessionRpcResult(
        [
          {
            ...removeSuccess,
            code: "student_session_already_removed",
            session_revision: maximum,
            epoch: maximum,
          },
        ],
        { ...remove, expectedSessionRevision: maximum },
      )?.ok,
    ).toBe(true);
    expect(
      parseRemoveStudentSessionRpcResult(
        [{ ...removeSuccess, session_revision: maximum + 1 }],
        { ...remove, expectedSessionRevision: maximum },
      ),
    ).toBeNull();
    expect(
      parseIssueTestJoinCodeRpcResult([issueSuccess], {
        ...issue,
        expectedTestRevision: maximum,
      }),
    ).toBeNull();
    expect(
      parsePrepareStudentReadmissionRpcResult([prepareSuccess], {
        ...prepare,
        expectedSessionRevision: maximum,
      }),
    ).toBeNull();
  });
  it("accepts only finite staff failures with no payload", () => {
    const parsers = [
      (value: unknown) => parseIssueTestJoinCodeRpcResult(value, issue),
      (value: unknown) => parseRemoveStudentSessionRpcResult(value, remove),
      (value: unknown) =>
        parsePrepareStudentReadmissionRpcResult(value, prepare),
    ];
    for (const code of [
      "email_unverified",
      "forbidden",
      "invalid_request",
      "membership_inactive",
      "session_expired",
      "session_revoked",
      "step_up_required",
      "unauthenticated",
      "dependency_unavailable",
      "test_unavailable",
      "test_revision_conflict",
      "test_transition_rejected",
      "student_session_unavailable",
      "student_session_revision_conflict",
      "student_session_transition_rejected",
    ]) {
      const failure = mutationRow(code);
      for (const parse of parsers) {
        expect(parse([failure])).toEqual({ ok: false, code });
        for (const key of Object.keys(failure).filter((key) => key !== "code"))
          expect(parse([{ ...failure, [key]: "retained" }])).toBeNull();
      }
    }
    for (const parse of parsers)
      expect(parse([mutationRow("unknown")])).toBeNull();
    expect(parseIssueTestJoinCodeRpcResult([removeSuccess], issue)).toBeNull();
    expect(
      parseRemoveStudentSessionRpcResult([prepareSuccess], remove),
    ).toBeNull();
    expect(
      parsePrepareStudentReadmissionRpcResult([issueSuccess], prepare),
    ).toBeNull();
  });
  it("rejects sparse/decorated/accessor arrays and rows without running getters", () => {
    const parsers = [
      (value: unknown) => parseReadStudentSessionsRpcResult(value, list),
      (value: unknown) => parseIssueTestJoinCodeRpcResult(value, issue),
      (value: unknown) => parseRemoveStudentSessionRpcResult(value, remove),
      (value: unknown) =>
        parsePrepareStudentReadmissionRpcResult(value, prepare),
    ];
    const rows = [sqlRow(), issueSuccess, removeSuccess, prepareSuccess];
    parsers.forEach((parse, index) => {
      const row = rows[index];
      const get = vi.fn(() => row);
      const bad = [
        new Array(1),
        Object.assign([row], { extra: true }),
        Object.defineProperty([row], "0", { get, enumerable: true }),
        [Object.defineProperty({ ...row }, "code", { get, enumerable: true })],
        new Proxy([row], {
          ownKeys() {
            throw new Error("hostile");
          },
        }),
      ];
      for (const value of bad) expect(parse(value)).toBeNull();
      expect(get).not.toHaveBeenCalled();
    });
  });
});
