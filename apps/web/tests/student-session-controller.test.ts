import { describe, expect, it, vi } from "vitest";
import type {
  IssueTestJoinCodeRequest,
  PrepareStudentReadmissionRequest,
  RemoveStudentSessionRequest,
  StaffStudentSession,
  StaffTest,
} from "@desmoslock/contracts";
import type {
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../src/auth/staff-product-access.js";
import { createStudentSessionController } from "../src/student-sessions/student-session-controller.js";
import type {
  StudentSessionAction,
  StudentSessionController,
  StudentSessionSnapshot,
} from "../src/student-sessions/student-session-controller.js";

const authority: StaffProductAuthority = {
  accountId: "01000000-0000-4000-8000-000000000001",
  providerSessionId: "02000000-0000-4000-8000-000000000001",
  profileId: "21000000-0000-4000-8000-000000000001",
  membershipId: "school-a:profile-a",
  schoolId: "11000000-0000-4000-8000-000000000001",
  role: "owner",
  assuranceLevel: "aal2",
  identityGeneration: "identity-a",
  sessionGeneration: "session-a",
};
const sessionId = (n: number) =>
  `51000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function testRow(overrides: Partial<StaffTest> = {}): StaffTest {
  return {
    id: "31000000-0000-4000-8000-000000000001",
    schoolId: authority.schoolId,
    createdByProfileId: authority.profileId,
    title: "Algebra",
    lifecycle: "open",
    revision: 2,
    createdAt: "2026-09-08T10:00:00.000001Z",
    openedAt: "2026-09-08T11:00:00.000001Z",
    endedAt: null,
    ...overrides,
  };
}
function session(
  n = 1,
  overrides: Partial<StaffStudentSession> = {},
): StaffStudentSession {
  return {
    id: sessionId(n),
    schoolId: authority.schoolId,
    testId: testRow().id,
    syntheticDisplayName: `Student A${n}`,
    state: "active",
    epoch: 1,
    revision: 1,
    createdAt: "2026-09-08T12:00:00.123456Z",
    ...overrides,
  };
}
function access(
  identity = authority,
  displayName = "North School",
  settingsRevision = 1,
): StaffProductAccessState {
  return {
    kind: "ready",
    access: {
      authority: { ...identity },
      school: { schoolId: identity.schoolId, displayName, settingsRevision },
    },
  };
}
function rawTest(row: StaffTest) {
  return [
    {
      code: "ok",
      test_id: row.id,
      school_id: row.schoolId,
      created_by_profile_id: row.createdByProfileId,
      title: row.title,
      lifecycle: row.lifecycle,
      test_revision: row.revision,
      created_at: row.createdAt,
      opened_at: row.openedAt,
      ended_at: row.endedAt,
    },
  ];
}
function rawSession(row: StaffStudentSession) {
  return {
    code: "ok",
    session_id: row.id,
    school_id: row.schoolId,
    test_id: row.testId,
    synthetic_display_name: row.syntheticDisplayName,
    state: row.state,
    epoch: row.epoch,
    session_revision: row.revision,
    created_at: row.createdAt,
  };
}
function mutationResult(code: string, fields: Record<string, unknown> = {}) {
  return [
    {
      code,
      test_id: null,
      session_id: null,
      session_revision: null,
      test_revision: null,
      epoch: null,
      expires_at: null,
      ...fields,
    },
  ];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function visible(snapshot: StudentSessionSnapshot) {
  if (!("data" in snapshot))
    throw new Error("Expected visible StudentSession data");
  return snapshot.data;
}
async function action(
  controller: StudentSessionController,
  type: Exclude<StudentSessionAction["type"], "select_session">,
) {
  const input =
    type === "load" ||
    type === "refresh" ||
    type === "first_page" ||
    type === "next_page"
      ? { type }
      : { type, snapshotRevision: controller.getSnapshot().revision };
  return controller.dispatch(input);
}
function harness(
  initialRows: StaffStudentSession[] = [session()],
  useProductionIssuance = false,
) {
  let live = access();
  let test = testRow();
  let rows = initialRows;
  let serial = 0;
  let now = Date.parse("2026-09-08T12:00:00.000Z");
  const refresh = vi.fn(async (): Promise<StaffProductRefreshResult> =>
    live.kind === "ready"
      ? { kind: "fresh_authorized", access: live.access }
      : { kind: live.kind },
  );
  const capture = vi.fn(async (): Promise<unknown> => ({
    status: "ready",
    authorityHandle: "student-purpose-handle",
  }));
  const release = vi.fn();
  const readTarget = vi.fn(async (): Promise<unknown> => rawTest(test));
  const read = vi.fn(
    async (request: {
      before: { createdAt: string; sessionId: string } | null;
    }): Promise<unknown> =>
      rows
        .filter(
          (row) =>
            request.before === null ||
            row.createdAt < request.before.createdAt ||
            (row.createdAt === request.before.createdAt &&
              row.id < request.before.sessionId),
        )
        .toSorted(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, 51)
        .map(rawSession),
  );
  const issued = new Map<string, unknown>();
  const issue = vi.fn(
    async (request: IssueTestJoinCodeRequest): Promise<unknown> => {
      const old = issued.get(request.issuanceRequestId);
      if (old !== undefined)
        return mutationResult("join_code_already_issued", {
          test_id: request.testId,
          test_revision: request.expectedTestRevision + 1,
          expires_at: "2026-09-08T12:15:00.123456Z",
        });
      if (request.expectedTestRevision !== test.revision)
        return mutationResult("test_revision_conflict");
      test = { ...test, revision: test.revision + 1 };
      const result = mutationResult("join_code_issued", {
        test_id: request.testId,
        test_revision: test.revision,
        expires_at: "2026-09-08T12:15:00.123456Z",
      });
      issued.set(request.issuanceRequestId, result);
      return result;
    },
  );
  const remove = vi.fn(
    async (request: RemoveStudentSessionRequest): Promise<unknown> => {
      const old = rows.find((row) => row.id === request.studentSessionId);
      if (old === undefined || old.revision !== request.expectedSessionRevision)
        return mutationResult("student_session_revision_conflict");
      const next = {
        ...old,
        state: "removed" as const,
        revision: old.revision + 1,
        epoch: old.epoch + 1,
      };
      rows = rows.map((row) => (row.id === next.id ? next : row));
      return mutationResult("student_session_removed", {
        test_id: test.id,
        session_id: next.id,
        session_revision: next.revision,
        epoch: next.epoch,
      });
    },
  );
  const prepare = vi.fn(
    async (request: PrepareStudentReadmissionRequest): Promise<unknown> => {
      const old = rows.find((row) => row.id === request.studentSessionId);
      if (old === undefined || old.revision !== request.expectedSessionRevision)
        return mutationResult("student_session_revision_conflict");
      const next = {
        ...old,
        state: "readmitted" as const,
        revision: old.revision + 1,
        epoch: old.epoch + 1,
      };
      rows = rows.map((row) => (row.id === next.id ? next : row));
      return mutationResult("student_readmission_prepared", {
        test_id: test.id,
        session_id: next.id,
        session_revision: next.revision,
        epoch: next.epoch,
        expires_at: "2026-09-08T12:15:00.123456Z",
      });
    },
  );
  const code = vi.fn(() => "0123456789AB");
  const ids = vi.fn(
    () => `41000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
  );
  const digest = vi.fn(async () => "a".repeat(64));
  const parentRefresh = vi.fn();
  const controller = createStudentSessionController({
    port: {
      captureStudentSessionAuthority: capture,
      releaseStudentSessionAuthority: release,
      readStudentTarget: readTarget,
      readStudentSessions: read,
      issueTestJoinCode: issue,
      removeStudentSession: remove,
      prepareStudentReadmission: prepare,
    },
    getAccess: () => live,
    refreshAccess: refresh,
    requestSelectedTestRefresh: parentRefresh,
    now: () => now,
    ...(useProductionIssuance
      ? {}
      : {
          issuance: { nextCode: code, nextRequestId: ids, digestCode: digest },
        }),
  });
  controller.setTarget({ test, parentBusy: false });
  return {
    controller,
    refresh,
    capture,
    release,
    readTarget,
    read,
    issue,
    remove,
    prepare,
    code,
    ids,
    digest,
    parentRefresh,
    test: () => test,
    rows: () => rows,
    setNow(value: number) {
      now = value;
    },
    setRows(next: StaffStudentSession[]) {
      rows = next;
    },
    setLive(next: StaffProductAccessState, publish = true) {
      live = next;
      if (publish) controller.setAccess(next);
    },
    setTest(next: StaffTest, parentBusy = false) {
      test = next;
      controller.setTarget({ test, parentBusy });
    },
    async load() {
      return action(controller, "load");
    },
    async select(id = sessionId(1)) {
      return controller.dispatch({
        type: "select_session",
        studentSessionId: id,
        snapshotRevision: controller.getSnapshot().revision,
      });
    },
  };
}

