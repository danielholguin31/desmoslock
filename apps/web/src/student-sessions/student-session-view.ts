import type {
  StaffStudentProtectionEvent,
  StaffStudentSession,
} from "@desmoslock/contracts";

import type {
  StudentSessionAction,
  StudentSessionController,
  StudentSessionNotice,
  StudentSessionSnapshot,
} from "./student-session-controller.js";

type RevisionAction = Exclude<
  Extract<StudentSessionAction, { snapshotRevision: number }>["type"],
  "select_session"
>;
type EvidenceAction = Extract<
  RevisionAction,
  | "open_evidence"
  | "close_evidence"
  | "evidence_first_page"
  | "evidence_next_page"
  | "refresh_evidence"
>;

function reportSummary(session: StaffStudentSession): string {
  const summary = session.evidenceSummary;
  if (summary.reportCount === 0) return "No client reports received";
  return (
    summary.reportCount +
    (summary.reportCount === 1 ? " report received" : " reports received") +
    " · " +
    summary.failureCount +
    (summary.failureCount === 1 ? " reported failure" : " reported failures") +
    " · Latest received report: admission version " +
    summary.latestReportedEpoch
  );
}

const reportPhase: Record<
  StaffStudentProtectionEvent["fact"]["phase"],
  string
> = {
  engaging: "Protection start reported",
  locked: "Protected state reported",
  ending: "Protection end requested",
  ended: "Protection end reported",
  failed: "Protection failure reported",
  recovery_required: "Recovery requirement reported",
};
const reportCause: Record<
  StaffStudentProtectionEvent["fact"]["cause"],
  string
> = {
  none: "",
  backend_unavailable: "Session service unavailable",
  admission_changed: "Admission changed",
  capability_expired: "Session access expired",
  native_interrupted: "Native protection interrupted",
  native_failure: "Native protection failed",
  observation_timeout: "Native observation timed out",
  application_policy: "Application policy failure",
  shortcut_unavailable: "Emergency shortcut unavailable",
  persistence_unavailable: "Local records unavailable",
  window_lost: "Assessment window lost",
  renderer_lost: "Assessment interface lost",
  suspend: "Device suspended",
  display_changed: "Display changed",
  emergency_abandonment: "Emergency exit requested",
  application_quit: "Application quit requested",
};
const reportCategories = {
  aac: "Native protection",
  shortcuts: "Emergency shortcut",
  applications: "Permitted applications",
  persistence: "Local records",
  windowNetwork: "Assessment window and network",
} as const;
const categoryObservation: Record<
  StaffStudentProtectionEvent["fact"]["categories"]["aac"]["code"],
  string
> = {
  none: "",
  awaiting_native_begin: "Waiting for native confirmation",
  native_unavailable: "Native support unavailable",
  native_inactive: "Native protection inactive",
  emergency_shortcut_unavailable: "Emergency shortcut unavailable",
  prohibited_application: "Prohibited application reported",
  application_observation_unavailable: "Applications could not be checked",
  durability_unavailable: "Local records could not be confirmed",
  evidence_capacity: "Local report capacity reached",
  window_unavailable: "Assessment window unavailable",
  network_policy_unavailable: "Network boundary unavailable",
  backend_unavailable: "Session service unavailable",
};

const stateText: Record<StaffStudentSession["state"], string> = {
  active: "Admitted",
  removed: "Removed",
  forfeited: "Left session",
  readmitted: "Re-admission prepared",
};

function noticeText(notice: StudentSessionNotice | null): string {
  if (notice === null) return "";
  if (notice.kind === "selection_changed")
    return "Session details changed. Review the current details before continuing.";
  if (notice.kind === "test_unavailable")
    return "Test unavailable. Refresh to check current access.";
  if (!("operation" in notice)) return "";
  const action = {
    issue_code: "Join code issuance",
    remove: "Session removal",
    prepare_readmission: "Private re-admission code preparation",
  }[notice.operation];
  if (notice.kind === "confirmed")
    return {
      issue_code: "Issued a join code.",
      remove: "Removed the session's admission.",
      prepare_readmission: "Prepared a private re-admission code.",
    }[notice.operation];
  if (notice.kind === "stale")
    return "Details changed. Refresh and review the current session or Test before continuing.";
  return notice.kind === "unconfirmed"
    ? action + " unconfirmed. Refresh to check current details."
    : action + " was not allowed. Refresh to check current details.";
}

