import { describe, expect, it, vi } from "vitest";

import type { StudentSessionViewState } from "@desmoslock/contracts";

import { bindStudentSessionView } from "../src/student-session-view.js";

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
    for (const listener of [...(this.listeners.get(type) ?? [])])
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

function state(
  phase: StudentSessionViewState["phase"] = "entry",
  revision = 1,
  overrides: Partial<StudentSessionViewState> = {},
): StudentSessionViewState {
  return {
    revision,
    phase,
    session:
      phase === "active"
        ? {
            syntheticDisplayName: "Student A7",
            sessionRevision: 2,
            capabilityExpiresAtMs: 9_000_000,
          }
        : null,
    protection: "unavailable",
    calculatorEligible: false,
    pendingOperation: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let count = 0; count < 4; count += 1) await Promise.resolve();
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
  initial: StudentSessionViewState | null = state(),
  firstRead = Promise.resolve(initial),
) {
  const document = new DocumentFixture();
  const root = new Element(document, "main");
  document.body.append(root);
  let snapshot = initial;
  let listener: ((value: StudentSessionViewState) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    readStudentSessionView: vi.fn(() => firstRead),
    joinTest: vi.fn<
      (request: { code: string }) => Promise<StudentSessionViewState | null>
    >(async () => snapshot),
    beginTargetedReadmission: vi.fn<
      (request: {
        code: string;
        snapshotRevision: number;
      }) => Promise<StudentSessionViewState | null>
    >(async () => snapshot),
    retryStudentSession: vi.fn(async () => snapshot),
    refreshStudentSession: vi.fn(async () => snapshot),
    forfeitStudentSession: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<StudentSessionViewState | null>
    >(async () => snapshot),
    onStudentSessionViewChanged: vi.fn(
      (next: (value: StudentSessionViewState) => void) => {
        listener = next;
        return unsubscribe;
      },
    ),
  };
  const dispose = bindStudentSessionView(
    root as unknown as HTMLElement,
    bridge,
  );
  const find = (predicate: (element: Element) => boolean) => {
    const element = nodes(root).find(predicate);
    if (element === undefined) throw new Error("Expected rendered element");
    return element;
  };
  const action = (key: string) =>
    find((element) => element.dataset.action === key);
  const input = () => find((element) => element.name === "code");
  const form = () => find((element) => element.tagName === "form");
  const heading = () =>
    find((element) => element.id === "student-session-heading").textContent;
  const text = () =>
    nodes(root)
      .filter(visible)
      .map((element) => element.textContent)
      .join(" ");
  return {
    document,
    root,
    bridge,
    unsubscribe,
    dispose,
    find,
    action,
    input,
    form,
    heading,
    text,
    publish(next: StudentSessionViewState) {
      snapshot = next;
      listener?.(next);
    },
  };
}

function savedListener(element: Element, type = "click") {
  const listener = [...(element.listeners.get(type) ?? [])][0];
  if (listener === undefined) throw new Error("Expected action listener");
  return () => listener({ preventDefault() {} } as Event);
}

