import type {
  SchoolSettingsAction,
  SchoolSettingsController,
  SchoolSettingsNotice,
  SchoolSettingsSnapshot,
} from "./school-settings-controller.js";

type EditableSnapshot = Extract<
  SchoolSettingsSnapshot,
  { kind: "editing" | "saving" | "conflict" }
>;

const noticeText: Record<SchoolSettingsNotice, string> = {
  updated: "Saved the School name change.",
  unchanged: "No name change was needed.",
  rejected:
    "The School name change was not allowed. Refresh School details to check your access.",
  unconfirmed:
    "We couldn’t confirm the name change. Refresh School details to check the current name.",
};

const validationText = {
  required: "Enter a School name.",
  too_long: "This School name is too long. Shorten it.",
  invalid_characters: "Use a name without line breaks or hidden characters.",
};

interface RenderedSettings {
  readonly section: HTMLElement;
  readonly currentName: HTMLParagraphElement;
  readonly input: HTMLInputElement;
  readonly form: HTMLFormElement;
  readonly status: HTMLParagraphElement;
  readonly error: HTMLParagraphElement;
  readonly conflict: HTMLElement;
  readonly save: HTMLButtonElement;
  readonly refresh: HTMLButtonElement;
  readonly useCurrent: HTMLButtonElement;
  readonly keepDraft: HTMLButtonElement;
}

