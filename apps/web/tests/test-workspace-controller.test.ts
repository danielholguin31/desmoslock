import { describe, expect, it, vi } from "vitest";
import type { StaffTest } from "@desmoslock/contracts";
import type {
  StaffProductAccess,
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../src/auth/staff-product-access.js";
import {
  createTestWorkspaceController,
  type TestWorkspaceAction,
  type TestWorkspaceController,
} from "../src/test-workspace/test-workspace-controller.js";

const authority: StaffProductAuthority = {
  accountId: "a1000000-0000-4000-8000-000000000001",
  providerSessionId: "51000000-0000-4000-8000-000000000001",
  profileId: "21000000-0000-4000-8000-000000000001",
  membershipId: "school-a:profile-a",
  schoolId: "11000000-0000-4000-8000-000000000001",
  role: "owner",
  assuranceLevel: "aal2",
  identityGeneration: "identity-a",
  sessionGeneration: "session-a",
};
const id = (n: number) =>
  `31000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const handle = "synthetic-test-workspace-handle";
function access(
  identity = authority,
  revision = 1,
  name = "Original School",
): StaffProductAccess {
  return {
    authority: { ...identity },
    school: {
      schoolId: identity.schoolId,
      displayName: name,
      settingsRevision: revision,
    },
  };
}
function row(n = 1, override: Partial<StaffTest> = {}): StaffTest {
  return {
    id: id(n),
    schoolId: authority.schoolId,
    createdByProfileId: authority.profileId,
    title: `Test ${n}`,
    lifecycle: "draft",
    revision: 1,
    createdAt: "2026-09-08T10:00:00.000000Z",
    openedAt: null,
    endedAt: null,
    ...override,
  };
}
function raw(row: StaffTest) {
  return {
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
  };
}
function unavailable(code = "test_unavailable") {
  return [
    {
      code,
      test_id: null,
      school_id: null,
      created_by_profile_id: null,
      title: null,
      lifecycle: null,
      test_revision: null,
      created_at: null,
      opened_at: null,
      ended_at: null,
    },
  ];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(rows: StaffTest[] = [row()], initial = access()) {
  let live: StaffProductAccessState = { kind: "ready", access: initial };
  let database = rows;
  const ids = vi.fn(() => "41000000-0000-4000-8000-000000000001");
  const refresh = vi.fn(async (): Promise<StaffProductRefreshResult> =>
    live.kind === "ready"
      ? { kind: "fresh_authorized", access: live.access }
      : { kind: live.kind },
  );
  const capture = vi.fn(async (): Promise<unknown> => ({
    status: "ready",
    authorityHandle: handle,
  }));
  const release = vi.fn();
  const list = vi.fn(
    async (request: {
      before: { createdAt: string; testId: string } | null;
    }): Promise<unknown> =>
      database
        .filter(
          (row) =>
            request.before === null ||
            row.createdAt < request.before.createdAt ||
            (row.createdAt === request.before.createdAt &&
              row.id < request.before.testId),
        )
        .toSorted(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, 51)
        .map(raw),
  );
  const detail = vi.fn(
    async (request: { testId: string }): Promise<unknown> => {
      const value = database.find((row) => row.id === request.testId);
      return value ? [raw(value)] : unavailable();
    },
  );
  const recorded = new Map<string, string>();
  const create = vi.fn(
    async (request: {
      title: string;
      creationRequestId: string;
    }): Promise<unknown> => {
      const existing = recorded.get(request.creationRequestId);
      if (existing)
        return [{ code: "test_creation_already_recorded", test_id: existing }];
      const value = row(100 + database.length, { title: request.title });
      database = [...database, value];
      recorded.set(request.creationRequestId, value.id);
      return [{ code: "test_created", test_id: value.id }];
    },
  );
  const title = vi.fn(
    async (request: {
      testId: string;
      title: string;
      expectedTestRevision: number;
    }): Promise<unknown> => {
      const old = database.find((row) => row.id === request.testId)!;
      if (old.revision !== request.expectedTestRevision)
        return [{ code: "test_revision_conflict" }];
      if (old.title === request.title)
        return [{ code: "test_title_unchanged" }];
      database = database.map((row) =>
        row.id === old.id
          ? { ...row, title: request.title, revision: row.revision + 1 }
          : row,
      );
      return [{ code: "test_title_updated" }];
    },
  );
  const open = vi.fn(async (request: { testId: string }): Promise<unknown> => {
    database = database.map((row) =>
      row.id === request.testId
        ? {
            ...row,
            lifecycle: "open",
            revision: row.revision + 1,
            openedAt: "2026-09-08T11:00:00.000000Z",
          }
        : row,
    );
    return [{ code: "test_opened" }];
  });
  const end = vi.fn(async (request: { testId: string }): Promise<unknown> => {
    database = database.map((row) =>
      row.id === request.testId
        ? {
            ...row,
            lifecycle: "ended",
            revision: row.revision + 1,
            endedAt: "2026-09-08T12:00:00.000000Z",
          }
        : row,
    );
    return [{ code: "test_ended" }];
  });
  const controller = createTestWorkspaceController({
    getAccess: () => live,
    refreshAccess: refresh,
    creationRequestIds: { next: ids },
    port: {
      captureTestWorkspaceAuthority: capture,
      releaseTestWorkspaceAuthority: release,
      readSchoolTests: list,
      readSchoolTest: detail,
      createSchoolTest: create,
      updateTestTitle: title,
      openTest: open,
      endTest: end,
    },
  });
  return {
    controller,
    refresh,
    capture,
    release,
    list,
    detail,
    create,
    title,
    open,
    end,
    ids,
    rows: () => database,
    setRows(value: StaffTest[]) {
      database = value;
    },
    live: () => live,
    setLive(value: StaffProductAccessState) {
      live = value;
    },
    set(value: StaffProductAccessState) {
      live = value;
      controller.setAccess(value);
    },
  };
}
type RevisionAction = Extract<
  TestWorkspaceAction,
  { snapshotRevision: number }
>["type"];
function action(controller: TestWorkspaceController, type: RevisionAction) {
  return controller.dispatch({
    type,
    snapshotRevision: controller.getSnapshot().revision,
  });
}
async function select(h: ReturnType<typeof harness>, target = id(1)) {
  await h.controller.dispatch({ type: "load" });
  await h.controller.dispatch({ type: "select_test", testId: target });
}
function data(controller: TestWorkspaceController) {
  const snapshot = controller.getSnapshot();
  if (!("data" in snapshot))
    throw new Error(`Missing data in ${snapshot.kind}`);
  return snapshot.data;
}

// These tests exercise the real contract decoders with injected product ports;
// they do not claim that the SQL/provider or native admission paths executed.
describe("Test workspace controller", () => {
  it("setAccess and construction are passive; fresh integration loads without recursively refreshing staff", async () => {
    const h = harness();
    expect(h.controller.getSnapshot().kind).toBe("loading");
    h.controller.setAccess({ kind: "ready", access: access() });
    expect(h.list).not.toHaveBeenCalled();
    await h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(data(h.controller).page.items).toEqual([row()]);
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(
      authority.accountId,
      authority.providerSessionId,
    );
    expect(h.list).toHaveBeenCalledWith(
      { schoolId: authority.schoolId, before: null },
      handle,
    );
    expect(h.release).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it.each(["paused", "unavailable"] as const)(
    "%s staff results initiate no Test requests",
    async (kind) => {
      const h = harness();
      await h.controller.refreshFromStaff({ kind });
      expect(h.capture).not.toHaveBeenCalled();
      expect(h.list).not.toHaveBeenCalled();
    },
  );
  it.each(["owner", "administrator", "teacher"] as const)(
    "%s can manage a colleague's Test with role-dependent assurance",
    async (role) => {
      const h = harness(
        [row(1, { createdByProfileId: id(99) })],
        access({
          ...authority,
          role,
          assuranceLevel: role === "teacher" ? "aal1" : "aal2",
        }),
      );
      await select(h);
      await h.controller.dispatch({
        type: "edit_title",
        value: "  Changed title  ",
      });
      expect(await action(h.controller, "save_title")).toMatchObject({
        kind: "ready",
        notice: { kind: "confirmed", code: "test_title_updated" },
      });
      expect(h.title).toHaveBeenCalledWith(
        {
          schoolId: authority.schoolId,
          testId: id(1),
          title: "Changed title",
          expectedTestRevision: 1,
        },
        handle,
      );
    },
  );
  it.each(["owner", "administrator"] as const)(
    "%s AAL1 has no product authority",
    async (role) => {
      const h = harness(
        [row()],
        access({ ...authority, role, assuranceLevel: "aal1" }),
      );
      await h.controller.dispatch({ type: "load" });
      expect(h.controller.getSnapshot().kind).toBe("unavailable");
      expect(h.capture).not.toHaveBeenCalled();
    },
  );
  it("coalesces same-page reads and gives explicit refresh one auth-only leaf", async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const a = h.controller.dispatch({ type: "load" });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    const b = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    pending.resolve([raw(row())]);
    await Promise.all([a, b]);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
  it("preserves microseconds and the 50th-row cursor while replacing pages", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      row(i + 1, {
        createdAt: `2026-09-08T10:00:00.000${String(i).padStart(3, "0")}Z`,
      }),
    );
    const h = harness(rows);
    await h.controller.dispatch({ type: "load" });
    expect(data(h.controller).page.items).toHaveLength(50);
    const cursor = data(h.controller).page.nextCursor;
    expect(cursor).toEqual({
      createdAt: rows[1]!.createdAt,
      testId: rows[1]!.id,
    });
    await h.controller.dispatch({ type: "next_page" });
    expect(h.list).toHaveBeenLastCalledWith(
      { schoolId: authority.schoolId, before: cursor },
      handle,
    );
    expect(data(h.controller).page.items).toEqual([rows[0]]);
    expect(data(h.controller).page.nextCursor).toBeNull();
  });
  it("keeps the selected Test when paging moves it out of the page", async () => {
    const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1)));
    await select(h, id(51));
    await h.controller.dispatch({ type: "next_page" });
    expect(data(h.controller).selected?.id).toBe(id(51));
    expect(h.detail).toHaveBeenLastCalledWith(
      { schoolId: authority.schoolId, testId: id(51) },
      handle,
    );
  });
  it("a superseded selection cannot publish its late target or old page", async () => {
    const h = harness([row(1), row(2)]);
    await h.controller.dispatch({ type: "load" });
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const old = h.controller.dispatch({ type: "select_test", testId: id(1) });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    await h.controller.dispatch({ type: "select_test", testId: id(2) });
    pending.resolve([raw(row(2)), raw(row(1))]);
    await old;
    expect(data(h.controller).selected?.id).toBe(id(2));
  });
  it.each([
    "accountId",
    "providerSessionId",
    "sessionGeneration",
    "identityGeneration",
    "role",
  ] as const)(
    "synchronous live %s replacement rejects the initiating write before any await",
    async (field) => {
      const h = harness();
      await select(h);
      await h.controller.dispatch({ type: "edit_title", value: "Draft" });
      const count = h.refresh.mock.calls.length;
      const replacement = {
        ...authority,
        [field]:
          field === "role"
            ? "teacher"
            : field === "providerSessionId"
              ? "51000000-0000-4000-8000-000000000002"
              : `replacement-${field}`,
      };
      h.setLive({ kind: "ready", access: access(replacement) });
      await action(h.controller, "save_title");
      expect(h.refresh).toHaveBeenCalledTimes(count);
      expect(h.title).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().kind).toBe("loading");
    },
  );
  it("replacement after capture resolves releases the original handle with zero Test egress", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    const pending = deferred<unknown>();
    h.capture.mockImplementationOnce(() => pending.promise);
    const write = action(h.controller, "save_title");
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(3));
    const listCount = h.list.mock.calls.length;
    h.set({
      kind: "ready",
      access: access({ ...authority, accountId: id(99) }),
    });
    pending.resolve({
      status: "ready",
      authorityHandle: "original-late-handle",
    });
    await write;
    expect(h.list).toHaveBeenCalledTimes(listCount);
    expect(h.title).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith("original-late-handle");
  });

  it("a later verified provider session for the same account rejects the old title intent and clears private drafts", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "Old creation draft",
    });
    await h.controller.dispatch({
      type: "edit_title",
      value: "Old title intent",
    });
    const fresh = deferred<StaffProductRefreshResult>();
    h.refresh.mockImplementationOnce(() => fresh.promise);
    h.capture.mockClear();
    const pending = action(h.controller, "save_title");
    const replacement = access({
      ...authority,
      providerSessionId: "51000000-0000-4000-8000-000000000002",
    });
    h.setLive({ kind: "ready", access: replacement });
    fresh.resolve({ kind: "fresh_authorized", access: replacement });
    expect(await pending).toMatchObject({ kind: "loading" });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.title).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    await h.controller.dispatch({ type: "load" });
    expect(data(h.controller)).toMatchObject({
      createDraft: "",
      titleDraft: null,
      selected: null,
    });
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(
      authority.accountId,
      replacement.authority.providerSessionId,
    );
    h.controller.dispose();
  });

  it("same-provider-session token renewal preserves a pending title intent and its captured session tuple", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({
      type: "edit_title",
      value: "Retained title intent",
    });
    const fresh = deferred<StaffProductRefreshResult>();
    h.refresh.mockImplementationOnce(() => fresh.promise);
    h.capture.mockClear();
    h.release.mockClear();
    const pending = action(h.controller, "save_title");
    const verifying = h.controller.getSnapshot();
    // The port owns renewed token material; its verified projection retains
    // this same provider session ID and existing product generations.
    const renewed = access({ ...authority });
    h.set({ kind: "ready", access: renewed });
    expect(h.controller.getSnapshot()).toBe(verifying);
    fresh.resolve({ kind: "fresh_authorized", access: renewed });
    expect(await pending).toMatchObject({
      kind: "ready",
      notice: { kind: "confirmed", code: "test_title_updated", testId: id(1) },
    });
    expect(data(h.controller).selected).toMatchObject({
      title: "Retained title intent",
      revision: 2,
    });
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(
      authority.accountId,
      authority.providerSessionId,
    );
    expect(h.title).toHaveBeenCalledExactlyOnceWith(
      {
        schoolId: authority.schoolId,
        testId: id(1),
        title: "Retained title intent",
        expectedTestRevision: 1,
      },
      handle,
    );
    expect(h.release).toHaveBeenCalledExactlyOnceWith(handle);
    h.controller.dispose();
  });

  it.each([false, true])(
    "provider session replacement=%s discards End intent while same-session renewal preserves it",
    async (replaced) => {
      const h = harness([
        row(1, {
          lifecycle: "open",
          revision: 2,
          openedAt: "2026-09-08T11:00:00.000000Z",
        }),
      ]);
      await select(h);
      await h.controller.dispatch({
        type: "edit_create_title",
        value: "Retained creation draft",
      });
      await action(h.controller, "review_end");
      const confirmation = h.controller.getSnapshot();
      expect(confirmation.kind).toBe("confirming_end");
      h.capture.mockClear();
      const nextAccess = access({
        ...authority,
        providerSessionId: replaced
          ? "51000000-0000-4000-8000-000000000002"
          : authority.providerSessionId,
      });
      h.set({ kind: "ready", access: nextAccess });
      if (replaced) {
        expect(h.controller.getSnapshot().kind).toBe("loading");
        await h.controller.dispatch({
          type: "confirm_end",
          snapshotRevision: confirmation.revision,
        });
        expect(h.end).not.toHaveBeenCalled();
        expect(h.capture).not.toHaveBeenCalled();
        await h.controller.dispatch({ type: "load" });
        expect(data(h.controller)).toMatchObject({
          selected: null,
          titleDraft: null,
          createDraft: "",
        });
      } else {
        expect(h.controller.getSnapshot()).toBe(confirmation);
        await action(h.controller, "confirm_end");
        expect(h.end).toHaveBeenCalledExactlyOnceWith(
          {
            schoolId: authority.schoolId,
            testId: id(1),
            expectedTestRevision: 2,
          },
          handle,
        );
        expect(h.capture).toHaveBeenCalledExactlyOnceWith(
          authority.accountId,
          authority.providerSessionId,
        );
        expect(data(h.controller).createDraft).toBe("Retained creation draft");
      }
      h.controller.dispose();
    },
  );
  it("disposal during capture releases a late handle and cannot restore presentation", async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.capture.mockImplementationOnce(() => pending.promise);
    const load = h.controller.dispatch({ type: "load" });
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalled());
    h.controller.dispose();
    pending.resolve({ status: "ready", authorityHandle: handle });
    await load;
    expect(h.list).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith(handle);
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });
  it("a paused preflight emits no capture and a later unchanged fresh handoff recovers retained drafts", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Retained" });
    h.refresh.mockResolvedValueOnce({ kind: "paused" });
    await action(h.controller, "save_title");
    expect(h.controller.getSnapshot().kind).toBe("paused");
    expect(h.capture).toHaveBeenCalledTimes(2);
    h.set({ kind: "ready", access: access() });
    await h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    expect(data(h.controller).titleDraft).toBe("Retained");
    await action(h.controller, "save_title");
    expect(h.title).toHaveBeenCalledTimes(1);
  });
  it("true access loss discards drafts and old asynchronous reads", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "Private",
    });
    await h.controller.dispatch({ type: "edit_title", value: "Private title" });
    h.set({ kind: "unavailable" });
    h.set({ kind: "ready", access: access() });
    await h.controller.dispatch({ type: "load" });
    expect(data(h.controller)).toMatchObject({
      createDraft: "",
      titleDraft: null,
      selected: null,
    });
  });
  it("immutable title intent survives own synchronous post-write School publication until refresh settles", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Frozen" });
    const after = deferred<StaffProductRefreshResult>();
    h.refresh.mockImplementationOnce(async () => ({
      kind: "fresh_authorized",
      access: access(),
    }));
    h.refresh.mockImplementationOnce(() => {
      h.set({ kind: "ready", access: access(authority, 2, "Renamed School") });
      return after.promise;
    });
    const pending = action(h.controller, "save_title");
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot()).toMatchObject({
        kind: "busy",
        operation: "save_title",
        phase: "refreshing",
      }),
    );
    expect(data(h.controller).school.displayName).toBe("Renamed School");
    await h.controller.dispatch({ type: "edit_title", value: "Intruding" });
    await action(h.controller, "save_title");
    await h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(authority, 2, "Renamed School"),
    });
    expect(h.title).toHaveBeenCalledTimes(1);
    after.resolve({
      kind: "fresh_authorized",
      access: access(authority, 2, "Renamed School"),
    });
    await pending;
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "ready",
      notice: { kind: "confirmed", code: "test_title_updated" },
    });
    expect(data(h.controller).titleDraft).toBe("Frozen");
  });
  it("newer dirty facts require explicit current-rendered reconciliation", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "My draft" });
    h.setRows([row(1, { title: "Their title", revision: 2 })]);
    await action(h.controller, "save_title");
    expect(h.title).not.toHaveBeenCalled();
    expect(h.detail).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      operation: "save_title",
    });
    const old = h.controller.getSnapshot().revision;
    h.setRows([row(1, { title: "Newer title", revision: 3 })]);
    await h.controller.dispatch({ type: "refresh" });
    await h.controller.dispatch({
      type: "keep_title_draft",
      snapshotRevision: old,
    });
    expect(h.controller.getSnapshot().kind).toBe("conflict");
    await action(h.controller, "keep_title_draft");
    await action(h.controller, "save_title");
    expect(h.title).toHaveBeenLastCalledWith(
      {
        schoolId: authority.schoolId,
        testId: id(1),
        title: "My draft",
        expectedTestRevision: 3,
      },
      handle,
    );
  });
  it("an unknown title response never becomes acknowledged from matching current state or refresh", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Changed" });
    h.title.mockImplementationOnce(async () => {
      h.setRows([row(1, { title: "Changed", revision: 2 })]);
      throw new Error("synthetic-private-message");
    });
    await action(h.controller, "save_title");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      notice: { kind: "unconfirmed", operation: "save_title" },
    });
    await h.controller.dispatch({ type: "refresh" });
    expect(h.title).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
      "synthetic-private-message",
    );
    expect(h.controller.getSnapshot()).toMatchObject({
      notice: { kind: "unconfirmed" },
    });
  });
  it("lost create uses the same private key/title only on explicit retry, including replay after later rename", async () => {
    const h = harness([]);
    await h.controller.dispatch({ type: "load" });
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "  Initial title  ",
    });
    const original = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(async (request) => {
      await original(request);
      return null;
    });
    await action(h.controller, "create_test");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "create_unconfirmed",
      submittedTitle: "Initial title",
    });
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "Different title",
    });
    await h.controller.dispatch({ type: "refresh" });
    expect(h.create).toHaveBeenCalledTimes(1);
    h.setRows(
      h.rows().map((row) => ({ ...row, title: "Renamed later", revision: 2 })),
    );
    await action(h.controller, "retry_create");
    expect(h.create.mock.calls[0]).toEqual(h.create.mock.calls[1]);
    expect(h.ids).toHaveBeenCalledTimes(1);
    expect(h.rows()).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "ready",
      notice: { kind: "confirmed", code: "test_creation_already_recorded" },
    });
    expect(data(h.controller).selected?.title).toBe("Renamed later");
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
      "creationRequestId",
    );
  });
  it("starting a new Test explicitly abandons uncertainty without sending a write", async () => {
    const h = harness([]);
    await h.controller.dispatch({ type: "load" });
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "Maybe created",
    });
    h.create.mockResolvedValueOnce(null);
    await action(h.controller, "create_test");
    await action(h.controller, "start_new_test");
    expect(data(h.controller).createDraft).toBe("");
    expect(h.create).toHaveBeenCalledTimes(1);
    h.ids.mockReturnValueOnce("41000000-0000-4000-8000-000000000002");
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "New intent",
    });
    await action(h.controller, "create_test");
    expect(h.create.mock.calls[0]![0].creationRequestId).not.toBe(
      h.create.mock.calls[1]![0].creationRequestId,
    );
  });
  it("end requires exact reviewed target/revision, preserves label changes, and cannot be repeated from stale controls", async () => {
    const h = harness();
    await select(h);
    await action(h.controller, "open_test");
    await action(h.controller, "review_end");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "confirming_end",
      target: { testId: id(1), title: "Test 1", expectedTestRevision: 2 },
    });
    const stale = h.controller.getSnapshot().revision;
    h.set({ kind: "ready", access: access(authority, 2, "Updated School") });
    expect(h.controller.getSnapshot().kind).toBe("confirming_end");
    await h.controller.dispatch({
      type: "confirm_end",
      snapshotRevision: stale,
    });
    expect(h.end).not.toHaveBeenCalled();
    await action(h.controller, "confirm_end");
    expect(h.end).toHaveBeenCalledWith(
      { schoolId: authority.schoolId, testId: id(1), expectedTestRevision: 2 },
      handle,
    );
    await h.controller.dispatch({
      type: "confirm_end",
      snapshotRevision: stale,
    });
    await action(h.controller, "review_end");
    await action(h.controller, "open_test");
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(data(h.controller).selected?.lifecycle).toBe("ended");
  });
  it("concurrent title change invalidates end confirmation and forces a new review", async () => {
    const h = harness([
      row(1, { lifecycle: "open", openedAt: "2026-09-08T11:00:00.000000Z" }),
    ]);
    await select(h);
    await action(h.controller, "review_end");
    h.setRows([
      row(1, {
        title: "Changed while reviewed",
        revision: 2,
        lifecycle: "open",
        openedAt: "2026-09-08T11:00:00.000000Z",
      }),
    ]);
    await action(h.controller, "confirm_end");
    expect(h.end).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      operation: "end",
    });
    await action(h.controller, "keep_title_draft");
    expect(h.controller.getSnapshot().kind).toBe("conflict");
    await action(h.controller, "use_current_test");
    await action(h.controller, "confirm_end");
    expect(h.end).not.toHaveBeenCalled();
    await action(h.controller, "review_end");
    await action(h.controller, "confirm_end");
    expect(h.end).toHaveBeenLastCalledWith(
      { schoolId: authority.schoolId, testId: id(1), expectedTestRevision: 2 },
      handle,
    );
  });
  it("target disappears between preflight and write without inventing Membership loss", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.title.mockImplementationOnce(async () => {
      h.setRows([]);
      return [{ code: "test_unavailable" }];
    });
    expect(await action(h.controller, "save_title")).toMatchObject({
      kind: "ready",
      notice: { kind: "test_unavailable" },
    });
    expect(data(h.controller).selected).toBeNull();
    expect(data(h.controller).school.schoolId).toBe(authority.schoolId);
  });
  it("a write rejection preserves refreshed active authority, while genuine post-write loss wins", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.title.mockResolvedValueOnce([{ code: "forbidden" }]);
    await action(h.controller, "save_title");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "ready",
      notice: { kind: "rejected", operation: "save_title" },
    });
    h.title.mockImplementationOnce(async () => {
      h.set({ kind: "unavailable" });
      return [{ code: "membership_inactive" }];
    });
    await action(h.controller, "save_title");
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });
  it("lower late revisions cannot roll presentation back; equal conflicting facts fail closed", async () => {
    const h = harness([row(1, { revision: 3, title: "Current" })]);
    await select(h);
    h.setRows([row()]);
    await h.controller.dispatch({ type: "refresh" });
    expect(data(h.controller).selected).toMatchObject({
      revision: 3,
      title: "Current",
    });
    h.setRows([row(1, { revision: 3, title: "Contradiction" })]);
    await h.controller.dispatch({ type: "refresh" });
    expect(h.controller.getSnapshot().kind).toBe("read_unavailable");
    h.set({ kind: "unavailable" });
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
  });
  it("a failed bounded read releases its handle and a later explicit read recovers", async () => {
    const h = harness();
    h.list.mockRejectedValueOnce(new Error("synthetic timeout"));
    await h.controller.dispatch({ type: "load" });
    expect(h.controller.getSnapshot().kind).toBe("read_unavailable");
    expect(h.release).toHaveBeenCalledWith(handle);
    await h.controller.dispatch({ type: "refresh" });
    expect(h.controller.getSnapshot().kind).toBe("ready");
  });
  it.each(["", "\u0000bad", "😀".repeat(41)])(
    "invalid raw title prevents mutation: %j",
    async (value) => {
      const h = harness();
      await select(h);
      await h.controller.dispatch({ type: "edit_title", value });
      await action(h.controller, "save_title");
      expect(h.title).not.toHaveBeenCalled();
      expect(data(h.controller).titleValidation).not.toBeNull();
    },
  );
  it("fresh preflight cannot borrow a newer cached row to conceal older raw target facts", async () => {
    const h = harness([row(1, { revision: 3, title: "Current" })]);
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.setRows([row()]);
    expect(await action(h.controller, "save_title")).toMatchObject({
      kind: "read_unavailable",
    });
    expect(h.detail).toHaveBeenCalledExactlyOnceWith(
      { schoolId: authority.schoolId, testId: id(1) },
      handle,
    );
    expect(h.title).not.toHaveBeenCalled();
  });
  it("capture failures resolve dispatch to the settled state and release no nonexistent handle", async () => {
    const h = harness();
    h.capture.mockResolvedValueOnce({ status: "unavailable" });
    expect(await h.controller.dispatch({ type: "load" })).toMatchObject({
      kind: "read_unavailable",
    });
    expect(h.release).not.toHaveBeenCalled();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.capture.mockResolvedValueOnce({ status: "unavailable" });
    expect(await action(h.controller, "save_title")).toMatchObject({
      kind: "ready",
      notice: { kind: "rejected" },
    });
    expect(h.title).not.toHaveBeenCalled();
  });
  it("an early target conflict resolves to its settled snapshot, and end review returns its confirmation", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.setRows([row(1, { title: "New title", revision: 2 })]);
    expect(await action(h.controller, "save_title")).toMatchObject({
      kind: "conflict",
    });
    await action(h.controller, "use_current_test");
    await action(h.controller, "open_test");
    expect(await action(h.controller, "review_end")).toMatchObject({
      kind: "confirming_end",
    });
  });
  it("synchronous authority loss from submitting publication prevents first write egress", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Draft" });
    h.controller.subscribe((snapshot) => {
      if (snapshot.kind === "busy" && snapshot.phase === "submitting")
        h.set({
          kind: "ready",
          access: access({ ...authority, accountId: id(99) }),
        });
    });
    await action(h.controller, "save_title");
    expect(h.title).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().kind).toBe("loading");
  });
  it("same-authority pause after create egress retains uncertainty and ignores a late acknowledgment", async () => {
    const h = harness([]);
    await h.controller.dispatch({ type: "load" });
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "Frozen create",
    });
    const pending = deferred<unknown>();
    h.create.mockImplementationOnce(() => pending.promise);
    const operation = action(h.controller, "create_test");
    await vi.waitFor(() => expect(h.create).toHaveBeenCalled());
    h.set({ kind: "paused", authority });
    h.set({ kind: "ready", access: access() });
    await h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "create_unconfirmed",
      submittedTitle: "Frozen create",
    });
    pending.resolve([{ code: "test_created", test_id: id(99) }]);
    await operation;
    expect(h.controller.getSnapshot().kind).toBe("create_unconfirmed");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.ids).toHaveBeenCalledTimes(1);
  });
  it("a dirty title is retained across an acknowledged Open and requires explicit reconciliation", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Unsaved title" });
    await action(h.controller, "open_test");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      operation: "save_title",
      notice: { kind: "confirmed", code: "test_opened" },
    });
    expect(data(h.controller).titleDraft).toBe("Unsaved title");
    await action(h.controller, "keep_title_draft");
    await action(h.controller, "save_title");
    expect(h.title).toHaveBeenCalledWith(
      {
        schoolId: authority.schoolId,
        testId: id(1),
        title: "Unsaved title",
        expectedTestRevision: 2,
      },
      handle,
    );
  });
  it("post-write targeted read publication remains busy until that exact read settles", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Own write" });
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(async () => [raw(row())]);
    h.list.mockImplementationOnce(() => pending.promise);
    const operation = action(h.controller, "save_title");
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(4));
    h.set({ kind: "ready", access: access(authority, 2, "Fresh label") });
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "busy",
      phase: "refreshing",
    });
    pending.resolve([raw(row(1, { title: "Own write", revision: 2 }))]);
    await operation;
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "ready",
      notice: { kind: "confirmed" },
    });
  });
  it("a malformed creation ID is rejected before refresh or capture", async () => {
    const h = harness([]);
    await h.controller.dispatch({ type: "load" });
    await h.controller.dispatch({ type: "edit_create_title", value: "Create" });
    h.ids.mockReturnValueOnce("invalid");
    const count = h.refresh.mock.calls.length;
    expect(await action(h.controller, "create_test")).toMatchObject({
      kind: "ready",
      notice: { kind: "rejected", operation: "create" },
    });
    expect(h.refresh).toHaveBeenCalledTimes(count);
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each(["select_test", "next_page", "first_page"] as const)(
    "quiet and explicit refresh coalesce with pending %s instead of restoring the settled view",
    async (type) => {
      const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1)));
      await h.controller.dispatch({ type: "load" });
      if (type === "first_page")
        await h.controller.dispatch({ type: "next_page" });
      const pending = deferred<unknown>();
      const original = h.list.getMockImplementation()!;
      const response = deferred<unknown>();
      h.list.mockImplementationOnce((request) => {
        void original(request).then(response.resolve);
        return pending.promise;
      });
      const count = h.list.mock.calls.length;
      const user = h.controller.dispatch(
        type === "select_test" ? { type, testId: id(51) } : { type },
      );
      await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(count + 1));
      const quiet = h.controller.refreshFromStaff({
        kind: "fresh_authorized",
        access: access(),
      });
      expect(h.controller.getSnapshot().kind).toBe("busy");
      const explicit = h.controller.dispatch({ type: "refresh" });
      pending.resolve(await response.promise);
      await Promise.all([user, quiet, explicit]);
      expect(h.list).toHaveBeenCalledTimes(count + 1);
      if (type === "select_test")
        expect(data(h.controller).selected?.id).toBe(id(51));
      else
        expect(data(h.controller).page.items.map((row) => row.id)).toEqual(
          type === "next_page"
            ? [id(1)]
            : Array.from({ length: 50 }, (_, i) => id(51 - i)),
        );
    },
  );
  it.each([
    "ready",
    "confirming_end",
    "conflict",
    "create_unconfirmed",
    "read_unavailable_initial",
    "read_unavailable_settled",
  ] as const)(
    "quiet lifecycle rename retains %s throughout a held read",
    async (state) => {
      const h = harness();
      if (state === "read_unavailable_initial") {
        h.list.mockResolvedValueOnce(null);
        await h.controller.dispatch({ type: "load" });
      } else {
        await select(h);
        if (state === "confirming_end") {
          await action(h.controller, "open_test");
          await action(h.controller, "review_end");
        } else if (state === "conflict") {
          await h.controller.dispatch({
            type: "edit_title",
            value: "Private draft",
          });
          h.setRows([row(1, { title: "Other title", revision: 2 })]);
          await h.controller.dispatch({ type: "refresh" });
        } else if (state === "create_unconfirmed") {
          await h.controller.dispatch({
            type: "edit_create_title",
            value: "Maybe created",
          });
          h.create.mockResolvedValueOnce(null);
          await action(h.controller, "create_test");
        } else if (state === "read_unavailable_settled") {
          h.list.mockResolvedValueOnce(null);
          await h.controller.dispatch({ type: "refresh" });
        }
      }
      const kind = state.startsWith("read_unavailable")
        ? "read_unavailable"
        : state;
      expect(h.controller.getSnapshot().kind).toBe(kind);
      const snapshots: string[] = [];
      h.controller.subscribe((snapshot) => snapshots.push(snapshot.kind));
      const pending = deferred<unknown>();
      h.list.mockImplementationOnce(() => pending.promise);
      const count = h.list.mock.calls.length;
      const renamed = access(authority, 2, "Renamed School");
      h.set({ kind: "ready", access: renamed });
      const quiet = h.controller.refreshFromStaff({
        kind: "fresh_authorized",
        access: renamed,
      });
      await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(count + 1));
      expect(h.controller.getSnapshot()).toMatchObject({ kind });
      const held = h.controller.getSnapshot();
      expect(
        "data" in held
          ? held.data.school
          : "school" in held
            ? held.school
            : null,
      ).toEqual(renamed.school);
      expect(snapshots).not.toContain("busy");
      expect(snapshots).not.toContain("loading");
      pending.resolve(
        h
          .rows()
          .toSorted((a, b) => b.id.localeCompare(a.id))
          .map(raw),
      );
      await quiet;
      expect(h.controller.getSnapshot().kind).toBe(
        kind === "read_unavailable" ? "ready" : kind,
      );
      expect(snapshots).not.toContain("busy");
      expect(snapshots).not.toContain("loading");
    },
  );
  it("quiet lifecycle reads retain typing in enabled title fields", async () => {
    const h = harness();
    await select(h);
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    await h.controller.dispatch({
      type: "edit_title",
      value: "Typing during refresh",
    });
    await h.controller.dispatch({
      type: "edit_create_title",
      value: "New creation draft",
    });
    expect(data(h.controller)).toMatchObject({
      titleDraft: "Typing during refresh",
      createDraft: "New creation draft",
    });
    pending.resolve([raw(row())]);
    await quiet;
    expect(data(h.controller)).toMatchObject({
      titleDraft: "Typing during refresh",
      createDraft: "New creation draft",
    });
    expect(h.controller.getSnapshot().kind).toBe("ready");
  });
  it("explicit Refresh promotes the same quiet read and blocks edits and writes until settlement", async () => {
    const h = harness();
    await select(h);
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    expect(h.controller.getSnapshot().kind).toBe("ready");
    const explicit = h.controller.dispatch({ type: "refresh" });
    expect(h.controller.getSnapshot().kind).toBe("busy");
    await h.controller.dispatch({ type: "edit_title", value: "Blocked input" });
    await action(h.controller, "open_test");
    expect(data(h.controller).titleDraft).toBe("Test 1");
    expect(h.open).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledTimes(3);
    const alsoQuiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    expect(h.controller.getSnapshot().kind).toBe("busy");
    pending.resolve([raw(row())]);
    await Promise.all([quiet, explicit, alsoQuiet]);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(h.controller.getSnapshot().kind).toBe("ready");
  });
  it("an initial quiet read still projects loading until data arrives", async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.controller.getSnapshot().kind).toBe("loading");
    pending.resolve([raw(row())]);
    await quiet;
    expect(h.controller.getSnapshot().kind).toBe("ready");
  });
  it("a title mutation releases the quiet read before fresh preflight and rejects its late higher facts", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({
      type: "edit_title",
      value: "Captured draft",
    });
    const pending = deferred<unknown>();
    h.capture.mockResolvedValueOnce({
      status: "ready",
      authorityHandle: "quiet-read-handle",
    });
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    const fresh = deferred<StaffProductRefreshResult>();
    h.refresh.mockImplementationOnce(() => {
      expect(h.release).toHaveBeenCalledWith("quiet-read-handle");
      return fresh.promise;
    });
    const write = action(h.controller, "save_title");
    expect(h.controller.getSnapshot()).toMatchObject({
      kind: "busy",
      operation: "save_title",
      phase: "verifying",
    });
    const verifying = h.controller.getSnapshot();
    await h.controller.dispatch({
      type: "edit_title",
      value: "Blocked after capture",
    });
    pending.resolve([
      raw(row(1, { title: "Obsolete higher result", revision: 99 })),
    ]);
    await quiet;
    expect(h.controller.getSnapshot()).toBe(verifying);
    expect(data(h.controller).selected?.revision).toBe(1);
    fresh.resolve({ kind: "fresh_authorized", access: access() });
    await write;
    expect(h.title).toHaveBeenCalledExactlyOnceWith(
      {
        schoolId: authority.schoolId,
        testId: id(1),
        title: "Captured draft",
        expectedTestRevision: 1,
      },
      handle,
    );
    expect(data(h.controller).selected).toMatchObject({
      title: "Captured draft",
      revision: 2,
    });
    expect(
      h.release.mock.calls.filter(([value]) => value === "quiet-read-handle"),
    ).toHaveLength(1);
  });
  it("a mutation can obsolete a pending quiet capture and releases its late handle without read egress", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "New intent" });
    const pending = deferred<unknown>();
    h.capture.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(3));
    await action(h.controller, "save_title");
    expect(h.title).toHaveBeenCalledTimes(1);
    const settled = h.controller.getSnapshot();
    const listCount = h.list.mock.calls.length;
    pending.resolve({
      status: "ready",
      authorityHandle: "obsolete-late-capture",
    });
    await quiet;
    expect(h.controller.getSnapshot()).toBe(settled);
    expect(h.list).toHaveBeenCalledTimes(listCount);
    expect(
      h.release.mock.calls.filter(
        ([value]) => value === "obsolete-late-capture",
      ),
    ).toHaveLength(1);
  });
  it("a late cancelled quiet detail cannot replace an off-page target after its title mutation", async () => {
    const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1)));
    await select(h, id(51));
    await h.controller.dispatch({ type: "next_page" });
    await h.controller.dispatch({
      type: "edit_title",
      value: "Off-page draft",
    });
    const pending = deferred<unknown>();
    h.capture.mockResolvedValueOnce({
      status: "ready",
      authorityHandle: "quiet-detail-handle",
    });
    h.detail.mockImplementationOnce(() => pending.promise);
    const details = h.detail.mock.calls.length;
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.detail).toHaveBeenCalledTimes(details + 1));
    await action(h.controller, "save_title");
    expect(h.release).toHaveBeenCalledWith("quiet-detail-handle");
    expect(h.title).toHaveBeenCalledExactlyOnceWith(
      {
        schoolId: authority.schoolId,
        testId: id(51),
        title: "Off-page draft",
        expectedTestRevision: 1,
      },
      handle,
    );
    const settled = h.controller.getSnapshot();
    expect(data(h.controller).selected).toMatchObject({
      id: id(51),
      title: "Off-page draft",
      revision: 2,
    });
    pending.resolve([
      raw(row(51, { title: "Late obsolete detail", revision: 99 })),
    ]);
    await quiet;
    expect(h.controller.getSnapshot()).toBe(settled);
    await h.controller.dispatch({ type: "refresh" });
    expect(data(h.controller).selected).toMatchObject({
      id: id(51),
      title: "Off-page draft",
      revision: 2,
    });
    expect(h.title).toHaveBeenCalledTimes(1);
  });
  it("End confirmation can cancel a quiet read while retaining the exact reviewed revision", async () => {
    const h = harness([
      row(1, { lifecycle: "open", openedAt: "2026-09-08T11:00:00.000000Z" }),
    ]);
    await select(h);
    await action(h.controller, "review_end");
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const listCount = h.list.mock.calls.length;
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(listCount + 1));
    await action(h.controller, "confirm_end");
    expect(h.end).toHaveBeenCalledExactlyOnceWith(
      {
        schoolId: authority.schoolId,
        testId: id(1),
        expectedTestRevision: 1,
      },
      handle,
    );
    const ended = h.controller.getSnapshot();
    pending.resolve([
      raw(
        row(1, { lifecycle: "open", openedAt: "2026-09-08T11:00:00.000000Z" }),
      ),
    ]);
    await quiet;
    expect(h.controller.getSnapshot()).toBe(ended);
    expect(data(h.controller).selected?.lifecycle).toBe("ended");
  });
  it("provider session replacement while a quiet read is pending still rejects a new write synchronously", async () => {
    const h = harness();
    await select(h);
    await h.controller.dispatch({ type: "edit_title", value: "Old SID draft" });
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    const captures = h.capture.mock.calls.length;
    const refreshes = h.refresh.mock.calls.length;
    h.setLive({
      kind: "ready",
      access: access({
        ...authority,
        providerSessionId: "51000000-0000-4000-8000-000000000002",
      }),
    });
    await action(h.controller, "save_title");
    expect(h.refresh).toHaveBeenCalledTimes(refreshes);
    expect(h.capture).toHaveBeenCalledTimes(captures);
    expect(h.title).not.toHaveBeenCalled();
    const replaced = h.controller.getSnapshot();
    expect(replaced.kind).toBe("loading");
    pending.resolve([raw(row(1, { title: "Old SID facts", revision: 99 }))]);
    await quiet;
    expect(h.controller.getSnapshot()).toBe(replaced);
  });
  it.each([
    "cancel_end",
    "use_current_test",
    "keep_title_draft",
    "start_new_test",
  ] as const)(
    "local %s remains meaningful during a quiet read without new egress",
    async (type) => {
      const h = harness();
      await select(h);
      if (type === "cancel_end") {
        await action(h.controller, "open_test");
        await action(h.controller, "review_end");
      } else if (type === "start_new_test") {
        await h.controller.dispatch({
          type: "edit_create_title",
          value: "Uncertain draft",
        });
        h.create.mockResolvedValueOnce(null);
        await action(h.controller, "create_test");
      } else {
        await h.controller.dispatch({
          type: "edit_title",
          value: "Private title",
        });
        h.setRows([row(1, { title: "Current server title", revision: 2 })]);
        await h.controller.dispatch({ type: "refresh" });
      }
      const stale = h.controller.getSnapshot().revision;
      const pending = deferred<unknown>();
      h.list.mockImplementationOnce(() => pending.promise);
      const renamed = access(authority, 2, "New School label");
      h.set({ kind: "ready", access: renamed });
      const listCount = h.list.mock.calls.length;
      const quiet = h.controller.refreshFromStaff({
        kind: "fresh_authorized",
        access: renamed,
      });
      await vi.waitFor(() =>
        expect(h.list).toHaveBeenCalledTimes(listCount + 1),
      );
      const captures = h.capture.mock.calls.length;
      const snapshot = h.controller.getSnapshot();
      await h.controller.dispatch({ type, snapshotRevision: stale });
      expect(h.controller.getSnapshot()).toBe(snapshot);
      await action(h.controller, type);
      expect(h.controller.getSnapshot().kind).toBe("ready");
      expect(h.capture).toHaveBeenCalledTimes(captures);
      expect(h.list).toHaveBeenCalledTimes(listCount + 1);
      expect(h.end).not.toHaveBeenCalled();
      expect(h.title).not.toHaveBeenCalled();
      pending.resolve(h.rows().map(raw));
      await quiet;
      expect(h.controller.getSnapshot().kind).toBe("ready");
      if (type === "keep_title_draft")
        expect(data(h.controller).titleDraft).toBe("Private title");
      if (type === "use_current_test")
        expect(data(h.controller).titleDraft).toBe("Current server title");
      if (type === "start_new_test") {
        expect(data(h.controller).createDraft).toBe("");
        expect(h.create).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["save_title", "end"] as const)(
    "quiet reads surface a real %s target conflict only when changed facts arrive",
    async (operation) => {
      const original =
        operation === "end"
          ? row(1, {
              lifecycle: "open",
              openedAt: "2026-09-08T11:00:00.000000Z",
            })
          : row();
      const h = harness([original]);
      await select(h);
      if (operation === "end") await action(h.controller, "review_end");
      else
        await h.controller.dispatch({
          type: "edit_title",
          value: "Retained draft",
        });
      const pending = deferred<unknown>();
      h.list.mockImplementationOnce(() => pending.promise);
      const listCount = h.list.mock.calls.length;
      const quiet = h.controller.refreshFromStaff({
        kind: "fresh_authorized",
        access: access(),
      });
      await vi.waitFor(() =>
        expect(h.list).toHaveBeenCalledTimes(listCount + 1),
      );
      expect(h.controller.getSnapshot().kind).toBe(
        operation === "end" ? "confirming_end" : "ready",
      );
      pending.resolve([
        raw({ ...original, revision: 2, title: "Changed target" }),
      ]);
      await quiet;
      expect(h.controller.getSnapshot()).toMatchObject({
        kind: "conflict",
        operation,
      });
      if (operation === "save_title")
        expect(data(h.controller).titleDraft).toBe("Retained draft");
      expect(h.title).not.toHaveBeenCalled();
      expect(h.end).not.toHaveBeenCalled();
    },
  );
  it("explicit selection replaces a quiet read and its late response cannot revive the old selection", async () => {
    const h = harness([row(1), row(2)]);
    await select(h);
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    await h.controller.dispatch({ type: "select_test", testId: id(2) });
    const selected = h.controller.getSnapshot();
    expect(data(h.controller).selected?.id).toBe(id(2));
    pending.resolve([
      raw(row(2)),
      raw(row(1, { title: "Late selection", revision: 99 })),
    ]);
    await quiet;
    expect(h.controller.getSnapshot()).toBe(selected);
  });
  it("synchronous access loss during explicit promotion leaves no live read or rejected dispatch", async () => {
    const h = harness();
    await select(h);
    const pending = deferred<unknown>();
    h.list.mockImplementationOnce(() => pending.promise);
    const quiet = h.controller.refreshFromStaff({
      kind: "fresh_authorized",
      access: access(),
    });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    h.controller.subscribe((snapshot) => {
      if (snapshot.kind === "busy") h.set({ kind: "unavailable" });
    });
    const explicit = h.controller.dispatch({ type: "refresh" });
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
    pending.resolve([raw(row())]);
    await expect(Promise.all([quiet, explicit])).resolves.toHaveLength(2);
    expect(h.controller.getSnapshot().kind).toBe("unavailable");
    expect(h.list).toHaveBeenCalledTimes(3);
  });
});
