import { describe, expect, it, vi } from "vitest";

import type { StudentSessionViewState } from "@desmoslock/contracts";

import type { DesktopStudentView } from "../src/assessment-protection-view-state.js";

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
): DesktopStudentView {
  const admission: StudentSessionViewState = {
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
  const category = { status: "pending", code: "none" } as const;
  return {
    revision: admission.revision,
    admission: {
      phase: admission.phase,
      session: admission.session,
      pendingOperation: admission.pendingOperation,
    },
    protection: {
      phase: "idle",
      categories: {
        aac: category,
        shortcuts: category,
        applications: category,
        persistence: category,
        windowNetwork: category,
      },
      calculatorVisible: false,
      failure: null,
      nativeEndObserved: false,
      cleanup: "not_requested",
      evidence: "none",
      emergencyReview: false,
    },
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

function nativeState(
  phase: DesktopStudentView["protection"]["phase"],
  revision = 1,
  overrides: Partial<DesktopStudentView["protection"]> = {},
): DesktopStudentView {
  const base = state("active", revision);
  const confirmed = { status: "confirmed", code: "none" } as const;
  return {
    ...base,
    protection: {
      ...base.protection,
      phase,
      ...(phase === "locked"
        ? {
            calculatorVisible: true,
            categories: {
              aac: confirmed,
              shortcuts: confirmed,
              applications: confirmed,
              persistence: confirmed,
              windowNetwork: confirmed,
            },
          }
        : {}),
      ...(phase === "ended"
        ? ({ nativeEndObserved: true, cleanup: "complete" } as const)
        : {}),
      ...(phase === "failed" ? ({ cleanup: "complete" } as const) : {}),
      ...overrides,
    },
  };
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
  initial: DesktopStudentView | null = state(),
  firstRead = Promise.resolve(initial),
) {
  const document = new DocumentFixture();
  const root = new Element(document, "main");
  document.body.append(root);
  let snapshot = initial;
  let listener: ((value: DesktopStudentView) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    readStudentSessionView: vi.fn(() => firstRead),
    joinTest: vi.fn<
      (request: { code: string }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    beginTargetedReadmission: vi.fn<
      (request: {
        code: string;
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    retryStudentSession: vi.fn(async () => snapshot),
    refreshStudentSession: vi.fn(async () => snapshot),
    forfeitStudentSession: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    startAssessment: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    reviewEmergencyEnd: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    cancelEmergencyEnd: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    confirmEmergencyEnd: vi.fn<
      (request: {
        snapshotRevision: number;
      }) => Promise<DesktopStudentView | null>
    >(async () => snapshot),
    onStudentSessionViewChanged: vi.fn(
      (next: (value: DesktopStudentView) => void) => {
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
    publish(next: DesktopStudentView) {
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
    const pending = deferred<DesktopStudentView | null>();
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
    const initialRead = deferred<DesktopStudentView | null>();
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
      const initialRead = deferred<DesktopStudentView | null>();
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

  it("returns a definitively unadmitted attempt to public code entry and submits the corrected code without private recovery", async () => {
    const view = setup();
    await settle();
    view.bridge.joinTest.mockResolvedValueOnce(
      state("entry", 2, { pendingOperation: "join" }),
    );
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    await settle();
    expect(view.heading()).toBe("Join a Test");
    expect(view.text()).toContain("Check the Test join code and try again");
    expect(visible(view.form())).toBe(true);
    expect(visible(view.action("retry"))).toBe(false);
    expect(visible(view.action("open-recovery"))).toBe(false);
    expect(view.text()).not.toContain("Private re-admission code");
    view.bridge.joinTest.mockResolvedValueOnce(state("active", 3));
    view.input().value = "123456789ABD";
    view.form().fire("submit");
    await settle();
    expect(view.bridge.joinTest.mock.calls).toEqual([
      [{ code: "123456789ABC" }],
      [{ code: "123456789ABD" }],
    ]);
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(view.bridge.retryStudentSession).not.toHaveBeenCalled();
    expect(view.heading()).toBe("Session confirmed");
  });

  it("keeps exact retry visible after an uncertain attempt is denied without exposing fresh public entry", async () => {
    const view = setup(state("unavailable", 2, { pendingOperation: "join" }));
    await settle();
    expect(view.text()).toContain("Retry that attempt or ask your teacher");
    expect(visible(view.form())).toBe(false);
    expect(visible(view.action("retry"))).toBe(true);
    expect(visible(view.action("open-recovery"))).toBe(true);
    view.bridge.retryStudentSession.mockResolvedValueOnce(
      state("unconfirmed", 3, { pendingOperation: "join" }),
    );
    view.action("retry").fire("click");
    await settle();
    expect(view.bridge.retryStudentSession).toHaveBeenCalledTimes(1);
    expect(view.bridge.joinTest).not.toHaveBeenCalled();
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(view.heading()).toBe("Session result unconfirmed");
  });

  it("does not let an older mutation result overwrite a newer unconfirmed projection", async () => {
    const view = setup();
    await settle();
    const pending = deferred<DesktopStudentView | null>();
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
    const initialRead = deferred<DesktopStudentView | null>();
    const view = setup(state(), initialRead.promise);
    view.publish(state("entry", 1));
    const mutation = deferred<DesktopStudentView | null>();
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
    const pending = deferred<DesktopStudentView | null>();
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
    const pending = deferred<DesktopStudentView | null>();
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
    view.publish(
      state("unavailable", 7, { session: state("active").admission.session }),
    );
    expect(view.text()).not.toContain("Student A7");
    expect(visible(view.action("confirm-review"))).toBe(false);
  });

  it("keeps an uncertain leave distinct from acknowledgement and refresh never resends it", async () => {
    const view = setup(
      state("unconfirmed", 6, {
        pendingOperation: "forfeit",
        session: state("active").admission.session,
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
          ...state("active").admission.session!,
          syntheticDisplayName: "Student B9",
        },
      }),
    );
    expect(view.heading()).toBe("Session unavailable");
    expect(view.text()).not.toContain("Student B9");
    view.publish(
      state("active", 6, {
        session: {
          ...state("active").admission.session!,
          syntheticDisplayName: '<img src=x onerror="fail()">',
        },
      }),
    );
    expect(view.text()).not.toContain("<img");
    view.publish({
      ...state("active", 7),
      calculatorEligible: true,
    } as unknown as DesktopStudentView);
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
    const pending = deferred<DesktopStudentView | null>();
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
    const pending = deferred<DesktopStudentView | null>();
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

describe("Student desktop protection presentation", () => {
  it.each(["unavailable", "unconfirmed"] as const)(
    "idle protection guidance preserves the saved %s admission instead of suggesting a new join",
    async (phase) => {
      const view = setup(state(phase, 3, { pendingOperation: "join" }));
      await settle();
      expect(view.text()).toContain(
        "Retry or recover your saved session admission, then choose Start assessment",
      );
      expect(view.text()).not.toContain(
        "Join a Test, then choose Start assessment",
      );
      expect(visible(view.form())).toBe(false);
      expect(visible(view.action("retry"))).toBe(true);
      expect(view.action("start-assessment").disabled).toBe(true);
      expect(view.bridge.joinTest).not.toHaveBeenCalled();
      expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    },
  );

  it("idle protection guidance joins from entry and checks protection directly after admission", async () => {
    const view = setup(state("entry", 1));
    await settle();
    expect(view.text()).toContain("Join a Test, then choose Start assessment");
    expect(view.action("start-assessment").disabled).toBe(true);
    view.publish(state("active", 2));
    expect(view.text()).toContain(
      "The calculator remains unavailable. Choose Start assessment to check protection.",
    );
    expect(view.text()).not.toContain(
      "Join a Test, then choose Start assessment",
    );
    expect(view.action("start-assessment").disabled).toBe(false);
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "recovery_required",
      "The previous assessment’s end could not be confirmed",
    ],
    ["failed", "The attempt did not establish confirmed protection"],
  ] as const)(
    "%s protection guidance keeps native recovery ahead of uncertain admission guidance",
    async (phase, copy) => {
      const view = setup({
        ...nativeState(phase, 3),
        admission: state("unconfirmed", 3, { pendingOperation: "join" })
          .admission,
      });
      await settle();
      expect(view.text()).toContain(copy);
      expect(view.text()).not.toContain(
        "Retry or recover your saved session admission",
      );
      expect(view.action("start-assessment").disabled).toBe(true);
    },
  );

  it("adds no renderer timer or polling authority to passive protection publication", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const view = setup(nativeState("idle", 1));
      await settle();
      view.publish(nativeState("preflight", 2));
      view.publish(nativeState("engaging", 3));
      view.publish(nativeState("locked", 4));
      view.dispose();
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(view.bridge.refreshStudentSession).not.toHaveBeenCalled();
      expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  });

  it("keeps an unconfigured bridge honest and settles null refresh without inventing controls", async () => {
    const view = setup(null);
    await settle();
    expect(view.heading()).toBe("Session unavailable");
    expect(
      view.find((node) => node.id === "protection-status").textContent,
    ).toBe("Protection status unconfirmed");
    expect(view.root.attributes["data-admission-phase"]).toBe("unavailable");
    expect(view.root.attributes["data-protection-phase"]).toBe("unconfirmed");
    expect(visible(view.action("start-assessment"))).toBe(false);
    expect(visible(view.action("review-emergency"))).toBe(false);
    view.action("refresh").fire("click");
    await settle();
    expect(view.action("refresh").disabled).toBe(false);
    expect(view.text()).not.toContain("Assessment protected");
  });

  it.each([
    ["idle", {}, true],
    ["ended", {}, true],
    ["failed", {}, true],
    ["failed", { cleanup: "unconfirmed" }, false],
    ["recovery_required", { cleanup: "complete" }, false],
    ["preflight", {}, false],
    ["engaging", {}, false],
    ["locked", {}, false],
    ["ending", {}, false],
    ["idle", { evidence: "acknowledged" }, true],
    ["idle", { evidence: "blocked" }, true],
    ["idle", { evidence: "full" }, false],
    ["idle", { evidence: "unconfirmed" }, false],
    ["idle", { emergencyReview: true }, false],
  ] as const)(
    "sends Start only for legal %s/%j presentation",
    async (phase, overrides, eligible) => {
      const view = setup(nativeState(phase, 31, overrides));
      await settle();
      expect(view.bridge.startAssessment).not.toHaveBeenCalled();
      expect(
        !view.action("start-assessment").disabled &&
          visible(view.action("start-assessment")),
      ).toBe(eligible);
      view.action("start-assessment").fire("click");
      expect(view.bridge.startAssessment).toHaveBeenCalledTimes(
        eligible ? 1 : 0,
      );
      if (eligible)
        expect(view.bridge.startAssessment).toHaveBeenCalledWith({
          snapshotRevision: 31,
        });
    },
  );

  it("allows a fresh explicit check after failed categories but never from an admission review or pending reconnect", async () => {
    const failed = nativeState("failed", 8, {
      categories: {
        ...state().protection.categories,
        aac: { status: "unavailable", code: "native_unavailable" },
      },
    });
    const view = setup(failed);
    await settle();
    expect(view.action("start-assessment").disabled).toBe(false);
    expect(view.text()).toContain("Protection unavailable");
    expect(view.text()).not.toContain("end was observed");
    view.action("review-forfeit").fire("click");
    view.action("start-assessment").fire("click");
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    view.action("cancel-review").fire("click");
    view.publish({
      ...failed,
      revision: 9,
      admission: { ...failed.admission, pendingOperation: "reconnect" },
    });
    view.action("start-assessment").fire("click");
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    view.publish(state("entry", 10));
    view.action("start-assessment").fire("click");
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
  });

  it("keeps Emergency independent of a held Start and requires main confirmation for protected layout", async () => {
    const view = setup(nativeState("idle", 4));
    await settle();
    const starting = deferred<DesktopStudentView | null>();
    view.bridge.startAssessment.mockReturnValueOnce(starting.promise);
    view.action("start-assessment").fire("click");
    view.action("start-assessment").fire("click");
    expect(view.bridge.startAssessment).toHaveBeenCalledTimes(1);
    expect(visible(view.action("review-emergency"))).toBe(true);
    view.publish(nativeState("engaging", 5));
    expect(view.root.attributes["data-calculator-space-reserved"]).toBe(
      "false",
    );
    const review = nativeState("engaging", 6, { emergencyReview: true });
    view.bridge.reviewEmergencyEnd.mockResolvedValueOnce(review);
    view.action("review-emergency").focus();
    view.action("review-emergency").fire("click");
    await settle();
    expect(view.bridge.reviewEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 5,
    });
    expect(view.document.activeElement?.id).toBe(
      "assessment-emergency-heading",
    );
    expect(view.bridge.confirmEmergencyEnd).not.toHaveBeenCalled();
    view.bridge.cancelEmergencyEnd.mockResolvedValueOnce(
      nativeState("engaging", 7),
    );
    view.action("cancel-emergency").fire("click");
    await settle();
    expect(view.bridge.cancelEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 6,
    });
    expect(view.bridge.confirmEmergencyEnd).not.toHaveBeenCalled();
    view.publish(nativeState("locked", 8));
    starting.resolve(nativeState("idle", 4));
    await settle();
    expect(view.root.attributes["data-protection-phase"]).toBe("locked");
    expect(view.root.attributes["data-calculator-space-reserved"]).toBe("true");
    expect(view.text()).toContain("Assessment protected");
    expect(
      visible(view.find((node) => node.className === "student-session")),
    ).toBe(false);
    expect(
      nodes(view.root).some((node) =>
        ["webview", "iframe", "canvas"].includes(node.tagName),
      ),
    ).toBe(false);
  });

  it.each([
    "aac",
    "shortcuts",
    "applications",
    "persistence",
    "windowNetwork",
  ] as const)(
    "never presents locked when %s is unconfirmed in a malformed IPC projection",
    async (category) => {
      const view = setup(nativeState("engaging", 5));
      await settle();
      const locked = nativeState("locked", 6);
      view.publish({
        ...locked,
        protection: {
          ...locked.protection,
          categories: {
            ...locked.protection.categories,
            [category]: { status: "pending", code: "none" },
          },
        },
      });
      expect(view.root.attributes["data-protection-phase"]).toBe("unconfirmed");
      expect(view.root.attributes["data-calculator-space-reserved"]).toBe(
        "false",
      );
      expect(view.text()).not.toContain("Assessment protected");
      expect(visible(view.action("review-emergency"))).toBe(true);
    },
  );

  it("does not read accessors or render private extras from the protection bridge", async () => {
    const view = setup(nativeState("engaging", 5));
    await settle();
    const getter = vi.fn(() => "private-native-proof");
    const malformed = nativeState("locked", 6);
    Object.defineProperty(malformed.protection, "nativeProof", {
      get: getter,
      enumerable: true,
    });
    view.publish(malformed);
    expect(getter).not.toHaveBeenCalled();
    expect(view.text()).not.toContain("private-native-proof");
    expect(view.text()).not.toContain("Assessment protected");
  });

  it("fences stale emergency confirmation and keeps cancellation inert", async () => {
    const view = setup(nativeState("locked", 10));
    await settle();
    view.publish(nativeState("locked", 11, { emergencyReview: true }));
    const oldConfirm = savedListener(view.action("confirm-emergency"));
    expect(view.document.activeElement?.id).toBe(
      "assessment-emergency-heading",
    );
    view.publish(nativeState("locked", 12, { emergencyReview: true }));
    oldConfirm();
    view.action("confirm-emergency").fire("click");
    expect(view.action("confirm-emergency").disabled).toBe(true);
    expect(view.text()).toContain("Session changed. Cancel and review again.");
    expect(view.bridge.confirmEmergencyEnd).not.toHaveBeenCalled();
    view.bridge.cancelEmergencyEnd.mockResolvedValueOnce(
      nativeState("locked", 13),
    );
    view.action("cancel-emergency").fire("click");
    await settle();
    expect(view.bridge.cancelEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 12,
    });
    expect(view.root.attributes["data-protection-phase"]).toBe("locked");
    view.publish(nativeState("locked", 14, { emergencyReview: true }));
    view.action("confirm-emergency").fire("click");
    expect(view.bridge.confirmEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 14,
    });
  });

  it("keeps focused emergency controls stable during pending and passive projections", async () => {
    const view = setup(nativeState("locked", 20));
    await settle();
    const button = view.action("review-emergency");
    const reading = deferred<DesktopStudentView | null>();
    view.bridge.reviewEmergencyEnd.mockReturnValueOnce(reading.promise);
    button.focus();
    const disables = button.disableTransitions;
    button.fire("click");
    button.fire("click");
    view.publish(nativeState("locked", 20));
    expect(view.document.activeElement).toBe(button);
    expect(button.disableTransitions).toBe(disables);
    expect(button.attributes["aria-disabled"]).toBe("true");
    expect(view.bridge.reviewEmergencyEnd).toHaveBeenCalledTimes(1);
    reading.resolve(nativeState("locked", 21, { emergencyReview: true }));
    await settle();
    const confirm = view.action("confirm-emergency");
    const ending = deferred<DesktopStudentView | null>();
    view.bridge.confirmEmergencyEnd.mockReturnValueOnce(ending.promise);
    confirm.focus();
    const confirmDisables = confirm.disableTransitions;
    confirm.fire("click");
    confirm.fire("click");
    expect(view.document.activeElement).toBe(confirm);
    expect(confirm.disableTransitions).toBe(confirmDisables);
    expect(view.bridge.confirmEmergencyEnd).toHaveBeenCalledTimes(1);
    expect(view.action("cancel-emergency").disabled).toBe(true);
    ending.resolve(nativeState("ended", 22));
    await settle();
    expect(view.root.attributes["data-protection-phase"]).toBe("ended");
  });

  it("does not send confirmation during a pending cancellation or steal moved focus on its reply", async () => {
    const view = setup(nativeState("locked", 4, { emergencyReview: true }));
    await settle();
    const cancel = view.action("cancel-emergency");
    const pending = deferred<DesktopStudentView | null>();
    view.bridge.cancelEmergencyEnd.mockReturnValueOnce(pending.promise);
    cancel.focus();
    cancel.fire("click");
    cancel.fire("click");
    view.action("confirm-emergency").fire("click");
    expect(view.bridge.cancelEmergencyEnd).toHaveBeenCalledTimes(1);
    expect(view.bridge.confirmEmergencyEnd).not.toHaveBeenCalled();
    expect(view.document.activeElement).toBe(cancel);
    const sibling = new Element(view.document, "button");
    view.document.body.append(sibling);
    sibling.focus();
    pending.resolve(nativeState("locked", 5));
    await settle();
    expect(view.document.activeElement).toBe(sibling);
    expect(view.root.attributes["data-protection-phase"]).toBe("locked");
  });

  it.each(["null", "reject"] as const)(
    "keeps uncertain %s emergency results honest and retryable without claiming end",
    async (mode) => {
      const view = setup(nativeState("locked", 6, { emergencyReview: true }));
      await settle();
      if (mode === "null")
        view.bridge.confirmEmergencyEnd.mockResolvedValueOnce(null);
      else
        view.bridge.confirmEmergencyEnd.mockRejectedValueOnce(
          new Error("private native detail"),
        );
      view.action("confirm-emergency").fire("click");
      await settle();
      expect(view.root.attributes["data-protection-phase"]).toBe("unconfirmed");
      expect(view.root.attributes["data-calculator-space-reserved"]).toBe(
        "true",
      );
      expect(view.text()).toContain("result is unconfirmed");
      expect(view.text()).not.toContain("private native detail");
      expect(view.text()).not.toContain("Assessment protected");
      expect(view.text()).not.toContain("protection ended");
      expect(view.action("confirm-emergency").disabled).toBe(false);
      expect(view.action("cancel-emergency").disabled).toBe(false);
    },
  );

  it.each([
    ["ended", "Assessment protection ended"],
    ["recovery_required", "Recovery required"],
  ] as const)(
    "uses newer main %s status while emergency confirmation is still pending",
    async (phase, label) => {
      const view = setup(nativeState("locked", 10, { emergencyReview: true }));
      await settle();
      const confirmation = deferred<DesktopStudentView | null>();
      view.bridge.confirmEmergencyEnd.mockReturnValueOnce(confirmation.promise);
      view.action("confirm-emergency").fire("click");
      expect(view.action("confirm-emergency").textContent).toBe("Ending…");
      view.publish(nativeState(phase, 11));
      const status = view.find((node) => node.id === "protection-status");
      expect(visible(status)).toBe(true);
      expect(status.textContent).toBe(label);
      expect(view.root.attributes["data-protection-phase"]).toBe(phase);
      expect(view.root.attributes["data-calculator-space-reserved"]).toBe(
        "false",
      );
      expect(view.text()).not.toContain("Ending protection");
      expect(view.heading()).toBe("Session confirmed");
      expect(view.text()).not.toContain(
        "This session’s admission was given up.",
      );
      confirmation.resolve(null);
      await settle();
      expect(status.textContent).toBe(label);
      expect(view.root.attributes["data-protection-phase"]).toBe(phase);
    },
  );

  it("lets emergency confirmation proceed while a failed session refresh is unresolved", async () => {
    const view = setup(
      nativeState("recovery_required", 5, {
        failure: "persistence_unavailable",
        cleanup: "unconfirmed",
        evidence: "unconfirmed",
      }),
    );
    await settle();
    const refreshing = deferred<DesktopStudentView | null>();
    view.bridge.refreshStudentSession.mockReturnValueOnce(refreshing.promise);
    view.action("refresh").fire("click");
    view.publish(
      nativeState("recovery_required", 6, {
        emergencyReview: true,
        failure: "persistence_unavailable",
        cleanup: "unconfirmed",
        evidence: "unconfirmed",
      }),
    );
    view.action("confirm-emergency").fire("click");
    expect(view.bridge.confirmEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 6,
    });
    view.publish(nativeState("ended", 7));
    refreshing.reject(new Error("private transport error"));
    await settle();
    expect(view.root.attributes["data-protection-phase"]).toBe("ended");
    expect(view.text()).not.toContain("private transport error");
  });

  it("distinguishes observed native end, pending cleanup and queued evidence from admission surrender", async () => {
    const view = setup(nativeState("ending", 3));
    await settle();
    expect(view.text()).toContain(
      "Native end and local cleanup are not yet confirmed",
    );
    view.publish(
      nativeState("ending", 4, { nativeEndObserved: true, cleanup: "pending" }),
    );
    expect(view.text()).toContain("Waiting for confirmed local cleanup");
    expect(view.text()).not.toContain("cleanup is complete");
    view.publish(nativeState("ended", 5, { evidence: "queued" }));
    expect(view.text()).toContain(
      "Native end was observed and local cleanup is complete",
    );
    expect(view.text()).toContain(
      "does not confirm the session’s admission was given up",
    );
    expect(view.text()).toContain("Server receipt is not confirmed");
    expect(view.heading()).toBe("Session confirmed");
  });

  it("limits acknowledgment to current saved reports and replaces it when new reports are queued", async () => {
    const view = setup(nativeState("idle", 3, { evidence: "acknowledged" }));
    await settle();
    expect(view.text()).toContain(
      "The server acknowledged the reports currently saved on this device. This does not confirm native protection or release.",
    );
    expect(view.root.attributes["data-protection-phase"]).toBe("idle");
    expect(view.text()).not.toContain("Assessment protected");
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    view.publish(nativeState("idle", 4, { evidence: "queued" }));
    expect(view.text()).toContain("Server receipt is not confirmed");
    expect(view.text()).not.toContain("The server acknowledged");
  });

  it("shows a current delivery block without claiming permanent denial or resolving native recovery", async () => {
    const view = setup(
      nativeState("recovery_required", 3, { evidence: "blocked" }),
    );
    await settle();
    expect(view.text()).toContain(
      "Reports cannot currently be delivered. Saved reports remain on this device.",
    );
    expect(view.root.attributes["data-protection-phase"]).toBe(
      "recovery_required",
    );
    expect(view.text()).not.toMatch(
      /permanent|server rejected|cleanup is complete/u,
    );
    expect(view.action("start-assessment").disabled).toBe(true);
    view.publish(
      nativeState("recovery_required", 4, { evidence: "acknowledged" }),
    );
    expect(view.root.attributes["data-protection-phase"]).toBe(
      "recovery_required",
    );
    expect(view.action("start-assessment").disabled).toBe(true);
    expect(view.text()).not.toContain("Reports cannot currently be delivered");
  });

  it.each(["admission_changed", "backend_unavailable"] as const)(
    "shows only generic public access guidance for %s",
    async (failure) => {
      const view = setup(
        nativeState("recovery_required", 4, {
          failure,
          cleanup: "unconfirmed",
        }),
      );
      await settle();
      expect(view.text()).toContain(
        "Session access cannot currently be confirmed",
      );
      expect(view.text()).not.toMatch(
        /teacher (removed|ended)|Test ended|revoked|expired/u,
      );
    },
  );

  it("blocks corrupt-record targeted recovery until operator recovery while preserving legal admission-only recovery", async () => {
    const view = setup(state("recovery_required", 4));
    await settle();
    expect(visible(view.form())).toBe(true);
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    const oldConfirm = savedListener(view.action("confirm-review"));
    const blocked = nativeState("recovery_required", 5, {
      cleanup: "unconfirmed",
      failure: "persistence_unavailable",
    });
    view.publish({
      ...blocked,
      admission: state("recovery_required").admission,
    });
    oldConfirm();
    view.form().fire("submit");
    view.action("open-recovery").fire("click");
    view.action("start-assessment").fire("click");
    expect(view.bridge.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
    expect(visible(view.form())).toBe(false);
    expect(visible(view.action("open-recovery"))).toBe(false);
    expect(view.input().value).toBe("");
    expect(view.text()).toContain("operator");
    expect(view.text()).not.toContain(
      "Ask your teacher for a private re-admission code",
    );
    expect(view.text()).not.toMatch(/reset|wipe/iu);
    view.publish(state("recovery_required", 6));
    view.input().value = "123456789ABC";
    view.form().fire("submit");
    view.action("confirm-review").fire("click");
    expect(view.bridge.beginTargetedReadmission).toHaveBeenCalledWith({
      code: "123456789ABC",
      snapshotRevision: 6,
    });
  });

  it("does not steal focus when an emergency reply arrives after user movement", async () => {
    const view = setup(nativeState("engaging", 1));
    await settle();
    const reviewing = deferred<DesktopStudentView | null>();
    view.bridge.reviewEmergencyEnd.mockReturnValueOnce(reviewing.promise);
    view.action("review-emergency").focus();
    view.action("review-emergency").fire("click");
    const sibling = new Element(view.document, "button");
    view.document.body.append(sibling);
    sibling.focus();
    reviewing.resolve(nativeState("engaging", 2, { emergencyReview: true }));
    await settle();
    expect(view.document.activeElement).toBe(sibling);
  });

  it("explains an unchanged unreadable-recovery Emergency reply without pretending a review opened", async () => {
    const recovery = {
      ...nativeState("recovery_required", 7, { cleanup: "unconfirmed" }),
      admission: state("recovery_required").admission,
    };
    const view = setup(recovery);
    await settle();
    view.action("review-emergency").fire("click");
    await settle();
    expect(view.bridge.reviewEmergencyEnd).toHaveBeenCalledWith({
      snapshotRevision: 7,
    });
    expect(view.text()).toContain(
      "Emergency review is unavailable. Ask your teacher or operator for help.",
    );
    expect(visible(view.action("confirm-emergency"))).toBe(false);
    expect(visible(view.action("review-emergency"))).toBe(true);
    expect(view.action("review-emergency").disabled).toBe(false);
    expect(visible(view.form())).toBe(false);
    expect(view.root.attributes["data-protection-phase"]).toBe(
      "recovery_required",
    );
    expect(view.bridge.confirmEmergencyEnd).not.toHaveBeenCalled();
    expect(view.bridge.startAssessment).not.toHaveBeenCalled();
  });

  it.each(["ended", "recovery_required", "locked"] as const)(
    "does not add unavailable-review feedback over a newer %s publication",
    async (phase) => {
      const recovery = {
        ...nativeState("recovery_required", 7, { cleanup: "unconfirmed" }),
        admission: state("recovery_required").admission,
      };
      const view = setup(recovery);
      await settle();
      const pending = deferred<DesktopStudentView | null>();
      view.bridge.reviewEmergencyEnd.mockReturnValueOnce(pending.promise);
      view.action("review-emergency").fire("click");
      view.publish(
        nativeState(phase, 8, { emergencyReview: phase === "locked" }),
      );
      pending.resolve(recovery);
      await settle();
      expect(view.root.attributes["data-protection-phase"]).toBe(phase);
      expect(view.text()).not.toContain("Emergency review is unavailable");
      expect(view.text()).not.toContain("The result is unconfirmed");
      expect(visible(view.action("confirm-emergency"))).toBe(
        phase === "locked",
      );
    },
  );

  it("cleans both UI surfaces and stale emergency intents even if unsubscribe fails during a pending action", async () => {
    const view = setup(nativeState("locked", 4, { emergencyReview: true }));
    await settle();
    const pending = deferred<DesktopStudentView | null>();
    view.bridge.confirmEmergencyEnd.mockReturnValueOnce(pending.promise);
    const confirm = savedListener(view.action("confirm-emergency"));
    view.action("confirm-emergency").fire("click");
    const controls = nodes(view.root);
    view.unsubscribe.mockImplementationOnce(() => {
      throw new Error("closed IPC");
    });
    expect(view.dispose).toThrow("closed IPC");
    pending.resolve(nativeState("ended", 5));
    view.publish(nativeState("locked", 6));
    await settle();
    confirm();
    expect(view.root.children).toHaveLength(0);
    expect(view.root.attributes["data-protection-phase"]).toBeUndefined();
    expect(view.root.attributes["data-admission-phase"]).toBeUndefined();
    expect(
      view.root.attributes["data-calculator-space-reserved"],
    ).toBeUndefined();
    expect(
      controls.every((control) =>
        [...control.listeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ),
    ).toBe(true);
    expect(view.bridge.confirmEmergencyEnd).toHaveBeenCalledTimes(1);
  });
});
