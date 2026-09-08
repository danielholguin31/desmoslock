import { describe, expect, it, vi } from "vitest";

import type {
  SchoolSettingsAction,
  SchoolSettingsController,
  SchoolSettingsSnapshot,
} from "../src/school-settings/school-settings-controller.js";
import { bindSchoolSettingsView } from "../src/school-settings/school-settings-view.js";

class Element {
  readonly children: Element[] = [];
  readonly attributes: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, (event: Event) => void>();
  className = "";
  textContent = "";
  name = "";
  type = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  selectionStart = 0;
  selectionEnd = 0;
  valueAssignments = 0;
  private inputValue = "";

  constructor(
    readonly ownerDocument: DocumentFixture,
    readonly tagName: string,
  ) {}
  get value() {
    return this.inputValue;
  }
  set value(value: string) {
    this.inputValue = value;
    this.valueAssignments += 1;
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children.splice(0, this.children.length, ...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  fire(type: string) {
    this.listeners.get(type)?.({ preventDefault() {} } as Event);
  }
}

class DocumentFixture {
  activeElement: Element | null = null;
  createElement(tagName: string) {
    return new Element(this, tagName);
  }
}

const school = {
  schoolId: "school-a",
  displayName: "Example School",
  settingsRevision: 1,
};
const editing: SchoolSettingsSnapshot = {
  kind: "editing",
  revision: 1,
  school,
  draft: "Example School",
  notice: null,
  validation: null,
};

function nodes(root: Element): Element[] {
  return root.children.flatMap((child) => [child, ...nodes(child)]);
}

function setup(initial: SchoolSettingsSnapshot = editing) {
  const document = new DocumentFixture();
  const root = new Element(document, "main");
  let snapshot = initial;
  let listener: ((next: SchoolSettingsSnapshot) => void) | undefined;
  const publish = (next: SchoolSettingsSnapshot) => {
    snapshot = next;
    listener?.(next);
  };
  const dispatch = vi.fn<
    (action: SchoolSettingsAction) => Promise<SchoolSettingsSnapshot>
  >(async () => snapshot);
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const controller: SchoolSettingsController = {
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
    dispatch,
    setAccess: vi.fn(),
    dispose: vi.fn(),
  };
  const dispose = bindSchoolSettingsView(
    root as unknown as HTMLElement,
    controller,
  );
  const find = (predicate: (element: Element) => boolean) => {
    const found = nodes(root).find(predicate);
    if (found === undefined) throw new Error("Expected rendered control");
    return found;
  };
  return {
    document,
    root,
    dispatch,
    publish,
    dispose,
    unsubscribe,
    input: () => find((element) => element.name === "school_name"),
    action: (type: SchoolSettingsAction["type"]) =>
      find((element) => element.dataset.schoolSettingsAction === type),
    submit: () => find((element) => element.tagName === "form").fire("submit"),
    text: () =>
      nodes(root)
        .map((element) => element.textContent)
        .join(" "),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("School settings view", () => {
  it.each(["unavailable", "paused"] as const)(
    "mounts no protected label or controls while %s",
    (kind) => {
      const fixture = setup({ kind, revision: 1 });
      expect(fixture.root.children).toEqual([]);
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it("shows a Teacher the School name as text without editing controls", () => {
    const fixture = setup({ kind: "read_only", revision: 1, school });
    expect(fixture.text()).toContain("School name: Example School");
    expect(
      nodes(fixture.root).some((element) =>
        ["input", "button", "form"].includes(element.tagName),
      ),
    ).toBe(false);
  });

  it("starts without stealing focus and disables a pristine or whitespace-only name change", () => {
    const fixture = setup();
    expect(fixture.document.activeElement).toBeNull();
    expect(fixture.action("save").disabled).toBe(true);
    fixture.publish({ ...editing, draft: "  Example School  ", revision: 2 });
    expect(fixture.action("save").disabled).toBe(true);
    fixture.submit();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a direct Save with the rendered revision and prevents a repeated submit", async () => {
    const fixture = setup({ ...editing, draft: "New School", revision: 8 });
    const wait = deferred<SchoolSettingsSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.submit();
    fixture.submit();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "save",
      snapshotRevision: 8,
    });
    expect(fixture.action("save").disabled).toBe(true);
    expect(fixture.input().readOnly).toBe(true);
    expect(fixture.text()).not.toContain("Confirm");
    wait.resolve(editing);
    await wait.promise;
  });

  it("does not rewrite a just-typed draft or native selection during its synchronous publication", async () => {
    const fixture = setup();
    const input = fixture.input();
    input.value = "Example New School";
    input.selectionStart = 11;
    input.selectionEnd = 11;
    input.focus();
    const assignments = input.valueAssignments;
    fixture.dispatch.mockImplementation(async (action) => {
      if (action.type === "edit_name")
        fixture.publish({ ...editing, draft: action.value, revision: 2 });
      return { ...editing, draft: input.value, revision: 2 };
    });
    input.fire("input");
    await Promise.resolve();
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "edit_name",
      value: "Example New School",
    });
    expect(fixture.input()).toBe(input);
    expect(input.valueAssignments).toBe(assignments);
    expect([input.selectionStart, input.selectionEnd]).toEqual([11, 11]);
    expect(fixture.document.activeElement).toBe(input);
  });

  it.each(["verifying", "submitting", "refreshing"] as const)(
    "keeps the draft node and every mutation/reconciliation disabled during %s",
    (phase) => {
      const fixture = setup({ ...editing, draft: "My draft" });
      const input = fixture.input();
      input.focus();
      fixture.publish({
        kind: "saving",
        revision: 2,
        phase,
        school: { ...school, displayName: "A later name", settingsRevision: 3 },
        draft: "My draft",
      });
      expect(fixture.input()).toBe(input);
      expect(input.value).toBe("My draft");
      expect(input.readOnly).toBe(true);
      for (const type of [
        "save",
        "use_current_name",
        "keep_draft",
        "refresh",
      ] as const) {
        expect(fixture.action(type).disabled).toBe(true);
        fixture.action(type).fire("click");
      }
      fixture.submit();
      input.fire("input");
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.document.activeElement).toBe(input);
      expect(fixture.text()).toContain("Current School name: A later name");
      expect(fixture.text()).not.toContain("Saved the School name change.");
    },
  );

  it.each([
    ["required", "Enter a School name."],
    ["too_long", "This School name is too long. Shorten it."],
    [
      "invalid_characters",
      "Use a name without line breaks or hidden characters.",
    ],
  ] as const)(
    "describes %s validation without clearing the invalid draft",
    (validation, message) => {
      const fixture = setup({ ...editing, draft: "Invalid draft", validation });
      expect(fixture.text()).toContain(message);
      expect(fixture.input().value).toBe("Invalid draft");
      expect(fixture.input().attributes["aria-invalid"]).toBe("true");
      expect(fixture.input().attributes["aria-describedby"]).toBe(
        "school-name-error",
      );
    },
  );

  it("focuses the retained invalid field after explicit Save", async () => {
    const fixture = setup({ ...editing, draft: "" });
    fixture.dispatch.mockImplementation(async () => {
      const invalid = {
        ...editing,
        draft: "",
        validation: "required" as const,
        revision: 2,
      };
      fixture.publish(invalid);
      return invalid;
    });
    fixture.submit();
    await Promise.resolve();
    expect(fixture.document.activeElement).toBe(fixture.input());
  });

  it.each(["use_current_name", "keep_draft"] as const)(
    "requires explicit %s reconciliation, binds the current rendered revision and then restores input focus",
    async (type) => {
      const fixture = setup({ ...editing, draft: "My draft" });
      const input = fixture.input();
      input.focus();
      input.selectionStart = 2;
      input.selectionEnd = 5;
      fixture.publish({
        kind: "conflict",
        revision: 9,
        current: {
          ...school,
          displayName: "New current name",
          settingsRevision: 2,
        },
        draft: "My draft",
        notice: null,
      });
      expect(fixture.input()).toBe(input);
      expect(input.readOnly).toBe(true);
      expect(input.value).toBe("My draft");
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
      expect(fixture.action("save").disabled).toBe(true);
      expect(fixture.action("save").hidden).toBe(true);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      fixture.dispatch.mockImplementation(async () => {
        const next = {
          ...editing,
          revision: 10,
          school: {
            ...school,
            displayName: "New current name",
            settingsRevision: 2,
          },
          draft: type === "keep_draft" ? "My draft" : "New current name",
        };
        fixture.publish(next);
        return next;
      });
      fixture.action(type).fire("click");
      await Promise.resolve();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
        type,
        snapshotRevision: 9,
      });
      expect(fixture.document.activeElement).toBe(input);
      expect(input.readOnly).toBe(false);
      expect(fixture.action("save").disabled).toBe(type === "use_current_name");
    },
  );

