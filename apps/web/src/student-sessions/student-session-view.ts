import type { StaffStudentSession } from "@desmoslock/contracts";

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
  let rendered: ReturnType<typeof create> | undefined;

  function clear() {
    epoch += 1;
    copyEpoch += 1;
    pending = false;
    if (rendered !== undefined) {
      rendered.code.value = "";
      rendered.rows.clear();
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
      }
    >();
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
    detail.append(detailHeading, detailState, detailActions);
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
        element.append(button, state);
        row = { element, button, state };
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
