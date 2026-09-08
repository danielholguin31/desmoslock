import { describe, expect, it, vi } from "vitest";

import type { StaffTest } from "@desmoslock/contracts";

import type {
  TestWorkspaceAction,
  TestWorkspaceController,
  TestWorkspaceData,
  TestWorkspaceNotice,
  TestWorkspaceSnapshot,
} from "../src/test-workspace/test-workspace-controller.js";
import { bindTestWorkspaceView } from "../src/test-workspace/test-workspace-view.js";

class Element {
  readonly children: Element[] = [];
  readonly attributes: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly focusCalls: Array<FocusOptions | undefined> = [];
  parentElement: Element | null = null;
  className = "";
  textContent = "";
  name = "";
  type = "";
  id = "";
  hidden = false;
  readOnly = false;
  tabIndex = 0;
  selectionStart = 0;
  selectionEnd = 0;
  valueAssignments = 0;
  disableTransitions = 0;
  private controlDisabled = false;
  private inputValue = "";

  constructor(
    readonly ownerDocument: DocumentFixture,
    readonly tagName: string,
  ) {}
  get disabled() {
    return this.controlDisabled;
  }
  set disabled(value: boolean) {
    if (value && !this.controlDisabled) {
      this.disableTransitions += 1;
      if (this.isConnected && this.ownerDocument.activeElement === this)
        this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.controlDisabled = value;
  }
  get value() {
    return this.inputValue;
  }
  set value(value: string) {
    this.inputValue = value;
    this.valueAssignments += 1;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }
  get isConnected() {
    return this.ownerDocument.body.contains(this);
  }
  get parentNode(): Element | null {
    return this.parentElement;
  }
  get firstChild(): Element | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): Element | null {
    if (this.parentElement === null) return null;
    return (
      this.parentElement.children[
        this.parentElement.children.indexOf(this) + 1
      ] ?? null
    );
  }
  append(...children: Element[]) {
    for (const child of children) this.insertBefore(child, null);
  }
  insertBefore(child: Element, reference: Element | null) {
    if (reference !== null && reference.parentElement !== this)
      throw new Error("Reference node is not a child of this parent");
    if (child === reference) return child;
    child.remove();
    child.parentElement = this;
    const index =
      reference === null
        ? this.children.length
        : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...children: Element[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    const parent = this.parentElement;
    if (parent !== null) {
      if (this.isConnected && this.contains(this.ownerDocument.activeElement))
        this.ownerDocument.activeElement = this.ownerDocument.body;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  contains(element: Element | null): boolean {
    return (
      element === this || this.children.some((child) => child.contains(element))
    );
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
    if (key.startsWith("data-"))
      this.dataset[
        key
          .slice(5)
          .replace(/-([a-z])/gu, (_, character: string) =>
            character.toUpperCase(),
          )
      ] = value;
  }
  getAttribute(key: string) {
    return this.attributes[key] ?? null;
  }
  removeAttribute(key: string) {
    delete this.attributes[key];
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  focus(options?: FocusOptions) {
    this.focusCalls.push(options);
    if (this.disabled || !this.isConnected) return;
    this.ownerDocument.activeElement = this;
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({
        target: this,
        currentTarget: this,
        preventDefault() {},
      } as unknown as Event);
  }
}

class DocumentFixture {
  activeElement: Element | null = null;
  readonly body = new Element(this, "body");
  createElement(tagName: string) {
    return new Element(this, tagName);
  }
}

const school = {
  schoolId: "90000000-0000-4000-8000-000000000001",
  displayName: "Example School",
  settingsRevision: 1,
};
const draftTest: StaffTest = {
  id: "90000000-0000-4000-8000-000000000011",
  schoolId: school.schoolId,
  createdByProfileId: "90000000-0000-4000-8000-000000000021",
  title: "Algebra quiz",
  lifecycle: "draft",
  revision: 3,
  createdAt: "2026-09-08T10:00:00.123456Z",
  openedAt: null,
  endedAt: null,
};
const openTest: StaffTest = {
  ...draftTest,
  lifecycle: "open",
  revision: 4,
  openedAt: "2026-09-08T11:00:00.123457Z",
};
const endedTest: StaffTest = {
  ...openTest,
  lifecycle: "ended",
  revision: 5,
  endedAt: "2026-09-08T12:00:00.123458Z",
};
const otherTest: StaffTest = {
  ...draftTest,
  id: "90000000-0000-4000-8000-000000000012",
  title: "Geometry quiz",
};

function data(overrides: Partial<TestWorkspaceData> = {}): TestWorkspaceData {
  return {
    school,
    page: { items: [draftTest, otherTest], nextCursor: null },
    selected: draftTest,
    createDraft: "New quiz",
    createValidation: null,
    titleDraft: "Revised algebra quiz",
    titleValidation: null,
    ...overrides,
  };
}

function ready(
  overrides: Partial<TestWorkspaceData> = {},
  revision = 1,
  notice: TestWorkspaceNotice | null = null,
): TestWorkspaceSnapshot {
  return { kind: "ready", revision, data: data(overrides), notice };
}

function review(revision = 2): TestWorkspaceSnapshot {
  return {
    kind: "confirming_end",
    revision,
    data: data({ selected: openTest, titleDraft: openTest.title }),
    target: {
      testId: openTest.id,
      title: openTest.title,
      expectedTestRevision: openTest.revision,
    },
  };
}

function nodes(root: Element): Element[] {
  return root.children.flatMap((child) => [child, ...nodes(child)]);
}

function visible(element: Element): boolean {
  return (
    !element.hidden &&
    (element.parentElement === null || visible(element.parentElement))
  );
}

function setup(initial: TestWorkspaceSnapshot = ready()) {
  const document = new DocumentFixture();
  const root = new Element(document, "main");
  document.body.append(root);
  let snapshot = initial;
  let listener: ((next: TestWorkspaceSnapshot) => void) | undefined;
  const publish = (next: TestWorkspaceSnapshot) => {
    snapshot = next;
    listener?.(next);
  };
  const dispatch = vi.fn<
    (action: TestWorkspaceAction) => Promise<TestWorkspaceSnapshot>
  >(async () => snapshot);
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const controller: TestWorkspaceController = {
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
    dispatch,
    setAccess: vi.fn(),
    refreshFromStaff: vi.fn(async () => snapshot),
    dispose: vi.fn(),
  };
  const dispose = bindTestWorkspaceView(
    root as unknown as HTMLElement,
    controller,
  );
  const find = (predicate: (element: Element) => boolean) => {
    const found = nodes(root).find(predicate);
    if (found === undefined) throw new Error("Expected rendered control");
    return found;
  };
  const input = (name: "new_test_title" | "test_title") =>
    find((element) => element.name === name);
  const form = (name: "new_test_title" | "test_title") => {
    let element: Element | null = input(name);
    while (element !== null && element.tagName !== "form")
      element = element.parentElement;
    if (element === null) throw new Error("Expected field inside a form");
    return element;
  };
  return {
    document,
    root,
    controller,
    dispatch,
    publish,
    dispose,
    unsubscribe,
    input,
    form,
    find,
    action: (type: TestWorkspaceAction["type"]) =>
      find((element) => element.dataset.testWorkspaceAction === type),
    heading: (marker = "testWorkspaceHeading") =>
      find((element) => marker in element.dataset),
    text: () =>
      nodes(root)
        .filter(visible)
        .map((element) => element.textContent)
        .join(" "),
    visibleActions: () =>
      nodes(root).filter(
        (element) =>
          "testWorkspaceAction" in element.dataset && visible(element),
      ),
    sibling: () => {
      const element = document.createElement("input");
      document.body.append(element);
      return element;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Test workspace view", () => {
  it.each(["unavailable", "paused"] as const)(
    "mounts no protected content and dispatches nothing while %s",
    (kind) => {
      const fixture = setup({ kind, revision: 1 });
      expect(fixture.root.children).toEqual([]);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.document.activeElement).toBeNull();
    },
  );

  it("keeps the passive heading through loading, empty and read failure without treating loading as empty", () => {
    const fixture = setup({ kind: "loading", revision: 1, school });
    const heading = fixture.heading();
    expect(heading.tabIndex).toBe(-1);
    expect(fixture.text()).toMatch(/loading Tests/iu);
    expect(fixture.text()).not.toMatch(/no Tests/iu);
    fixture.publish(
      ready(
        {
          page: { items: [], nextCursor: null },
          selected: null,
          titleDraft: null,
        },
        2,
      ),
    );
    expect(fixture.heading()).toBe(heading);
    expect(fixture.text()).toMatch(/no Tests/iu);
    expect(fixture.input("new_test_title").readOnly).toBe(false);
    fixture.publish({ kind: "read_unavailable", revision: 3, school });
    expect(fixture.heading()).toBe(heading);
    expect(fixture.text()).not.toMatch(/no Tests/iu);
    expect(fixture.action("refresh").disabled).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.document.activeElement).toBeNull();
  });

  it("renders Create, selected detail and list in DOM order without a mount read or autofocus", () => {
    const fixture = setup();
    const order = nodes(fixture.root);
    expect(order.indexOf(fixture.input("new_test_title"))).toBeLessThan(
      order.indexOf(fixture.heading("testWorkspaceDetailHeading")),
    );
    expect(
      order.indexOf(fixture.heading("testWorkspaceDetailHeading")),
    ).toBeLessThan(order.indexOf(fixture.heading("testWorkspaceListHeading")));
    expect(fixture.input("new_test_title")).not.toBe(
      fixture.input("test_title"),
    );
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.document.activeElement).toBeNull();
  });

  it.each([
    ["new_test_title", "edit_create_title"],
    ["test_title", "edit_title"],
  ] as const)(
    "keeps the %s node, native caret and the other draft during synchronous input publication",
    async (name, type) => {
      const fixture = setup();
      const input = fixture.input(name);
      const other = fixture.input(
        name === "test_title" ? "new_test_title" : "test_title",
      );
      const otherValue = other.value;
      input.value = "Typed in the middle";
      input.selectionStart = 6;
      input.selectionEnd = 9;
      input.focus();
      const assignments = input.valueAssignments;
      fixture.dispatch.mockImplementation(async (action) => {
        if (
          action.type === "edit_create_title" ||
          action.type === "edit_title"
        ) {
          const next = ready(
            {
              [action.type === "edit_title" ? "titleDraft" : "createDraft"]:
                action.value,
            },
            2,
          );
          fixture.publish(next);
          return next;
        }
        return ready();
      });
      input.fire("input");
      await settle();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
        type,
        value: "Typed in the middle",
      });
      expect(fixture.input(name)).toBe(input);
      expect(input.valueAssignments).toBe(assignments);
      expect([input.selectionStart, input.selectionEnd]).toEqual([6, 9]);
      expect(other.value).toBe(otherValue);
      expect(fixture.document.activeElement).toBe(input);
    },
  );

  it("patches School labels and quiet list changes without rewriting fields or stealing sibling focus", () => {
    const fixture = setup();
    const create = fixture.input("new_test_title");
    const title = fixture.input("test_title");
    title.selectionStart = 2;
    title.selectionEnd = 7;
    const assignments = [create.valueAssignments, title.valueAssignments];
    const sibling = fixture.sibling();
    sibling.value = "Membership draft";
    sibling.focus();
    fixture.publish(
      ready(
        {
          school: {
            ...school,
            displayName: "Renamed School",
            settingsRevision: 2,
          },
          page: {
            items: [
              draftTest,
              { ...otherTest, title: "Changed elsewhere", revision: 4 },
            ],
            nextCursor: null,
          },
        },
        8,
      ),
    );
    expect(fixture.input("new_test_title")).toBe(create);
    expect(fixture.input("test_title")).toBe(title);
    expect([create.valueAssignments, title.valueAssignments]).toEqual(
      assignments,
    );
    expect([title.selectionStart, title.selectionEnd]).toEqual([2, 7]);
    expect(fixture.document.activeElement).toBe(sibling);
    expect(sibling.value).toBe("Membership draft");
    expect(fixture.text()).toContain("Renamed School");
    expect(fixture.text()).toContain("Changed elsewhere");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["confirm_end", "cancel_end", "refresh"] as const)(
    "preserves focused %s across a passive School rename without temporarily disabling or refocusing it",
    (type) => {
      const initial = type === "refresh" ? ready() : review();
      if (!("data" in initial)) throw new Error("Expected data snapshot");
      const fixture = setup(initial);
      const control = fixture.action(type);
      expect(control.disabled).toBe(false);
      control.focus();
      expect(fixture.document.activeElement === control).toBe(true);
      const disableTransitions = control.disableTransitions;
      const focusCalls = control.focusCalls.length;
      fixture.publish({
        ...initial,
        revision: 8,
        data: {
          ...initial.data,
          school: {
            ...school,
            displayName: "Renamed School",
            settingsRevision: 2,
          },
        },
      });
      expect(fixture.action(type)).toBe(control);
      expect(control.isConnected).toBe(true);
      expect(control.disabled).toBe(false);
      expect(control.disableTransitions).toBe(disableTransitions);
      expect(fixture.document.activeElement === control).toBe(true);
      expect(control.focusCalls).toHaveLength(focusCalls);
      expect(fixture.text()).toContain("Renamed School");
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it("retains focused Refresh in a read error across a passive School rename", () => {
    const fixture = setup({ kind: "read_unavailable", revision: 1, school });
    const refresh = fixture.action("refresh");
    refresh.focus();
    const disableTransitions = refresh.disableTransitions;
    const focusCalls = refresh.focusCalls.length;
    fixture.publish({
      kind: "read_unavailable",
      revision: 2,
      school: { ...school, displayName: "Renamed School", settingsRevision: 2 },
    });
    expect(fixture.action("refresh")).toBe(refresh);
    expect(refresh.disabled).toBe(false);
    expect(refresh.disableTransitions).toBe(disableTransitions);
    expect(fixture.document.activeElement === refresh).toBe(true);
    expect(refresh.focusCalls).toHaveLength(focusCalls);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["prepend", "remove_unrelated"] as const)(
    "keeps the unchanged surviving row connected and focused during a quiet %s list update",
    (change) => {
      const fixture = setup();
      const row = fixture.find(
        (element) =>
          element.dataset.testWorkspaceAction === "select_test" &&
          element.textContent === draftTest.title,
      );
      const listItem = row.parentElement;
      row.focus();
      const focusCalls = row.focusCalls.length;
      const newTest = {
        ...otherTest,
        id: "90000000-0000-4000-8000-000000000013",
        title: "New colleague quiz",
        createdAt: "2026-09-08T10:00:00.123457Z",
      };
      const items =
        change === "prepend" ? [newTest, draftTest, otherTest] : [draftTest];
      fixture.publish(ready({ page: { items, nextCursor: null } }, 2));
      expect(
        fixture.find(
          (element) =>
            element.dataset.testWorkspaceAction === "select_test" &&
            element.textContent === draftTest.title,
        ),
      ).toBe(row);
      expect(row.parentElement).toBe(listItem);
      expect(row.isConnected).toBe(true);
      expect(fixture.document.activeElement === row).toBe(true);
      expect(row.focusCalls).toHaveLength(focusCalls);
      const renderedTitles = nodes(fixture.root)
        .filter(
          (element) => element.dataset.testWorkspaceAction === "select_test",
        )
        .map((element) => element.textContent);
      expect(renderedTitles).toEqual(items.map((item) => item.title));
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["new_test_title", "create_test"],
    ["test_title", "save_title"],
  ] as const)(
    "submits %s once with the latest rendered revision and blocks competing actions before publication",
    async (name, type) => {
      const fixture = setup();
      const form = fixture.form(name);
      fixture.publish(ready({}, 12));
      const wait = deferred<TestWorkspaceSnapshot>();
      fixture.dispatch.mockReturnValue(wait.promise);
      form.fire("submit");
      form.fire("submit");
      fixture.action("open_test").fire("click");
      fixture.action("refresh").fire("click");
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
        type,
        snapshotRevision: 12,
      });
      expect(fixture.input(name).readOnly).toBe(true);
      wait.resolve(ready({}, 12));
      await settle();
    },
  );

  it("opens directly with the current snapshot revision and no End confirmation", async () => {
    const fixture = setup();
    const button = fixture.action("open_test");
    fixture.publish(
      ready(
        {
          school: {
            ...school,
            displayName: "Current School",
            settingsRevision: 2,
          },
        },
        9,
      ),
    );
    expect(fixture.action("open_test")).toBe(button);
    button.fire("click");
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "open_test",
      snapshotRevision: 9,
    });
    expect(
      fixture
        .visibleActions()
        .some(
          (element) => element.dataset.testWorkspaceAction === "confirm_end",
        ),
    ).toBe(false);
  });

  it("does not submit a pristine canonical title as a new Save", () => {
    const fixture = setup(ready({ titleDraft: `  ${draftTest.title}  ` }));
    expect(fixture.action("save_title").disabled).toBe(true);
    fixture.form("test_title").fire("submit");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["verifying", "submitting", "refreshing"] as const)(
    "retains both drafts and disables all Test interactions during %s",
    (phase) => {
      const fixture = setup();
      const create = fixture.input("new_test_title");
      const title = fixture.input("test_title");
      title.focus();
      fixture.publish({
        kind: "busy",
        revision: 2,
        operation: "save_title",
        phase,
        data: data(),
      });
      expect(fixture.input("new_test_title")).toBe(create);
      expect(fixture.input("test_title")).toBe(title);
      expect(create.readOnly).toBe(true);
      expect(title.readOnly).toBe(true);
      for (const button of fixture.visibleActions()) {
        expect(button.disabled).toBe(true);
        button.fire("click");
      }
      fixture.form("new_test_title").fire("submit");
      fixture.form("test_title").fire("submit");
      create.fire("input");
      title.fire("input");
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.document.activeElement).toBe(title);
    },
  );

  it.each(["required", "too_long", "invalid_characters"] as const)(
    "associates %s errors with each retained draft without a character-count maxlength",
    (validation) => {
      const fixture = setup(
        ready({ createValidation: validation, titleValidation: validation }),
      );
      for (const name of ["new_test_title", "test_title"] as const) {
        const input = fixture.input(name);
        expect(input.attributes["aria-invalid"]).toBe("true");
        const describedBy = input.attributes["aria-describedby"];
        expect(describedBy).toBeTruthy();
        const error = fixture.find((element) => element.id === describedBy);
        expect(error.textContent.length).toBeGreaterThan(0);
        expect(visible(error)).toBe(true);
        expect(input.attributes.maxlength).toBeUndefined();
      }
      expect(fixture.input("new_test_title").value).toBe("New quiz");
      expect(fixture.input("test_title").value).toBe("Revised algebra quiz");
    },
  );

  it.each([
    ["new_test_title", "createValidation"],
    ["test_title", "titleValidation"],
  ] as const)(
    "focuses %s only after its explicit invalid submission",
    async (name, validationKey) => {
      const fixture = setup();
      const input = fixture.input(name);
      fixture.dispatch.mockImplementation(async () => {
        const next = ready({ [validationKey]: "too_long" }, 2);
        fixture.publish(next);
        return next;
      });
      fixture.form(name).fire("submit");
      await settle();
      expect(fixture.document.activeElement).toBe(input);
      expect(input.focusCalls.at(-1)).toEqual({ preventScroll: true });
    },
  );

  it("selects explicitly, focuses detail, and returns to the invoking row without dispatching a deselect", async () => {
    const fixture = setup();
    const row = fixture.find(
      (element) =>
        element.dataset.testWorkspaceAction === "select_test" &&
        element.textContent.includes(otherTest.title),
    );
    row.focus();
    fixture.dispatch.mockImplementation(async () => {
      const next = ready(
        { selected: otherTest, titleDraft: otherTest.title },
        2,
      );
      fixture.publish(next);
      return next;
    });
    row.fire("click");
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "select_test",
      testId: otherTest.id,
    });
    expect(fixture.document.activeElement).toBe(
      fixture.heading("testWorkspaceDetailHeading"),
    );
    const back = fixture.find(
      (element) =>
        element.tagName === "button" &&
        /back to Tests/iu.test(element.textContent),
    );
    back.fire("click");
    expect(fixture.document.activeElement).toBe(row);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns to the list heading when the invoking row has left the current page", async () => {
    const fixture = setup();
    const row = fixture.find(
      (element) =>
        element.dataset.testWorkspaceAction === "select_test" &&
        element.textContent.includes(otherTest.title),
    );
    row.focus();
    fixture.dispatch.mockImplementation(async () => {
      const next = ready(
        { selected: otherTest, titleDraft: otherTest.title },
        2,
      );
      fixture.publish(next);
      return next;
    });
    row.fire("click");
    await settle();
    fixture.publish(
      ready(
        {
          selected: otherTest,
          titleDraft: otherTest.title,
          page: { items: [draftTest], nextCursor: null },
        },
        3,
      ),
    );
    fixture
      .find(
        (element) =>
          element.tagName === "button" &&
          /back to Tests/iu.test(element.textContent),
      )
      .fire("click");
    expect(fixture.document.activeElement).toBe(
      fixture.heading("testWorkspaceListHeading"),
    );
    row.fire("click");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not move focus back from a sibling when a deferred selection completes", async () => {
    const fixture = setup();
    const row = fixture.action("select_test");
    row.focus();
    const wait = deferred<TestWorkspaceSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    row.fire("click");
    const sibling = fixture.sibling();
    sibling.focus();
    const next = ready({}, 2);
    fixture.publish(next);
    wait.resolve(next);
    await settle();
    expect(fixture.document.activeElement).toBe(sibling);
  });

  it("reviews End, preserves its controls on School rename, and confirms only the snapshot revision", async () => {
    const fixture = setup(
      ready({ selected: openTest, titleDraft: openTest.title }),
    );
    const end = fixture.action("review_end");
    end.focus();
    fixture.dispatch.mockImplementation(async () => {
      const next = review();
      fixture.publish(next);
      return next;
    });
    end.fire("click");
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "review_end",
      snapshotRevision: 1,
    });
    expect(fixture.document.activeElement).toBe(
      fixture.heading("testWorkspaceEndHeading"),
    );
    const confirm = fixture.action("confirm_end");
    const cancel = fixture.action("cancel_end");
    confirm.focus();
    const current = review(8);
    if (current.kind !== "confirming_end") throw new Error("Expected review");
    fixture.publish({
      ...current,
      data: {
        ...current.data,
        school: {
          ...school,
          displayName: "Renamed School",
          settingsRevision: 2,
        },
      },
    });
    expect(fixture.action("confirm_end")).toBe(confirm);
    expect(fixture.action("cancel_end")).toBe(cancel);
    expect(fixture.document.activeElement === confirm).toBe(true);
    expect(fixture.text()).toContain("Renamed School");
    fixture.dispatch.mockImplementation(async () =>
      fixture.controller.getSnapshot(),
    );
    confirm.fire("click");
    await settle();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "confirm_end",
      snapshotRevision: 8,
    });
    expect(fixture.text()).not.toMatch(/unlock.*device|device.*unlock/iu);
  });

  it("cancels End explicitly and restores the valid End action without writing", async () => {
    const fixture = setup(
      ready({ selected: openTest, titleDraft: openTest.title }),
    );
    const end = fixture.action("review_end");
    end.focus();
    fixture.dispatch.mockImplementation(async (action) => {
      const next =
        action.type === "review_end"
          ? review()
          : ready({ selected: openTest, titleDraft: openTest.title }, 3);
      fixture.publish(next);
      return next;
    });
    end.fire("click");
    await settle();
    fixture.action("cancel_end").focus();
    fixture.action("cancel_end").fire("click");
    await settle();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "review_end", snapshotRevision: 1 },
      { type: "cancel_end", snapshotRevision: 2 },
    ]);
    expect(fixture.document.activeElement).toBe(fixture.action("review_end"));
  });

  it("makes a detached confirmation inert when current Test facts cancel the review", () => {
    const fixture = setup(review());
    const confirm = fixture.action("confirm_end");
    fixture.publish({
      kind: "conflict",
      revision: 3,
      operation: "end",
      data: data({
        selected: { ...openTest, title: "Changed by colleague", revision: 5 },
        titleDraft: openTest.title,
      }),
      notice: { kind: "selection_changed" },
    });
    confirm.fire("click");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fixture
        .visibleActions()
        .some(
          (element) => element.dataset.testWorkspaceAction === "confirm_end",
        ),
    ).toBe(false);
    expect(fixture.text()).toContain("Changed by colleague");
  });

  it.each(["use_current_test", "keep_title_draft"] as const)(
    "reconciles a title conflict with explicit %s and focuses the retained draft without saving",
    async (type) => {
      const fixture = setup();
      const input = fixture.input("test_title");
      fixture.publish({
        kind: "conflict",
        revision: 7,
        operation: "save_title",
        data: data({
          selected: {
            ...draftTest,
            title: "Current colleague title",
            revision: 4,
          },
        }),
        notice: null,
      });
      expect(fixture.input("test_title")).toBe(input);
      expect(input.value).toBe("Revised algebra quiz");
      expect(input.readOnly).toBe(true);
      expect(fixture.action("save_title").disabled).toBe(true);
      fixture.dispatch.mockImplementation(async () => {
        const next = ready(
          {
            selected: {
              ...draftTest,
              title: "Current colleague title",
              revision: 4,
            },
            titleDraft:
              type === "use_current_test"
                ? "Current colleague title"
                : "Revised algebra quiz",
          },
          8,
        );
        fixture.publish(next);
        return next;
      });
      fixture.action(type).focus();
      fixture.action(type).fire("click");
      await settle();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
        type,
        snapshotRevision: 7,
      });
      expect(fixture.document.activeElement).toBe(input);
      expect(input.readOnly).toBe(false);
    },
  );

  it.each([
    ["open", openTest],
    ["end", endedTest],
    ["save_title", endedTest],
  ] as const)(
    "does not offer Keep draft for %s conflict on %s",
    (operation, selected) => {
      const fixture = setup({
        kind: "conflict",
        revision: 4,
        operation,
        data: data({ selected }),
        notice: null,
      });
      const actions = fixture.visibleActions();
      expect(
        actions.some(
          (element) =>
            element.dataset.testWorkspaceAction === "keep_title_draft",
        ),
      ).toBe(false);
      expect(fixture.action("use_current_test").disabled).toBe(false);
      expect(
        actions.some(
          (element) =>
            ["save_title", "open_test", "review_end"].includes(
              element.dataset.testWorkspaceAction ?? "",
            ) && !element.disabled,
        ),
      ).toBe(false);
    },
  );

  it("renders ended detail as read-only text without an editable title form", () => {
    const fixture = setup(ready({ selected: endedTest, titleDraft: null }));
    expect(
      nodes(fixture.root).some(
        (element) => visible(element) && element.name === "test_title",
      ),
    ).toBe(false);
    expect(
      fixture
        .visibleActions()
        .some((element) =>
          ["save_title", "open_test", "review_end"].includes(
            element.dataset.testWorkspaceAction ?? "",
          ),
        ),
    ).toBe(false);
    expect(fixture.text()).toContain(endedTest.title);
    expect(fixture.text()).toMatch(/ended/iu);
    expect(fixture.input("new_test_title").readOnly).toBe(false);
  });

  it.each(["retry_create", "start_new_test", "refresh"] as const)(
    "keeps creation uncertainty immutable and dispatches only explicit %s",
    async (type) => {
      const initial: TestWorkspaceSnapshot = {
        kind: "create_unconfirmed",
        revision: 11,
        data: data({
          selected: { ...draftTest, title: "Later verified title" },
        }),
        submittedTitle: "Original submitted title",
      };
      const fixture = setup(initial);
      expect(fixture.text()).toMatch(/creation unconfirmed/iu);
      expect(fixture.text()).toContain("Original submitted title");
      expect(fixture.input("new_test_title").readOnly).toBe(true);
      expect(
        fixture
          .visibleActions()
          .some(
            (element) =>
              element.dataset.testWorkspaceAction === "create_test" &&
              !element.disabled,
          ),
      ).toBe(false);
      const wait = deferred<TestWorkspaceSnapshot>();
      fixture.dispatch.mockReturnValue(wait.promise);
      fixture.action(type).fire("click");
      fixture.action(type).fire("click");
      fixture.form("new_test_title").fire("submit");
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(
        type === "refresh" ? { type } : { type, snapshotRevision: 11 },
      );
      wait.resolve(initial);
      await settle();
      expect(fixture.text()).toMatch(/creation unconfirmed/iu);
      expect(fixture.text()).not.toContain("Test created.");
    },
  );

  it.each(["save_title", "open", "end"] as const)(
    "shows an unconfirmed %s beside current facts with read-only refresh and no automatic retry",
    async (operation) => {
      const fixture = setup(
        ready({ selected: endedTest, titleDraft: null }, 6, {
          kind: "unconfirmed",
          operation,
        }),
      );
      expect(fixture.text()).toMatch(/unconfirmed/iu);
      expect(fixture.text()).not.toMatch(/retry/iu);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      fixture.action("refresh").fire("click");
      await settle();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
        type: "refresh",
      });
      expect(fixture.text()).not.toContain(
        "Test ended. Participation is closed.",
      );
    },
  );

  it.each([
    ["test_created", /Test created/iu],
    ["test_creation_already_recorded", /earlier|already/iu],
    ["test_title_updated", /saved.*title/iu],
    ["test_title_unchanged", /no.*change|unchanged/iu],
    ["test_opened", /opened.*Test|Test opened/iu],
    ["test_already_open", /already open/iu],
    ["test_ended", /Test ended/iu],
    ["test_already_ended", /already ended/iu],
  ] as const)(
    "renders historical %s honestly beside later current facts",
    (code, message) => {
      const fixture = setup(
        ready(
          {
            selected: { ...endedTest, title: "Later current title" },
            titleDraft: null,
          },
          9,
          { kind: "confirmed", code, testId: draftTest.id },
        ),
      );
      expect(fixture.text()).toMatch(message);
      expect(fixture.text()).toContain("Later current title");
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it("preserves acknowledged creation when current selected details are unavailable", () => {
    const fixture = setup(
      ready({ selected: null, titleDraft: null }, 5, {
        kind: "confirmed",
        code: "test_created",
        testId: draftTest.id,
      }),
    );
    expect(fixture.text()).toContain("Test created.");
    expect(fixture.text()).not.toMatch(/creation unconfirmed/iu);
    expect(
      fixture
        .visibleActions()
        .some(
          (element) => element.dataset.testWorkspaceAction === "retry_create",
        ),
    ).toBe(false);
  });

  it("shows a generic unavailable target while preserving the create form and other rows", () => {
    const fixture = setup(
      ready(
        {
          selected: null,
          titleDraft: null,
          page: { items: [otherTest], nextCursor: null },
        },
        7,
        { kind: "test_unavailable" },
      ),
    );
    expect(fixture.text()).toMatch(/Test unavailable/iu);
    expect(fixture.text()).toContain(otherTest.title);
    expect(fixture.text()).not.toContain(draftTest.title);
    expect(fixture.input("new_test_title").readOnly).toBe(false);
    expect(fixture.text()).not.toMatch(/membership.*revoked|signed out/iu);
  });

  it.each(["first_page", "next_page"] as const)(
    "uses exact %s navigation without exposing or reconstructing cursor fields",
    async (type) => {
      const fixture = setup(
        ready({
          page: {
            items: [draftTest, otherTest],
            nextCursor: {
              createdAt: otherTest.createdAt,
              testId: otherTest.id,
            },
          },
        }),
      );
      fixture.action(type).fire("click");
      await settle();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type });
      expect(fixture.text()).not.toContain(otherTest.createdAt);
      expect(fixture.text()).not.toContain(otherTest.id);
    },
  );

  it("does not navigate Older Tests when no continuation exists", () => {
    const fixture = setup();
    const older = fixture.action("next_page");
    expect(older.disabled || !visible(older)).toBe(true);
    older.fire("click");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("renders literal titles and School labels as text without leaking private identifiers or wire facts", () => {
    const literal = '<img src="x" onerror="alert(1)"> 学校';
    const fixture = setup(
      ready({
        school: { ...school, displayName: literal },
        selected: { ...draftTest, title: literal },
        page: { items: [{ ...draftTest, title: literal }], nextCursor: null },
        titleDraft: literal,
      }),
    );
    expect(fixture.text()).toContain(literal);
    expect(
      nodes(fixture.root).some((element) =>
        ["img", "script"].includes(element.tagName),
      ),
    ).toBe(false);
    const presentation =
      fixture.text() +
      JSON.stringify(nodes(fixture.root).map((element) => element.dataset));
    for (const privateValue of [
      draftTest.createdByProfileId,
      school.schoolId,
      draftTest.createdAt,
    ])
      expect(presentation).not.toContain(privateValue);
    expect(presentation).not.toMatch(
      /creationRequestId|authorityHandle|expectedTestRevision|access_token/iu,
    );
  });

  it("uses the latest selected Test presentation and revision when retained detail controls are invoked", async () => {
    const fixture = setup();
    const title = fixture.input("test_title");
    const open = fixture.action("open_test");
    fixture.publish(
      ready({ selected: otherTest, titleDraft: otherTest.title }, 2),
    );
    expect(fixture.input("test_title")).toBe(title);
    expect(fixture.action("open_test")).toBe(open);
    expect(title.value).toBe(otherTest.title);
    expect(fixture.heading("testWorkspaceDetailHeading").textContent).toBe(
      otherTest.title,
    );
    open.fire("click");
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "open_test",
      snapshotRevision: 2,
    });
  });

  it("prevents a repeated End confirmation or competing reconciliation before controller publication", async () => {
    const fixture = setup(review(13));
    const wait = deferred<TestWorkspaceSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.action("confirm_end").fire("click");
    fixture.action("confirm_end").fire("click");
    fixture.action("cancel_end").fire("click");
    fixture.action("use_current_test").fire("click");
    fixture.action("refresh").fire("click");
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "confirm_end",
      snapshotRevision: 13,
    });
    wait.resolve(review(13));
    await settle();
  });

  it("does not acknowledge an uncertain creation merely because a quiet page now contains its submitted title", () => {
    const original: TestWorkspaceSnapshot = {
      kind: "create_unconfirmed",
      revision: 3,
      data: data(),
      submittedTitle: "Original submitted title",
    };
    const fixture = setup(original);
    const retry = fixture.action("retry_create");
    fixture.publish({
      ...original,
      revision: 4,
      data: data({
        page: {
          items: [{ ...otherTest, title: original.submittedTitle }],
          nextCursor: null,
        },
      }),
    });
    expect(fixture.action("retry_create")).toBe(retry);
    expect(fixture.text()).toMatch(/creation unconfirmed/iu);
    expect(fixture.text()).not.toContain("Test created.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["create", "save_title", "open", "end"] as const)(
    "keeps a rejected %s distinct from an acknowledged outcome and never automatically replays it",
    (operation) => {
      const fixture = setup(ready({}, 5, { kind: "rejected", operation }));
      expect(fixture.text()).toMatch(/not allowed/iu);
      expect(fixture.text()).not.toMatch(
        /Test created\.|Saved the Test title change\.|Opened the Test\.|Test ended\./u,
      );
      expect(fixture.action("refresh").disabled).toBe(false);
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["paused", "unavailable"] as const)(
    "scrubs detached draft controls on %s and starts fresh mounted controls on return",
    (kind) => {
      const fixture = setup();
      const create = fixture.input("new_test_title");
      const title = fixture.input("test_title");
      const form = fixture.form("new_test_title");
      const open = fixture.action("open_test");
      fixture.publish({ kind, revision: 2 });
      expect(fixture.root.children).toEqual([]);
      expect(create.value).toBe("");
      expect(title.value).toBe("");
      fixture.publish(ready({ createDraft: "Returned private draft" }, 3));
      expect(fixture.input("new_test_title")).not.toBe(create);
      form.fire("submit");
      open.fire("click");
      create.value = "Old value";
      create.fire("input");
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.input("new_test_title").value).toBe(
        "Returned private draft",
      );
      expect(fixture.document.activeElement).toBeNull();
    },
  );

  it("ignores an old action completion after authority loss and replacement", async () => {
    const fixture = setup();
    const wait = deferred<TestWorkspaceSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    fixture.form("new_test_title").fire("submit");
    fixture.publish({ kind: "unavailable", revision: 2 });
    fixture.publish(ready({ createDraft: "Replacement draft" }, 3));
    const replacement = fixture.input("new_test_title");
    const sibling = fixture.sibling();
    sibling.focus();
    wait.resolve(ready({ createValidation: "required" }));
    await settle();
    expect(fixture.input("new_test_title")).toBe(replacement);
    expect(replacement.value).toBe("Replacement draft");
    expect(replacement.readOnly).toBe(false);
    expect(fixture.document.activeElement).toBe(sibling);
  });

  it("unsubscribes and scrubs idempotently, without disposing the application-owned controller or reviving pending work", async () => {
    const fixture = setup();
    const create = fixture.input("new_test_title");
    const title = fixture.input("test_title");
    const form = fixture.form("new_test_title");
    const wait = deferred<TestWorkspaceSnapshot>();
    fixture.dispatch.mockReturnValue(wait.promise);
    form.fire("submit");
    fixture.dispose();
    fixture.dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.controller.dispose).not.toHaveBeenCalled();
    expect(create.value).toBe("");
    expect(title.value).toBe("");
    expect(fixture.root.children).toEqual([]);
    wait.resolve(ready());
    await settle();
    fixture.publish(ready());
    form.fire("submit");
    create.fire("input");
    expect(fixture.root.children).toEqual([]);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.document.activeElement).toBeNull();
  });
});
