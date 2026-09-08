import { describe, expect, it, vi } from "vitest";
import type {
  IssueTestJoinCodeRequest,
  ReadStudentSessionsRequest,
  ReadStudentProtectionEventsRequest,
} from "@desmoslock/contracts";
import { createStudentSessionPort } from "../src/student-sessions/student-session-port.js";
import type { StudentSessionTransport } from "../src/student-sessions/student-session-port.js";

const scope = {
  schoolId: "11000000-0000-4000-8000-000000000001",
  testId: "31000000-0000-4000-8000-000000000001",
};
const removal = {
  ...scope,
  studentSessionId: "51000000-0000-4000-8000-000000000001",
  expectedSessionRevision: 7,
};
const material = {
  issuanceRequestId: "41000000-0000-4000-8000-000000000001",
  joinMaterialDigest: "a".repeat(64),
};
const handle = "private-student-purpose-handle";
function harness() {
  const transport = {
    captureAuthority: vi.fn<StudentSessionTransport["captureAuthority"]>(
      async () => ({ status: "ready", authorityHandle: handle }),
    ),
    releaseAuthority: vi.fn<StudentSessionTransport["releaseAuthority"]>(),
    currentSchoolTest: vi.fn<StudentSessionTransport["currentSchoolTest"]>(
      async () => [],
    ),
    currentTestStudentSessions: vi.fn<
      StudentSessionTransport["currentTestStudentSessions"]
    >(async () => []),
    currentStudentProtectionEvents: vi.fn<
      StudentSessionTransport["currentStudentProtectionEvents"]
    >(async () => []),
    issueTestJoinCode: vi.fn<StudentSessionTransport["issueTestJoinCode"]>(
      async () => [],
    ),
    removeStudentSession: vi.fn<
      StudentSessionTransport["removeStudentSession"]
    >(async () => []),
    prepareStudentReadmission: vi.fn<
      StudentSessionTransport["prepareStudentReadmission"]
    >(async () => []),
  };
  return { transport, port: createStudentSessionPort(transport) };
}
describe("StudentSession named purpose port", () => {
  it("maps and snapshots history scope and the exact six-digit receipt cursor", async () => {
    const h = harness();
    const request = {
      ...scope,
      studentSessionId: removal.studentSessionId,
      before: {
        receivedAt: "2026-09-08T12:00:00.123456Z",
        eventId: "71000000-0000-4000-8000-000000000001",
      },
    };
    const operation = h.port.readStudentProtectionEvents(request, handle);
    request.before.receivedAt = "2026-09-08T12:00:00.999999Z";
    request.studentSessionId = scope.testId;
    await operation;
    expect(h.transport.currentStudentProtectionEvents).toHaveBeenCalledWith(
      handle,
      {
        workspace_id: scope.schoolId,
        test_id: scope.testId,
        student_session_id: removal.studentSessionId,
        before_received_at: "2026-09-08T12:00:00.123456Z",
        before_event_id: "71000000-0000-4000-8000-000000000001",
      },
    );
    expect(
      Object.isFrozen(
        h.transport.currentStudentProtectionEvents.mock.calls[0]?.[1],
      ),
    ).toBe(true);
    await h.port.readStudentProtectionEvents(
      {
        ...scope,
        studentSessionId: removal.studentSessionId,
        before: null,
      },
      handle,
    );
    expect(
      h.transport.currentStudentProtectionEvents.mock.calls[1]?.[1],
    ).toMatchObject({
      before_received_at: null,
      before_event_id: null,
    });
  });
  it("rejects malformed or accessor history fields and empty handles before authority-bearing transport", async () => {
    const h = harness();
    const request = {
      ...scope,
      studentSessionId: removal.studentSessionId,
      before: null,
    };
    const getter = vi.fn(() => removal.studentSessionId);
    const hostile = [
      { ...request, purpose: "staff_management" },
      {
        ...request,
        before: {
          receivedAt: "2026-09-08T12:00:00.123Z",
          eventId: removal.studentSessionId,
        },
      },
      {
        ...request,
        before: {
          receivedAt: "2026-09-08T12:00:00.123456Z",
          eventId: "not-a-uuid",
        },
      },
      Object.defineProperty({ ...scope, before: null }, "studentSessionId", {
        get: getter,
        enumerable: true,
      }),
      Object.create(request),
      new Proxy(request, {
        ownKeys() {
          throw new Error("Hostile reflection");
        },
      }),
    ];
    for (const value of hostile)
      expect(
        await h.port.readStudentProtectionEvents(
          value as ReadStudentProtectionEventsRequest,
          handle,
        ),
      ).toBeNull();
    expect(await h.port.readStudentProtectionEvents(request, "")).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(h.transport.currentStudentProtectionEvents).not.toHaveBeenCalled();
  });
  it("maps five fixed named seams, preserving scope, original revisions and full cursor precision", async () => {
    const h = harness();
    await h.port.readStudentTarget(scope, handle);
    expect(h.transport.currentSchoolTest).toHaveBeenCalledWith(handle, {
      workspace_id: scope.schoolId,
      test_id: scope.testId,
    });
    await h.port.readStudentSessions(
      {
        ...scope,
        before: {
          createdAt: "2026-09-08T12:00:00.123456Z",
          sessionId: removal.studentSessionId,
        },
      },
      handle,
    );
    expect(h.transport.currentTestStudentSessions).toHaveBeenCalledWith(
      handle,
      {
        workspace_id: scope.schoolId,
        test_id: scope.testId,
        before_created_at: "2026-09-08T12:00:00.123456Z",
        before_session_id: removal.studentSessionId,
      },
    );
    await h.port.issueTestJoinCode(
      { ...scope, ...material, expectedTestRevision: 9 },
      handle,
    );
    expect(h.transport.issueTestJoinCode).toHaveBeenCalledWith(handle, {
      workspace_id: scope.schoolId,
      test_id: scope.testId,
      issuance_request_id: material.issuanceRequestId,
      join_material_digest: material.joinMaterialDigest,
      expected_test_revision: 9,
    });
    await h.port.removeStudentSession(removal, handle);
    expect(h.transport.removeStudentSession).toHaveBeenCalledWith(handle, {
      workspace_id: scope.schoolId,
      test_id: scope.testId,
      student_session_id: removal.studentSessionId,
      expected_session_revision: 7,
    });
    await h.port.prepareStudentReadmission({ ...removal, ...material }, handle);
    expect(h.transport.prepareStudentReadmission).toHaveBeenCalledWith(handle, {
      workspace_id: scope.schoolId,
      test_id: scope.testId,
      student_session_id: removal.studentSessionId,
      expected_session_revision: 7,
      issuance_request_id: material.issuanceRequestId,
      join_material_digest: material.joinMaterialDigest,
    });
  });
  it("requires an exact expected account and provider session before authority capture", async () => {
    const h = harness();
    await h.port.captureStudentSessionAuthority(scope.schoolId, scope.testId);
    expect(h.transport.captureAuthority).toHaveBeenCalledWith(
      scope.schoolId,
      scope.testId,
    );
    expect(
      await h.port.captureStudentSessionAuthority("wrong", scope.testId),
    ).toEqual({ status: "unavailable" });
    expect(h.transport.captureAuthority).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed, extra, accessor, inherited and arbitrary RPC material before transport", async () => {
    const h = harness();
    const getter = vi.fn(() => scope.schoolId);
    const request = { ...scope, before: null };
    const hostile = [
      { ...request, rpc: "admin_reset" },
      {
        ...request,
        before: {
          createdAt: "2026-09-08T12:00:00.123Z",
          sessionId: removal.studentSessionId,
        },
      },
      Object.defineProperty(
        { testId: scope.testId, before: null },
        "schoolId",
        { get: getter, enumerable: true },
      ),
      Object.create(request),
      new Proxy(request, {
        ownKeys() {
          throw new Error("Hostile reflection");
        },
      }),
    ];
    for (const value of hostile)
      expect(
        await h.port.readStudentSessions(
          value as ReadStudentSessionsRequest,
          handle,
        ),
      ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(h.transport.currentTestStudentSessions).not.toHaveBeenCalled();
    expect(
      await h.port.issueTestJoinCode(
        {
          ...scope,
          ...material,
          expectedTestRevision: 0,
        } as IssueTestJoinCodeRequest,
        handle,
      ),
    ).toBeNull();
    expect(
      await h.port.issueTestJoinCode(
        { ...scope, ...material, expectedTestRevision: 2 },
        "",
      ),
    ).toBeNull();
    expect(h.transport.issueTestJoinCode).not.toHaveBeenCalled();
  });
  it("snapshots and freezes scalar arguments instead of passing caller-owned records to transport", async () => {
    const h = harness();
    const request = {
      ...scope,
      before: {
        createdAt: "2026-09-08T12:00:00.123456Z",
        sessionId: removal.studentSessionId,
      },
    };
    const operation = h.port.readStudentSessions(request, handle);
    request.schoolId = scope.testId;
    request.before.createdAt = "2026-09-08T12:00:00.999999Z";
    await operation;
    const args = h.transport.currentTestStudentSessions.mock.calls[0];
    expect(args).toEqual([
      handle,
      {
        workspace_id: scope.schoolId,
        test_id: scope.testId,
        before_created_at: "2026-09-08T12:00:00.123456Z",
        before_session_id: removal.studentSessionId,
      },
    ]);
    expect(Object.isFrozen(args?.[1])).toBe(true);
  });
});
