import { describe, expect, it, vi } from "vitest";
import type {
  StaffStudentProtectionEvent,
  StaffStudentSession,
  StaffTest,
} from "@desmoslock/contracts";
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
  open = false;
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
  evidenceSummary: {
    reportCount: 0,
    failureCount: 0,
    latestReceivedAt: null,
    latestReportedEpoch: null,
  },
};
function data(overrides: Partial<StudentSessionData> = {}): StudentSessionData {
  return {
    school,
    test,
    parentBusy: false,
    page: { items: [session], nextCursor: null },
    selected: session,
    disclosure: null,
    evidence: { kind: "closed" },
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
    !(
      element.parentElement?.tagName === "details" &&
      !element.parentElement.open &&
      element.tagName !== "summary"
    ) &&
    (element.parentElement === null || visible(element.parentElement))
  );
}
function report(
  overrides: Partial<StaffStudentProtectionEvent> = {},
): StaffStudentProtectionEvent {
  return {
    fact: {
      policyVersion: 1,
      sequence: 7,
      eventId: "90000000-0000-4000-8000-000000000071",
      attemptId: "90000000-0000-4000-8000-000000000072",
      scope: {
        schoolId: school.schoolId,
        testId: test.id,
        studentSessionId: session.id,
        deviceSessionId: "90000000-0000-4000-8000-000000000073",
        epoch: 1,
      },
      slot: "failure",
      phase: "failed",
      nativeEvent: null,
      nativeSequence: null,
      cause: "application_policy",
      categories: {
        aac: { status: "pending", code: "awaiting_native_begin" },
        shortcuts: { status: "confirmed", code: "none" },
        applications: { status: "failed", code: "prohibited_application" },
        persistence: { status: "confirmed", code: "none" },
        windowNetwork: { status: "confirmed", code: "none" },
      },
    },
    originBuild: { kind: "unverified_build" },
    contentDigest: "a".repeat(64),
    receivedAt: "2026-09-08T12:00:00.123456Z",
    ...overrides,
  };
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

describe("Teacher historical client reports", () => {
  it("shows neutral absence and never opens or reads reports automatically", () => {
    const view = setup();
    expect(view.text()).toContain("No client reports received");
    expect(visible(view.action("open_evidence"))).toBe(true);
    expect(view.text()).not.toContain(
      "Reports from the client may arrive late",
    );
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("keeps a late old-admission report historical and uses readable receipt time with exact detail", () => {
    const current = {
      ...session,
      epoch: 2,
      evidenceSummary: {
        reportCount: 1,
        failureCount: 1,
        latestReceivedAt: report().receivedAt,
        latestReportedEpoch: 1,
      },
    };
    const view = setup(
      ready({
        selected: current,
        page: { items: [current], nextCursor: null },
        evidence: {
          kind: "ready",
          page: { items: [report()], nextCursor: null },
        },
      }),
    );
    expect(view.text()).toContain(
      "1 report received · 1 reported failure · Latest received report: admission version 1",
    );
    expect(view.text()).toContain("Current admission version 2");
    expect(view.text()).toContain(
      "Original admission version 1 · Report sequence 7",
    );
    expect(view.text()).toContain("They do not confirm current protection");
    expect(view.text()).toContain("Protection failure reported");
    expect(view.text()).toContain("Prohibited application reported");
    const received = view.find((node) => node.tagName === "time");
    expect(received.textContent).toBe("Received 2026-09-08 12:00:00 UTC");
    expect(received.attributes.datetime).toBe("2026-09-08T12:00:00.123456Z");
    expect(received.attributes.title).toContain(".123456Z");
    expect(view.text()).not.toContain(report().fact.eventId);
    expect(view.text()).not.toContain(report().contentDigest);
  });

  it.each(["build", "unverified_build", "legacy_unknown"] as const)(
    "keeps %s provenance in optional details without a release claim",
    (kind) => {
      const originBuild: StaffStudentProtectionEvent["originBuild"] =
        kind === "build"
          ? {
              kind,
              identity: {
                schemaVersion: 1,
                sourceRepository: "danielholguin31/desmoslock",
                sourceCommit: "a".repeat(40),
                sourceTree: "b".repeat(40),
                packageLockSha256: "c".repeat(64),
                buildId: "d".repeat(64),
              },
            }
          : { kind };
      const view = setup(
        ready({
          evidence: {
            kind: "ready",
            page: { items: [report({ originBuild })], nextCursor: null },
          },
        }),
      );
      const details = view.find((node) => node.tagName === "details");
      expect(details.open).toBe(false);
      expect(view.text()).not.toContain("d".repeat(64));
      details.open = true;
      if (kind === "build") {
        expect(view.text()).toContain("Build ID: " + "d".repeat(64));
        expect(view.text()).toContain("not release verification");
      } else
        expect(view.text()).toContain(
          kind === "unverified_build"
            ? "did not have a verified build identity"
            : "original build identity is unknown",
        );
    },
  );

  it("uses exact revision-bound named actions and explicit open/close focus", async () => {
    const view = setup();
    view.dispatch.mockImplementation(async (action) => {
      if (action.type === "open_evidence")
        view.publish(
          ready(
            {
              evidence: {
                kind: "ready",
                page: { items: [], nextCursor: null },
              },
            },
            2,
          ),
        );
      else if (action.type === "close_evidence") view.publish(ready({}, 3));
      return ready();
    });
    const open = view.action("open_evidence");
    open.focus();
    open.fire("click");
    await settle();
    expect(view.dispatch).toHaveBeenNthCalledWith(1, {
      type: "open_evidence",
      snapshotRevision: 1,
    });
    expect(view.document.activeElement?.textContent).toBe("Client reports");
    expect(view.text()).toContain(
      "No client reports received for this session",
    );
    view.action("close_evidence").focus();
    view.action("close_evidence").fire("click");
    await settle();
    expect(view.dispatch).toHaveBeenNthCalledWith(2, {
      type: "close_evidence",
      snapshotRevision: 2,
    });
    expect(view.document.activeElement).toBe(open);
  });

  it("retains focused details and private review through quiet history prepend and School rename", () => {
    const event = report();
    const initial = review("remove");
    if (!("data" in initial)) throw Error("Data required");
    const view = setup({
      ...initial,
      data: data({
        evidence: { kind: "ready", page: { items: [event], nextCursor: null } },
      }),
    });
    const build = view.find((node) => node.tagName === "details");
    build.open = true;
    const summary = view.find((node) => node.tagName === "summary");
    summary.focus();
    const newer = report({
      fact: {
        ...event.fact,
        eventId: "90000000-0000-4000-8000-000000000074",
        sequence: 8,
      },
      receivedAt: "2026-09-08T12:00:00.123457Z",
    });
    const confirm = view.action("confirm_review"),
      transitions = confirm.disableTransitions;
    view.publish({
      ...initial,
      revision: 3,
      data: data({
        school: {
          ...school,
          displayName: "Renamed School",
          settingsRevision: 2,
        },
        evidence: {
          kind: "ready",
          page: { items: [newer, event], nextCursor: null },
        },
      }),
    });
    expect(view.document.activeElement).toBe(summary);
    expect(summary.isConnected).toBe(true);
    expect(build.open).toBe(true);
    expect(confirm.disableTransitions).toBe(transitions);
    expect(confirm.disabled).toBe(false);
    expect(view.text()).toContain("Remove this session?");
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("preserves disclosed code selection through a quiet report refresh", () => {
    const disclosure = {
      kind: "join" as const,
      code: "23456789ABCD",
      expiresAt: "2026-09-08T12:15:00.123456Z",
      studentSessionId: null,
    };
    const view = setup(
      ready({
        disclosure,
        evidence: { kind: "ready", page: { items: [], nextCursor: null } },
      }),
    );
    const code = view.find((node) => node.tagName === "input");
    code.focus();
    code.selectionStart = 2;
    code.selectionEnd = 7;
    const writes = code.valueAssignments,
      focusCalls = code.focusCalls.length;
    view.publish(
      ready(
        {
          disclosure,
          school: { ...school, displayName: "Renamed", settingsRevision: 2 },
          evidence: {
            kind: "ready",
            page: { items: [report()], nextCursor: null },
          },
        },
        2,
      ),
    );
    expect(code.valueAssignments).toBe(writes);
    expect([code.selectionStart, code.selectionEnd]).toEqual([2, 7]);
    expect(view.document.activeElement).toBe(code);
    expect(code.focusCalls).toHaveLength(focusCalls);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("keeps held history feedback separate from Student confirmation and can close immediately", async () => {
    const initial = review("remove");
    if (!("data" in initial)) throw Error("Data required");
    const page = { items: [report()], nextCursor: null };
    const view = setup({
      ...initial,
      data: data({ evidence: { kind: "ready", page } }),
    });
    let release!: (value: StudentSessionSnapshot) => void;
    view.dispatch.mockImplementation((action) => {
      if (action.type === "refresh_evidence")
        return new Promise((resolve) => {
          release = resolve;
        });
      if (action.type === "close_evidence")
        view.publish({ ...initial, revision: 3, data: data() });
      return Promise.resolve(initial);
    });
    const confirm = view.action("confirm_review");
    confirm.focus();
    const transitions = confirm.disableTransitions;
    view.action("refresh_evidence").fire("click");
    expect(confirm.disabled).toBe(false);
    expect(confirm.disableTransitions).toBe(transitions);
    expect(view.document.activeElement).toBe(confirm);
    expect(view.action("close_evidence").disabled).toBe(false);
    view.action("close_evidence").fire("click");
    await settle();
    release(initial);
    await settle();
    expect(view.text()).not.toContain(
      "Reports from the client may arrive late",
    );
    expect(view.text()).toContain("Remove this session?");
  });

  it.each(["throw", "reject"] as const)(
    "contains a %s history failure without clearing a Student review",
    async (failure) => {
      const initial = review("remove");
      if (!("data" in initial)) throw Error("Data required");
      const view = setup({
        ...initial,
        data: data({
          evidence: {
            kind: "ready",
            page: { items: [report()], nextCursor: null },
          },
        }),
      });
      view.dispatch.mockImplementation(() => {
        if (failure === "throw") throw Error("private error");
        return Promise.reject(Error("private error"));
      });
      view.action("refresh_evidence").fire("click");
      await settle();
      expect(view.text()).toContain(
        "Client reports unavailable. Refresh reports to try again",
      );
      expect(view.text()).toContain("Remove this session?");
      expect(view.text()).not.toContain("private error");
      expect(view.action("confirm_review").disabled).toBe(false);
    },
  );

  it("labels unavailable retained history honestly and leaves explicit read retry usable", () => {
    const view = setup(
      ready({
        evidence: {
          kind: "unavailable",
          page: { items: [report()], nextCursor: null },
        },
      }),
    );
    expect(view.text()).toContain("Previously received reports are shown");
    expect(view.text()).toContain("Protection failure reported");
    expect(view.action("refresh_evidence").disabled).toBe(false);
    expect(view.text()).not.toContain(
      "No client reports received for this session",
    );
  });

  it("reads ended Test reports without enabling participation mutations", () => {
    const view = setup(
      ready({
        test: {
          ...test,
          lifecycle: "ended",
          endedAt: "2026-09-08T13:00:00.000000Z",
        },
        evidence: {
          kind: "ready",
          page: { items: [report()], nextCursor: null },
        },
      }),
    );
    expect(view.action("refresh_evidence").disabled).toBe(false);
    expect(view.action("review_remove").disabled).toBe(true);
    expect(view.action("review_issue_code").disabled).toBe(true);
    expect(view.text()).toContain("Received");
  });

  it("discards late history UI completion after authority withdrawal", async () => {
    const view = setup();
    let release!: (value: StudentSessionSnapshot) => void;
    view.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    view.action("open_evidence").fire("click");
    view.publish({ kind: "unavailable", revision: 2 });
    release(
      ready(
        {
          evidence: {
            kind: "ready",
            page: { items: [report()], nextCursor: null },
          },
        },
        3,
      ),
    );
    await settle();
    expect(view.root.children).toHaveLength(0);
    expect(view.root.hidden).toBe(true);
  });
});

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