// This view holds presentation only. Code material and revision-bound intents
// belong to the controller; quiet projections retain connected native controls.
export function bindStudentSessionView(
  root: HTMLElement,
  controller: StudentSessionController,
  options: { readonly copyText?: (text: string) => Promise<void> } = {},
): () => void {
  const document = root.ownerDocument;
  let snapshot = controller.getSnapshot();
  let disposed = false;
  let pending = false;
  let epoch = 0;
  let copyEpoch = 0;
  let evidenceRequest = 0;
  let evidencePending = false;
  let evidenceError = "";
  let rendered: ReturnType<typeof create> | undefined;

  function clear() {
    epoch += 1;
    copyEpoch += 1;
    evidenceRequest += 1;
    evidencePending = false;
    evidenceError = "";
    pending = false;
    if (rendered !== undefined) {
      rendered.code.value = "";
      rendered.rows.clear();
      rendered.reportRows.clear();
    }
    rendered = undefined;
    root.replaceChildren();
  }

  function showUnavailable() {
    clear();
    const error = document.createElement("p");
    error.textContent =
      "Student sessions unavailable. Return to this Test to check current access.";
    error.setAttribute("role", "status");
    root.append(error);
  }

  function send(action: StudentSessionAction) {
    const origin = rendered;
    if (disposed || pending || origin === undefined) return;
    const operation = ++epoch;
    const previousFocus = document.activeElement;
    const previousSelection = origin.selectedId;
    pending = true;
    render(snapshot);
    let result: Promise<StudentSessionSnapshot>;
    try {
      result = controller.dispatch(action);
    } catch {
      showUnavailable();
      return;
    }
    void result.then(
      () => {
        if (disposed || operation !== epoch || rendered !== origin) return;
        pending = false;
        render(controller.getSnapshot());
        if (
          rendered !== origin ||
          (document.activeElement !== previousFocus &&
            document.activeElement !== document.body)
        )
          return;
        if (action.type.startsWith("review_") && snapshot.kind === "review")
          origin.reviewHeading.focus();
        else if (
          action.type === "select_session" &&
          "data" in snapshot &&
          snapshot.data.selected?.id === action.studentSessionId
        )
          origin.detailHeading.focus();
        else if (
          action.type === "cancel_review" &&
          snapshot.kind === "ready" &&
          previousSelection === origin.selectedId
        ) {
          const target = origin.reviewInvoker;
          if (target !== undefined && !target.disabled && !target.hidden)
            target.focus({ preventScroll: true });
        }
      },
      () => {
        if (!disposed && operation === epoch && rendered === origin) {
          showUnavailable();
        }
      },
    );
  }

  // Report reads have their own presentation feedback. They must not disable
  // or discard a separate Student review while the controller checks access.
  function sendEvidence(type: EvidenceAction) {
    const origin = rendered;
    if (
      disposed ||
      origin === undefined ||
      (evidencePending && type !== "close_evidence")
    )
      return;
    const request = ++evidenceRequest;
    const selectedId = origin.selectedId;
    const previousFocus = document.activeElement;
    evidencePending = type !== "close_evidence";
    evidenceError = "";
    let result: Promise<StudentSessionSnapshot>;
    try {
      result = controller.dispatch({
        type,
        snapshotRevision: snapshot.revision,
      });
    } catch {
      evidencePending = false;
      evidenceError =
        "Client reports unavailable. Refresh reports to try again.";
      render(snapshot);
      return;
    }
    render(snapshot);
    void result.then(
      () => {
        if (disposed || request !== evidenceRequest || rendered !== origin)
          return;
        evidencePending = false;
        render(controller.getSnapshot());
        if (
          rendered !== origin ||
          origin.selectedId !== selectedId ||
          (document.activeElement !== previousFocus &&
            document.activeElement !== document.body)
        )
          return;
        if (type === "open_evidence" && !origin.evidencePanel.hidden)
          origin.evidenceHeading.focus();
        else if (type === "close_evidence" && !origin.openEvidence.hidden)
          origin.openEvidence.focus({ preventScroll: true });
      },
      () => {
        if (disposed || request !== evidenceRequest || rendered !== origin)
          return;
        evidencePending = false;
        evidenceError =
          "Client reports unavailable. Refresh reports to try again.";
        render(controller.getSnapshot());
      },
    );
  }

  function createReportRow() {
    const element = document.createElement("li");
    const heading = document.createElement("h4");
    const context = document.createElement("p");
    const received = document.createElement("time");
    const cause = document.createElement("p");
    const categories = document.createElement("dl");
    const observations = new Map<keyof typeof reportCategories, HTMLElement>();
    for (const key of Object.keys(reportCategories) as Array<
      keyof typeof reportCategories
    >) {
      const label = document.createElement("dt");
      label.textContent = reportCategories[key];
      const value = document.createElement("dd");
      categories.append(label, value);
      observations.set(key, value);
    }
    const build = document.createElement("details");
    const buildLabel = document.createElement("summary");
    const buildDescription = document.createElement("p");
    build.append(buildLabel, buildDescription);
    element.append(heading, context, received, cause, categories, build);
    return {
      element,
      heading,
      context,
      received,
      cause,
      observations,
      build,
      buildLabel,
      buildDescription,
    };
  }

  function updateReportRow(
    row: ReturnType<typeof createReportRow>,
    event: StaffStudentProtectionEvent,
  ) {
    const fact = event.fact;
    row.heading.textContent = reportPhase[fact.phase];
    row.context.textContent =
      "Original admission version " +
      fact.scope.epoch +
      " · Report sequence " +
      fact.sequence;
    row.received.textContent =
      "Received " +
      event.receivedAt.slice(0, 10) +
      " " +
      event.receivedAt.slice(11, 19) +
      " UTC";
    row.received.setAttribute("datetime", event.receivedAt);
    row.received.setAttribute(
      "title",
      "Exact server receipt: " + event.receivedAt,
    );
    row.cause.hidden = fact.cause === "none";
    row.cause.textContent = "Reported reason: " + reportCause[fact.cause];
    for (const [key, detail] of row.observations) {
      const observation = fact.categories[key];
      detail.textContent =
        observation.code !== "none"
          ? categoryObservation[observation.code]
          : {
              pending: "Pending",
              confirmed: "Reported confirmed",
              failed: "Reported failed",
              unavailable: "Unavailable",
            }[observation.status];
    }
    const build = event.originBuild;
    row.buildLabel.textContent =
      build.kind === "build"
        ? "Build details (client-reported)"
        : build.kind === "unverified_build"
          ? "Build details (unverified)"
          : "Build details (legacy unknown)";
    row.buildDescription.textContent =
      build.kind === "build"
        ? "Build ID: " +
          build.identity.buildId +
          ". Source commit: " +
          build.identity.sourceCommit +
          ". Source tree: " +
          build.identity.sourceTree +
          ". Dependency lock: " +
          build.identity.packageLockSha256 +
          ". This client-reported identity is not release verification."
        : build.kind === "unverified_build"
          ? "The client did not have a verified build identity for this report."
          : "The original build identity is unknown for this retained legacy report.";
  }

  function create() {
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
      const node = document.createElement(tag);
      node.textContent = text;
      return node;
    }
    const section = element("section");
    section.className = "student-sessions";
    const heading = element("h2", "Student sessions");
    const context = element("p");
    const status = element("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const lifecycle = element("p");
    const controls = element("div");
    controls.className = "student-sessions-actions";
    const content = element("div");
    content.className = "student-sessions-content";
    const detail = element("section");
    const detailHeading = element("h3");
    detailHeading.tabIndex = -1;
    const detailState = element("p");
    const detailSummary = element("p");
    const detailActions = element("div");
    detailActions.className = "student-sessions-actions";
    const review = element("section");
    review.className = "student-sessions-notice";
    const reviewHeading = element("h3");
    reviewHeading.tabIndex = -1;
    const reviewMessage = element("p");
    const reviewStale = element(
      "p",
      "These details changed. Cancel, refresh, and review again.",
    );
    const reviewActions = element("div");
    reviewActions.className = "student-sessions-actions";
    const disclosure = element("section");
    disclosure.className = "student-sessions-notice";
    const disclosureHeading = element("h3");
    const code = element("input");
    code.type = "text";
    code.readOnly = true;
    code.setAttribute("aria-label", "Issued code");
    code.setAttribute("autocomplete", "off");
    code.setAttribute("spellcheck", "false");
    code.className = "student-sessions-code";
    const expiry = element("p");
    const disclosureMessage = element("p");
    const copyStatus = element("p");
    copyStatus.setAttribute("role", "status");
    const disclosureActions = element("div");
    disclosureActions.className = "student-sessions-actions";
    const uncertain = element("section");
    uncertain.className = "student-sessions-notice";
    const uncertainHeading = element("h3", "Code issuance unconfirmed");
    const uncertainMessage = element(
      "p",
      "No confirmed code is available from this attempt. Retry the same issuance to check its result. Refresh only reads current details.",
    );
    const listHeading = element("h3", "Sessions in this Test");
    const list = element("ul");
    list.className = "student-sessions-list";
    const empty = element("p", "No sessions on this page.");
    const pages = element("div");
    pages.className = "student-sessions-actions";
    const rows = new Map<
      string,
      {
        element: HTMLLIElement;
        button: HTMLButtonElement;
        state: HTMLSpanElement;
        summary: HTMLParagraphElement;
      }
    >();
    const evidencePanel = element("section");
    evidencePanel.className = "student-reports";
    const evidenceHeading = element("h3", "Client reports");
    evidenceHeading.tabIndex = -1;
    const evidenceDescription = element(
      "p",
      "Reports from the client may arrive late. They do not confirm current protection.",
    );
    const evidenceContext = element("p");
    const evidenceStatus = element("p");
    evidenceStatus.setAttribute("role", "status");
    evidenceStatus.setAttribute("aria-live", "polite");
    const evidenceActions = element("div");
    evidenceActions.className = "student-sessions-actions";
    const evidenceList = element("ol");
    evidenceList.className = "student-report-list";
    const evidenceEmpty = element(
      "p",
      "No client reports received for this session.",
    );
    const reportRows = new Map<string, ReturnType<typeof createReportRow>>();
    function evidenceButton(
      label: string,
      type: EvidenceAction,
      parent: HTMLElement,
    ) {
      const control = element("button", label);
      control.type = "button";
      control.dataset.studentSessionAction = type;
      control.addEventListener("click", () => {
        if (
          disposed ||
          rendered?.section !== section ||
          control.disabled ||
          control.hidden ||
          content.hidden ||
          detail.hidden ||
          (type !== "open_evidence" && evidencePanel.hidden)
        )
          return;
        sendEvidence(type);
      });
      parent.append(control);
      return control;
    }
    function button(
      label: string,
      type: RevisionAction | "refresh" | "first_page" | "next_page",
      parent: HTMLElement,
    ) {
      const control = element("button", label);
      control.type = "button";
      control.dataset.studentSessionAction = type;
      control.addEventListener("click", () => {
        if (
          disposed ||
          rendered?.section !== section ||
          control.disabled ||
          control.hidden
        )
          return;
        if (type.startsWith("review_")) rendered.reviewInvoker = control;
        if (type === "refresh" || type === "first_page" || type === "next_page")
          send({ type });
        else send({ type, snapshotRevision: snapshot.revision });
      });
      parent.append(control);
      return control;
    }
    const refresh = button("Refresh sessions", "refresh", controls);
    const issue = button("Issue join code", "review_issue_code", controls);
    const remove = button("Remove session", "review_remove", detailActions);
    const prepare = button(
      "Prepare private re-admission",
      "review_prepare_readmission",
      detailActions,
    );
    const confirm = button("Confirm", "confirm_review", reviewActions);
    const cancel = button("Cancel", "cancel_review", reviewActions);
    const retry = button("Retry same issuance", "retry_issuance", uncertain);
    const dismiss = button("Hide code", "dismiss_code", disclosureActions);
    const copy = element("button", "Copy code");
    copy.type = "button";
    copy.addEventListener("click", () => {
      if (
        disposed ||
        rendered?.section !== section ||
        copy.disabled ||
        disclosure.hidden ||
        code.value === ""
      )
        return;
      const value = code.value;
      const sequence = ++copyEpoch;
      let result: Promise<void>;
      try {
        result = (
          options.copyText ?? ((text) => navigator.clipboard.writeText(text))
        )(value);
      } catch {
        copyStatus.textContent =
          "Copy unavailable. Select and copy the code above.";
        return;
      }
      void result.then(
        () => {
          if (
            !disposed &&
            sequence === copyEpoch &&
            rendered?.section === section &&
            code.value === value
          )
            copyStatus.textContent = "Code copied.";
        },
        () => {
          if (
            !disposed &&
            sequence === copyEpoch &&
            rendered?.section === section &&
            code.value === value
          )
            copyStatus.textContent =
              "Copy unavailable. Select and copy the code above.";
        },
      );
    });
    disclosureActions.append(copy);
    const first = button("First page", "first_page", pages);
    const next = button("Next page", "next_page", pages);
    const openEvidence = evidenceButton(
      "View client reports",
      "open_evidence",
      detailActions,
    );
    const closeEvidence = evidenceButton(
      "Close reports",
      "close_evidence",
      evidenceActions,
    );
    const refreshEvidence = evidenceButton(
      "Refresh reports",
      "refresh_evidence",
      evidenceActions,
    );
    const firstEvidence = evidenceButton(
      "Newest reports",
      "evidence_first_page",
      evidenceActions,
    );
    const nextEvidence = evidenceButton(
      "Older reports",
      "evidence_next_page",
      evidenceActions,
    );
    evidencePanel.append(
      evidenceHeading,
      evidenceDescription,
      evidenceContext,
      evidenceActions,
      evidenceStatus,
      evidenceList,
      evidenceEmpty,
    );
    detail.append(
      detailHeading,
      detailState,
      detailSummary,
      detailActions,
      evidencePanel,
    );
    review.append(reviewHeading, reviewMessage, reviewStale, reviewActions);
    disclosure.append(
      disclosureHeading,
      code,
      expiry,
      disclosureMessage,
      disclosureActions,
      copyStatus,
    );
    uncertain.insertBefore(uncertainHeading, retry);
    uncertain.insertBefore(uncertainMessage, retry);
    content.append(
      detail,
      review,
      disclosure,
      uncertain,
      listHeading,
      list,
      empty,
      pages,
    );
    section.append(heading, context, status, lifecycle, controls, content);
    root.append(section);
    return {
      section,
      context,
      status,
      lifecycle,
      content,
      detail,
      detailHeading,
      detailState,
      detailSummary,
      review,
      reviewHeading,
      reviewMessage,
      reviewStale,
      disclosure,
      disclosureHeading,
      code,
      expiry,
      disclosureMessage,
      copyStatus,
      uncertain,
      list,
      empty,
      rows,
      refresh,
      issue,
      remove,
      prepare,
      confirm,
      cancel,
      retry,
      dismiss,
      copy,
      first,
      next,
      evidencePanel,
      evidenceHeading,
      evidenceContext,
      evidenceStatus,
      evidenceList,
      evidenceEmpty,
      reportRows,
      openEvidence,
      closeEvidence,
      refreshEvidence,
      firstEvidence,
      nextEvidence,
      evidenceBinding: "",
      selectedId: null as string | null,
      reviewInvoker: undefined as HTMLButtonElement | undefined,
    };
  }

  function render(next: StudentSessionSnapshot) {
    if (disposed) return;
    snapshot = next;
    if (!("data" in next)) {
      clear();
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const view = rendered ?? (rendered = create());
    const { data } = next;
    const busy = pending || next.kind === "busy";
    const loaded = next.kind !== "loading" && next.kind !== "read_unavailable";
    const enabled = loaded && !busy && !data.parentBusy;
    const ready = next.kind === "ready" && enabled;
    const open = data.test.lifecycle === "open";
    const evidenceBinding = JSON.stringify([
      data.school.schoolId,
      data.test.id,
      data.test.lifecycle,
      data.selected?.id,
      data.selected?.epoch,
      data.selected?.revision,
      data.selected?.state,
    ]);
    if (view.evidenceBinding !== evidenceBinding) {
      view.evidenceBinding = evidenceBinding;
      evidenceRequest += 1;
      evidencePending = false;
      evidenceError = "";
    }
    view.selectedId = data.selected?.id ?? null;
    view.context.textContent =
      data.test.title + " · " + data.school.displayName;
    view.lifecycle.textContent =
      data.test.lifecycle === "ended"
        ? "Test ended. Participation is closed."
        : data.test.lifecycle === "draft"
          ? "Open this Test before admitting students."
          : "Students join with a code. Session names are assigned automatically.";
    view.status.textContent =
      next.kind === "loading"
        ? "Loading student sessions…"
        : next.kind === "read_unavailable"
          ? "Student sessions unavailable. Refresh to check current details."
          : next.kind === "busy"
            ? next.phase === "verifying"
              ? "Checking current access and details…"
              : next.phase === "refreshing"
                ? "Refreshing student sessions…"
                : next.operation === "remove"
                  ? "Removing session…"
                  : next.operation === "load"
                    ? "Loading student sessions…"
                    : "Issuing code…"
            : noticeText(next.notice);
    if (data.parentBusy && !busy)
      view.status.textContent =
        "Finish the current Test action before managing student sessions.";
    view.section.setAttribute(
      "aria-busy",
      String(busy || next.kind === "loading"),
    );
    view.refresh.disabled = busy || data.parentBusy;
    view.issue.disabled = !ready || !open;
    view.content.hidden = !loaded;
    view.detail.hidden = data.selected === null;
    view.detailHeading.textContent = data.selected?.syntheticDisplayName ?? "";
    view.detailState.textContent =
      data.selected === null ? "" : stateText[data.selected.state];
    view.detailSummary.textContent =
      data.selected === null ? "" : reportSummary(data.selected);
    const evidence = data.evidence;
    const evidenceOpen = data.selected !== null && evidence.kind !== "closed";
    const historyPage = evidence.kind === "closed" ? null : evidence.page;
    view.openEvidence.hidden = evidenceOpen;
    view.openEvidence.disabled = !enabled || data.selected === null;
    view.evidencePanel.hidden = !evidenceOpen;
    view.evidencePanel.setAttribute(
      "aria-busy",
      String(evidencePending || evidence.kind === "loading"),
    );
    view.evidenceContext.textContent =
      data.selected === null
        ? ""
        : data.selected.syntheticDisplayName +
          " · Current admission version " +
          data.selected.epoch;
    view.evidenceStatus.textContent =
      evidenceError ||
      (evidence.kind === "loading"
        ? "Loading client reports…"
        : evidence.kind === "unavailable"
          ? historyPage === null
            ? "Client reports unavailable. Refresh reports to try again."
            : "Could not refresh client reports. Previously received reports are shown."
          : "");
    const historyBusy = evidencePending || evidence.kind === "loading";
    view.closeEvidence.disabled = false;
    view.refreshEvidence.disabled = !enabled || historyBusy;
    view.firstEvidence.disabled =
      !enabled || historyBusy || historyPage === null;
    view.nextEvidence.disabled =
      !enabled || historyBusy || historyPage?.nextCursor == null;
    view.evidenceEmpty.hidden =
      evidence.kind !== "ready" || historyPage?.items.length !== 0;
    view.evidenceList.hidden =
      historyPage === null || historyPage.items.length === 0;
    const reportIds = new Set(
      historyPage?.items.map((item) => item.fact.eventId) ?? [],
    );
    for (const [id, row] of view.reportRows) {
      if (!reportIds.has(id)) {
        row.element.remove();
        view.reportRows.delete(id);
      }
    }
    for (const event of historyPage?.items ?? []) {
      let row = view.reportRows.get(event.fact.eventId);
      if (row === undefined) {
        row = createReportRow();
        view.reportRows.set(event.fact.eventId, row);
      }
      updateReportRow(row, event);
    }
    let reportBefore = view.evidenceList.firstChild;
    for (const event of historyPage?.items ?? []) {
      const row = view.reportRows.get(event.fact.eventId);
      if (row === undefined) continue;
      if (row.element === reportBefore) reportBefore = row.element.nextSibling;
      else view.evidenceList.insertBefore(row.element, reportBefore);
    }
    view.remove.hidden = data.selected?.state !== "active";
    view.remove.disabled = !ready || !open || data.selected?.state !== "active";
    view.prepare.hidden =
      data.selected === null || data.selected.state === "active";
    view.prepare.disabled =
      !ready ||
      !open ||
      data.selected === null ||
      data.selected.state === "active";
    view.prepare.textContent =
      data.selected?.state === "readmitted"
        ? "Replace private re-admission code"
        : "Prepare private re-admission";
    view.review.hidden = next.kind !== "review";
    view.confirm.disabled =
      !enabled || next.kind !== "review" || next.target.stale || !open;
    view.cancel.disabled = busy || next.kind !== "review";
    if (next.kind === "review") {
      const { target } = next;
      view.reviewHeading.textContent =
        target.operation === "issue_code"
          ? "Review join code issuance"
          : target.operation === "remove"
            ? "Remove this session?"
            : "Prepare private re-admission?";
      view.reviewMessage.textContent =
        target.operation === "issue_code"
          ? "Issue a join code for “" +
            target.title +
            "” at " +
            data.school.displayName +
            ". This replaces any earlier join code for this Test. Students already admitted keep their admission."
          : target.operation === "remove"
            ? "Remove admission for " +
              target.syntheticDisplayName +
              " in “" +
              target.title +
              "” at " +
              data.school.displayName +
              "? This changes this session's admission only."
            : "Prepare a private code for " +
              target.syntheticDisplayName +
              " in “" +
              target.title +
              "” at " +
              data.school.displayName +
              ". This replaces any earlier private code for this session. Share it only with the student recovering this session.";
      view.confirm.textContent =
        target.operation === "issue_code"
          ? "Issue join code"
          : target.operation === "remove"
            ? "Remove session"
            : "Prepare private code";
      view.reviewStale.hidden = !target.stale;
    }
    const disclosure = loaded ? data.disclosure : null;
    const code = disclosure?.code ?? "";
    if (view.code.value !== code) {
      copyEpoch += 1;
      view.code.value = code;
      view.copyStatus.textContent = "";
    }
    view.disclosure.hidden = disclosure === null;
    view.copy.disabled = disclosure === null;
    view.dismiss.disabled = busy || disclosure === null;
    view.disclosureHeading.textContent =
      disclosure?.kind === "readmission"
        ? "Issued private re-admission code"
        : "Issued join code";
    view.expiry.textContent =
      disclosure === null ? "" : "Expires: " + disclosure.expiresAt;
    view.disclosureMessage.textContent =
      disclosure?.kind === "readmission"
        ? "Share only with the student recovering this session. A later issuance may replace this code."
        : "Share with students joining this Test. A later issuance may replace this code.";
    view.uncertain.hidden = next.kind !== "unconfirmed";
    view.retry.disabled = !enabled || next.kind !== "unconfirmed" || !open;
    view.first.disabled = !ready;
    view.next.disabled = !ready || data.page.nextCursor === null;
    const ids = new Set(data.page.items.map((row) => row.id));
    for (const [id, row] of view.rows)
      if (!ids.has(id)) {
        row.element.remove();
        view.rows.delete(id);
      }
    for (const session of data.page.items) {
      let row = view.rows.get(session.id);
      if (row === undefined) {
        const element = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        const state = document.createElement("span");
        const summary = document.createElement("p");
        summary.className = "student-report-summary";
        element.append(button, state, summary);
        row = { element, button, state, summary };
        const origin = row;
        button.addEventListener("click", () => {
          if (
            rendered !== view ||
            button.disabled ||
            view.rows.get(session.id) !== origin
          )
            return;
          send({
            type: "select_session",
            studentSessionId: session.id,
            snapshotRevision: snapshot.revision,
          });
        });
        view.rows.set(session.id, row);
      }
      row.button.textContent = session.syntheticDisplayName;
      row.button.disabled = !ready;
      row.button.setAttribute(
        "aria-pressed",
        String(session.id === data.selected?.id),
      );
      row.state.textContent = stateText[session.state];
      row.summary.textContent = reportSummary(session);
      if (session.evidenceSummary.latestReceivedAt !== null)
        row.summary.setAttribute(
          "title",
          "Latest server receipt: " + session.evidenceSummary.latestReceivedAt,
        );
      else row.summary.removeAttribute("title");
    }
    let before = view.list.firstChild;
    for (const session of data.page.items) {
      const row = view.rows.get(session.id);
      if (row === undefined) continue;
      if (row.element === before) before = row.element.nextSibling;
      else view.list.insertBefore(row.element, before);
    }
    view.empty.hidden = data.page.items.length !== 0;
  }

  const unsubscribe = controller.subscribe(render);
  render(controller.getSnapshot());
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    clear();
    root.hidden = true;
  };
}
