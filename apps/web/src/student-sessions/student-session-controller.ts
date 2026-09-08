import {
  encodeStudentMaterialDigestInput,
  parseIssueTestJoinCodeRequest,
  parseIssueTestJoinCodeRpcResult,
  parsePrepareStudentReadmissionRequest,
  parsePrepareStudentReadmissionRpcResult,
  parseReadSchoolTestRpcResult,
  parseReadStudentProtectionEventsRpcResult,
  parseReadStudentSessionsRpcResult,
  parseRemoveStudentSessionRpcResult,
  parseSchoolSettings,
  parseStaffTest,
  parseStudentJoinCode,
} from "@desmoslock/contracts";
import type {
  IssueTestJoinCodeRequest,
  PrepareStudentReadmissionRequest,
  SchoolSettings,
  StaffStudentSession,
  StaffStudentSessionPage,
  StaffStudentProtectionEventPage,
  StaffTest,
  StudentProtectionEventPageCursor,
  StudentSessionPageCursor,
} from "@desmoslock/contracts";
import type {
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../auth/staff-product-access.js";
import type { StudentSessionPort } from "./student-session-port.js";

export type StudentSessionMutation =
  "issue_code" | "remove" | "prepare_readmission";
export type StudentSessionIssuance = Exclude<StudentSessionMutation, "remove">;
export interface StaffStudentTarget {
  readonly test: StaffTest;
  readonly parentBusy: boolean;
}
export interface StudentCodeDisclosure {
  readonly kind: "join" | "readmission";
  readonly code: string;
  readonly expiresAt: string;
  readonly studentSessionId: string | null;
}
export type StudentSessionEvidence =
  | { readonly kind: "closed" }
  | {
      readonly kind: "loading" | "unavailable";
      readonly page: StaffStudentProtectionEventPage | null;
    }
  | { readonly kind: "ready"; readonly page: StaffStudentProtectionEventPage };
export interface StudentSessionData {
  readonly school: SchoolSettings;
  readonly test: StaffTest;
  readonly parentBusy: boolean;
  readonly page: StaffStudentSessionPage;
  readonly selected: StaffStudentSession | null;
  readonly disclosure: StudentCodeDisclosure | null;
  readonly evidence: StudentSessionEvidence;
}
export interface StudentSessionReview {
  readonly operation: StudentSessionMutation;
  readonly testId: string;
  readonly title: string;
  readonly studentSessionId: string | null;
  readonly syntheticDisplayName: string | null;
  readonly expectedTestRevision: number;
  readonly expectedSessionRevision: number | null;
  readonly stale: boolean;
}
export type StudentSessionNotice =
  | {
      readonly kind: "confirmed" | "rejected" | "unconfirmed" | "stale";
      readonly operation: StudentSessionMutation;
    }
  | { readonly kind: "selection_changed" | "test_unavailable" };
export type StudentSessionSnapshot = { readonly revision: number } & (
  | { readonly kind: "unavailable" | "paused" }
  | {
      readonly kind: "loading" | "read_unavailable" | "ready";
      readonly data: StudentSessionData;
      readonly notice: StudentSessionNotice | null;
    }
  | {
      readonly kind: "busy";
      readonly data: StudentSessionData;
      readonly operation: "load" | StudentSessionMutation;
      readonly phase: "verifying" | "submitting" | "refreshing";
    }
  | {
      readonly kind: "review";
      readonly data: StudentSessionData;
      readonly target: StudentSessionReview;
      readonly notice: StudentSessionNotice | null;
    }
  | {
      readonly kind: "unconfirmed";
      readonly data: StudentSessionData;
      readonly operation: StudentSessionIssuance;
      readonly notice: StudentSessionNotice | null;
    }
);
export type StudentSessionAction =
  | { readonly type: "load" | "refresh" | "first_page" | "next_page" }
  | {
      readonly type: "select_session";
      readonly studentSessionId: string;
      readonly snapshotRevision: number;
    }
  | {
      readonly type:
        | "review_issue_code"
        | "review_remove"
        | "review_prepare_readmission"
        | "confirm_review"
        | "cancel_review"
        | "retry_issuance"
        | "dismiss_code"
        | "open_evidence"
        | "close_evidence"
        | "evidence_first_page"
        | "evidence_next_page"
        | "refresh_evidence";
      readonly snapshotRevision: number;
    };
export interface StudentSessionController {
  getSnapshot(): StudentSessionSnapshot;
  subscribe(listener: (snapshot: StudentSessionSnapshot) => void): () => void;
  setAccess(access: StaffProductAccessState): void;
  setTarget(target: StaffStudentTarget | null): void;
  refreshFromStaff(
    result: StaffProductRefreshResult,
  ): Promise<StudentSessionSnapshot>;
  dispatch(action: StudentSessionAction): Promise<StudentSessionSnapshot>;
  dispose(): void;
}
export interface StudentSessionControllerDependencies {
  readonly port: StudentSessionPort;
  readonly getAccess: () => StaffProductAccessState;
  readonly refreshAccess: () => Promise<StaffProductRefreshResult>;
  readonly requestSelectedTestRefresh: (target: {
    readonly schoolId: string;
    readonly testId: string;
  }) => void;
  /** Presentation expiry only; server authority is established by the port. */
  readonly now?: () => number;
  readonly issuance?: {
    nextCode(): string;
    nextRequestId(): string;
    digestCode(code: string): Promise<string>;
  };
}

type SnapshotBody = StudentSessionSnapshot extends infer S
  ? S extends StudentSessionSnapshot
    ? Omit<S, "revision">
    : never
  : never;
interface ReviewIntent {
  readonly authority: StaffProductAuthority;
  readonly test: StaffTest;
  readonly session: StaffStudentSession | null;
  readonly operation: StudentSessionMutation;
  issuance: PrivateIssuance | null;
  stale: boolean;
}
interface PrivateIssuance {
  readonly operation: StudentSessionIssuance;
  readonly authority: StaffProductAuthority;
  readonly test: StaffTest;
  readonly session: StaffStudentSession | null;
  readonly code: string;
  readonly request: IssueTestJoinCodeRequest | PrepareStudentReadmissionRequest;
}
interface Work {
  readonly epoch: number;
  readonly authority: StaffProductAuthority;
  readonly test: StaffTest;
  readonly kind: "read" | "evidence" | "review" | "mutation";
  readonly review: ReviewIntent | null;
  readonly before: StudentSessionPageCursor | null;
  readonly evidenceBefore: StudentProtectionEventPageCursor | null;
  readonly quiet: boolean;
  readonly retry: boolean;
  handle: string | null;
  egress: boolean;
  phase: "verifying" | "submitting" | "refreshing";
  promise: Promise<StudentSessionSnapshot>;
}
interface EvidenceBinding {
  readonly schoolId: string;
  readonly testId: string;
  readonly studentSessionId: string;
  readonly sessionEpoch: number;
}

const emptyPage: StaffStudentSessionPage = Object.freeze({
  items: Object.freeze([]),
  nextCursor: null,
});
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
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
function sameTarget(a: StaffTest, b: StaffTest): boolean {
  return (
    a.id === b.id &&
    a.schoolId === b.schoolId &&
    a.createdAt === b.createdAt &&
    a.createdByProfileId === b.createdByProfileId &&
    a.lifecycle === b.lifecycle
  );
}
function sameSession(a: StaffStudentSession, b: StaffStudentSession): boolean {
  return (
    a.id === b.id &&
    a.schoolId === b.schoolId &&
    a.testId === b.testId &&
    a.createdAt === b.createdAt &&
    a.syntheticDisplayName === b.syntheticDisplayName &&
    a.revision === b.revision &&
    a.epoch === b.epoch &&
    a.state === b.state
  );
}
function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Reflect.ownKeys(value);
    if (
      names.length !== keys.length ||
      names.some((name) => typeof name !== "string" || !keys.includes(name))
    )
      return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        return null;
      result[key] = descriptor.value as unknown;
    }
    return result;
  } catch {
    return null;
  }
}
function parseAction(value: unknown): StudentSessionAction | null {
  const simple = exactRecord(value, ["type"]);
  if (
    simple !== null &&
    (simple.type === "load" ||
      simple.type === "refresh" ||
      simple.type === "first_page" ||
      simple.type === "next_page")
  )
    return { type: simple.type };
  const selection = exactRecord(value, [
    "type",
    "studentSessionId",
    "snapshotRevision",
  ]);
  if (
    selection !== null &&
    selection.type === "select_session" &&
    typeof selection.studentSessionId === "string" &&
    typeof selection.snapshotRevision === "number" &&
    Number.isSafeInteger(selection.snapshotRevision) &&
    selection.snapshotRevision >= 0
  )
    return {
      type: selection.type,
      studentSessionId: selection.studentSessionId,
      snapshotRevision: selection.snapshotRevision,
    };
  const action = exactRecord(value, ["type", "snapshotRevision"]);
  if (
    action === null ||
    typeof action.snapshotRevision !== "number" ||
    !Number.isSafeInteger(action.snapshotRevision) ||
    action.snapshotRevision < 0
  )
    return null;
  if (
    action.type === "review_issue_code" ||
    action.type === "review_remove" ||
    action.type === "review_prepare_readmission" ||
    action.type === "confirm_review" ||
    action.type === "cancel_review" ||
    action.type === "retry_issuance" ||
    action.type === "dismiss_code" ||
    action.type === "open_evidence" ||
    action.type === "close_evidence" ||
    action.type === "evidence_first_page" ||
    action.type === "evidence_next_page" ||
    action.type === "refresh_evidence"
  )
    return { type: action.type, snapshotRevision: action.snapshotRevision };
  return null;
}
function readyHandle(value: unknown): string | null {
  const row = exactRecord(value, ["status", "authorityHandle"]);
  return row?.status === "ready" &&
    typeof row.authorityHandle === "string" &&
    row.authorityHandle.length > 0 &&
    row.authorityHandle.length <= 256
    ? row.authorityHandle
    : null;
}

