import { validateTestTitleDraft } from "@desmoslock/contracts";
import type { StaffTest } from "@desmoslock/contracts";

import type {
  TestWorkspaceAction,
  TestWorkspaceController,
  TestWorkspaceData,
  TestWorkspaceNotice,
  TestWorkspaceSnapshot,
} from "./test-workspace-controller.js";

type RevisionAction = Extract<
  TestWorkspaceAction,
  { readonly snapshotRevision: number }
>["type"];

interface TestRow {
  readonly element: HTMLLIElement;
  readonly select: HTMLButtonElement;
  readonly lifecycle: HTMLSpanElement;
}

interface RenderedTests {
  readonly section: HTMLElement;
  readonly heading: HTMLHeadingElement;
  readonly school: HTMLParagraphElement;
  readonly status: HTMLParagraphElement;
  readonly refresh: HTMLButtonElement;
  readonly content: HTMLDivElement;
  readonly createForm: HTMLFormElement;
  readonly createInput: HTMLInputElement;
  readonly createError: HTMLParagraphElement;
  readonly create: HTMLButtonElement;
  readonly uncertain: HTMLDivElement;
  readonly uncertainTitle: HTMLParagraphElement;
  readonly retryCreate: HTMLButtonElement;
  readonly startNew: HTMLButtonElement;
  readonly detail: HTMLElement;
  readonly detailHeading: HTMLHeadingElement;
  readonly lifecycle: HTMLParagraphElement;
  readonly ended: HTMLParagraphElement;
  readonly titleForm: HTMLFormElement;
  readonly titleInput: HTMLInputElement;
  readonly titleError: HTMLParagraphElement;
  readonly saveTitle: HTMLButtonElement;
  readonly open: HTMLButtonElement;
  readonly reviewEnd: HTMLButtonElement;
  readonly confirmation: HTMLDivElement;
  readonly endHeading: HTMLHeadingElement;
  readonly endMessage: HTMLParagraphElement;
  readonly confirmEnd: HTMLButtonElement;
  readonly cancelEnd: HTMLButtonElement;
  readonly conflict: HTMLDivElement;
  readonly conflictMessage: HTMLParagraphElement;
  readonly useCurrent: HTMLButtonElement;
  readonly keepDraft: HTMLButtonElement;
  readonly back: HTMLButtonElement;
  readonly listHeading: HTMLHeadingElement;
  readonly list: HTMLUListElement;
  readonly empty: HTMLParagraphElement;
  readonly firstPage: HTMLButtonElement;
  readonly nextPage: HTMLButtonElement;
  readonly rows: Map<string, TestRow>;
  readonly buttons: HTMLButtonElement[];
  selectedId: string | null;
}

const validationText = {
  required: "Enter a Test title.",
  too_long: "This Test title is too long. Shorten it.",
  invalid_characters: "Use a title without line breaks or hidden characters.",
};

const confirmedText = {
  test_created: "Test created.",
  test_creation_already_recorded:
    "The earlier Test was created. Its current details may reflect later changes.",
  test_title_updated: "Saved the Test title change.",
  test_title_unchanged: "No title change was needed.",
  test_opened: "Opened the Test.",
  test_already_open: "The Test was already open.",
  test_ended: "Test ended. Participation is closed.",
  test_already_ended: "The Test was already ended. Participation is closed.",
};

function noticeText(notice: TestWorkspaceNotice | null): string {
  if (notice === null) return "";
  if (notice.kind === "confirmed") return confirmedText[notice.code];
  if (notice.kind === "test_unavailable")
    return "Test unavailable. Refresh Tests to check current details.";
  if (notice.kind === "selection_changed")
    return "Test details changed. Review the current details before continuing.";
  if ("operation" in notice) {
    const action = {
      create: "Creation",
      save_title: "Title change",
      open: "Opening",
      end: "Ending",
    }[notice.operation];
    return notice.kind === "unconfirmed"
      ? action + " unconfirmed. Refresh Tests to check current details."
      : action + " was not allowed. Refresh Tests to check current details.";
  }
  return "";
}