describe("Student desktop session view", () => {
  it("mounts passively, reads once and never substitutes protection for admission", async () => {
    const view = setup();
    expect(view.heading()).toBe("Loading session…");
    expect(view.document.activeElement).toBeNull();
    await settle();
    expect(view.heading()).toBe("Join a Test");
    expect(view.text()).toContain("Assessment protection unavailable");
    expect(view.bridge.readStudentSessionView).toHaveBeenCalledTimes(1);
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
    expect(view.bridge.refreshStudentSession).not.toHaveBeenCalled();
    expect(
      nodes(view.root).every((element) => element.focusCalls.length === 0),
    ).toBe(true);
  });

  it("rejects malformed codes and submits only exact canonical code bytes once", async () => {
    const view = setup();
    await settle();
    for (const invalid of [
      "",
      "123456789AB",
      "123456789ABCD",
      "123456789abo",
      "123456789ABO",
      " 123456789AB",
      "1234 56789AB",
      "123456789AB\n",
    ]) {
      view.input().value = invalid;
      view.form().fire("submit");
      expect(view.input().getAttribute("aria-invalid")).toBe("true");
    }
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.joinTest.mockReturnValueOnce(pending.promise);
    view.input().value = "123456789ABC";
    view.input().fire("input");
    view.form().fire("submit");
    expect(view.bridge.joinTest).toHaveBeenCalledExactlyOnceWith({
      code: "123456789ABC",
    });
    expect(view.input().value).toBe("");
    expect(view.input().readOnly).toBe(true);
    expect(view.action("submit-code").disabled).toBe(true);
    view.form().fire("submit");
    expect(view.bridge.joinTest).toHaveBeenCalledTimes(1);
    pending.resolve(state("active", 2));
    await settle();
    expect(view.heading()).toBe("Session confirmed");
    expect(view.text()).toContain("Student A7");
    expect(view.text()).not.toContain("123456789ABC");
    expect(view.text()).toContain("The calculator remains unavailable");
  });

  it("keeps a newer subscription projection when the initial read arrives late", async () => {
    const initialRead = deferred<StudentSessionViewState | null>();
    const view = setup(state(), initialRead.promise);
    view.publish(state("active", 5));
    initialRead.resolve(state("entry", 1));
    await settle();
    expect(view.heading()).toBe("Session confirmed");
    expect(visible(view.form())).toBe(false);
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
  });

  it.each(["null", "rejection"])(
    "ignores a late initial %s after a trusted subscription",
    async (outcome) => {
      const initialRead = deferred<StudentSessionViewState | null>();
      const view = setup(state(), initialRead.promise);
      view.publish(state("active", 5));
      if (outcome === "null") initialRead.resolve(null);
      else initialRead.reject(new Error("private IPC failure detail"));
      await settle();
      expect(view.heading()).toBe("Session confirmed");
      expect(view.text()).not.toContain("private IPC failure detail");
    },
  );

  it("preserves drafts, caret and focused controls through unchanged and newer passive entry reads", async () => {
    const view = setup();
    await settle();
    const input = view.input();
    input.value = "12AB56";
    input.selectionStart = 2;
    input.selectionEnd = 4;
    input.focus();
    const assignments = input.valueAssignments;
    const calls = input.focusCalls.length;
    view.publish(state("entry", 1));
    view.publish(state("entry", 2));
    expect(view.input()).toBe(input);
    expect(input.value).toBe("12AB56");
    expect(input.valueAssignments).toBe(assignments);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
    expect(view.document.activeElement).toBe(input);
    expect(input.focusCalls).toHaveLength(calls);
    const submit = view.action("submit-code");
    submit.focus();
    const transitions = submit.disableTransitions;
    const focusCalls = submit.focusCalls.length;
    view.publish(state("entry", 3));
    expect(view.document.activeElement).toBe(submit);
    expect(submit.disableTransitions).toBe(transitions);
    expect(submit.focusCalls).toHaveLength(focusCalls);
  });

  it("rejects stale entry handlers and never replays a join after a phase change", async () => {
    const view = setup();
    await settle();
    const oldSubmit = savedListener(view.form(), "submit");
    view.input().value = "123456789ABC";
    view.publish(state("unavailable", 2));
    oldSubmit();
    expect(view.input().value).toBe("");
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
    expect(view.heading()).toBe("Session unavailable");
  });

  it("does not let an older mutation result overwrite a newer unconfirmed projection", async () => {
    const view = setup();
    await settle();
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.joinTest.mockReturnValueOnce(pending.promise);
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    view.publish(state("unconfirmed", 4, { pendingOperation: "join" }));
    pending.resolve(state("active", 3));
    await settle();
    expect(view.heading()).toBe("Session result unconfirmed");
    expect(view.text()).not.toContain("Student A7");
    expect(visible(view.action("retry"))).toBe(true);
  });

  it("a null mutation result confirms nothing and requires a fresh main projection", async () => {
    const view = setup();
    await settle();
    view.bridge.joinTest.mockResolvedValueOnce(null);
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    await settle();
    expect(view.heading()).toBe("Session unavailable");
    expect(visible(view.form())).toBe(false);
    expect(visible(view.action("retry"))).toBe(false);
    expect(visible(view.action("open-recovery"))).toBe(false);
    expect(view.input().value).toBe("");
    view.bridge.refreshStudentSession.mockResolvedValueOnce(
      state("unconfirmed", 2, { pendingOperation: "join" }),
    );
    view.action("refresh").fire("click");
    await settle();
    expect(view.heading()).toBe("Session result unconfirmed");
    expect(view.bridge.joinTest).toHaveBeenCalledTimes(1);
    expect(visible(view.action("retry"))).toBe(true);
  });

  it("an equal-revision old read cannot mask a later null mutation result", async () => {
    const initialRead = deferred<StudentSessionViewState | null>();
    const view = setup(state(), initialRead.promise);
    view.publish(state("entry", 1));
    const mutation = deferred<StudentSessionViewState | null>();
    view.bridge.joinTest.mockReturnValueOnce(mutation.promise);
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    initialRead.resolve(state("entry", 1));
    await settle();
    mutation.resolve(null);
    await settle();
    expect(view.heading()).toBe("Session unavailable");
    expect(visible(view.form())).toBe(false);
    expect(view.bridge.joinTest).toHaveBeenCalledTimes(1);
  });

  it("requires recovery review, preserves a cancellable draft and submits only the captured revision", async () => {
    const view = setup(state("recovery_required", 7));
    await settle();
    const submit = view.action("submit-code");
    view.input().value = "123456789ABC";
    submit.focus();
    view.form().fire("submit");
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(view.document.activeElement?.id).toBe(
      "student-session-review-heading",
    );
    expect(view.text()).not.toContain("123456789ABC");
    expect(view.text()).toContain("previous saved record will be preserved");
    view.action("cancel-review").fire("click");
    expect(view.input().value).toBe("123456789ABC");
    expect(view.document.activeElement).toBe(submit);
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    view.form().fire("submit");
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.beginTargetedReadmission.mockReturnValueOnce(pending.promise);
    const confirmOld = savedListener(view.action("confirm-review"));
    view.action("confirm-review").fire("click");
    confirmOld();
    expect(
      view.bridge.beginTargetedReadmission,
    ).toHaveBeenCalledExactlyOnceWith({
      code: "123456789ABC",
      snapshotRevision: 7,
    });
    expect(view.input().value).toBe("");
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
    pending.resolve(state("unconfirmed", 8, { pendingOperation: "join" }));
    await settle();
    expect(view.heading()).toBe("Session result unconfirmed");
  });

  it("does not rebase a recovery review after a newer same-phase projection", async () => {
    const view = setup(state("recovery_required", 7));
    await settle();
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    const oldConfirm = savedListener(view.action("confirm-review"));
    view.publish(state("recovery_required", 8));
    expect(view.action("confirm-review").disabled).toBe(true);
    expect(view.text()).toContain("The session changed");
    oldConfirm();
    view.action("confirm-review").fire("click");
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    view.action("cancel-review").fire("click");
    view.form().fire("submit");
    view.action("confirm-review").fire("click");
    expect(
      view.bridge.beginTargetedReadmission,
    ).toHaveBeenCalledExactlyOnceWith({
      code: "123456789ABC",
      snapshotRevision: 8,
    });
  });

  it.each(["unavailable", "forfeited"] as const)(
    "opens targeted recovery deliberately from %s without rewriting the main phase",
    async (phase) => {
      const view = setup(state(phase, 4));
      await settle();
      const originalHeading = view.heading();
      expect(visible(view.form())).toBe(false);
      view.action("open-recovery").fire("click");
      expect(view.heading()).toBe(originalHeading);
      expect(visible(view.form())).toBe(true);
      expect(
        view.find((element) => element.tagName === "label").textContent,
      ).toBe("Private re-admission code");
      view.input().value = "123456789ABC";
      view.action("cancel-recovery").fire("click");
      expect(view.input().value).toBe("");
      expect(visible(view.form())).toBe(false);
      expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
      view.action("open-recovery").fire("click");
      view.input().value = "123456789ABC";
      view.form().fire("submit");
      view.action("confirm-review").fire("click");
      expect(
        view.bridge.beginTargetedReadmission,
      ).toHaveBeenCalledExactlyOnceWith({
        code: "123456789ABC",
        snapshotRevision: 4,
      });
      expect(view.bridge.joinTest).not.toHaveBeenCalled();
    },
  );

  it("reviews the synthetic session before leaving and acknowledges only an exact forfeited projection", async () => {
    const view = setup(state("active", 5));
    await settle();
    view.action("review-forfeit").fire("click");
    expect(view.text()).toContain("Leave Student A7?");
    expect(view.text()).toContain("This changes this session’s admission only");
    expect(view.bridge.forfeitStudentSession).not.toHaveBeenCalled();
    view.action("cancel-review").fire("click");
    expect(view.document.activeElement).toBe(view.action("review-forfeit"));
    view.action("review-forfeit").fire("click");
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.forfeitStudentSession.mockReturnValueOnce(pending.promise);
    view.action("confirm-review").fire("click");
    expect(view.bridge.forfeitStudentSession).toHaveBeenCalledExactlyOnceWith({
      snapshotRevision: 5,
    });
    expect(view.text()).toContain("Leaving has not yet been confirmed");
    pending.resolve(state("forfeited", 6));
    await settle();
    expect(view.heading()).toBe("You left this Test session.");
    expect(view.text()).not.toContain("Student A7");
  });

  it("invalidates a stale leave review without substituting a newer revision or session identity", async () => {
    const view = setup(state("active", 5));
    await settle();
    view.action("review-forfeit").fire("click");
    const oldConfirm = savedListener(view.action("confirm-review"));
    view.publish(state("active", 6));
    oldConfirm();
    view.action("confirm-review").fire("click");
    expect(view.bridge.forfeitStudentSession).not.toHaveBeenCalled();
    expect(view.action("confirm-review").disabled).toBe(true);
    view.publish(state("unavailable", 7, { session: state("active").session }));
    expect(view.text()).not.toContain("Student A7");
    expect(visible(view.action("confirm-review"))).toBe(false);
  });

  it("keeps an uncertain leave distinct from acknowledgement and refresh never resends it", async () => {
    const view = setup(
      state("unconfirmed", 6, {
        pendingOperation: "forfeit",
        session: state("active").session,
      }),
    );
    await settle();
    expect(view.text()).toContain("Leaving has not been confirmed");
    expect(view.text()).not.toContain("You left this Test session");
    expect(view.text()).not.toContain("Student A7");
    view.action("refresh").fire("click");
    await settle();
    expect(view.bridge.refreshStudentSession).toHaveBeenCalledTimes(1);
    expect(view.bridge.retryStudentSession).not.toHaveBeenCalled();
    expect(view.bridge.forfeitStudentSession).not.toHaveBeenCalled();
    view.bridge.retryStudentSession.mockResolvedValueOnce(
      state("unavailable", 7),
    );
    view.action("retry").fire("click");
    await settle();
    expect(view.bridge.retryStudentSession).toHaveBeenCalledTimes(1);
    expect(view.heading()).toBe("Session unavailable");
    expect(view.text()).not.toContain("You left this Test session");
  });

  it.each([null, "join", "reconnect", "forfeit"] as const)(
    "offers exact retry only with a projected retained pending operation: %s",
    async (pendingOperation) => {
      const view = setup(state("unconfirmed", 2, { pendingOperation }));
      await settle();
      expect(visible(view.action("retry"))).toBe(pendingOperation !== null);
      view.action("retry").fire("click");
      expect(view.bridge.retryStudentSession).toHaveBeenCalledTimes(
        pendingOperation === null ? 0 : 1,
      );
      expect(view.bridge.joinTest).not.toHaveBeenCalled();
    },
  );

  it("fails closed for malformed, contradictory or ineligible projections without rendering their data", async () => {
    const view = setup(state("active", 5));
    await settle();
    view.publish(
      state("active", 5, {
        session: {
          ...state("active").session!,
          syntheticDisplayName: "Student B9",
        },
      }),
    );
    expect(view.heading()).toBe("Session unavailable");
    expect(view.text()).not.toContain("Student B9");
    view.publish(
      state("active", 6, {
        session: {
          ...state("active").session!,
          syntheticDisplayName: '<img src=x onerror="fail()">',
        },
      }),
    );
    expect(view.text()).not.toContain("<img");
    view.publish({
      ...state("active", 7),
      calculatorEligible: true,
    } as unknown as StudentSessionViewState);
    expect(view.heading()).toBe("Session unavailable");
    expect(visible(view.action("review-forfeit"))).toBe(false);
    expect(
      nodes(view.root).some((element) =>
        ["img", "iframe", "webview", "script"].includes(element.tagName),
      ),
    ).toBe(false);
  });

  it("does not steal focus when an asynchronous reply settles after user movement", async () => {
    const view = setup(state("active", 5));
    await settle();
    const sibling = new Element(view.document, "button");
    view.document.body.append(sibling);
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.refreshStudentSession.mockReturnValueOnce(pending.promise);
    view.action("refresh").fire("click");
    sibling.focus();
    pending.resolve(state("active", 6));
    await settle();
    expect(view.document.activeElement).toBe(sibling);
    expect(
      nodes(view.root).every((element) => element.focusCalls.length === 0),
    ).toBe(true);
  });

  it("disposes listeners, sensitive drafts and identity; late callbacks and intents stay inert", async () => {
    const view = setup(state("recovery_required", 5));
    await settle();
    const input = view.input();
    input.value = "123456789ABC";
    view.form().fire("submit");
    const oldConfirm = savedListener(view.action("confirm-review"));
    const pending = deferred<StudentSessionViewState | null>();
    view.bridge.beginTargetedReadmission.mockReturnValueOnce(pending.promise);
    view.action("confirm-review").fire("click");
    const controls = nodes(view.root);
    view.dispose();
    view.dispose();
    view.publish(state("active", 7));
    pending.resolve(state("active", 6));
    await settle();
    oldConfirm();
    expect(view.unsubscribe).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
    expect(view.root.children).toHaveLength(0);
    expect(
      controls.every((element) =>
        [...element.listeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ),
    ).toBe(true);
    expect(view.bridge.beginTargetedReadmission).toHaveBeenCalledTimes(1);
  });

  it("renders a missing bridge honestly without an enabled recovery or join path", () => {
    const document = new DocumentFixture();
    const root = new Element(document, "main");
    document.body.append(root);
    const dispose = bindStudentSessionView(
      root as unknown as HTMLElement,
      undefined,
    );
    expect(
      nodes(root)
        .filter(visible)
        .map((element) => element.textContent)
        .join(" "),
    ).toContain("Session unavailable");
    expect(
      nodes(root)
        .filter((element) => element.tagName === "button" && visible(element))
        .every((element) => element.disabled),
    ).toBe(true);
    dispose();
  });

  it("still clears drafts and disconnects controls when unsubscribe throws", async () => {
    const view = setup(state("recovery_required", 5));
    await settle();
    const input = view.input();
    input.value = "123456789ABC";
    view.form().fire("submit");
    const oldConfirm = savedListener(view.action("confirm-review"));
    const controls = nodes(view.root);
    view.unsubscribe.mockImplementationOnce(() => {
      throw new Error("IPC unsubscribe failed");
    });
    expect(() => view.dispose()).toThrow("IPC unsubscribe failed");
    expect(input.value).toBe("");
    expect(view.root.children).toHaveLength(0);
    expect(
      controls.every((element) =>
        [...element.listeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ),
    ).toBe(true);
    oldConfirm();
    view.publish(state("active", 6));
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(view.root.children).toHaveLength(0);
    expect(() => view.dispose()).not.toThrow();
  });
});