describe("StudentSession sibling controller", () => {
  it.each(["join", "readmission"] as const)(
    "clears only confirmed %s disclosure at expiry during shared refresh",
    async (kind) => {
      const h = harness([session(1, { state: "removed" })]);
      await h.load();
      await h.select();
      await action(
        h.controller,
        kind === "join" ? "review_issue_code" : "review_prepare_readmission",
      );
      await action(h.controller, "confirm_review");
      const disclosure = visible(h.controller.getSnapshot()).disclosure;
      expect(disclosure?.kind).toBe(kind);
      const expiresAt = Date.parse(disclosure!.expiresAt);
      h.setNow(expiresAt - 1);
      await h.controller.refreshFromStaff(await h.refresh());
      expect(visible(h.controller.getSnapshot()).disclosure).toBe(disclosure);
      const selected = visible(h.controller.getSnapshot()).selected;
      const writes = h.issue.mock.calls.length + h.prepare.mock.calls.length;
      h.setNow(expiresAt);
      await h.controller.refreshFromStaff(await h.refresh());
      const cleared = h.controller.getSnapshot();
      expect(visible(cleared).disclosure).toBeNull();
      expect(visible(cleared).selected).toEqual(selected);
      expect(JSON.stringify(cleared)).not.toContain(disclosure!.code);
      expect(h.issue.mock.calls.length + h.prepare.mock.calls.length).toBe(
        writes,
      );
      // A later backwards wall-clock adjustment cannot reveal cleared material.
      h.setNow(expiresAt - 1000);
      h.setTest({
        ...h.test(),
        title: "Another label",
        revision: h.test().revision + 1,
      });
      expect(visible(h.controller.getSnapshot()).disclosure).toBeNull();
    },
  );

  it("retains exact uncertain issuance across expiry while withholding an expired retry receipt", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const issue = h.issue.getMockImplementation()!;
    h.issue.mockImplementationOnce(async (request) => {
      await issue(request);
      return null;
    });
    await action(h.controller, "confirm_review");
    h.setNow(Date.parse("2026-09-08T12:15:00.124Z"));
    await h.controller.refreshFromStaff(await h.refresh());
    expect(h.controller.getSnapshot().kind).toBe("unconfirmed");
    const original = h.issue.mock.calls[0]?.[0];
    await action(h.controller, "retry_issuance");
    expect(h.issue.mock.calls[1]?.[0]).toEqual(original);
    expect(visible(h.controller.getSnapshot()).disclosure).toBeNull();
    expect(h.ids).toHaveBeenCalledTimes(1);
    expect(h.code).toHaveBeenCalledTimes(1);
  });

  it("uses synchronous setters without reads, admits Teacher AAL1 and rejects privileged AAL1", () => {
    const h = harness();
    h.setTest(testRow({ title: "New label", revision: 3 }));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    h.setLive(
      access({ ...authority, role: "teacher", assuranceLevel: "aal1" }),
    );
    h.setTest(testRow());
    expect(h.controller.getSnapshot().kind).toBe("loading");
    h.setLive(access({ ...authority, assuranceLevel: "aal1" }));
    expect(h.controller.getSnapshot()).toEqual({
      kind: "unavailable",
      revision: expect.any(Number),
    });
  });

  it("requires a revision-bound review even for first code issuance and discloses only confirmed material", async () => {
    const h = harness();
    const loaded = await h.load();
    expect(loaded).toBe(h.controller.getSnapshot());
    const reviewed = await action(h.controller, "review_issue_code");
    expect(reviewed.kind).toBe("review");
    expect(h.issue).not.toHaveBeenCalled();
    expect(JSON.stringify(reviewed)).not.toContain("0123456789AB");
    expect(JSON.stringify(reviewed)).not.toContain("issuanceRequestId");
    expect(h.capture).toHaveBeenLastCalledWith(
      authority.accountId,
      authority.providerSessionId,
    );
    const confirmed = await action(h.controller, "confirm_review");
    expect(confirmed).toBe(h.controller.getSnapshot());
    expect(visible(confirmed).disclosure).toEqual({
      kind: "join",
      code: "0123456789AB",
      expiresAt: "2026-09-08T12:15:00.123456Z",
      studentSessionId: null,
    });
    expect(h.issue).toHaveBeenCalledTimes(1);
    expect(h.parentRefresh).toHaveBeenCalledWith({
      schoolId: authority.schoolId,
      testId: testRow().id,
    });
    expect(h.release).toHaveBeenCalledTimes(3);
  });

  it("retries an uncertain committed issuance with original revision, ID, digest and expiry", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const realIssue = h.issue.getMockImplementation()!;
    h.issue.mockImplementationOnce(async (request) => {
      await realIssue(request);
      return null;
    });
    const first = await action(h.controller, "confirm_review");
    expect(first.kind).toBe("unconfirmed");
    expect(visible(first).disclosure).toBeNull();
    expect(h.test().revision).toBe(3);
    const second = await action(h.controller, "retry_issuance");
    expect(visible(second).disclosure?.code).toBe("0123456789AB");
    expect(h.issue.mock.calls[1]?.[0]).toEqual(h.issue.mock.calls[0]?.[0]);
    expect(h.issue.mock.calls[1]?.[0].expectedTestRevision).toBe(2);
    expect(h.code).toHaveBeenCalledTimes(1);
    expect(h.ids).toHaveBeenCalledTimes(1);
    expect(h.digest).toHaveBeenCalledTimes(1);
    expect(h.parentRefresh).toHaveBeenCalledTimes(2);
  });

  it("does not reinterpret retry denial as success or discard the retained candidate", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    h.issue.mockResolvedValueOnce(null);
    await action(h.controller, "confirm_review");
    h.issue.mockResolvedValueOnce(mutationResult("test_revision_conflict"));
    const denied = await action(h.controller, "retry_issuance");
    expect(denied.kind).toBe("unconfirmed");
    expect(visible(denied).disclosure).toBeNull();
    await action(h.controller, "retry_issuance");
    expect(h.issue.mock.calls[2]?.[0]).toEqual(h.issue.mock.calls[0]?.[0]);
  });

  it("preserves reviews and confirmed codes across School labels and Test presentation changes", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    h.setLive(access(authority, "Renamed School", 2));
    h.setTest(testRow({ title: "Renamed Test", revision: 3 }));
    const stale = h.controller.getSnapshot();
    expect(stale.kind).toBe("review");
    if (stale.kind !== "review") throw new Error("Missing review");
    expect(stale.target).toMatchObject({
      title: "Algebra",
      expectedTestRevision: 2,
      stale: true,
    });
    expect(stale.data.test.title).toBe("Renamed Test");
    await action(h.controller, "confirm_review");
    expect(h.issue).not.toHaveBeenCalled();
    await action(h.controller, "cancel_review");
    await action(h.controller, "review_issue_code");
    await action(h.controller, "confirm_review");
    h.setTest({ ...h.test(), title: "Another label", revision: 5 });
    expect(visible(h.controller.getSnapshot()).disclosure?.code).toBe(
      "0123456789AB",
    );
  });

  it("pauses a preflight under parent activity and later submits its original review", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const gate = deferred<unknown>();
    h.readTarget.mockReturnValueOnce(gate.promise);
    const confirming = action(h.controller, "confirm_review");
    await vi.waitFor(() => expect(h.readTarget).toHaveBeenCalledTimes(3));
    h.setTest(h.test(), true);
    gate.resolve(rawTest(h.test()));
    await confirming;
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().kind).toBe("review");
    expect(visible(h.controller.getSnapshot()).parentBusy).toBe(true);
    h.setTest(h.test(), false);
    await action(h.controller, "confirm_review");
    expect(h.code).toHaveBeenCalledTimes(1);
    expect(h.issue.mock.calls[0]?.[0].expectedTestRevision).toBe(2);
  });

  it("lets an already submitted child settle during a parent pause", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const gate = deferred<unknown>();
    h.issue.mockReturnValueOnce(gate.promise);
    const confirming = action(h.controller, "confirm_review");
    await vi.waitFor(() => expect(h.issue).toHaveBeenCalledTimes(1));
    h.setTest(h.test(), true);
    gate.resolve(
      mutationResult("join_code_issued", {
        test_id: h.test().id,
        test_revision: 3,
        expires_at: "2026-09-08T12:15:00.123456Z",
      }),
    );
    const result = await confirming;
    expect(visible(result).parentBusy).toBe(true);
    expect(visible(result).disclosure?.code).toBe("0123456789AB");
  });

  it("does not rebase a selected StudentSession after a late concurrent mutation", async () => {
    const h = harness();
    await h.load();
    await h.select();
    await action(h.controller, "review_remove");
    h.setRows([session(1, { revision: 2, epoch: 2, state: "readmitted" })]);
    const result = await action(h.controller, "confirm_review");
    expect(result.kind).toBe("review");
    expect(h.remove).not.toHaveBeenCalled();
    if (result.kind !== "review") throw new Error("Missing stale review");
    expect(result.target).toMatchObject({
      stale: true,
      expectedSessionRevision: 1,
    });
    expect(result.data.selected?.revision).toBe(2);
  });

  it("ignores unrelated Test title revisions for a reviewed removal, then explicitly prepares targeted recovery", async () => {
    const h = harness();
    await h.load();
    await h.select();
    await action(h.controller, "review_prepare_readmission");
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().kind).toBe("ready");
    await action(h.controller, "review_remove");
    h.setTest(testRow({ title: "Edited title", revision: 3 }));
    await action(h.controller, "confirm_review");
    expect(h.remove.mock.calls[0]?.[0].expectedSessionRevision).toBe(1);
    expect(visible(h.controller.getSnapshot()).selected?.state).toBe("removed");
    await action(h.controller, "review_prepare_readmission");
    expect(h.prepare).not.toHaveBeenCalled();
    await action(h.controller, "confirm_review");
    expect(h.prepare.mock.calls[0]?.[0].expectedSessionRevision).toBe(2);
    expect(visible(h.controller.getSnapshot()).disclosure).toMatchObject({
      kind: "readmission",
      studentSessionId: sessionId(1),
    });
  });

  it("drops late responses and releases late handles after provider-session changes", async () => {
    const h = harness();
    await h.load();
    const gate = deferred<unknown>();
    h.capture.mockReturnValueOnce(gate.promise);
    const reviewing = action(h.controller, "review_issue_code");
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(2));
    h.setLive(
      access({
        ...authority,
        providerSessionId: "02000000-0000-4000-8000-000000000002",
        sessionGeneration: "session-b",
      }),
    );
    gate.resolve({ status: "ready", authorityHandle: "late-old-handle" });
    await reviewing;
    expect(h.release).toHaveBeenCalledWith("late-old-handle");
    expect(h.code).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });

  it("invalidates private material on parent end without reporting a physical release", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const gate = deferred<unknown>();
    h.issue.mockReturnValueOnce(gate.promise);
    const confirming = action(h.controller, "confirm_review");
    await vi.waitFor(() => expect(h.issue).toHaveBeenCalledTimes(1));
    h.setTest(
      testRow({
        lifecycle: "ended",
        revision: 3,
        endedAt: "2026-09-08T12:05:00.000001Z",
      }),
    );
    gate.resolve(
      mutationResult("join_code_issued", {
        test_id: h.test().id,
        test_revision: 3,
        expires_at: "2026-09-08T12:15:00.123456Z",
      }),
    );
    await confirming;
    expect(visible(h.controller.getSnapshot()).disclosure).toBeNull();
    expect(h.parentRefresh).not.toHaveBeenCalled();
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
      "released",
    );
  });

  it("keeps exact pending issuance private across a same-authority pause after egress", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const fresh = access();
    if (fresh.kind !== "ready")
      throw new Error("Expected initial ready access");
    h.refresh.mockResolvedValueOnce({
      kind: "fresh_authorized",
      access: fresh.access,
    });
    h.refresh.mockResolvedValueOnce({ kind: "paused" });
    await action(h.controller, "confirm_review");
    expect(h.controller.getSnapshot().kind).toBe("paused");
    h.setLive(access());
    expect(h.controller.getSnapshot().kind).toBe("unconfirmed");
    await action(h.controller, "retry_issuance");
    expect(h.issue.mock.calls[1]?.[0]).toEqual(h.issue.mock.calls[0]?.[0]);
  });

  it("fences reentrant submission and authority changes at the final publication before egress", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const staleRevision = h.controller.getSnapshot().revision - 1;
    await h.controller.dispatch({
      type: "confirm_review",
      snapshotRevision: staleRevision,
    });
    expect(h.issue).not.toHaveBeenCalled();
    const unsubscribe = h.controller.subscribe((snapshot) => {
      if (snapshot.kind === "busy" && snapshot.phase === "submitting") {
        void action(h.controller, "confirm_review");
        h.setLive({ kind: "unavailable" }, false);
      }
    });
    await action(h.controller, "confirm_review");
    unsubscribe();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });

  it("rejects accessor actions and authority results without executing getters", async () => {
    const h = harness();
    await h.load();
    const getter = vi.fn(() => "review_issue_code");
    await h.controller.dispatch(
      Object.defineProperty(
        { snapshotRevision: h.controller.getSnapshot().revision },
        "type",
        { enumerable: true, get: getter },
      ) as StudentSessionAction,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(h.code).not.toHaveBeenCalled();
    h.capture.mockResolvedValueOnce(
      Object.defineProperty({ status: "ready" }, "authorityHandle", {
        enumerable: true,
        get: getter,
      }),
    );
    await action(h.controller, "review_issue_code");
    expect(getter).not.toHaveBeenCalled();
    expect(h.code).not.toHaveBeenCalled();
  });

  it("rejects unknown or extra-field mutation responses without disclosing code", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    h.issue.mockResolvedValueOnce(
      mutationResult("join_code_issued", {
        test_id: h.test().id,
        test_revision: 3,
        expires_at: "2026-09-08T12:15:00.123456Z",
        debug: "unexpected",
      }),
    );
    const result = await action(h.controller, "confirm_review");
    expect(result.kind).toBe("unconfirmed");
    expect(visible(result).disclosure).toBeNull();
  });

  it("preserves six-digit cursors and an explicit page request during a shared staff refresh", async () => {
    const h = harness(Array.from({ length: 60 }, (_, n) => session(n + 1)));
    await h.load();
    expect(visible(h.controller.getSnapshot()).page.items).toHaveLength(50);
    expect(visible(h.controller.getSnapshot()).page.nextCursor).toEqual({
      createdAt: "2026-09-08T12:00:00.123456Z",
      sessionId: sessionId(11),
    });
    const gate = deferred<unknown>();
    h.read.mockReturnValueOnce(gate.promise);
    const paging = action(h.controller, "next_page");
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await h.controller.refreshFromStaff(await h.refresh());
    expect(h.read).toHaveBeenCalledTimes(2);
    gate.resolve(
      Array.from({ length: 10 }, (_, n) => rawSession(session(10 - n))),
    );
    const result = await paging;
    expect(h.read.mock.calls[1]?.[0].before?.createdAt).toBe(
      "2026-09-08T12:00:00.123456Z",
    );
    expect(visible(result).page.items.map((row) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, n) => sessionId(10 - n)),
    );
    expect(visible(result).page.nextCursor).toBeNull();
  });

  it("uses the production CSPRNG code path and the independently pinned join-material digest", async () => {
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (!(array instanceof Uint8Array))
          throw new Error("Unexpected random buffer");
        array.set(Array.from({ length: array.length }, (_, i) => i));
        return array;
      });
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("41000000-0000-4000-8000-000000000001");
    try {
      const h = harness([session()], true);
      await h.load();
      await action(h.controller, "review_issue_code");
      await action(h.controller, "confirm_review");
      expect(h.issue.mock.calls[0]?.[0].joinMaterialDigest).toBe(
        "5c4b9f4b01ced1ab28a3e7971770f230c4c959b103e07120c9537c54c47f205e",
      );
      expect(visible(h.controller.getSnapshot()).disclosure?.code).toBe(
        "0123456789AB",
      );
    } finally {
      random.mockRestore();
      uuid.mockRestore();
    }
  });

  it("publishes immutable nested state and clears its public snapshot on disposal", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    await action(h.controller, "confirm_review");
    const state = h.controller.getSnapshot();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(visible(state).disclosure)).toBe(true);
    expect("notice" in state && Object.isFrozen(state.notice)).toBe(true);
    h.controller.dispose();
    expect(h.controller.getSnapshot()).toEqual({
      kind: "unavailable",
      revision: expect.any(Number),
    });
    await action(h.controller, "review_issue_code");
    expect(h.issue).toHaveBeenCalledTimes(1);
  });

  it("does not start a provider refresh for work invalidated by its initial publication", async () => {
    const h = harness();
    await h.load();
    const unsubscribe = h.controller.subscribe((state) => {
      if (state.kind === "busy" && state.phase === "verifying")
        h.setLive({ kind: "unavailable" }, false);
    });
    await action(h.controller, "review_issue_code");
    unsubscribe();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });

  it("honors a reentrant work reservation made during access presentation", async () => {
    const h = harness();
    await h.load();
    h.setLive(access(authority, "Renamed", 2), false);
    let inner: Promise<StudentSessionSnapshot> | null = null;
    const unsubscribe = h.controller.subscribe((state) => {
      if (
        state.kind === "ready" &&
        state.data.school.displayName === "Renamed" &&
        inner === null
      )
        inner = action(h.controller, "review_issue_code");
    });
    await action(h.controller, "review_issue_code");
    await inner;
    unsubscribe();
    expect(h.controller.getSnapshot().kind).toBe("review");
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.code).toHaveBeenCalledTimes(1);
  });

  it("fences a hostile row parser that switches the provider session during reflection", async () => {
    const h = harness();
    await h.load();
    const changed = access({
      ...authority,
      providerSessionId: "02000000-0000-4000-8000-000000000002",
      sessionGeneration: "session-b",
    });
    const row = new Proxy(rawSession(session()), {
      ownKeys(value) {
        h.setLive(changed);
        h.setTest(testRow());
        return Reflect.ownKeys(value);
      },
    });
    h.read.mockResolvedValueOnce([row]);
    await action(h.controller, "refresh");
    h.setLive(changed);
    expect(visible(h.controller.getSnapshot()).page.items).toEqual([]);
    expect(h.controller.getSnapshot().kind).toBe("loading");
  });

  it("does not refresh or disclose after mutation response parsing loses authority", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const raw = mutationResult("join_code_issued", {
      test_id: h.test().id,
      test_revision: 3,
      expires_at: "2026-09-08T12:15:00.123456Z",
    });
    h.issue.mockResolvedValueOnce([
      new Proxy(raw[0]!, {
        ownKeys(value) {
          h.setLive({ kind: "unavailable" });
          return Reflect.ownKeys(value);
        },
      }),
    ]);
    await action(h.controller, "confirm_review");
    expect(h.refresh).toHaveBeenCalledTimes(3);
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });

  it("checks authority after the post-response publication and reports bounded capture failures", async () => {
    const h = harness();
    await h.load();
    await action(h.controller, "review_issue_code");
    const unsubscribe = h.controller.subscribe((state) => {
      if (state.kind === "busy" && state.phase === "refreshing")
        h.setLive({ kind: "unavailable" }, false);
    });
    await action(h.controller, "confirm_review");
    unsubscribe();
    expect(h.refresh).toHaveBeenCalledTimes(3);
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
    const failed = harness();
    failed.capture.mockResolvedValueOnce({ status: "unavailable" });
    expect((await failed.load()).kind).toBe("read_unavailable");
  });
});