export function createStudentSessionController(
  dependencies: StudentSessionControllerDependencies,
): StudentSessionController {
  let disposed = false;
  let epoch = 0;
  let mode: StaffProductAccessState["kind"] = "unavailable";
  let authority: StaffProductAuthority | null = null;
  let school: SchoolSettings | null = null;
  let target: StaffStudentTarget | null = null;
  let page: StaffStudentSessionPage | null = null;
  let before: StudentSessionPageCursor | null = null;
  let selected: StaffStudentSession | null = null;
  let disclosure: StudentCodeDisclosure | null = null;
  let evidence: StudentSessionEvidence = Object.freeze({ kind: "closed" });
  let evidenceBinding: EvidenceBinding | null = null;
  let evidenceBefore: StudentProtectionEventPageCursor | null = null;
  let evidenceGeneration = 0;
  let review: ReviewIntent | null = null;
  let pending: PrivateIssuance | null = null;
  let notice: StudentSessionNotice | null = null;
  let readUnavailable = false;
  let active: Work | null = null;
  const now = dependencies.now ?? Date.now;
  const latest = new Map<string, StaffStudentSession>();
  const listeners = new Set<(snapshot: StudentSessionSnapshot) => void>();
  let snapshot: StudentSessionSnapshot = Object.freeze({
    kind: "unavailable",
    revision: 0,
  });
  const issuance = dependencies.issuance ?? {
    nextCode: () =>
      Array.from(
        crypto.getRandomValues(new Uint8Array(12)),
        (byte) => alphabet[byte & 31],
      ).join(""),
    nextRequestId: () => crypto.randomUUID(),
    async digestCode(code: string): Promise<string> {
      const bytes = encodeStudentMaterialDigestInput("joinMaterial", code);
      if (bytes === null) throw new Error("Invalid join material");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(bytes),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    },
  };

  function publish(body: SnapshotBody): void {
    const previous = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== "revision"),
    );
    if (disposed || JSON.stringify(body) === JSON.stringify(previous)) return;
    if ("notice" in body && body.notice !== null) Object.freeze(body.notice);
    snapshot = Object.freeze({ ...body, revision: snapshot.revision + 1 });
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Presentation cannot settle authority. */
      }
    }
  }
  function release(work: Work): void {
    const handle = work.handle;
    work.handle = null;
    if (handle !== null) {
      try {
        dependencies.port.releaseStudentSessionAuthority(handle);
      } catch {
        /* The port also expires handles. */
      }
    }
  }
  function clearEvidence(): void {
    evidenceGeneration += 1;
    evidence = Object.freeze({ kind: "closed" });
    evidenceBinding = null;
    evidenceBefore = null;
  }
  function evidenceSelectionMatches(binding: EvidenceBinding): boolean {
    return (
      selected !== null &&
      selected.schoolId === binding.schoolId &&
      selected.testId === binding.testId &&
      selected.id === binding.studentSessionId &&
      selected.epoch === binding.sessionEpoch
    );
  }
  function reconcileEvidence(): void {
    if (evidenceBinding !== null && !evidenceSelectionMatches(evidenceBinding))
      clearEvidence();
  }
  function settleEvidenceRead(): void {
    if (evidence.kind !== "loading") return;
    evidence = Object.freeze(
      evidence.page === null
        ? { kind: "unavailable", page: null }
        : { kind: "ready", page: evidence.page },
    );
  }
  function invalidate(clear: boolean): void {
    epoch += 1;
    clearEvidence();
    if (active !== null) {
      if (!clear && active.egress && active.review !== null) {
        notice = { kind: "unconfirmed", operation: active.review.operation };
        if (active.review.issuance !== null) pending = active.review.issuance;
        review = null;
      }
      release(active);
      active = null;
    }
    if (clear) {
      page = null;
      before = null;
      selected = null;
      disclosure = null;
      review = null;
      pending = null;
      notice = null;
      readUnavailable = false;
      latest.clear();
    }
  }
  function data(): StudentSessionData {
    if (school === null || target === null)
      throw new Error("Student presentation unavailable");
    return Object.freeze({
      school,
      test: target.test,
      parentBusy: target.parentBusy,
      page: page ?? emptyPage,
      selected,
      disclosure,
      evidence,
    });
  }
  function staleReview(value: ReviewIntent): boolean {
    if (target === null || !sameTarget(value.test, target.test)) return true;
    if (value.operation === "issue_code")
      return value.test.revision !== target.test.revision;
    const current =
      value.session === null ? null : latest.get(value.session.id);
    return (
      value.session === null ||
      current === undefined ||
      current === null ||
      !sameSession(value.session, current)
    );
  }
  function project(): void {
    if (disclosure !== null) {
      const nowMs = now();
      if (!Number.isFinite(nowMs) || nowMs >= Date.parse(disclosure.expiresAt))
        disclosure = null;
    }
    if (
      mode !== "ready" ||
      school === null ||
      authority === null ||
      target === null
    ) {
      publish({ kind: mode === "paused" ? "paused" : "unavailable" });
      return;
    }
    if (active !== null && !active.quiet) {
      if (active.kind === "read" && page === null)
        publish({ kind: "loading", data: data(), notice });
      else
        publish({
          kind: "busy",
          data: data(),
          operation: active.review?.operation ?? "load",
          phase: active.phase,
        });
      return;
    }
    if (review !== null) {
      review.stale ||= staleReview(review);
      publish({
        kind: "review",
        data: data(),
        target: Object.freeze({
          operation: review.operation,
          testId: review.test.id,
          title: review.test.title,
          studentSessionId: review.session?.id ?? null,
          syntheticDisplayName: review.session?.syntheticDisplayName ?? null,
          expectedTestRevision: review.test.revision,
          expectedSessionRevision: review.session?.revision ?? null,
          stale: review.stale,
        }),
        notice,
      });
    } else if (pending !== null)
      publish({
        kind: "unconfirmed",
        data: data(),
        operation: pending.operation,
        notice,
      });
    else
      publish({
        kind: readUnavailable
          ? "read_unavailable"
          : page === null
            ? "loading"
            : "ready",
        data: data(),
        notice,
      });
  }
  function setAccess(access: StaffProductAccessState): void {
    if (disposed) return;
    if (access.kind === "unavailable") {
      invalidate(true);
      authority = null;
      school = null;
      target = null;
      mode = "unavailable";
      project();
      return;
    }
    const incoming =
      access.kind === "ready" ? access.access.authority : access.authority;
    const same = authority !== null && sameAuthority(authority, incoming);
    if (!same) {
      invalidate(true);
      target = null;
      school = null;
    }
    authority = Object.freeze({ ...incoming });
    if (access.kind === "paused") {
      if (mode !== "paused") invalidate(false);
      mode = "paused";
      project();
      return;
    }
    const parsed = parseSchoolSettings(access.access.school);
    if (
      parsed === null ||
      parsed.schoolId !== incoming.schoolId ||
      (incoming.role !== "teacher" &&
        incoming.role !== "administrator" &&
        incoming.role !== "owner") ||
      (incoming.assuranceLevel !== "aal1" &&
        incoming.assuranceLevel !== "aal2") ||
      (incoming.role !== "teacher" && incoming.assuranceLevel !== "aal2")
    ) {
      setAccess({ kind: "unavailable" });
      return;
    }
    if (
      school !== null &&
      parsed.settingsRevision === school.settingsRevision &&
      parsed.displayName !== school.displayName
    ) {
      setAccess({ kind: "unavailable" });
      return;
    }
    if (school === null || parsed.settingsRevision >= school.settingsRevision)
      school = Object.freeze({ ...parsed });
    mode = "ready";
    project();
  }
  function setTarget(value: StaffStudentTarget | null): void {
    if (disposed) return;
    const parsed = value === null ? null : parseStaffTest(value.test);
    if (
      parsed === null ||
      authority === null ||
      parsed.schoolId !== authority.schoolId ||
      typeof value?.parentBusy !== "boolean"
    ) {
      invalidate(true);
      target = null;
      project();
      return;
    }
    if (target === null || !sameTarget(target.test, parsed)) invalidate(true);
    else if (parsed.revision < target.test.revision) {
      target = Object.freeze({
        test: target.test,
        parentBusy: value.parentBusy,
      });
      project();
      return;
    } else if (
      parsed.revision === target.test.revision &&
      JSON.stringify(parsed) !== JSON.stringify(target.test)
    ) {
      invalidate(true);
      target = null;
      project();
      return;
    }
    target = Object.freeze({
      test: Object.freeze({ ...parsed }),
      parentBusy: value.parentBusy,
    });
    project();
  }
  function liveAccess(): StaffProductAccessState {
    try {
      return dependencies.getAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }
  function current(work: Work): boolean {
    return (
      !disposed &&
      active === work &&
      work.epoch === epoch &&
      mode === "ready" &&
      authority !== null &&
      sameAuthority(authority, work.authority) &&
      target !== null &&
      sameTarget(target.test, work.test)
    );
  }
  function checkLive(work: Work): boolean {
    if (!current(work)) return false;
    setAccess(liveAccess());
    return current(work);
  }
  async function refreshAccess(): Promise<StaffProductRefreshResult> {
    try {
      return await dependencies.refreshAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }
  function adoptFresh(work: Work, result: StaffProductRefreshResult): boolean {
    if (!checkLive(work)) return false;
    if (result.kind !== "fresh_authorized") {
      setAccess(
        result.kind === "paused"
          ? { kind: "paused", authority: work.authority }
          : { kind: "unavailable" },
      );
      return false;
    }
    if (!sameAuthority(result.access.authority, work.authority)) {
      setAccess({ kind: "paused", authority: work.authority });
      return false;
    }
    setAccess({ kind: "ready", access: result.access });
    return checkLive(work);
  }
  async function capture(work: Work): Promise<boolean> {
    if (!checkLive(work)) return false;
    let raw: unknown;
    try {
      raw = await dependencies.port.captureStudentSessionAuthority(
        work.authority.accountId,
        work.authority.providerSessionId,
      );
    } catch {
      raw = null;
    }
    work.handle = readyHandle(raw);
    if (!checkLive(work) || work.handle === null) {
      release(work);
      return false;
    }
    return true;
  }
  function applyPage(
    value: StaffStudentSessionPage,
    cursor: StudentSessionPageCursor | null,
  ): boolean {
    const items: StaffStudentSession[] = [];
    for (const item of value.items) {
      const old = latest.get(item.id);
      if (
        old !== undefined &&
        (old.createdAt !== item.createdAt ||
          old.syntheticDisplayName !== item.syntheticDisplayName ||
          (old.revision === item.revision && !sameSession(old, item)))
      )
        return false;
      items.push(
        old !== undefined && old.revision > item.revision
          ? old
          : Object.freeze({ ...item }),
      );
    }
    for (const item of items) latest.set(item.id, item);
    page = Object.freeze({
      items: Object.freeze(items),
      nextCursor:
        value.nextCursor === null
          ? null
          : Object.freeze({ ...value.nextCursor }),
    });
    before = cursor;
    if (selected !== null)
      selected = items.find((item) => item.id === selected?.id) ?? null;
    reconcileEvidence();
    readUnavailable = false;
    return true;
  }
  async function readFacts(
    work: Work,
  ): Promise<{ test: StaffTest; page: StaffStudentSessionPage } | null> {
    if (!checkLive(work) || work.handle === null) return null;
    const targetRequest = Object.freeze({
      schoolId: work.authority.schoolId,
      testId: work.test.id,
    });
    let raw: unknown;
    try {
      raw = await dependencies.port.readStudentTarget(
        targetRequest,
        work.handle,
      );
    } catch {
      raw = null;
    }
    if (!checkLive(work)) return null;
    const response = parseReadSchoolTestRpcResult(raw, targetRequest);
    if (!checkLive(work)) return null;
    if (response === null || !response.ok) return null;
    if (!sameTarget(response.test, work.test)) {
      setTarget({
        test: response.test,
        parentBusy: target?.parentBusy ?? false,
      });
      return null;
    }
    setTarget({ test: response.test, parentBusy: target?.parentBusy ?? false });
    if (!checkLive(work) || work.handle === null) return null;
    const request = Object.freeze({ ...targetRequest, before: work.before });
    try {
      raw = await dependencies.port.readStudentSessions(request, work.handle);
    } catch {
      raw = null;
    }
    if (!checkLive(work)) return null;
    const sessions = parseReadStudentSessionsRpcResult(raw, request);
    if (!checkLive(work)) return null;
    if (
      sessions === null ||
      !sessions.ok ||
      !applyPage(sessions.page, work.before)
    )
      return null;
    return { test: response.test, page: sessions.page };
  }
  async function readEvidence(
    work: Work,
    cursor: StudentProtectionEventPageCursor | null,
  ): Promise<void> {
    const binding = evidenceBinding;
    const generation = evidenceGeneration;
    if (evidence.kind === "closed" || binding === null) return;
    const previousPage = evidence.page;
    const currentEvidence = () =>
      checkLive(work) &&
      evidenceGeneration === generation &&
      evidenceBinding === binding &&
      evidenceSelectionMatches(binding) &&
      evidence.kind !== "closed";
    if (!currentEvidence() || work.handle === null) return;
    if (!work.quiet || work.kind === "evidence" || previousPage === null)
      evidence = Object.freeze({ kind: "loading", page: previousPage });
    project();
    if (!currentEvidence() || work.handle === null) return;
    const request = Object.freeze({
      schoolId: binding.schoolId,
      testId: binding.testId,
      studentSessionId: binding.studentSessionId,
      before: cursor,
    });
    let raw: unknown;
    try {
      raw = await dependencies.port.readStudentProtectionEvents(
        request,
        work.handle,
      );
    } catch {
      raw = null;
    }
    if (!currentEvidence()) return;
    const response = parseReadStudentProtectionEventsRpcResult(raw, request);
    if (!currentEvidence()) return;
    if (
      response === null ||
      !response.ok ||
      response.page.items.some(
        (item) => item.fact.scope.epoch > binding.sessionEpoch,
      )
    ) {
      evidence = Object.freeze({
        kind: "unavailable",
        page:
          response !== null &&
          !response.ok &&
          response.code !== "dependency_unavailable"
            ? null
            : previousPage,
      });
      return;
    }
    evidenceBefore = cursor;
    evidence = Object.freeze({ kind: "ready", page: response.page });
  }
  function factsMatch(
    work: Work,
    facts: { test: StaffTest; page: StaffStudentSessionPage },
  ): boolean {
    const intent = work.review;
    if (intent === null || facts.test.lifecycle !== "open") return false;
    if (intent.operation === "issue_code")
      return facts.test.revision === intent.test.revision;
    const item = facts.page.items.find((row) => row.id === intent.session?.id);
    return (
      item !== undefined &&
      intent.session !== null &&
      sameSession(item, intent.session)
    );
  }
  async function prepareIssuance(work: Work): Promise<boolean> {
    const intent = work.review;
    if (
      intent === null ||
      intent.operation === "remove" ||
      intent.issuance !== null
    )
      return true;
    let code: string | null;
    let requestId: string;
    let digest: string;
    try {
      code = parseStudentJoinCode(issuance.nextCode());
      requestId = issuance.nextRequestId();
      if (code === null) return false;
      digest = await issuance.digestCode(code);
    } catch {
      return false;
    }
    if (!checkLive(work)) return false;
    const material = {
      schoolId: work.authority.schoolId,
      testId: work.test.id,
      issuanceRequestId: requestId,
      joinMaterialDigest: digest,
    };
    const request =
      intent.operation === "issue_code"
        ? parseIssueTestJoinCodeRequest({
            ...material,
            expectedTestRevision: intent.test.revision,
          })
        : parsePrepareStudentReadmissionRequest({
            ...material,
            studentSessionId: intent.session?.id,
            expectedSessionRevision: intent.session?.revision,
          });
    if (request === null) return false;
    intent.issuance = Object.freeze({
      operation: intent.operation,
      authority: work.authority,
      test: intent.test,
      session: intent.session,
      code,
      request: Object.freeze(request),
    });
    return true;
  }
  async function submit(work: Work): Promise<void> {
    const intent = work.review;
    if (
      intent === null ||
      !checkLive(work) ||
      work.handle === null ||
      target?.parentBusy
    )
      return;
    work.phase = "submitting";
    project();
    // A subscriber can change authority or pause the parent during publication.
    if (!checkLive(work) || work.handle === null || target?.parentBusy) return;
    work.egress = true;
    if (intent.issuance !== null) {
      pending = intent.issuance;
      disclosure = null;
    }
    let raw: unknown;
    try {
      if (
        intent.operation === "issue_code" &&
        intent.issuance !== null &&
        "expectedTestRevision" in intent.issuance.request
      )
        raw = await dependencies.port.issueTestJoinCode(
          intent.issuance.request,
          work.handle,
        );
      else if (
        intent.operation === "prepare_readmission" &&
        intent.issuance !== null &&
        "studentSessionId" in intent.issuance.request
      )
        raw = await dependencies.port.prepareStudentReadmission(
          intent.issuance.request,
          work.handle,
        );
      else if (intent.operation === "remove" && intent.session !== null)
        raw = await dependencies.port.removeStudentSession(
          Object.freeze({
            schoolId: work.authority.schoolId,
            testId: work.test.id,
            studentSessionId: intent.session.id,
            expectedSessionRevision: intent.session.revision,
          }),
          work.handle,
        );
    } catch {
      raw = null;
    }
    if (!checkLive(work)) return;
    const response =
      intent.operation === "issue_code" &&
      intent.issuance !== null &&
      "expectedTestRevision" in intent.issuance.request
        ? parseIssueTestJoinCodeRpcResult(raw, intent.issuance.request)
        : intent.operation === "prepare_readmission" &&
            intent.issuance !== null &&
            "studentSessionId" in intent.issuance.request
          ? parsePrepareStudentReadmissionRpcResult(
              raw,
              intent.issuance.request,
            )
          : intent.session !== null
            ? parseRemoveStudentSessionRpcResult(raw, {
                schoolId: work.authority.schoolId,
                testId: work.test.id,
                studentSessionId: intent.session.id,
                expectedSessionRevision: intent.session.revision,
              })
            : null;
    if (!checkLive(work)) return;
    work.phase = "refreshing";
    project();
    if (!checkLive(work)) return;
    if (!adoptFresh(work, await refreshAccess())) return;
    review = null;
    if (
      response === null ||
      (!response.ok && response.code === "dependency_unavailable")
    ) {
      notice = { kind: "unconfirmed", operation: intent.operation };
      return;
    }
    if (!response.ok) {
      const conflict =
        response.code === "test_revision_conflict" ||
        response.code === "student_session_revision_conflict";
      notice = {
        kind: conflict ? "stale" : "rejected",
        operation: intent.operation,
      };
      // A later denial cannot resolve a previous uncertain issuance.
      if (!work.retry) pending = null;
      return;
    }
    notice = { kind: "confirmed", operation: intent.operation };
    if (intent.issuance !== null && "expiresAt" in response) {
      pending = null;
      disclosure = Object.freeze({
        kind: intent.operation === "issue_code" ? "join" : "readmission",
        code: intent.issuance.code,
        expiresAt: response.expiresAt,
        studentSessionId: intent.session?.id ?? null,
      });
    }
    if (intent.operation !== "issue_code") {
      const facts = await readFacts(work);
      if (current(work) && facts === null) readUnavailable = true;
    }
  }
  function stopQuietRead(): void {
    if (
      (active?.kind === "read" || active?.kind === "evidence") &&
      active.quiet
    ) {
      const old = active;
      active = null;
      release(old);
      settleEvidenceRead();
    }
  }
  function begin(
    kind: Work["kind"],
    intent: ReviewIntent | null,
    cursor: StudentSessionPageCursor | null,
    fresh: StaffProductRefreshResult | null = null,
    quiet = false,
    retry = false,
    evidenceCursor: StudentProtectionEventPageCursor | null = null,
  ): Promise<StudentSessionSnapshot> {
    if (
      disposed ||
      active !== null ||
      authority === null ||
      target === null ||
      mode !== "ready"
    )
      return Promise.resolve(snapshot);
    const original = authority;
    setAccess(liveAccess());
    if (
      active !== null ||
      authority === null ||
      !sameAuthority(original, authority) ||
      target === null ||
      mode !== "ready"
    )
      return Promise.resolve(snapshot);
    const work: Work = {
      epoch,
      authority: original,
      test: target.test,
      kind,
      review: intent,
      before: cursor,
      evidenceBefore: evidenceCursor,
      quiet,
      retry,
      handle: null,
      egress: false,
      phase: "verifying",
      promise: Promise.resolve(snapshot),
    };
    active = work;
    work.promise = Promise.resolve().then(async () => {
      let refreshParent = false;
      const run = async (): Promise<void> => {
        if (
          !checkLive(work) ||
          !adoptFresh(work, fresh ?? (await refreshAccess()))
        )
          return;
        if (!(await capture(work))) {
          if (current(work)) {
            if (evidence.kind !== "closed")
              evidence = Object.freeze({
                kind: "unavailable",
                page: evidence.page,
              });
            if (intent === null && kind !== "evidence") readUnavailable = true;
            else if (intent !== null)
              notice = { kind: "rejected", operation: intent.operation };
          }
          return;
        }
        if (kind === "evidence") {
          await readEvidence(work, work.evidenceBefore);
          return;
        }
        const facts = await readFacts(work);
        if (!current(work)) return;
        if (facts === null) {
          readUnavailable = true;
          if (evidence.kind !== "closed")
            evidence = Object.freeze({
              kind: "unavailable",
              page: evidence.page,
            });
          return;
        }
        if (kind === "read") {
          await readEvidence(work, evidenceBefore);
          return;
        }
        if (intent === null) return;
        // Receipt recovery is a distinct path: preserve original revisions and
        // candidates even if the prior unconfirmed commit changed the row.
        if (!retry && !factsMatch(work, facts)) {
          intent.stale = true;
          review = intent;
          notice = { kind: "stale", operation: intent.operation };
          return;
        }
        if (!(await prepareIssuance(work))) {
          if (current(work))
            notice = { kind: "rejected", operation: intent.operation };
          return;
        }
        if (!checkLive(work)) return;
        review = intent;
        if (kind === "review" || target?.parentBusy) return;
        await submit(work);
        refreshParent =
          work.egress && intent.operation === "issue_code" && current(work);
      };
      try {
        await run();
      } finally {
        release(work);
        if (active === work) {
          active = null;
          project();
        }
        if (
          refreshParent &&
          !disposed &&
          authority !== null &&
          sameAuthority(authority, work.authority) &&
          target !== null &&
          sameTarget(target.test, work.test)
        ) {
          try {
            dependencies.requestSelectedTestRefresh(
              Object.freeze({
                schoolId: work.authority.schoolId,
                testId: work.test.id,
              }),
            );
          } catch {
            /* The next shared staff cycle can refresh the parent. */
          }
        }
      }
      return snapshot;
    });
    project();
    return work.promise;
  }
  function startReview(
    operation: StudentSessionMutation,
  ): Promise<StudentSessionSnapshot> {
    if (
      target === null ||
      target.parentBusy ||
      target.test.lifecycle !== "open" ||
      authority === null ||
      page === null
    )
      return Promise.resolve(snapshot);
    const session = operation === "issue_code" ? null : selected;
    if (
      operation !== "issue_code" &&
      (session === null ||
        (operation === "remove"
          ? session.state !== "active"
          : session.state === "active"))
    )
      return Promise.resolve(snapshot);
    stopQuietRead();
    if (active !== null) return Promise.resolve(snapshot);
    notice = null;
    const intent: ReviewIntent = {
      authority,
      test: target.test,
      session,
      operation,
      issuance: null,
      stale: false,
    };
    return begin("review", intent, before);
  }
  function evidenceWorkActive(): boolean {
    return active?.kind === "evidence";
  }
  function dispatchEvidence(
    type:
      | "open_evidence"
      | "close_evidence"
      | "evidence_first_page"
      | "evidence_next_page"
      | "refresh_evidence",
  ): Promise<StudentSessionSnapshot> {
    if (type === "close_evidence") {
      clearEvidence();
      stopQuietRead();
      project();
      return Promise.resolve(snapshot);
    }
    if (
      selected === null ||
      target === null ||
      target.parentBusy ||
      authority === null ||
      mode !== "ready" ||
      selected.schoolId !== authority.schoolId ||
      selected.testId !== target.test.id ||
      (type !== "open_evidence" && evidence.kind === "closed")
    )
      return Promise.resolve(snapshot);
    if (type === "open_evidence" && evidence.kind !== "closed")
      return active?.promise ?? Promise.resolve(snapshot);
    const next = evidence.kind === "closed" ? null : evidence.page?.nextCursor;
    if (type === "evidence_next_page" && next == null)
      return Promise.resolve(snapshot);
    if (type === "evidence_first_page" || type === "evidence_next_page") {
      const binding = evidenceBinding;
      stopQuietRead();
      if (
        binding === null ||
        evidenceBinding !== binding ||
        !evidenceSelectionMatches(binding)
      )
        return Promise.resolve(snapshot);
    }
    if (
      active !== null &&
      !(active.kind === "read" && active.quiet && type === "open_evidence")
    )
      return active.kind === "evidence" ||
        (active.kind === "read" && active.quiet)
        ? active.promise
        : Promise.resolve(snapshot);
    if (type === "open_evidence") {
      evidenceGeneration += 1;
      evidenceBinding = Object.freeze({
        schoolId: selected.schoolId,
        testId: selected.testId,
        studentSessionId: selected.id,
        sessionEpoch: selected.epoch,
      });
      evidenceBefore = null;
    }
    const cursor =
      type === "open_evidence" || type === "evidence_first_page"
        ? null
        : type === "evidence_next_page"
          ? (next ?? null)
          : evidenceBefore;
    evidence = Object.freeze({
      kind: "loading",
      page: evidence.kind === "closed" ? null : evidence.page,
    });
    if (active !== null) {
      const work = active;
      project();
      return work.promise;
    }
    const operation = begin(
      "evidence",
      null,
      before,
      null,
      true,
      false,
      cursor,
    );
    if (!evidenceWorkActive()) {
      settleEvidenceRead();
      project();
    }
    return operation;
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
    setTarget,
    refreshFromStaff(result) {
      if (
        disposed ||
        result.kind !== "fresh_authorized" ||
        target?.parentBusy ||
        active !== null
      )
        return Promise.resolve(snapshot);
      return begin("read", null, before, result, true);
    },
    dispatch(value) {
      const action = parseAction(value);
      if (action === null) return Promise.resolve(snapshot);
      if (disposed) return Promise.resolve(snapshot);
      if (
        "snapshotRevision" in action &&
        action.snapshotRevision !== snapshot.revision
      )
        return Promise.resolve(snapshot);
      if (
        action.type === "open_evidence" ||
        action.type === "close_evidence" ||
        action.type === "evidence_first_page" ||
        action.type === "evidence_next_page" ||
        action.type === "refresh_evidence"
      )
        return dispatchEvidence(action.type);
      if (
        action.type === "load" ||
        action.type === "refresh" ||
        action.type === "first_page" ||
        action.type === "next_page"
      ) {
        if (target?.parentBusy) return Promise.resolve(snapshot);
        if (
          action.type === "first_page" ||
          action.type === "next_page" ||
          active?.kind === "evidence"
        )
          stopQuietRead();
        if (active?.kind === "read") return active.promise;
        if (action.type === "next_page" && page?.nextCursor == null)
          return Promise.resolve(snapshot);
        return begin(
          "read",
          null,
          action.type === "first_page"
            ? null
            : action.type === "next_page"
              ? (page?.nextCursor ?? null)
              : before,
        );
      }
      if (action.type === "select_session") {
        stopQuietRead();
        if (active !== null || review !== null || target?.parentBusy)
          return Promise.resolve(snapshot);
        const item = page?.items.find(
          (row) => row.id === action.studentSessionId,
        );
        if (item !== undefined) {
          selected = item;
          reconcileEvidence();
          notice = null;
          project();
        }
      } else if (action.type === "review_issue_code")
        return startReview("issue_code");
      else if (action.type === "review_remove") return startReview("remove");
      else if (action.type === "review_prepare_readmission")
        return startReview("prepare_readmission");
      else if (action.type === "confirm_review") {
        if (
          review === null ||
          review.stale ||
          staleReview(review) ||
          target?.parentBusy
        )
          return Promise.resolve(snapshot);
        stopQuietRead();
        return begin("mutation", review, before);
      } else if (action.type === "cancel_review") {
        stopQuietRead();
        if (active === null) {
          review = null;
          notice = null;
          project();
        }
      } else if (action.type === "retry_issuance") {
        if (
          pending === null ||
          target === null ||
          target.parentBusy ||
          target.test.lifecycle !== "open" ||
          authority === null ||
          !sameAuthority(pending.authority, authority) ||
          !sameTarget(pending.test, target.test)
        )
          return Promise.resolve(snapshot);
        stopQuietRead();
        return begin(
          "mutation",
          {
            authority: pending.authority,
            test: pending.test,
            session: pending.session,
            operation: pending.operation,
            issuance: pending,
            stale: false,
          },
          before,
          null,
          false,
          true,
        );
      } else if (action.type === "dismiss_code") {
        stopQuietRead();
        if (active === null) {
          disclosure = null;
          project();
        }
      }
      return Promise.resolve(snapshot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate(true);
      authority = null;
      school = null;
      target = null;
      snapshot = Object.freeze({
        kind: "unavailable",
        revision: snapshot.revision + 1,
      });
      listeners.clear();
    },
  };
}
