import {
  parseCreateSchoolTestRequest,
  parseCreateSchoolTestRpcResult,
  parseEndTestRpcResult,
  parseOpenTestRpcResult,
  parseReadSchoolTestRpcResult,
  parseReadSchoolTestsRpcResult,
  parseSchoolSettings,
  parseUpdateTestTitleRpcResult,
  validateTestTitleDraft,
} from "@desmoslock/contracts";

import type {
  CreateSchoolTestRequest,
  ReadSchoolTestRequest,
  ReadSchoolTestsRequest,
  SchoolSettings,
  StaffTest,
  StaffTestPage,
  TestPageCursor,
  TestRevisionRequest,
  TestTitleValidation,
  UpdateTestTitleRequest,
} from "@desmoslock/contracts";

import type {
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../auth/staff-product-access.js";

export type TestWorkspaceMutation = "create" | "save_title" | "open" | "end";
export type TestWorkspaceOperation =
  TestWorkspaceMutation | "load" | "select" | "review_end";
export type TestWorkspaceNotice =
  | {
      readonly kind: "confirmed";
      readonly code:
        | "test_created"
        | "test_creation_already_recorded"
        | "test_title_updated"
        | "test_title_unchanged"
        | "test_opened"
        | "test_already_open"
        | "test_ended"
        | "test_already_ended";
      readonly testId: string;
    }
  | {
      readonly kind: "rejected" | "unconfirmed";
      readonly operation: TestWorkspaceMutation;
    }
  | { readonly kind: "test_unavailable" | "selection_changed" };

export interface TestWorkspaceData {
  readonly school: SchoolSettings;
  readonly page: StaffTestPage;
  readonly selected: StaffTest | null;
  readonly createDraft: string;
  readonly createValidation: TestTitleValidation | null;
  readonly titleDraft: string | null;
  readonly titleValidation: TestTitleValidation | null;
}

export type TestWorkspaceSnapshot = { readonly revision: number } & (
  | { readonly kind: "unavailable" | "paused" }
  | {
      readonly kind: "loading" | "read_unavailable";
      readonly school: SchoolSettings;
    }
  | {
      readonly kind: "ready";
      readonly data: TestWorkspaceData;
      readonly notice: TestWorkspaceNotice | null;
    }
  | {
      readonly kind: "busy";
      readonly operation: TestWorkspaceOperation;
      readonly phase: "verifying" | "submitting" | "refreshing";
      readonly data: TestWorkspaceData;
    }
  | {
      readonly kind: "confirming_end";
      readonly data: TestWorkspaceData;
      readonly target: Readonly<{
        testId: string;
        title: string;
        expectedTestRevision: number;
      }>;
    }
  | {
      readonly kind: "conflict";
      readonly operation: "save_title" | "open" | "end";
      readonly data: TestWorkspaceData;
      readonly notice: TestWorkspaceNotice | null;
    }
  | {
      readonly kind: "create_unconfirmed";
      readonly data: TestWorkspaceData;
      readonly submittedTitle: string;
    }
);

export type TestWorkspaceAction =
  | { readonly type: "load" | "refresh" | "first_page" | "next_page" }
  | { readonly type: "select_test"; readonly testId: string }
  | {
      readonly type: "edit_create_title" | "edit_title";
      readonly value: string;
    }
  | {
      readonly type:
        | "create_test"
        | "retry_create"
        | "start_new_test"
        | "save_title"
        | "open_test"
        | "review_end"
        | "confirm_end"
        | "cancel_end"
        | "use_current_test"
        | "keep_title_draft";
      readonly snapshotRevision: number;
    };

export interface TestWorkspacePort {
  captureTestWorkspaceAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  releaseTestWorkspaceAuthority(authorityHandle: string): void;
  readSchoolTests(
    request: ReadSchoolTestsRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  readSchoolTest(
    request: ReadSchoolTestRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  createSchoolTest(
    request: CreateSchoolTestRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  updateTestTitle(
    request: UpdateTestTitleRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  openTest(
    request: TestRevisionRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  endTest(
    request: TestRevisionRequest,
    authorityHandle: string,
  ): Promise<unknown>;
}

export interface TestWorkspaceController {
  getSnapshot(): TestWorkspaceSnapshot;
  subscribe(listener: (snapshot: TestWorkspaceSnapshot) => void): () => void;
  setAccess(access: StaffProductAccessState): void;
  refreshFromStaff(
    result: StaffProductRefreshResult,
  ): Promise<TestWorkspaceSnapshot>;
  dispatch(action: TestWorkspaceAction): Promise<TestWorkspaceSnapshot>;
  dispose(): void;
}

export interface TestWorkspaceControllerDependencies {
  readonly port: TestWorkspacePort;
  readonly getAccess: () => StaffProductAccessState;
  readonly refreshAccess: () => Promise<StaffProductRefreshResult>;
  readonly creationRequestIds: { next(): string };
}

type SnapshotBody = TestWorkspaceSnapshot extends infer Snapshot
  ? Snapshot extends TestWorkspaceSnapshot
    ? Omit<Snapshot, "revision">
    : never
  : never;
interface AuthorityIntent {
  readonly epoch: number;
  readonly authority: StaffProductAuthority;
  handle: string | null;
}
interface CreationIntent {
  readonly authority: StaffProductAuthority;
  readonly request: CreateSchoolTestRequest;
}
interface MutationIntent extends AuthorityIntent {
  readonly operation: TestWorkspaceMutation | "review_end";
  readonly baseline: StaffTest | null;
  readonly title: string | null;
  readonly creation: CreationIntent | null;
  phase: "verifying" | "submitting" | "refreshing";
  egress: boolean;
}
interface ReadIntent extends AuthorityIntent {
  readonly key: string;
  readonly before: TestPageCursor | null;
  readonly selectedId: string | null;
  readonly operation: "load" | "select";
  promise: Promise<TestWorkspaceSnapshot>;
}
interface EndIntent {
  readonly authority: StaffProductAuthority;
  readonly target: StaffTest;
}
interface TestFacts {
  readonly page: StaffTestPage;
  readonly selected: StaffTest | null;
  readonly unavailable: boolean;
}

function sameAuthority(
  a: StaffProductAuthority,
  b: StaffProductAuthority,
): boolean {
  return (
    a.accountId === b.accountId &&
    a.providerSessionId === b.providerSessionId &&
    a.profileId === b.profileId &&
    a.membershipId === b.membershipId &&
    a.schoolId === b.schoolId &&
    a.role === b.role &&
    a.assuranceLevel === b.assuranceLevel &&
    a.identityGeneration === b.identityGeneration &&
    a.sessionGeneration === b.sessionGeneration
  );
}
function sameTest(a: StaffTest, b: StaffTest): boolean {
  return (
    a.id === b.id &&
    a.schoolId === b.schoolId &&
    a.createdByProfileId === b.createdByProfileId &&
    a.title === b.title &&
    a.lifecycle === b.lifecycle &&
    a.revision === b.revision &&
    a.createdAt === b.createdAt &&
    a.openedAt === b.openedAt &&
    a.endedAt === b.endedAt
  );
}
function readyHandle(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    record.status === "ready" &&
    typeof record.authorityHandle === "string" &&
    record.authorityHandle.length > 0
    ? record.authorityHandle
    : null;
}
const emptyPage: StaffTestPage = Object.freeze({
  items: Object.freeze([]),
  nextCursor: null,
});

export function createTestWorkspaceController(
  dependencies: TestWorkspaceControllerDependencies,
): TestWorkspaceController {
  let disposed = false;
  let epoch = 0;
  let mode: StaffProductAccessState["kind"] = "unavailable";
  let authority: StaffProductAuthority | null = null;
  let school: SchoolSettings | null = null;
  let page: StaffTestPage | null = null;
  let before: TestPageCursor | null = null;
  let selected: StaffTest | null = null;
  let selectedId: string | null = null;
  let baseline: StaffTest | null = null;
  let titleDraft: string | null = null;
  let titleValidation: TestTitleValidation | null = null;
  let createDraft = "";
  let createValidation: TestTitleValidation | null = null;
  let creation: CreationIntent | null = null;
  let confirmation: EndIntent | null = null;
  let conflict: "save_title" | "open" | "end" | null = null;
  let notice: TestWorkspaceNotice | null = null;
  let readUnavailable = false;
  let mutation: MutationIntent | null = null;
  let reading: ReadIntent | null = null;
  const latest = new Map<string, StaffTest>();
  const listeners = new Set<(snapshot: TestWorkspaceSnapshot) => void>();
  let snapshot: TestWorkspaceSnapshot = Object.freeze({
    kind: "unavailable",
    revision: 0,
  });

  function publish(body: SnapshotBody): void {
    if (
      disposed ||
      JSON.stringify(body) === JSON.stringify(withoutRevision(snapshot))
    )
      return;
    snapshot = Object.freeze({ ...body, revision: snapshot.revision + 1 });
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* View failures do not settle operations. */
      }
    }
  }
  function release(intent: AuthorityIntent): void {
    const handle = intent.handle;
    intent.handle = null;
    if (handle !== null) {
      try {
        dependencies.port.releaseTestWorkspaceAuthority(handle);
      } catch {
        /* The port also bounds each handle's lifetime. */
      }
    }
  }
  function invalidate(retain: boolean): void {
    epoch += 1;
    if (mutation !== null) {
      if (retain && mutation.egress && mutation.operation !== "review_end") {
        notice = { kind: "unconfirmed", operation: mutation.operation };
        if (mutation.operation === "create") creation = mutation.creation;
      }
      release(mutation);
      mutation = null;
    }
    if (reading !== null) release(reading);
    reading = null;
    confirmation = null;
    if (!retain) {
      authority = null;
      school = null;
      page = null;
      before = null;
      selected = null;
      selectedId = null;
      baseline = null;
      titleDraft = null;
      titleValidation = null;
      createDraft = "";
      createValidation = null;
      creation = null;
      conflict = null;
      notice = null;
      readUnavailable = false;
      latest.clear();
    }
  }
  function data(): TestWorkspaceData {
    if (school === null)
      throw new Error("Test workspace presentation unavailable");
    return Object.freeze({
      school,
      page: page ?? emptyPage,
      selected,
      createDraft,
      createValidation,
      titleDraft,
      titleValidation,
    });
  }
  function adoptSelection(): void {
    baseline = selected;
    titleDraft = selected?.title ?? null;
    titleValidation = null;
    conflict = null;
  }
  function reconcile(): void {
    if (
      confirmation !== null &&
      (selected === null || !sameTest(confirmation.target, selected))
    ) {
      confirmation = null;
      conflict = "end";
    }
    if (selected === null) {
      baseline = null;
      titleDraft = null;
      titleValidation = null;
      return;
    }
    if (baseline === null || baseline.id !== selected.id) {
      adoptSelection();
      return;
    }
    if (sameTest(baseline, selected)) return;
    if (conflict !== null) return;
    if (titleDraft !== baseline.title) conflict = "save_title";
    else adoptSelection();
  }
  function project(): void {
    if (mode !== "ready" || school === null || authority === null) {
      publish({ kind: mode === "paused" ? "paused" : "unavailable" });
      return;
    }
    if (mutation !== null) {
      publish({
        kind: "busy",
        operation: mutation.operation,
        phase: mutation.phase,
        data: data(),
      });
      return;
    }
    if (reading !== null) {
      if (page === null) publish({ kind: "loading", school });
      else
        publish({
          kind: "busy",
          operation: reading.operation,
          phase: "refreshing",
          data: data(),
        });
      return;
    }
    if (readUnavailable) {
      publish({ kind: "read_unavailable", school });
      return;
    }
    if (page === null) {
      publish({ kind: "loading", school });
      return;
    }
    reconcile();
    if (creation !== null) {
      publish({
        kind: "create_unconfirmed",
        data: data(),
        submittedTitle: creation.request.title,
      });
    } else if (conflict !== null) {
      publish({ kind: "conflict", operation: conflict, data: data(), notice });
    } else if (confirmation !== null) {
      publish({
        kind: "confirming_end",
        data: data(),
        target: Object.freeze({
          testId: confirmation.target.id,
          title: confirmation.target.title,
          expectedTestRevision: confirmation.target.revision,
        }),
      });
    } else publish({ kind: "ready", data: data(), notice });
  }
  function setAccess(access: StaffProductAccessState): void {
    if (disposed) return;
    if (access.kind === "unavailable") {
      invalidate(false);
      mode = "unavailable";
      project();
      return;
    }
    if (access.kind === "paused") {
      const retain =
        authority !== null && sameAuthority(authority, access.authority);
      invalidate(retain);
      authority = Object.freeze({ ...access.authority });
      mode = "paused";
      project();
      return;
    }
    const parsed = parseSchoolSettings(access.access.school);
    const incoming = access.access.authority;
    if (
      parsed === null ||
      parsed.schoolId !== incoming.schoolId ||
      (incoming.role !== "teacher" && incoming.assuranceLevel !== "aal2")
    ) {
      setAccess({ kind: "unavailable" });
      return;
    }
    const same = authority !== null && sameAuthority(authority, incoming);
    if (!same) invalidate(false);
    authority = Object.freeze({ ...incoming });
    if (same && school !== null) {
      if (parsed.settingsRevision < school.settingsRevision) {
        mode = "ready";
        project();
        return;
      }
      if (
        parsed.settingsRevision === school.settingsRevision &&
        parsed.displayName !== school.displayName
      ) {
        setAccess({ kind: "unavailable" });
        return;
      }
    }
    school = Object.freeze({ ...parsed });
    mode = "ready";
    project();
  }
  function liveAccess(): StaffProductAccessState {
    try {
      return dependencies.getAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }
  function initiatingAuthority(): StaffProductAuthority | null {
    if (disposed || mode !== "ready" || authority === null) return null;
    const original = Object.freeze({ ...authority });
    const live = liveAccess();
    if (
      live.kind !== "ready" ||
      !sameAuthority(original, live.access.authority)
    ) {
      setAccess(live);
      return null;
    }
    setAccess(live);
    return mode === "ready" &&
      authority !== null &&
      sameAuthority(original, authority)
      ? original
      : null;
  }
  function isCurrent(intent: AuthorityIntent): boolean {
    return (
      !disposed &&
      intent.epoch === epoch &&
      (reading === intent || mutation === intent) &&
      mode === "ready" &&
      authority !== null &&
      sameAuthority(authority, intent.authority)
    );
  }
  function checkLive(intent: AuthorityIntent): boolean {
    if (!isCurrent(intent)) return false;
    setAccess(liveAccess());
    return isCurrent(intent);
  }
  async function refreshAccess(): Promise<StaffProductRefreshResult> {
    try {
      return await dependencies.refreshAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }
  function adoptFresh(
    intent: AuthorityIntent,
    result: StaffProductRefreshResult,
  ): boolean {
    if (!isCurrent(intent)) return false;
    const live = liveAccess();
    if (
      live.kind !== "ready" ||
      !sameAuthority(live.access.authority, intent.authority)
    ) {
      setAccess(live);
      return false;
    }
    if (result.kind === "unavailable") {
      setAccess({ kind: "unavailable" });
      return false;
    }
    if (result.kind === "paused") {
      setAccess({ kind: "paused", authority: intent.authority });
      return false;
    }
    if (!sameAuthority(result.access.authority, intent.authority)) {
      setAccess({ kind: "paused", authority: intent.authority });
      return false;
    }
    setAccess({ kind: "ready", access: result.access });
    return checkLive(intent);
  }
  async function capture(intent: AuthorityIntent): Promise<boolean> {
    if (!checkLive(intent)) return false;
    let raw: unknown;
    try {
      raw = await dependencies.port.captureTestWorkspaceAuthority(
        intent.authority.accountId,
        intent.authority.providerSessionId,
      );
    } catch {
      raw = null;
    }
    intent.handle = readyHandle(raw);
    return checkLive(intent) && intent.handle !== null;
  }
  function mergeTest(row: StaffTest): StaffTest | null {
    const previous = latest.get(row.id);
    if (previous !== undefined) {
      if (
        previous.schoolId !== row.schoolId ||
        previous.createdByProfileId !== row.createdByProfileId ||
        previous.createdAt !== row.createdAt
      )
        return null;
      if (row.revision < previous.revision) return previous;
      if (row.revision === previous.revision)
        return sameTest(row, previous) ? previous : null;
    }
    const frozen = Object.freeze({ ...row });
    latest.set(row.id, frozen);
    return frozen;
  }
  async function readFacts(
    intent: AuthorityIntent,
    cursor: TestPageCursor | null,
    targetId: string | null,
    expected: StaffTest | null = null,
  ): Promise<TestFacts | null> {
    if (!checkLive(intent) || intent.handle === null) return null;
    const request = Object.freeze({
      schoolId: intent.authority.schoolId,
      before: cursor,
    });
    let raw: unknown;
    try {
      raw = await dependencies.port.readSchoolTests(request, intent.handle);
    } catch {
      raw = null;
    }
    if (!checkLive(intent)) return null;
    const response = parseReadSchoolTestsRpcResult(raw, request);
    if (response === null || !response.ok) return null;
    const items: StaffTest[] = [];
    for (const row of response.page.items) {
      const merged = mergeTest(row);
      if (merged === null) return null;
      items.push(merged);
    }
    const rawTarget = response.page.items.find((row) => row.id === targetId);
    let target =
      targetId === null
        ? null
        : (items.find((row) => row.id === targetId) ?? null);
    let unavailable = false;
    if (
      targetId !== null &&
      (target === null ||
        (expected !== null &&
          (rawTarget?.revision !== expected.revision ||
            rawTarget?.lifecycle !== expected.lifecycle)))
    ) {
      if (!checkLive(intent) || intent.handle === null) return null;
      const targetRequest = Object.freeze({
        schoolId: intent.authority.schoolId,
        testId: targetId,
      });
      try {
        raw = await dependencies.port.readSchoolTest(
          targetRequest,
          intent.handle,
        );
      } catch {
        raw = null;
      }
      if (!checkLive(intent)) return null;
      const detail = parseReadSchoolTestRpcResult(raw, targetRequest);
      if (detail === null) return null;
      if (!detail.ok) {
        if (detail.code !== "test_unavailable") return null;
        unavailable = true;
        target = null;
      } else {
        // Monotonic display facts do not substitute for this operation's fresh target read.
        if (expected !== null && detail.test.revision < expected.revision)
          return null;
        target = mergeTest(detail.test);
        if (target === null) return null;
      }
    }
    return {
      page: Object.freeze({
        items: Object.freeze(items),
        nextCursor:
          response.page.nextCursor === null
            ? null
            : Object.freeze({ ...response.page.nextCursor }),
      }),
      selected: target,
      unavailable,
    };
  }
  function applyFacts(
    facts: TestFacts,
    cursor: TestPageCursor | null,
    targetId: string | null,
  ): void {
    page = facts.page;
    before = cursor;
    selected = facts.selected;
    selectedId = facts.unavailable ? null : targetId;
    readUnavailable = false;
    if (facts.unavailable) {
      confirmation = null;
      notice = { kind: "test_unavailable" };
    }
    project();
  }
  function startRead(
    result: StaffProductRefreshResult | undefined,
    cursor: TestPageCursor | null,
    targetId: string | null,
    operation: "load" | "select",
  ): Promise<TestWorkspaceSnapshot> {
    if (mutation !== null) return Promise.resolve(snapshot);
    const original = initiatingAuthority();
    if (original === null) return Promise.resolve(snapshot);
    if (result !== undefined && result.kind !== "fresh_authorized")
      return Promise.resolve(snapshot);
    const key = JSON.stringify([cursor, targetId]);
    if (reading !== null && reading.key === key && isCurrent(reading))
      return reading.promise;
    if (reading !== null) release(reading);
    const intent: ReadIntent = {
      epoch,
      authority: original,
      before: cursor === null ? null : Object.freeze({ ...cursor }),
      selectedId: targetId,
      operation,
      key,
      handle: null,
      promise: Promise.resolve(snapshot),
    };
    reading = intent;
    // Defer execution by one microtask so the shared promise exists before a
    // synchronous subscriber tries to coalesce this same read.
    intent.promise = Promise.resolve().then(async () => {
      const work = async (): Promise<void> => {
        if (!isCurrent(intent)) return;
        const fresh = result ?? (await refreshAccess());
        if (!adoptFresh(intent, fresh)) return;
        if (!(await capture(intent))) {
          if (isCurrent(intent)) readUnavailable = true;
          return;
        }
        const facts = await readFacts(intent, intent.before, intent.selectedId);
        if (!isCurrent(intent)) return;
        if (facts === null) {
          const refreshed = await refreshAccess();
          if (adoptFresh(intent, refreshed)) readUnavailable = true;
        } else applyFacts(facts, intent.before, intent.selectedId);
      };
      try {
        await work();
      } finally {
        release(intent);
        if (reading === intent) {
          reading = null;
          project();
        }
      }
      return snapshot;
    });
    project();
    return intent.promise;
  }
  function phase(intent: MutationIntent, value: MutationIntent["phase"]): void {
    if (!isCurrent(intent)) return;
    intent.phase = value;
    project();
  }
  function targetConflict(intent: MutationIntent): void {
    if (!isCurrent(intent) || intent.operation === "create") return;
    confirmation = null;
    conflict = intent.operation === "review_end" ? "end" : intent.operation;
    baseline = intent.baseline;
    if (intent.operation === "save_title") titleDraft = intent.title;
  }
  async function settleMutation(
    intent: MutationIntent,
    raw: unknown,
  ): Promise<void> {
    if (!isCurrent(intent) || intent.operation === "review_end") return;
    const response =
      intent.operation === "create"
        ? parseCreateSchoolTestRpcResult(raw)
        : intent.operation === "save_title"
          ? parseUpdateTestTitleRpcResult(raw)
          : intent.operation === "open"
            ? parseOpenTestRpcResult(raw)
            : parseEndTestRpcResult(raw);
    const unknown =
      response === null ||
      (!response.ok && response.code === "dependency_unavailable");
    const targetId =
      response?.ok && "testId" in response
        ? response.testId
        : (intent.baseline?.id ?? selectedId);
    phase(intent, "refreshing");
    const fresh = await refreshAccess();
    if (!adoptFresh(intent, fresh)) return;
    const cursor =
      intent.operation === "create" && response?.ok ? null : before;
    const facts = await readFacts(intent, cursor, targetId);
    if (!isCurrent(intent)) return;
    if (facts !== null) applyFacts(facts, cursor, targetId);
    else readUnavailable = true;
    confirmation = null;
    titleValidation = null;
    if (unknown) {
      notice = { kind: "unconfirmed", operation: intent.operation };
      if (intent.operation === "create") creation = intent.creation;
      if (intent.operation === "save_title") {
        baseline = intent.baseline;
        titleDraft = intent.title;
      }
      return;
    }
    if (response.ok) {
      notice = {
        kind: "confirmed",
        code: response.code,
        testId: targetId ?? "",
      };
      if (intent.operation === "create") {
        creation = null;
        createDraft = "";
        createValidation = null;
      }
      if (
        intent.operation === "create" ||
        intent.operation === "save_title" ||
        titleDraft === baseline?.title
      )
        adoptSelection();
      return;
    }
    if (response.code === "test_revision_conflict") {
      notice = null;
      targetConflict(intent);
    } else {
      notice =
        response.code === "test_unavailable"
          ? { kind: "test_unavailable" }
          : { kind: "rejected", operation: intent.operation };
      if (response.code === "test_unavailable") {
        selected = null;
        selectedId = null;
        baseline = null;
        titleDraft = null;
      }
      // A deterministic create denial never proves an earlier uncertain create
      // disappeared. Only the replay success or explicit abandonment clears it.
    }
  }
  async function performMutation(
    intent: MutationIntent,
  ): Promise<TestWorkspaceSnapshot> {
    const work = async (): Promise<void> => {
      if (!checkLive(intent)) return;
      const fresh = await refreshAccess();
      if (!adoptFresh(intent, fresh)) return;
      if (!(await capture(intent))) {
        if (isCurrent(intent) && intent.operation !== "review_end")
          notice = { kind: "rejected", operation: intent.operation };
        return;
      }
      if (intent.operation !== "create") {
        const facts = await readFacts(
          intent,
          before,
          intent.baseline?.id ?? null,
          intent.baseline,
        );
        if (!isCurrent(intent)) return;
        if (facts === null) {
          const refreshed = await refreshAccess();
          if (adoptFresh(intent, refreshed)) readUnavailable = true;
          return;
        }
        applyFacts(facts, before, intent.baseline?.id ?? null);
        if (!checkLive(intent)) return;
        if (facts.unavailable || facts.selected === null) {
          confirmation = null;
          notice = { kind: "test_unavailable" };
          return;
        }
        if (
          intent.baseline === null ||
          !sameTest(intent.baseline, facts.selected)
        ) {
          targetConflict(intent);
          return;
        }
        if (intent.operation === "review_end") {
          confirmation = {
            authority: intent.authority,
            target: intent.baseline,
          };
          conflict = null;
          return;
        }
      }
      phase(intent, "submitting");
      if (!checkLive(intent) || intent.handle === null) return;
      intent.egress = true;
      let raw: unknown;
      try {
        if (intent.operation === "create" && intent.creation !== null) {
          raw = await dependencies.port.createSchoolTest(
            intent.creation.request,
            intent.handle,
          );
        } else if (intent.baseline !== null) {
          const request: TestRevisionRequest = Object.freeze({
            schoolId: intent.authority.schoolId,
            testId: intent.baseline.id,
            expectedTestRevision: intent.baseline.revision,
          });
          if (intent.operation === "save_title" && intent.title !== null)
            raw = await dependencies.port.updateTestTitle(
              Object.freeze({ ...request, title: intent.title }),
              intent.handle,
            );
          else if (intent.operation === "open")
            raw = await dependencies.port.openTest(request, intent.handle);
          else if (intent.operation === "end")
            raw = await dependencies.port.endTest(request, intent.handle);
        }
      } catch {
        raw = null;
      }
      if (isCurrent(intent)) await settleMutation(intent, raw);
    };
    try {
      await work();
    } finally {
      release(intent);
      if (mutation === intent) {
        mutation = null;
        project();
      }
    }
    return snapshot;
  }
  function beginMutation(
    operation: MutationIntent["operation"],
    retry = false,
  ): Promise<TestWorkspaceSnapshot> {
    if (
      disposed ||
      mutation !== null ||
      reading !== null ||
      page === null ||
      (snapshot.kind !== "ready" &&
        !(retry && snapshot.kind === "create_unconfirmed") &&
        !(operation === "end" && snapshot.kind === "confirming_end"))
    )
      return Promise.resolve(snapshot);
    // Capture the rendered target, authority and submitted fields before any
    // refresh/capture promise. Later reads may update presentation, never intent.
    const original = initiatingAuthority();
    if (original === null) return Promise.resolve(snapshot);
    let capturedCreation: CreationIntent | null = null;
    let title: string | null = null;
    let target =
      operation === "end" ? (confirmation?.target ?? null) : baseline;
    if (operation === "create") {
      if (retry) {
        if (creation === null || !sameAuthority(creation.authority, original))
          return Promise.resolve(snapshot);
        capturedCreation = creation;
      } else {
        const validated = validateTestTitleDraft(createDraft);
        if (!validated.ok) {
          createValidation = validated.reason;
          project();
          return Promise.resolve(snapshot);
        }
        let id: string;
        try {
          id = dependencies.creationRequestIds.next();
        } catch {
          id = "";
        }
        const request = parseCreateSchoolTestRequest({
          schoolId: original.schoolId,
          creationRequestId: id,
          title: validated.title,
        });
        if (request === null) {
          notice = { kind: "rejected", operation: "create" };
          project();
          return Promise.resolve(snapshot);
        }
        capturedCreation = Object.freeze({
          authority: original,
          request: Object.freeze(request),
        });
      }
      target = null;
      createValidation = null;
    } else {
      if (
        target === null ||
        selected === null ||
        selected.id !== target.id ||
        selected.lifecycle === "ended"
      )
        return Promise.resolve(snapshot);
      if (
        operation === "end" &&
        (confirmation === null ||
          !sameAuthority(confirmation.authority, original))
      )
        return Promise.resolve(snapshot);
      if (
        (operation === "review_end" || operation === "end") &&
        target.lifecycle !== "open"
      )
        return Promise.resolve(snapshot);
      if (operation === "open" && target.lifecycle !== "draft")
        return Promise.resolve(snapshot);
      if (operation === "save_title") {
        const validated = validateTestTitleDraft(titleDraft ?? "");
        if (!validated.ok) {
          titleValidation = validated.reason;
          project();
          return Promise.resolve(snapshot);
        }
        title = validated.title;
      }
    }
    const intent: MutationIntent = {
      epoch,
      authority: original,
      operation,
      baseline: target === null ? null : Object.freeze({ ...target }),
      title,
      creation: capturedCreation,
      handle: null,
      phase: "verifying",
      egress: false,
    };
    mutation = intent;
    notice = null;
    titleValidation = null;
    project();
    return performMutation(intent);
  }
  function currentRevision(action: {
    readonly snapshotRevision: number;
  }): boolean {
    return action.snapshotRevision === snapshot.revision;
  }
  setAccess(liveAccess());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAccess,
    refreshFromStaff(result) {
      if (disposed || result.kind !== "fresh_authorized" || mutation !== null)
        return Promise.resolve(snapshot);
      // A quiet lifecycle refresh observes the user's in-flight page/selection;
      // it must not replace that intent with the previously settled view.
      return startRead(
        result,
        reading === null ? before : reading.before,
        reading === null ? selectedId : reading.selectedId,
        reading?.operation ?? "load",
      );
    },
    async dispatch(action) {
      if (disposed) return snapshot;
      if (
        action.type === "load" ||
        action.type === "refresh" ||
        action.type === "first_page" ||
        action.type === "next_page"
      ) {
        if (mutation !== null) return snapshot;
        if (action.type === "next_page" && page?.nextCursor == null)
          return snapshot;
        return startRead(
          undefined,
          action.type === "first_page"
            ? null
            : action.type === "next_page"
              ? page!.nextCursor
              : reading === null
                ? before
                : reading.before,
          reading === null ? selectedId : reading.selectedId,
          "load",
        );
      }
      if (action.type === "select_test") {
        if (
          mutation !== null ||
          page === null ||
          !page.items.some((row) => row.id === action.testId)
        )
          return snapshot;
        return startRead(undefined, before, action.testId, "select");
      }
      if (mutation !== null || reading !== null || mode !== "ready")
        return snapshot;
      if (action.type === "edit_create_title") {
        if (snapshot.kind !== "ready") return snapshot;
        createDraft = action.value;
        createValidation = null;
        notice = null;
        project();
        return snapshot;
      }
      if (action.type === "edit_title") {
        if (
          snapshot.kind !== "ready" ||
          selected === null ||
          selected.lifecycle === "ended"
        )
          return snapshot;
        titleDraft = action.value;
        titleValidation = null;
        notice = null;
        project();
        return snapshot;
      }
      if (!("snapshotRevision" in action) || !currentRevision(action))
        return snapshot;
      if (action.type === "create_test") return beginMutation("create");
      if (action.type === "retry_create") return beginMutation("create", true);
      if (action.type === "save_title") return beginMutation("save_title");
      if (action.type === "open_test") return beginMutation("open");
      if (action.type === "review_end") return beginMutation("review_end");
      if (action.type === "confirm_end") return beginMutation("end");
      if (initiatingAuthority() === null) return snapshot;
      if (
        action.type === "start_new_test" &&
        snapshot.kind === "create_unconfirmed"
      ) {
        creation = null;
        createDraft = "";
        createValidation = null;
        notice = null;
        project();
      } else if (
        action.type === "cancel_end" &&
        snapshot.kind === "confirming_end"
      ) {
        confirmation = null;
        project();
      } else if (
        action.type === "use_current_test" &&
        snapshot.kind === "conflict"
      ) {
        confirmation = null;
        notice = null;
        adoptSelection();
        project();
      } else if (
        action.type === "keep_title_draft" &&
        snapshot.kind === "conflict" &&
        conflict === "save_title" &&
        selected !== null &&
        selected.lifecycle !== "ended"
      ) {
        baseline = selected;
        conflict = null;
        titleValidation = null;
        notice = null;
        project();
      }
      return snapshot;
    },
    dispose() {
      if (disposed) return;
      invalidate(false);
      mode = "unavailable";
      snapshot = Object.freeze({
        kind: "unavailable",
        revision: snapshot.revision + 1,
      });
      disposed = true;
      listeners.clear();
    },
  };
}

function withoutRevision(value: TestWorkspaceSnapshot): unknown {
  const { revision, ...body } = value;
  void revision;
  return body;
}