  it.each(["updated", "unchanged", "rejected", "unconfirmed"] as const)(
    "renders %s honestly beside only the verified current name",
    (notice) => {
      const fixture = setup({
        ...editing,
        school: {
          ...school,
          displayName: "Later verified name",
          settingsRevision: 3,
        },
        draft: "Later verified name",
        notice,
      });
      expect(fixture.text()).toContain(
        "Current School name: Later verified name",
      );
      expect(fixture.action("refresh").hidden).toBe(
        notice === "updated" || notice === "unchanged",
      );
      if (notice === "updated")
        expect(fixture.text()).toContain("Saved the School name change.");
      if (notice === "unconfirmed")
        expect(fixture.text()).toContain(
          "We couldn’t confirm the name change.",
        );
      expect(fixture.text()).not.toContain("Retry");
    },
  );

  it("refreshes an unconfirmed result once without replaying Save", async () => {
    const fixture = setup({
      ...editing,
      draft: "Proposed name",
      notice: "unconfirmed",
    });
    const wait = deferred<SchoolSettingsSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.action("refresh").fire("click");
    fixture.action("refresh").fire("click");
    fixture.submit();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "refresh",
    });
    wait.resolve(editing);
    await wait.promise;
  });

  it("renders long and markup-like labels as text without adding markup elements", () => {
    const displayName = '<img src="x" onerror="alert(1)"> ' + "学校".repeat(30);
    const fixture = setup({
      kind: "read_only",
      revision: 1,
      school: { ...school, displayName },
    });
    expect(fixture.text()).toContain(displayName);
    expect(
      nodes(fixture.root).some((element) => element.tagName === "img"),
    ).toBe(false);
  });

  it.each(["paused", "unavailable"] as const)(
    "scrubs and detaches controls on %s and ignores old handlers",
    (kind) => {
      const fixture = setup({ ...editing, draft: "Private draft" });
      const input = fixture.input();
      const oldForm = nodes(fixture.root).find(
        (element) => element.tagName === "form",
      );
      fixture.publish({ kind, revision: 2 });
      expect(input.value).toBe("");
      expect(fixture.root.children).toEqual([]);
      oldForm?.fire("submit");
      input.value = "Old input";
      input.fire("input");
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it("does not let a late old action disable or focus replacement controls", async () => {
    const fixture = setup({ ...editing, draft: "Old draft" });
    const wait = deferred<SchoolSettingsSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.submit();
    fixture.publish({ kind: "unavailable", revision: 2 });
    fixture.publish({ ...editing, draft: "Replacement draft", revision: 3 });
    const replacement = fixture.input();
    expect(replacement.readOnly).toBe(false);
    wait.resolve({ ...editing, validation: "required" });
    await wait.promise;
    expect(fixture.input()).toBe(replacement);
    expect(replacement.value).toBe("Replacement draft");
    expect(fixture.document.activeElement).toBeNull();
  });

  it("unsubscribes and scrubs on terminal idempotent disposal, even with pending work", async () => {
    const fixture = setup({ ...editing, draft: "Draft" });
    const input = fixture.input();
    const wait = deferred<SchoolSettingsSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.submit();
    fixture.dispose();
    fixture.dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
    wait.resolve(editing);
    await wait.promise;
    fixture.publish(editing);
    expect(fixture.root.children).toEqual([]);
  });
});