function busyText(snapshot: Extract<TestWorkspaceSnapshot, { kind: "busy" }>) {
  if (snapshot.phase === "refreshing") return "Refreshing Test details…";
  if (snapshot.phase === "verifying")
    return snapshot.operation === "create"
      ? "Checking your access…"
      : "Checking current Test details…";
  return {
    create: "Creating Test…",
    save_title: "Saving title…",
    open: "Opening Test…",
    end: "Ending Test…",
    load: "Loading Tests…",
    select: "Loading Test details…",
    review_end: "Checking this Test before ending…",
  }[snapshot.operation];
}

// Controllers retain drafts and authority. This binder retains only DOM controls,
// so School labels and quiet reads cannot reset a native input or its selection.
export function bindTestWorkspaceView(
  root: HTMLElement,
  controller: TestWorkspaceController,
): () => void {
  const document = root.ownerDocument;
  let disposed = false;
  let pending = false;
  let operationEpoch = 0;
  let rendered: RenderedTests | undefined;
  let snapshot = controller.getSnapshot();

  function clear(): void {
    operationEpoch += 1;
    pending = false;
    if (rendered !== undefined) {
      rendered.createInput.value = "";
      rendered.titleInput.value = "";
      rendered.rows.clear();
    }
    rendered = undefined;
    root.replaceChildren();
  }

  function send(action: TestWorkspaceAction): void {
    const origin = rendered;
    if (disposed || pending || origin === undefined) return;
    const editing =
      action.type === "edit_create_title" || action.type === "edit_title";
    const epoch = editing ? operationEpoch : ++operationEpoch;
    const previousFocus = document.activeElement;
    const previousTarget = origin.selectedId;
    if (!editing) {
      pending = true;
      render(snapshot);
    }
    let result: Promise<TestWorkspaceSnapshot>;
    try {
      result = controller.dispatch(action);
    } catch {
      clear();
      return;
    }
    void result.then(
      () => {
        if (disposed || epoch !== operationEpoch || rendered !== origin) return;
        if (!editing) pending = false;
        render(controller.getSnapshot());
        if (
          editing ||
          rendered !== origin ||
          (document.activeElement !== previousFocus &&
            document.activeElement !== document.body)
        )
          return;
        if (
          action.type === "select_test" &&
          snapshot.kind === "ready" &&
          snapshot.data.selected?.id === action.testId
        ) {
          origin.detailHeading.focus();
        } else if (
          action.type === "review_end" &&
          snapshot.kind === "confirming_end" &&
          snapshot.target.testId === previousTarget
        ) {
          origin.endHeading.focus();
        } else if (
          action.type === "cancel_end" &&
          snapshot.kind === "ready" &&
          origin.selectedId === previousTarget &&
          !origin.reviewEnd.disabled &&
          !origin.reviewEnd.hidden
        ) {
          origin.reviewEnd.focus({ preventScroll: true });
        } else if (snapshot.kind === "ready") {
          if (
            (action.type === "create_test" &&
              snapshot.data.createValidation !== null) ||
            action.type === "start_new_test"
          ) {
            origin.createInput.focus({ preventScroll: true });
          } else if (
            origin.selectedId === previousTarget &&
            !origin.titleForm.hidden &&
            ((action.type === "save_title" &&
              snapshot.data.titleValidation !== null) ||
              action.type === "keep_title_draft" ||
              action.type === "use_current_test")
          ) {
            origin.titleInput.focus({ preventScroll: true });
          }
        }
      },
      () => {
        if (!disposed && epoch === operationEpoch && rendered === origin)
          clear();
      },
    );
  }

  function createView(): RenderedTests {
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
      const node = document.createElement(tag);
      node.textContent = text;
      return node;
    }
    function group(className: string) {
      const node = element("div");
      node.className = "test-workspace__" + className;
      return node;
    }
    function heading(text: string, marker: string) {
      const node = element("h3", text);
      node.tabIndex = -1;
      node.setAttribute(marker, "");
      return node;
    }
    const buttons: HTMLButtonElement[] = [];
    function button(text: string, type?: TestWorkspaceAction["type"]) {
      const node = element("button", text);
      node.type = "button";
      if (type !== undefined) node.dataset.testWorkspaceAction = type;
      buttons.push(node);
      return node;
    }
    function revisionButton(text: string, type: RevisionAction) {
      const node = button(text, type);
      node.addEventListener("click", () => {
        if (rendered !== view || node.disabled || node.hidden) return;
        send({ type, snapshotRevision: snapshot.revision });
      });
      return node;
    }
    function field(name: string, labelText: string, errorId: string) {
      const label = element("label");
      label.className = "test-workspace__field";
      const input = element("input");
      input.name = name;
      input.type = "text";
      input.autocomplete = "off";
      input.required = true;
      input.setAttribute("aria-describedby", errorId);
      label.append(element("span", labelText), input);
      const error = element("p");
      error.id = errorId;
      error.className = "test-workspace__error";
      error.setAttribute("aria-live", "polite");
      return { label, input, error };
    }
    const section = element("section");
    section.className = "test-workspace";
    const title = element("h2", "Tests");
    title.dataset.testWorkspaceHeading = "";
    title.tabIndex = -1;
    const school = element("p");
    const toolbar = group("toolbar");
    const refresh = button("Refresh Tests", "refresh");
    toolbar.append(title, refresh);
    const status = element("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const content = group("content");
    const createForm = element("form");
    createForm.className = "test-workspace__form";
    createForm.noValidate = true;
    const createField = field(
      "new_test_title",
      "New Test title",
      "new-test-title-error",
    );
    const create = button("Create Test", "create_test");
    create.type = "submit";
    createForm.append(
      element("h3", "Create a Test"),
      createField.label,
      createField.error,
      create,
    );
    const uncertain = group("uncertain");
    const uncertainTitle = element("p");
    const retryCreate = revisionButton("Retry same creation", "retry_create");
    const startNew = revisionButton("Start a new Test", "start_new_test");
    const uncertainActions = group("actions");
    uncertainActions.append(retryCreate, startNew);
    uncertain.append(
      element("h3", "Creation unconfirmed"),
      uncertainTitle,
      element(
        "p",
        "A Test may already exist. Retry the same creation to check it, or start a new Test with a separate creation.",
      ),
      uncertainActions,
    );
    const detail = element("section");
    detail.className = "test-workspace__detail";
    const detailHeading = heading(
      "Test details",
      "data-test-workspace-detail-heading",
    );
    const lifecycle = element("p");
    lifecycle.className = "test-workspace__lifecycle";
    const ended = element(
      "p",
      "Participation is closed. This Test is read-only.",
    );
    const titleForm = element("form");
    titleForm.className = "test-workspace__form";
    titleForm.noValidate = true;
    const titleField = field("test_title", "Test title", "test-title-error");
    const saveTitle = button("Save title", "save_title");
    saveTitle.type = "submit";
    const open = revisionButton("Open Test", "open_test");
    const reviewEnd = revisionButton("End Test", "review_end");
    const titleActions = group("actions");
    titleActions.append(saveTitle, open, reviewEnd);
    titleForm.append(titleField.label, titleField.error, titleActions);
    const confirmation = group("confirmation");
    const endHeading = heading(
      "End this Test?",
      "data-test-workspace-end-heading",
    );
    const endMessage = element("p");
    const confirmEnd = revisionButton("Confirm end", "confirm_end");
    confirmEnd.dataset.testWorkspaceTone = "danger";
    const cancelEnd = revisionButton("Cancel", "cancel_end");
    const endActions = group("actions");
    endActions.append(confirmEnd, cancelEnd);
    confirmation.append(
      endHeading,
      endMessage,
      element(
        "p",
        "Ending closes participation for this Test. Ended Tests are read-only and cannot be reopened.",
      ),
      endActions,
    );
    const conflict = group("conflict");
    const conflictMessage = element("p");
    const useCurrent = revisionButton("Use current Test", "use_current_test");
    const keepDraft = revisionButton("Keep my draft", "keep_title_draft");
    const conflictActions = group("actions");
    conflictActions.append(useCurrent, keepDraft);
    conflict.append(
      element("h3", "Test details changed"),
      conflictMessage,
      conflictActions,
    );
    const back = button("Back to Tests");
    back.className = "test-workspace__secondary";
    detail.append(
      detailHeading,
      lifecycle,
      ended,
      titleForm,
      confirmation,
      conflict,
      back,
    );
    const listSection = element("section");
    listSection.className = "test-workspace__list-section";
    const listHeading = heading(
      "Test list",
      "data-test-workspace-list-heading",
    );
    const empty = element("p", "No Tests on this page.");
    const list = element("ul");
    list.className = "test-workspace__list";
    const firstPage = button("Newest Tests", "first_page");
    const nextPage = button("Older Tests", "next_page");
    const pages = group("actions");
    pages.append(firstPage, nextPage);
    listSection.append(listHeading, empty, list, pages);
    content.append(createForm, uncertain, detail, listSection);
    section.append(toolbar, school, status, content);
    const view: RenderedTests = {
      section,
      heading: title,
      school,
      status,
      refresh,
      content,
      createForm,
      createInput: createField.input,
      createError: createField.error,
      create,
      uncertain,
      uncertainTitle,
      retryCreate,
      startNew,
      detail,
      detailHeading,
      lifecycle,
      ended,
      titleForm,
      titleInput: titleField.input,
      titleError: titleField.error,
      saveTitle,
      open,
      reviewEnd,
      confirmation,
      endHeading,
      endMessage,
      confirmEnd,
      cancelEnd,
      conflict,
      conflictMessage,
      useCurrent,
      keepDraft,
      back,
      listHeading,
      list,
      empty,
      firstPage,
      nextPage,
      rows: new Map(),
      buttons,
      selectedId: null,
    };
    for (const [form, control, type] of [
      [createForm, create, "create_test"],
      [titleForm, saveTitle, "save_title"],
    ] as const) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (
          rendered !== view ||
          snapshot.kind !== "ready" ||
          control.disabled ||
          control.hidden ||
          form.hidden
        )
          return;
        send({ type, snapshotRevision: snapshot.revision });
      });
    }
    for (const [input, type] of [
      [createField.input, "edit_create_title"],
      [titleField.input, "edit_title"],
    ] as const) {
      input.addEventListener("input", () => {
        if (rendered !== view || snapshot.kind !== "ready" || input.readOnly)
          return;
        send({ type, value: input.value });
      });
    }
    for (const [control, type] of [
      [refresh, "refresh"],
      [firstPage, "first_page"],
      [nextPage, "next_page"],
    ] as const) {
      control.addEventListener("click", () => {
        if (rendered === view && !control.disabled && !control.hidden)
          send({ type });
      });
    }
    back.addEventListener("click", () => {
      if (rendered !== view || back.disabled || detail.hidden) return;
      const row =
        view.selectedId === null ? undefined : view.rows.get(view.selectedId);
      (row?.select ?? view.listHeading).focus();
    });
    root.replaceChildren(section);
    return view;
  }

  function patchRows(
    view: RenderedTests,
    data: TestWorkspaceData,
    enabled: boolean,
  ) {
    const ids = data.page.items.map((test) => test.id);
    const currentIds = new Set(ids);
    for (const id of view.rows.keys()) {
      if (!currentIds.has(id)) {
        view.rows.get(id)?.element.remove();
        view.rows.delete(id);
      }
    }
    for (const test of data.page.items) {
      let row = view.rows.get(test.id);
      if (row === undefined) {
        const element = document.createElement("li");
        const select = document.createElement("button");
        select.type = "button";
        select.dataset.testWorkspaceAction = "select_test";
        const lifecycle = document.createElement("span");
        element.append(select, lifecycle);
        row = { element, select, lifecycle };
        const origin = row;
        select.addEventListener("click", () => {
          if (
            rendered !== view ||
            snapshot.kind !== "ready" ||
            select.disabled ||
            view.rows.get(test.id) !== origin
          )
            return;
          send({ type: "select_test", testId: test.id });
        });
        view.rows.set(test.id, row);
      }
      row.select.textContent = test.title;
      row.select.disabled = !enabled;
      row.select.setAttribute(
        "aria-pressed",
        String(test.id === data.selected?.id),
      );
      row.lifecycle.textContent = lifecycleText(test.lifecycle);
    }
    // The ordering keys are immutable. Quiet insertions/removals leave surviving
    // rows in relative order, so keep them connected instead of resetting focus.
    let before = view.list.firstChild;
    for (const id of ids) {
      const row = view.rows.get(id);
      if (row === undefined) continue;
      if (row.element === before) before = row.element.nextSibling;
      else view.list.insertBefore(row.element, before);
    }
    view.empty.hidden = ids.length !== 0;
  }

  function lifecycleText(lifecycle: StaffTest["lifecycle"]) {
    return { draft: "Draft", open: "Open", ended: "Ended" }[lifecycle];
  }

  function render(next: TestWorkspaceSnapshot): void {
    if (disposed) return;
    snapshot = next;
    if (next.kind === "unavailable" || next.kind === "paused") {
      clear();
      return;
    }
    const view = rendered ?? createView();
    rendered = view;
    view.section.dataset.testWorkspaceStatus = next.kind;
    if (!("data" in next)) {
      for (const button of view.buttons)
        button.disabled =
          button !== view.refresh ||
          pending ||
          next.kind !== "read_unavailable";
      view.createInput.readOnly = true;
      view.titleInput.readOnly = true;
      if (!("school" in next)) {
        clear();
        return;
      }
      view.school.textContent = "School: " + next.school.displayName;
      view.status.textContent =
        next.kind === "loading"
          ? "Loading Tests…"
          : "Tests are unavailable right now. Refresh Tests to try reading them again.";
      view.status.hidden = false;
      view.content.hidden = true;
      view.section.setAttribute("aria-busy", String(next.kind === "loading"));
      view.createInput.value = "";
      view.titleInput.value = "";
      view.detailHeading.textContent = "Test details";
      view.lifecycle.textContent = "";
      view.endMessage.textContent = "";
      view.uncertainTitle.textContent = "";
      view.conflictMessage.textContent = "";
      view.createError.textContent = "";
      view.titleError.textContent = "";
      view.selectedId = null;
      view.rows.clear();
      view.list.replaceChildren();
      return;
    }
    const data = next.data;
    const selected = data.selected;
    const busy = pending || next.kind === "busy";
    const ready = !busy && next.kind === "ready";
    const confirming = next.kind === "confirming_end";
    const conflict = next.kind === "conflict";
    const uncertain = next.kind === "create_unconfirmed";
    view.content.hidden = false;
    view.section.setAttribute("aria-busy", String(busy));
    view.school.textContent = "School: " + data.school.displayName;
    view.status.textContent =
      next.kind === "busy"
        ? busyText(next)
        : "notice" in next
          ? noticeText(next.notice)
          : "";
    view.status.hidden = view.status.textContent === "";
    view.refresh.disabled = busy || confirming;
    if (view.createInput.value !== data.createDraft)
      view.createInput.value = data.createDraft;
    view.createInput.readOnly = !ready;
    const createValidation =
      next.kind === "ready" ? data.createValidation : null;
    view.createInput.setAttribute(
      "aria-invalid",
      String(createValidation !== null),
    );
    view.createError.textContent =
      createValidation === null ? "" : validationText[createValidation];
    view.createError.hidden = createValidation === null;
    view.create.disabled = !ready;
    view.create.textContent =
      next.kind === "busy" && next.operation === "create"
        ? "Creating Test…"
        : "Create Test";
    view.uncertain.hidden = !uncertain;
    view.uncertainTitle.textContent = uncertain
      ? "Submitted title: " + next.submittedTitle
      : "";
    view.retryCreate.disabled = busy || !uncertain;
    view.startNew.disabled = busy || !uncertain;
    view.selectedId = selected?.id ?? null;
    view.detail.hidden = selected === null && !confirming && !conflict;
    view.detailHeading.textContent = selected?.title ?? "Test details";
    view.lifecycle.textContent =
      selected === null ? "" : lifecycleText(selected.lifecycle);
    view.ended.hidden = selected?.lifecycle !== "ended";
    const titleDraft = data.titleDraft ?? "";
    if (view.titleInput.value !== titleDraft)
      view.titleInput.value = titleDraft;
    view.titleForm.hidden = selected === null || selected.lifecycle === "ended";
    view.titleInput.readOnly = !ready;
    const titleValidation = next.kind === "ready" ? data.titleValidation : null;
    view.titleInput.setAttribute(
      "aria-invalid",
      String(titleValidation !== null),
    );
    view.titleError.textContent =
      titleValidation === null ? "" : validationText[titleValidation];
    view.titleError.hidden = titleValidation === null;
    const validTitle = validateTestTitleDraft(titleDraft);
    view.saveTitle.disabled =
      !ready ||
      view.titleForm.hidden ||
      (validTitle.ok && validTitle.title === selected?.title);
    view.saveTitle.textContent =
      next.kind === "busy" && next.operation === "save_title"
        ? "Saving title…"
        : "Save title";
    view.open.hidden = selected?.lifecycle !== "draft";
    view.open.disabled = !ready || view.open.hidden;
    view.reviewEnd.hidden = selected?.lifecycle !== "open";
    view.reviewEnd.disabled = !ready || view.reviewEnd.hidden;
    view.confirmation.hidden = !confirming;
    view.endMessage.textContent = confirming
      ? "End “" + next.target.title + "” at " + data.school.displayName + "?"
      : "";
    view.confirmEnd.disabled =
      busy ||
      !confirming ||
      selected === null ||
      selected.id !== next.target.testId ||
      selected.revision !== next.target.expectedTestRevision ||
      selected.title !== next.target.title ||
      selected.lifecycle !== "open";
    view.cancelEnd.disabled = busy || !confirming;
    view.conflict.hidden = !conflict;
    view.conflictMessage.textContent = conflict
      ? next.operation === "save_title"
        ? selected?.lifecycle === "ended"
          ? "This Test ended while you were editing. The draft cannot be saved. Use the current Test to continue."
          : "The Test changed while you were editing. Your draft is kept above. Use the current Test, or keep your draft to review and save it again."
        : "The Test changed before the action could be confirmed. Use the current Test and review any new action."
      : "";
    view.useCurrent.disabled = busy || !conflict;
    view.keepDraft.hidden =
      !conflict ||
      next.operation !== "save_title" ||
      selected === null ||
      selected.lifecycle === "ended" ||
      data.titleDraft === null;
    view.keepDraft.disabled = busy || view.keepDraft.hidden;
    view.back.disabled = busy;
    view.firstPage.disabled = !ready;
    view.nextPage.disabled = !ready || data.page.nextCursor === null;
    patchRows(view, data, ready);
  }

  render(snapshot);
  const unsubscribe = controller.subscribe(render);
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe();
    } finally {
      clear();
    }
  };
}
