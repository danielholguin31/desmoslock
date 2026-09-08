import { describe, expect, it, vi } from "vitest";
import type { StaffStudentSession, StaffTest } from "@desmoslock/contracts";
import type {
  StudentSessionAction,
  StudentSessionController,
  StudentSessionData,
  StudentSessionSnapshot,
} from "../src/student-sessions/student-session-controller.js";
import { bindStudentSessionView } from "../src/student-sessions/student-session-view.js";

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
const test: StaffTest = {
  id: "90000000-0000-4000-8000-000000000011",
  schoolId: school.schoolId,
  createdByProfileId: "90000000-0000-4000-8000-000000000021",
  title: "Algebra quiz",
  lifecycle: "open",
  revision: 4,
  createdAt: "2026-09-08T10:00:00.123456Z",
  openedAt: "2026-09-08T11:00:00.123456Z",
  endedAt: null,
};
const session: StaffStudentSession = {
  id: "90000000-0000-4000-8000-000000000031",
  schoolId: school.schoolId,
  testId: test.id,
  syntheticDisplayName: "Blue Otter 123",
  state: "active",
  epoch: 1,
  revision: 1,
  createdAt: "2026-09-08T12:00:00.123456Z",
};
function data(overrides: Partial<StudentSessionData> = {}): StudentSessionData {
  return {
    school,
    test,
    parentBusy: false,
    page: { items: [session], nextCursor: null },
    selected: session,
    disclosure: null,
    ...overrides,
  };
}
function ready(
  overrides: Partial<StudentSessionData> = {},
  revision = 1,
): StudentSessionSnapshot & { readonly kind: "ready" } {
  return { kind: "ready", revision, data: data(overrides), notice: null };
}
function review(
  operation: "issue_code" | "remove" | "prepare_readmission" = "issue_code",
  stale = false,
): StudentSessionSnapshot {
  return {
    kind: "review",
    revision: 2,
    data: data(),
    notice: null,
    target: {
      operation,
      testId: test.id,
      title: test.title,
      studentSessionId: operation === "issue_code" ? null : session.id,
      syntheticDisplayName:
        operation === "issue_code" ? null : session.syntheticDisplayName,
      expectedTestRevision: 4,
      expectedSessionRevision: operation === "issue_code" ? null : 1,
      stale,
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
function setup(
  initial: StudentSessionSnapshot = ready(),
  copyText = vi.fn<(text: string) => Promise<void>>(async () => {}),
) {
  const document = new DocumentFixture();
  const root = new Element(document, "main");
  document.body.append(root);
  let snapshot = initial;
  let listener: ((next: StudentSessionSnapshot) => void) | undefined;
  const publish = (next: StudentSessionSnapshot) => {
    snapshot = next;
    listener?.(next);
  };
  const dispatch = vi.fn<
    (action: StudentSessionAction) => Promise<StudentSessionSnapshot>
  >(async () => snapshot);
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const controller: StudentSessionController = {
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
    dispatch,
    setAccess: vi.fn(),
    setTarget: vi.fn(),
    refreshFromStaff: vi.fn(async () => snapshot),
    dispose: vi.fn(),
  };
  const dispose = bindStudentSessionView(
    root as unknown as HTMLElement,
    controller,
    { copyText },
  );
  const find = (predicate: (element: Element) => boolean) => {
    const found = nodes(root).find(predicate);
    if (found === undefined) throw new Error("Missing control");
    return found;
  };
  return {
    root,
    document,
    publish,
    dispatch,
    dispose,
    unsubscribe,
    copyText,
    find,
    action: (type: StudentSessionAction["type"]) =>
      find((element) => element.dataset.studentSessionAction === type),
    text: () =>
      nodes(root)
        .filter(visible)
        .map((element) => element.textContent)
        .join(" "),
  };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Student session staff view", () => {
  it.each(["throw", "reject"] as const)(
    "clears action controls and reports an unavailable boundary on %s",
    async (failure) => {
      const view = setup();
      view.dispatch.mockImplementation(() => {
        if (failure === "throw") throw new Error("Unavailable");
        return Promise.reject(new Error("Unavailable"));
      });
      view.action("review_issue_code").fire("click");
      await settle();
      expect(view.text()).toContain("Student sessions unavailable");
      expect(nodes(view.root).some((node) => node.tagName === "button")).toBe(
        false,
      );
    },
  );
  it("shows only synthetic identity and ordinary session actions", () => {
    const view = setup();
    expect(view.text()).toContain("Blue Otter 123");
    expect(view.text()).toContain("Admitted");
    for (const value of [
      school.schoolId,
      test.id,
      session.id,
      session.createdAt,
      "expectedTestRevision",
    ])
      expect(view.text()).not.toContain(value);
    expect(view.action("review_issue_code").disabled).toBe(false);
    expect(view.action("review_remove").disabled).toBe(false);
    expect(visible(view.action("review_prepare_readmission"))).toBe(false);
  });
  it("always routes code issuance through a revision-bound review", async () => {
    const view = setup();
    view.dispatch.mockImplementation(async () => {
      view.publish(review());
      return review();
    });
    view.action("review_issue_code").fire("click");
    await settle();
    expect(view.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "review_issue_code",
      snapshotRevision: 1,
    });
    expect(view.text()).toContain("replaces any earlier join code");
    expect(view.text()).toContain("already admitted keep their admission");
    expect(view.document.activeElement?.textContent).toBe(
      "Review join code issuance",
    );
    view.dispatch.mockClear();
    view.action("confirm_review").fire("click");
    expect(view.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "confirm_review",
      snapshotRevision: 2,
    });
  });
  it.each(["issue_code", "remove", "prepare_readmission"] as const)(
    "disables stale %s review without replay",
    (operation) => {
      const view = setup(review(operation, true));
      expect(view.action("confirm_review").disabled).toBe(true);
      view.action("confirm_review").fire("click");
      expect(view.dispatch).not.toHaveBeenCalled();
      expect(view.text()).toContain("Cancel, refresh, and review again");
    },
  );
  it.each(["removed", "forfeited", "readmitted"] as const)(
    "offers only reviewed private recovery for %s",
    (state) => {
      const view = setup(ready({ selected: { ...session, state } }));
      expect(visible(view.action("review_remove"))).toBe(false);
      expect(view.action("review_prepare_readmission").disabled).toBe(false);
      view.action("review_prepare_readmission").fire("click");
      expect(view.dispatch).toHaveBeenCalledWith({
        type: "review_prepare_readmission",
        snapshotRevision: 1,
      });
    },
  );
  it.each(["draft", "ended"] as const)(
    "keeps %s Tests read-only",
    (lifecycle) => {
      const view = setup(ready({ test: { ...test, lifecycle } }));
      expect(view.action("review_issue_code").disabled).toBe(true);
      expect(view.action("review_remove").disabled).toBe(true);
      expect(view.action("refresh").disabled).toBe(false);
      if (lifecycle === "ended")
        expect(view.text()).toContain("Test ended. Participation is closed.");
    },
  );
  it.each(["confirm_review", "cancel_review", "refresh"] as const)(
    "preserves native focused %s through quiet School rename",
    (action) => {
      const view = setup(review());
      const button = view.action(action);
      button.focus();
      const disables = button.disableTransitions;
      const calls = button.focusCalls.length;
      const before = review();
      if (!("data" in before)) throw new Error("Expected data");
      view.publish({
        ...before,
        revision: 3,
        data: data({
          school: {
            ...school,
            displayName: "Renamed School",
            settingsRevision: 2,
          },
        }),
      });
      expect(view.document.activeElement).toBe(button);
      expect(button.disableTransitions).toBe(disables);
      expect(button.focusCalls).toHaveLength(calls);
      expect(view.text()).toContain("Renamed School");
    },
  );
  it("preserves a focused surviving row through prepend and removal", () => {
    const view = setup();
    const button = view.find(
      (node) =>
        node.tagName === "button" &&
        node.textContent === session.syntheticDisplayName,
    );
    button.focus();
    const newer = {
      ...session,
      id: "90000000-0000-4000-8000-000000000032",
      syntheticDisplayName: "Green Finch 456",
      createdAt: "2026-09-08T12:00:00.123457Z",
    };
    view.publish(
      ready({ page: { items: [newer, session], nextCursor: null } }, 2),
    );
    expect(view.document.activeElement).toBe(button);
    view.publish(ready({}, 3));
    expect(view.document.activeElement).toBe(button);
    expect(button.focusCalls).toHaveLength(1);
  });
  it("preserves focused read-error Refresh during a label-only update", () => {
    const view = setup({
      kind: "read_unavailable",
      revision: 1,
      data: data(),
      notice: null,
    });
    const button = view.action("refresh");
    button.focus();
    view.publish({
      kind: "read_unavailable",
      revision: 2,
      data: data({ school: { ...school, displayName: "Renamed" } }),
      notice: null,
    });
    expect(view.document.activeElement).toBe(button);
    expect(button.disableTransitions).toBe(0);
  });
  it("shows unknown issuance without a code and retries only the retained intent", async () => {
    const view = setup({
      kind: "unconfirmed",
      revision: 4,
      data: data(),
      operation: "issue_code",
      notice: null,
    });
    expect(view.text()).toContain("No confirmed code");
    expect(visible(view.find((node) => node.tagName === "input"))).toBe(false);
    view.action("refresh").fire("click");
    await settle();
    expect(view.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "refresh" });
    view.dispatch.mockClear();
    view.action("retry_issuance").fire("click");
    expect(view.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "retry_issuance",
      snapshotRevision: 4,
    });
  });
  it("does not offer a blind retry for unknown removal", () => {
    const view = setup({
      ...ready(),
      kind: "ready",
      notice: { kind: "unconfirmed", operation: "remove" },
    });
    expect(view.text()).toContain("Session removal unconfirmed");
    expect(visible(view.action("retry_issuance"))).toBe(false);
  });
  it.each(["verifying", "submitting", "refreshing"] as const)(
    "disables duplicate controls while %s",
    (phase) => {
      const view = setup({
        kind: "busy",
        revision: 4,
        data: data(),
        operation: "issue_code",
        phase,
      });
      for (const type of [
        "confirm_review",
        "cancel_review",
        "review_issue_code",
        "review_remove",
        "retry_issuance",
        "refresh",
      ] as const) {
        expect(view.action(type).disabled).toBe(true);
        view.action(type).fire("click");
      }
      expect(view.dispatch).not.toHaveBeenCalled();
    },
  );
  it("pauses new child actions during parent work while allowing review cancellation", () => {
    const initial = review();
    if (initial.kind !== "review") throw new Error("Expected review");
    const view = setup({ ...initial, data: data({ parentBusy: true }) });
    expect(view.action("confirm_review").disabled).toBe(true);
    expect(view.action("refresh").disabled).toBe(true);
    expect(view.action("cancel_review").disabled).toBe(false);
  });
  it("blocks a rapid second click until the initiating promise settles", async () => {
    const view = setup();
    let resolve: ((snapshot: StudentSessionSnapshot) => void) | undefined;
    view.dispatch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const button = view.action("review_issue_code");
    button.fire("click");
    button.fire("click");
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    resolve?.(ready());
    await settle();
    expect(button.disabled).toBe(false);
  });
  it("reveals only confirmed code, with original expiry and honest replacement copy", () => {
    const view = setup(
      ready({
        disclosure: {
          kind: "join",
          code: "23456789ABCD",
          expiresAt: "2026-09-08T12:15:00.123456Z",
          studentSessionId: null,
        },
      }),
    );
    const code = view.find((node) => node.tagName === "input");
    expect(code.value).toBe("23456789ABCD");
    expect(code.readOnly).toBe(true);
    expect(view.text()).toContain("2026-09-08T12:15:00.123456Z");
    expect(view.text()).toContain("later issuance may replace");
  });
  it("keeps a code selection intact during a label refresh", () => {
    const disclosure = {
      kind: "join" as const,
      code: "23456789ABCD",
      expiresAt: "2026-09-08T12:15:00.123456Z",
      studentSessionId: null,
    };
    const view = setup(ready({ disclosure }));
    const code = view.find((node) => node.tagName === "input");
    code.focus();
    code.selectionStart = 2;
    code.selectionEnd = 7;
    const writes = code.valueAssignments;
    view.publish(
      ready({ disclosure, school: { ...school, displayName: "Renamed" } }, 2),
    );
    expect(code.valueAssignments).toBe(writes);
    expect(code.selectionStart).toBe(2);
    expect(code.selectionEnd).toBe(7);
    expect(view.document.activeElement).toBe(code);
  });
  it.each(["paused", "unavailable"] as const)(
    "clears disclosed material and detached controls on %s",
    (kind) => {
      const view = setup(
        ready({
          disclosure: {
            kind: "join",
            code: "23456789ABCD",
            expiresAt: "2026-09-08T12:15:00.123456Z",
            studentSessionId: null,
          },
        }),
      );
      const code = view.find((node) => node.tagName === "input");
      const button = view.action("review_issue_code");
      view.publish({ kind, revision: 2 });
      expect(code.value).toBe("");
      expect(view.root.children).toHaveLength(0);
      button.fire("click");
      expect(view.dispatch).not.toHaveBeenCalled();
    },
  );
  it("ignores a late clipboard settlement after disclosure removal", async () => {
    let done: (() => void) | undefined;
    const copy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const view = setup(
      ready({
        disclosure: {
          kind: "join",
          code: "23456789ABCD",
          expiresAt: "2026-09-08T12:15:00.123456Z",
          studentSessionId: null,
        },
      }),
      copy,
    );
    view.find((node) => node.textContent === "Copy code").fire("click");
    view.publish(ready({}, 2));
    done?.();
    await settle();
    expect(view.text()).not.toContain("Code copied");
    expect(view.find((node) => node.tagName === "input").value).toBe("");
  });
  it("provides selectable fallback when clipboard is unavailable", async () => {
    const copy = vi.fn(async () => {
      throw new Error("Unavailable");
    });
    const view = setup(
      ready({
        disclosure: {
          kind: "join",
          code: "23456789ABCD",
          expiresAt: "2026-09-08T12:15:00.123456Z",
          studentSessionId: null,
        },
      }),
      copy,
    );
    view.find((node) => node.textContent === "Copy code").fire("click");
    await settle();
    expect(view.text()).toContain("Select and copy the code above");
  });
  it("renders caller labels literally without markup", () => {
    const view = setup(
      ready({
        test: { ...test, title: "<img src=x onerror=alert(1)>" },
        selected: { ...session, syntheticDisplayName: "<b>Blue Otter</b>" },
      }),
    );
    expect(view.text()).toContain("<img src=x onerror=alert(1)>");
    expect(
      nodes(view.root).some(
        (node) => node.tagName === "img" || node.tagName === "b",
      ),
    ).toBe(false);
  });
  it("passes opaque page intent without rendering or reformating the cursor", () => {
    const view = setup(
      ready({
        page: {
          items: [session],
          nextCursor: { createdAt: session.createdAt, sessionId: session.id },
        },
      }),
    );
    view.action("next_page").fire("click");
    expect(view.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "next_page",
    });
    expect(view.text()).not.toContain(session.createdAt);
  });
  it("does not steal sibling focus when an asynchronous review completes", async () => {
    const view = setup();
    let done: (() => void) | undefined;
    view.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = () => {
            view.publish(review());
            resolve(review());
          };
        }),
    );
    view.action("review_issue_code").fire("click");
    const sibling = new Element(view.document, "input");
    view.document.body.append(sibling);
    sibling.focus();
    done?.();
    await settle();
    expect(view.document.activeElement).toBe(sibling);
  });
  it("disposes subscription and blocks late promise publication", async () => {
    const view = setup();
    let done: ((snapshot: StudentSessionSnapshot) => void) | undefined;
    view.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    view.action("review_issue_code").fire("click");
    view.dispose();
    view.dispose();
    done?.(review());
    await settle();
    expect(view.unsubscribe).toHaveBeenCalledTimes(1);
    expect(view.root.children).toHaveLength(0);
  });
});