// The controller owns the draft and authority. This binder retains only mounted
// controls, so a presentation update never recreates an active text field.
export function bindSchoolSettingsView(
  root: HTMLElement,
  controller: SchoolSettingsController,
): () => void {
  const document = root.ownerDocument;
  let disposed = false;
  let pending = false;
  let operationEpoch = 0;
  let rendered: RenderedSettings | undefined;
  let readOnlyName: HTMLParagraphElement | undefined;
  let snapshot = controller.getSnapshot();

  function clear(): void {
    operationEpoch += 1;
    pending = false;
    if (rendered !== undefined) rendered.input.value = "";
    rendered = undefined;
    readOnlyName = undefined;
    root.replaceChildren();
  }

  function heading(): HTMLHeadingElement {
    const element = document.createElement("h2");
    element.textContent = "School settings";
    return element;
  }

  function button(
    label: string,
    action: SchoolSettingsAction["type"],
  ): HTMLButtonElement {
    const element = document.createElement("button");
    element.textContent = label;
    element.type = "button";
    element.dataset.schoolSettingsAction = action;
    return element;
  }

  function send(action: SchoolSettingsAction): void {
    if (disposed || pending || rendered === undefined) return;
    const origin = rendered;
    const epoch = ++operationEpoch;
    const shouldFocus =
      action.type === "save" ||
      action.type === "use_current_name" ||
      action.type === "keep_draft";
    if (action.type !== "edit_name") {
      pending = true;
      render(snapshot);
    }
    void controller.dispatch(action).then(
      () => {
        if (disposed || epoch !== operationEpoch) return;
        if (action.type !== "edit_name") pending = false;
        render(controller.getSnapshot());
        if (
          shouldFocus &&
          rendered === origin &&
          snapshot.kind === "editing" &&
          (action.type !== "save" || snapshot.validation !== null)
        ) {
          rendered.input.focus({ preventScroll: true });
        }
      },
      () => {
        if (disposed || epoch !== operationEpoch) return;
        pending = false;
        clear();
      },
    );
  }

  function createForm(): RenderedSettings {
    const section = document.createElement("section");
    section.className = "school-settings";
    const currentName = document.createElement("p");
    currentName.className = "school-settings__current";
    const status = document.createElement("p");
    status.className = "school-settings__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const form = document.createElement("form");
    form.className = "school-settings__form";
    form.noValidate = true;
    const label = document.createElement("label");
    label.className = "school-settings__field";
    const labelText = document.createElement("span");
    labelText.textContent = "School name";
    const input = document.createElement("input");
    input.name = "school_name";
    input.type = "text";
    input.autocomplete = "off";
    input.required = true;
    input.setAttribute("aria-describedby", "school-name-error");
    label.append(labelText, input);
    const error = document.createElement("p");
    error.id = "school-name-error";
    error.className = "school-settings__error";
    error.setAttribute("aria-live", "polite");
    const conflict = document.createElement("div");
    conflict.className = "school-settings__conflict";
    const conflictHeading = document.createElement("h3");
    conflictHeading.textContent = "Review the updated School name";
    const explanation = document.createElement("p");
    explanation.textContent =
      "The School name changed while you were editing. Your draft is kept above. Use the current name, or keep your draft to review and save it again.";
    const reconciliation = document.createElement("div");
    reconciliation.className = "school-settings__actions";
    const useCurrent = button("Use current name", "use_current_name");
    const keepDraft = button("Keep my draft", "keep_draft");
    reconciliation.append(useCurrent, keepDraft);
    conflict.append(conflictHeading, explanation, reconciliation);
    const actions = document.createElement("div");
    actions.className = "school-settings__actions";
    const save = button("Save", "save");
    save.type = "submit";
    const refresh = button("Refresh School details", "refresh");
    actions.append(save, refresh);
    form.append(label, error, conflict, actions);
    section.append(heading(), currentName, status, form);
    const elements = {
      section,
      currentName,
      input,
      form,
      status,
      error,
      conflict,
      save,
      refresh,
      useCurrent,
      keepDraft,
    };

    input.addEventListener("input", () => {
      if (rendered !== elements || snapshot.kind !== "editing") return;
      send({ type: "edit_name", value: input.value });
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (rendered !== elements || snapshot.kind !== "editing" || save.disabled)
        return;
      send({ type: "save", snapshotRevision: snapshot.revision });
    });
    for (const [control, type] of [
      [useCurrent, "use_current_name"],
      [keepDraft, "keep_draft"],
    ] as const) {
      control.addEventListener("click", () => {
        if (
          rendered !== elements ||
          snapshot.kind !== "conflict" ||
          control.disabled
        )
          return;
        send({ type, snapshotRevision: snapshot.revision });
      });
    }
    refresh.addEventListener("click", () => {
      if (rendered !== elements || refresh.disabled || refresh.hidden) return;
      send({ type: "refresh" });
    });
    return elements;
  }

  function patch(value: EditableSnapshot, elements: RenderedSettings): void {
    const school = value.kind === "conflict" ? value.current : value.school;
    const busy = pending || value.kind === "saving";
    const notice = value.kind === "saving" ? null : value.notice;
    const validation = value.kind === "editing" ? value.validation : null;
    elements.section.dataset.schoolSettingsStatus = value.kind;
    elements.form.setAttribute("aria-busy", String(busy));
    elements.currentName.textContent = `Current School name: ${school.displayName}`;
    // Assigning even an identical value can alter the native caret/selection.
    if (elements.input.value !== value.draft)
      elements.input.value = value.draft;
    elements.input.readOnly = busy || value.kind === "conflict";
    elements.input.setAttribute("aria-invalid", String(validation !== null));
    elements.error.textContent =
      validation === null ? "" : validationText[validation];
    elements.error.hidden = validation === null;
    elements.conflict.hidden = value.kind !== "conflict";
    elements.useCurrent.disabled = busy || value.kind !== "conflict";
    elements.keepDraft.disabled = busy || value.kind !== "conflict";
    elements.save.hidden = value.kind === "conflict";
    elements.save.disabled =
      busy ||
      value.kind !== "editing" ||
      value.draft.trim() === school.displayName;
    elements.save.textContent = value.kind === "saving" ? "Saving…" : "Save";
    elements.refresh.hidden = notice !== "unconfirmed" && notice !== "rejected";
    elements.refresh.disabled = busy;
    elements.status.textContent =
      value.kind === "saving"
        ? value.phase === "verifying"
          ? "Checking your access before saving…"
          : value.phase === "submitting"
            ? "Saving the School name…"
            : "Checking the current School details…"
        : notice === null
          ? ""
          : noticeText[notice];
    elements.status.hidden = elements.status.textContent === "";
  }

  function render(value: SchoolSettingsSnapshot): void {
    if (disposed) return;
    snapshot = value;
    if (value.kind === "unavailable" || value.kind === "paused") {
      clear();
      return;
    }
    if (value.kind === "read_only") {
      if (readOnlyName === undefined) {
        clear();
        const section = document.createElement("section");
        section.className = "school-settings";
        section.dataset.schoolSettingsStatus = "read_only";
        readOnlyName = document.createElement("p");
        section.append(heading(), readOnlyName);
        root.replaceChildren(section);
      }
      readOnlyName.textContent = `School name: ${value.school.displayName}`;
      return;
    }
    if (!("draft" in value)) return;
    if (rendered === undefined) {
      clear();
      rendered = createForm();
      root.replaceChildren(rendered.section);
    }
    patch(value, rendered);
  }

  render(snapshot);
  const unsubscribe = controller.subscribe(render);
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    clear();
  };
}
