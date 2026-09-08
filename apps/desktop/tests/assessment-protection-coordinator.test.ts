import type {
  StudentSessionScope,
  StudentSessionViewState,
} from "@desmoslock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStudentSessionCoordinator } from "../src/main/student-session-coordinator.js";
import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionStore,
  type NativeStudentRecordHandle,
  type StudentSessionRecord,
} from "../src/main/student-session-store.js";
import {
  createStudentSessionTransport,
  type StudentSessionFetch,
} from "../src/main/student-session-transport.js";

import { createAssessmentProtectionCoordinator } from "../src/main/assessment-protection-coordinator.js";
import { parseDesktopStudentView } from "../src/assessment-protection-view-state.js";
import type { CalculatorSurface } from "../src/main/calculator-surface.js";
import type { ProtectionCategories } from "../src/main/assessment-protection-types.js";
import type {
  ApplicationObservation,
  NativeAssessmentEvent,
  NativeProtectionAdapter,
} from "../src/main/native-protection-adapter.js";
import type {
  FreshAdmissionResult,
  FreshStudentAdmission,
  StudentAdmissionObservation,
  StudentAdmissionSnapshot,
  StudentSessionCoordinator,
} from "../src/main/student-session-coordinator.js";
import type {
  ProtectionFact,
  ProtectionTransition,
  StoredNativeProtection,
} from "../src/main/student-session-store.js";

// Pure main-process logic tests use explicitly synthetic native/window ports.
// They establish ordering and issuer fences, not Electron rendering or AAC proof.
const attempt = "60000000-0000-4000-8000-000000000001";
const scope: StudentSessionScope = Object.freeze({
  schoolId: "30000000-0000-4000-8000-000000000001",
  testId: "40000000-0000-4000-8000-000000000001",
  studentSessionId: "50000000-0000-4000-8000-000000000001",
  deviceSessionId: "70000000-0000-4000-8000-000000000001",
  epoch: 1,
});
const confirmed = Object.freeze<ProtectionCategories>({
  aac: { status: "confirmed", code: "none" },
  shortcuts: { status: "confirmed", code: "none" },
  applications: { status: "confirmed", code: "none" },
  persistence: { status: "confirmed", code: "none" },
  windowNetwork: { status: "confirmed", code: "none" },
});
const current = () => true;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
}

function fakeStudent(events: string[], now: () => number) {
  let active = true;
  let observationSequence = 0;
  let receipt: FreshStudentAdmission | null = null;
  let protection: StoredNativeProtection | null = null;
  let readGate: Promise<void> | null = null;
  let externalRead: Promise<void> | null = null;
  let view: StudentSessionViewState = {
    revision: 71,
    phase: "active",
    session: {
      syntheticDisplayName: "Student ABC",
      sessionRevision: 1,
      capabilityExpiresAtMs: 1_300_000,
    },
    protection: "unavailable",
    calculatorEligible: false,
    pendingOperation: null,
  };
  const admission: StudentAdmissionSnapshot = Object.freeze({
    scope,
    admissionGeneration: 1,
    sessionRevision: 1,
    capabilityDeadline: 300_000,
  });
  const privateListeners = new Set<
    (value: StudentAdmissionObservation) => void
  >();
  const publicListeners = new Set<(value: StudentSessionViewState) => void>();
  const gates = new Map<ProtectionTransition["kind"], Promise<void>>();
  const deniedCommits = new Set<ProtectionTransition["kind"]>();
  const commands: ProtectionTransition[] = [];
  function issue(sequence: number, startedAt: number) {
    receipt = Object.freeze({
      ...admission,
      observationSequence: sequence,
      readStartedAt: startedAt,
      observationDeadline: Math.min(300_000, startedAt + 30_000),
    });
    for (const listener of privateListeners)
      listener({ status: "fresh", authority: receipt });
    return receipt;
  }
  const readFreshAdmission = vi.fn(
    async (
      _expected: StudentAdmissionSnapshot,
      afterObservationSequence?: number,
    ): Promise<FreshAdmissionResult> => {
      events.push("student.read:start");
      if (externalRead !== null) await externalRead;
      const startedAt = now();
      const sequence = ++observationSequence;
      if (readGate !== null) await readGate;
      if (
        !active ||
        (afterObservationSequence !== undefined &&
          sequence <= afterObservationSequence)
      )
        return { status: "unavailable" };
      const authority = issue(sequence, startedAt);
      events.push("student.read:issued");
      return { status: "fresh", authority };
    },
  );
  const commitProtectionTransition = vi.fn(
    async (command: ProtectionTransition) => {
      commands.push(command);
      events.push("commit:" + command.kind + ":start");
      const gate = gates.get(command.kind);
      if (gate !== undefined) await gate;
      if (
        deniedCommits.has(command.kind) ||
        command.expectedProtectionRevision !== (protection?.revision ?? 0)
      )
        return { status: "unavailable" as const };
      const previous = protection?.latestAttempt;
      const facts = protection?.facts ?? [];
      const phase =
        command.kind === "engaging" || command.kind === "began"
          ? "engaging"
          : command.kind === "locked"
            ? "locked"
            : command.kind === "disposed_without_terminal_observation"
              ? "failed"
              : command.kind === "failure"
                ? "recovery_required"
                : command.kind === "cleanup" && command.outcome === "complete"
                  ? "ended"
                  : "ending";
      const nativeSequence =
        command.kind === "began" || command.kind === "native_terminal"
          ? command.event.sequence
          : command.kind === "locked"
            ? command.nativeSequence
            : (previous?.nativeSequence ?? null);
      const nativeDisposition =
        command.kind === "disposed_without_terminal_observation"
          ? "disposed_without_terminal_observation"
          : command.kind === "native_terminal"
            ? command.event.type === "did_end"
              ? "ended"
              : "failed_to_begin"
            : command.kind === "began" || command.kind === "locked"
              ? "active"
              : (previous?.nativeDisposition ?? "pending");
      const slot =
        command.kind === "ending"
          ? "end_requested"
          : command.kind === "disposed_without_terminal_observation"
            ? "cleanup"
            : command.kind;
      const fact: ProtectionFact = {
        sequence: facts.length + 1,
        eventId:
          "80000000-0000-4000-8000-" +
          String(facts.length + 1).padStart(12, "0"),
        attemptId: command.attemptId,
        scope,
        policyVersion: 1,
        slot,
        phase,
        nativeEvent:
          command.kind === "began" || command.kind === "native_terminal"
            ? command.event.type
            : null,
        nativeSequence,
        categories: "categories" in command ? command.categories : confirmed,
        cause: "cause" in command ? command.cause : "none",
      };
      const successor: StoredNativeProtection = {
        policyVersion: 1,
        revision: (protection?.revision ?? 0) + 1,
        latestAttempt: {
          attemptId: command.attemptId,
          scope,
          phase,
          nativeDisposition,
          nativeSequence,
          cleanup:
            command.kind === "disposed_without_terminal_observation"
              ? "complete"
              : command.kind === "cleanup"
                ? command.outcome
                : (previous?.cleanup ?? "not_requested"),
          abandonment:
            command.kind === "abandoned"
              ? "requested"
              : (previous?.abandonment ?? "none"),
        },
        nextFactSequence: facts.length + 2,
        facts: [...facts, fact],
      };
      protection = Object.freeze(successor);
      events.push("commit:" + command.kind + ":durable");
      return {
        status: "committed" as const,
        protectionRevision: successor.revision,
      };
    },
  );
  const student = {
    initialize: vi.fn(async () => undefined),
    joinInitial: vi.fn<(code: string) => Promise<void>>(async () => undefined),
    beginTargetedReadmission: vi.fn<
      (code: string, revision: number) => Promise<void>
    >(async () => undefined),
    retryPending: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    forfeit: vi.fn<(revision: number) => Promise<void>>(async () => {
      events.push("student.forfeit");
    }),
    dispose: vi.fn(async () => {
      events.push("student.dispose");
      return true;
    }),
    readView: () => view,
    readProtectionContext: () => ({
      admission: active ? admission : null,
      freshAdmission: receipt,
      observationSequence,
      protection,
    }),
    readFreshAdmission,
    isCurrentAdmission: (value: FreshStudentAdmission) =>
      active &&
      value === receipt &&
      now() < value.observationDeadline &&
      now() < value.capabilityDeadline,
    subscribeAdmissionObservation(
      listener: (value: StudentAdmissionObservation) => void,
    ) {
      events.push("student.subscribe-private");
      privateListeners.add(listener);
      return () => {
        privateListeners.delete(listener);
      };
    },
    subscribe(listener: (value: StudentSessionViewState) => void) {
      publicListeners.add(listener);
      return () => {
        publicListeners.delete(listener);
      };
    },
    commitProtectionTransition,
  } satisfies StudentSessionCoordinator;
  return {
    student,
    admission,
    commands,
    setProtection(value: StoredNativeProtection) {
      protection = value;
    },
    holdCommit(kind: ProtectionTransition["kind"], promise: Promise<void>) {
      gates.set(kind, promise);
    },
    denyCommit(kind: ProtectionTransition["kind"]) {
      deniedCommits.add(kind);
    },
    holdRead(promise: Promise<void> | null) {
      readGate = promise;
    },
    observe() {
      return issue(++observationSequence, now());
    },
    startExternalRead() {
      const completion = deferred();
      const sequence = ++observationSequence;
      const startedAt = now();
      externalRead = completion.promise.then(() => {
        issue(sequence, startedAt);
        externalRead = null;
      });
      return { sequence, finish: () => completion.resolve() };
    },
    invalidate() {
      active = false;
      receipt = null;
      for (const listener of privateListeners)
        listener({ status: "invalidated" });
      view = {
        ...view,
        revision: view.revision + 1,
        phase: "unavailable",
        session: null,
      };
      for (const listener of publicListeners) listener(view);
    },
    setPhase(phase: StudentSessionViewState["phase"]) {
      active = phase === "active";
      view = {
        ...view,
        revision: view.revision + 1,
        phase,
        session: active
          ? {
              syntheticDisplayName: "Student ABC",
              sessionRevision: 1,
              capabilityExpiresAtMs: 1_300_000,
            }
          : null,
      };
      for (const listener of publicListeners) listener(view);
    },
    publishPublic() {
      view = { ...view, revision: view.revision + 1 };
      for (const listener of publicListeners) listener(view);
    },
  };
}

function harness(
  options: {
    readonly student?: StudentSessionCoordinator;
    readonly now?: () => number;
    readonly protection?: StoredNativeProtection;
  } = {},
) {
  const events: string[] = [];
  let elapsed = 0;
  const now = options.now ?? (() => elapsed);
  const fake = fakeStudent(events, now);
  if (options.protection !== undefined) fake.setProtection(options.protection);
  const student = options.student ?? fake.student;
  const nativeListeners = new Set<(value: NativeAssessmentEvent) => void>();
  const appListeners = new Set<(value: ApplicationObservation) => void>();
  let observation: ApplicationObservation = {
    status: "clear",
    reason: "policy_clear",
  };
  let nativeAvailable = true;
  let nativeActive = false;
  let nativePending = false;
  let beginFailure: Error | null = null;
  let nativeSequence = 0;
  let registered = false;
  let registerAllowed = true;
  let windowReady = true;
  let prepareGate: Promise<void> | null = null;
  let windowGate: Promise<void> | null = null;
  let closeGate: Promise<void> | null = null;
  let restoreGate: Promise<void> | null = null;
  let disposeFailure: Error | null = null;
  let displayed = false;
  let emergency: (() => void) | null = null;
  const native = {
    inspectSupport: vi.fn(() => ({
      available: nativeAvailable,
      reason: nativeAvailable
        ? ("api_available_authorization_unverified" as const)
        : ("api_unavailable" as const),
    })),
    subscribe(listener: (event: NativeAssessmentEvent) => void) {
      events.push("native.subscribe");
      nativeListeners.add(listener);
      return () => {
        events.push("native.unsubscribe");
        nativeListeners.delete(listener);
      };
    },
    observeApplicationStatus(
      listener: (value: ApplicationObservation) => void,
    ) {
      events.push("app.subscribe");
      appListeners.add(listener);
      return () => {
        events.push("app.unsubscribe");
        appListeners.delete(listener);
      };
    },
    readApplicationStatus: vi.fn(() => {
      events.push("app.read");
      return observation;
    }),
    begin: vi.fn<(attemptId: string) => void>(() => {
      events.push("native.begin");
      if (beginFailure !== null) throw beginFailure;
      nativePending = true;
    }),
    requestEnd: vi.fn<(attemptId: string) => void>(() => {
      events.push("native.requestEnd");
      nativeActive = false;
    }),
    isAttemptActive: vi.fn(
      (attemptId: string, sequence: number) =>
        attemptId === attempt && nativeActive && nativeSequence === sequence,
    ),
    disposeAfterEnd: vi.fn(() => {
      events.push("native.dispose");
      if (disposeFailure !== null) throw disposeFailure;
      if (nativePending)
        throw new Error("synthetic native owner still pending");
    }),
  } satisfies NativeProtectionAdapter;
  const surface: CalculatorSurface = {
    partition: "desmoslock-calculator-synthetic",
    webContentsId: 17,
    attach: vi.fn(() => {
      events.push("surface.attach");
      displayed = true;
    }),
    detach: vi.fn(() => {
      events.push("surface.detach");
      displayed = false;
    }),
    close: vi.fn(async () => {
      events.push("surface.close");
      displayed = false;
      if (closeGate !== null) await closeGate;
      events.push("surface.closed");
    }),
    setBounds: vi.fn(),
  };
  const prepareCalculator = vi.fn(async () => {
    events.push("surface.prepare");
    if (prepareGate !== null) await prepareGate;
    return surface;
  });
  const window = {
    prepare: vi.fn(async () => {
      events.push("window.prepare");
      if (windowGate !== null) await windowGate;
    }),
    isReady: vi.fn(() => windowReady),
    showRecovery: vi.fn(() => {
      events.push("window.recovery");
    }),
    restore: vi.fn(async () => {
      events.push("window.restore");
      if (restoreGate !== null) await restoreGate;
      events.push("window.restored");
    }),
  };
  const shortcuts = {
    register: vi.fn((listener: () => void) => {
      events.push("shortcut.register");
      emergency = listener;
      registered = registerAllowed;
      return registerAllowed;
    }),
    isRegistered: vi.fn(() => registered),
    unregister: vi.fn(() => {
      events.push("shortcut.unregister");
      registered = false;
    }),
  };
  const coordinator = createAssessmentProtectionCoordinator({
    student,
    native,
    prepareCalculator,
    window,
    shortcuts,
    monotonicNow: now,
    attemptId: () => attempt,
  });
  return {
    coordinator,
    fake,
    student,
    native,
    surface,
    prepareCalculator,
    window,
    shortcuts,
    events,
    displayed: () => displayed,
    async advance(ms: number) {
      elapsed += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    setNativeAvailable(value: boolean) {
      nativeAvailable = value;
    },
    setNativeActive(value: boolean) {
      nativeActive = value;
    },
    setRegisterAllowed(value: boolean) {
      registerAllowed = value;
    },
    loseShortcut() {
      registered = false;
    },
    setWindowReady(value: boolean) {
      windowReady = value;
    },
    setApplication(value: ApplicationObservation) {
      observation = value;
      for (const listener of appListeners) listener(value);
    },
    holdPreparation(promise: Promise<void>) {
      prepareGate = promise;
    },
    holdWindow(promise: Promise<void>) {
      windowGate = promise;
    },
    holdClose(promise: Promise<void>) {
      closeGate = promise;
    },
    holdRestore(promise: Promise<void>) {
      restoreGate = promise;
    },
    failNativeBegin() {
      beginFailure = new Error("synthetic native begin failure");
    },
    failNativeDisposal() {
      disposeFailure = new Error("synthetic native disposal failure");
    },
    emergencyShortcut() {
      emergency?.();
    },
    emit(
      type: NativeAssessmentEvent["type"],
      sequence: number,
      suppliedAttempt = attempt,
    ) {
      nativeSequence = sequence;
      nativeActive = type === "did_begin";
      nativePending = type === "did_begin" || type === "interrupted";
      const event: NativeAssessmentEvent = {
        type,
        sequence,
        attemptId: suppliedAttempt,
        code:
          type === "failed_to_begin"
            ? "native_failed_to_begin"
            : type === "interrupted"
              ? "native_interrupted"
              : "none",
      };
      events.push("native.event:" + type);
      for (const listener of nativeListeners) listener(event);
    },
  };
}

function previousJournal(factCount: 24 | 25): StoredNativeProtection {
  const facts: ProtectionFact[] = [];
  let lastAttemptId = "";
  for (let index = 0; index < 4; index += 1) {
    lastAttemptId =
      "60000000-0000-4000-8000-" + String(index + 10).padStart(12, "0");
    const slots: ProtectionFact["slot"][] = [
      "engaging",
      "began",
      "locked",
      "end_requested",
    ];
    if (factCount === 25 && index === 0) slots.push("failure");
    slots.push("native_terminal", "cleanup");
    for (const slot of slots) {
      facts.push({
        sequence: facts.length + 1,
        eventId:
          "81000000-0000-4000-8000-" +
          String(facts.length + 1).padStart(12, "0"),
        attemptId: lastAttemptId,
        scope,
        policyVersion: 1,
        slot,
        phase:
          slot === "cleanup"
            ? "ended"
            : slot === "locked"
              ? "locked"
              : slot === "failure"
                ? "recovery_required"
                : slot === "engaging" || slot === "began"
                  ? "engaging"
                  : "ending",
        nativeEvent:
          slot === "began"
            ? "did_begin"
            : slot === "native_terminal"
              ? "did_end"
              : null,
        nativeSequence:
          slot === "engaging"
            ? null
            : slot === "native_terminal" || slot === "cleanup"
              ? 3
              : 2,
        categories: confirmed,
        cause: slot === "failure" ? "window_lost" : "none",
      });
    }
  }
  return {
    policyVersion: 1,
    revision: factCount,
    nextFactSequence: factCount + 1,
    facts,
    latestAttempt: {
      attemptId: lastAttemptId,
      scope,
      phase: "ended",
      nativeDisposition: "ended",
      nativeSequence: 3,
      cleanup: "complete",
      abandonment: "none",
    },
  };
}

type Harness = ReturnType<typeof harness>;
async function engaging(h: Harness) {
  const operation = h.coordinator.start(
    h.coordinator.readView().revision,
    current,
  );
  await settle();
  expect(h.native.begin).toHaveBeenCalledOnce();
  expect(h.surface.attach).not.toHaveBeenCalled();
  return operation;
}
async function locked(h: Harness) {
  void engaging(h);
  await settle();
  h.emit("did_begin", 2);
  await settle();
  expect(h.coordinator.readView().protection.phase).toBe("locked");
  expect(h.surface.attach).toHaveBeenCalledOnce();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("assessment protection coordinator authority and containment", () => {
  it("latches unreadable protection recovery through Student repair without inventing a retained native attempt", async () => {
    const fake = fakeStudent([], () => 0);
    fake.setPhase("recovery_required");
    const h = harness({ student: fake.student });
    expect(h.coordinator.readView().protection.phase).toBe("recovery_required");
    expect(parseDesktopStudentView(h.coordinator.readView())).not.toBeNull();
    expect(h.coordinator.hasRetainedAttempt()).toBe(false);
    await h.coordinator.start(h.coordinator.readView().revision, current);
    expect(fake.student.readFreshAdmission).not.toHaveBeenCalled();
    const studentRevision = fake.student.readView().revision;
    await h.coordinator.beginTargetedReadmission(
      "0123456789AB",
      h.coordinator.readView().revision,
      current,
    );
    expect(
      fake.student.beginTargetedReadmission,
    ).toHaveBeenCalledExactlyOnceWith("0123456789AB", studentRevision);
    fake.setPhase("active");
    expect(h.coordinator.readView().admission.phase).toBe("active");
    expect(h.coordinator.readView().protection.phase).toBe("recovery_required");
    await h.coordinator.start(h.coordinator.readView().revision, current);
    expect(h.native.begin).not.toHaveBeenCalled();
    expect(h.prepareCalculator).not.toHaveBeenCalled();
    expect(fake.commands).toHaveLength(0);
    expect(await h.coordinator.shutdown()).toBe("complete");
    expect(fake.student.dispose).toHaveBeenCalledOnce();
  });

  it("does not invent calculator closure after detached preparation rejects without returning its owner", async () => {
    const h = harness();
    h.prepareCalculator.mockRejectedValueOnce(
      new Error("synthetic preparation and cleanup failure"),
    );
    await h.coordinator.start(h.coordinator.readView().revision, current);
    await settle();
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    expect(h.coordinator.readView().protection.cleanup).toBe("unconfirmed");
    expect(h.native.begin).not.toHaveBeenCalled();
    expect(h.surface.attach).not.toHaveBeenCalled();
    expect(h.window.showRecovery).not.toHaveBeenCalled();
    expect(h.window.restore).not.toHaveBeenCalled();
    expect(await h.coordinator.shutdown()).toBe("retained");
  });

  it("requires a current explicit Start and never treats admission or native availability as engagement", async () => {
    const h = harness();
    expect(parseDesktopStudentView(h.coordinator.readView())).not.toBeNull();
    expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
    expect(h.native.begin).not.toHaveBeenCalled();
    await h.coordinator.start(h.coordinator.readView().revision + 1, current);
    await h.coordinator.start(h.coordinator.readView().revision, () => false);
    expect(h.native.begin).not.toHaveBeenCalled();
    expect(h.prepareCalculator).not.toHaveBeenCalled();
    expect(h.fake.student.readFreshAdmission).not.toHaveBeenCalled();
  });

  it("commits engaging before native begin and a post-begin read plus locked commit before synchronous attach", async () => {
    const h = harness();
    const durableEngaging = deferred();
    const durableLocked = deferred();
    h.fake.holdCommit("engaging", durableEngaging.promise);
    h.fake.holdCommit("locked", durableLocked.promise);
    const starting = h.coordinator.start(
      h.coordinator.readView().revision,
      current,
    );
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    await settle();
    expect(h.native.begin).not.toHaveBeenCalled();
    expect(h.surface.attach).not.toHaveBeenCalled();
    durableEngaging.resolve();
    await settle();
    expect(h.native.begin).toHaveBeenCalledExactlyOnceWith(attempt);
    h.emit("did_begin", 4);
    await settle();
    expect(h.fake.student.readFreshAdmission).toHaveBeenCalledTimes(2);
    expect(h.surface.attach).not.toHaveBeenCalled();
    durableLocked.resolve();
    await starting;
    await settle();
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.events.indexOf("native.subscribe")).toBeLessThan(
      h.events.indexOf("native.begin"),
    );
    expect(h.events.indexOf("app.subscribe")).toBeLessThan(
      h.events.indexOf("app.read"),
    );
    expect(h.events.indexOf("commit:engaging:durable")).toBeLessThan(
      h.events.indexOf("native.begin"),
    );
    expect(h.events.indexOf("commit:locked:durable")).toBeLessThan(
      h.events.indexOf("surface.attach"),
    );
    expect(parseDesktopStudentView(h.coordinator.readView())).not.toBeNull();
  });

  it.each(["native", "applications", "shortcut", "window", "persistence"])(
    "never begins or attaches without the %s preflight category",
    async (category) => {
      const h = harness();
      if (category === "native") h.setNativeAvailable(false);
      if (category === "applications")
        h.setApplication({
          status: "blocked",
          reason: "prohibited_application",
        });
      if (category === "shortcut") h.setRegisterAllowed(false);
      if (category === "window") h.setWindowReady(false);
      if (category === "persistence") h.fake.denyCommit("engaging");
      await h.coordinator.start(h.coordinator.readView().revision, current);
      await settle();
      expect(h.native.begin).not.toHaveBeenCalled();
      expect(h.surface.attach).not.toHaveBeenCalled();
      expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
    },
  );

  it("fences an equal-time read started before did_begin and waits for the one newer issued read", async () => {
    const h = harness();
    void engaging(h);
    await settle();
    const old = h.fake.startExternalRead();
    const newer = deferred();
    h.fake.holdRead(newer.promise);
    h.emit("did_begin", 2);
    await settle();
    expect(h.fake.student.readFreshAdmission.mock.calls.at(-1)?.[1]).toBe(
      old.sequence,
    );
    expect(h.surface.attach).not.toHaveBeenCalled();
    old.finish();
    await settle();
    expect(h.surface.attach).not.toHaveBeenCalled();
    newer.resolve();
    await settle();
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.fake.student.readFreshAdmission).toHaveBeenCalledTimes(2);
  });

  it.each(["preparation", "window", "engaging", "post-read", "locked"])(
    "closes the promotion gate when admission is lost during held %s work",
    async (stage) => {
      const h = harness();
      const gate = deferred();
      if (stage === "preparation") h.holdPreparation(gate.promise);
      if (stage === "window") h.holdWindow(gate.promise);
      if (stage === "engaging") h.fake.holdCommit("engaging", gate.promise);
      if (stage === "locked") h.fake.holdCommit("locked", gate.promise);
      const starting = h.coordinator.start(
        h.coordinator.readView().revision,
        current,
      );
      await settle();
      if (stage === "post-read") h.fake.holdRead(gate.promise);
      if (stage === "post-read" || stage === "locked") {
        h.emit("did_begin", 2);
        await settle();
      }
      h.fake.invalidate();
      expect(h.displayed()).toBe(false);
      gate.resolve();
      await starting;
      await settle();
      expect(h.surface.attach).not.toHaveBeenCalled();
      expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
    },
  );

  it.each(["began", "post-read"])(
    "ends immediately when the originating shell becomes stale during held %s work",
    async (stage) => {
      const h = harness();
      const held = deferred();
      let shellCurrent = true;
      await h.coordinator.start(
        h.coordinator.readView().revision,
        () => shellCurrent,
      );
      expect(h.native.begin).toHaveBeenCalledOnce();
      if (stage === "began") h.fake.holdCommit("began", held.promise);
      else h.fake.holdRead(held.promise);
      h.emit("did_begin", 2);
      await settle();
      expect(h.native.requestEnd).not.toHaveBeenCalled();
      shellCurrent = false;
      held.resolve();
      await settle();
      expect(h.native.requestEnd).toHaveBeenCalledOnce();
      expect(h.surface.attach).not.toHaveBeenCalled();
      expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
      expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
    },
  );

  it("detaches and requests native end synchronously before an unsettled ending writer", async () => {
    const h = harness();
    await locked(h);
    const disk = deferred();
    h.fake.holdCommit("ending", disk.promise);
    h.events.length = 0;
    h.coordinator.requestLocalEnd("suspend");
    expect(h.displayed()).toBe(false);
    expect(h.surface.detach).toHaveBeenCalledOnce();
    expect(h.native.requestEnd).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(h.events.indexOf("surface.detach")).toBeLessThan(
      h.events.indexOf("native.requestEnd"),
    );
    await settle();
    expect(h.events.indexOf("native.requestEnd")).toBeLessThan(
      h.events.indexOf("commit:ending:start"),
    );
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    disk.resolve();
    await settle();
  });

  it("publishes observed did_end before a held terminal journal and cannot complete cleanup before all owners finish", async () => {
    const h = harness();
    await locked(h);
    h.coordinator.requestLocalEnd("application_quit");
    await settle();
    const terminal = deferred();
    const cleanup = deferred();
    const restore = deferred();
    h.fake.holdCommit("native_terminal", terminal.promise);
    h.holdClose(cleanup.promise);
    h.holdRestore(restore.promise);
    h.emit("did_end", 7);
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(true);
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    await settle();
    expect(
      h.fake.commands.some(
        (command) =>
          command.kind === "cleanup" && command.outcome === "complete",
      ),
    ).toBe(false);
    terminal.resolve();
    await settle();
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    cleanup.resolve();
    restore.resolve();
    await settle();
    expect(h.native.disposeAfterEnd).toHaveBeenCalledOnce();
    expect(h.shortcuts.unregister).toHaveBeenCalledOnce();
    expect(h.coordinator.readView().protection).toMatchObject({
      phase: "ended",
      nativeEndObserved: true,
      cleanup: "complete",
      calculatorVisible: false,
    });
    expect(
      h.fake.commands.filter(
        (command) =>
          command.kind === "cleanup" && command.outcome === "complete",
      ),
    ).toHaveLength(1);
    await expect(h.coordinator.shutdown()).resolves.toBe("complete");
  });

  it("retains native ownership when actual end is observed but disposal fails", async () => {
    const h = harness();
    await locked(h);
    h.failNativeDisposal();
    h.coordinator.requestLocalEnd("application_quit");
    await settle();
    h.emit("did_end", 3);
    await settle();
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(true);
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    await expect(h.coordinator.shutdown()).resolves.toBe("retained");
    expect(h.fake.student.dispose).not.toHaveBeenCalled();
  });

  it("times out pending begin without fabricating an end callback and refuses a late did_begin", async () => {
    const h = harness();
    void engaging(h);
    await settle();
    await h.advance(15_000);
    await settle();
    expect(h.native.requestEnd).toHaveBeenCalled();
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
    expect(
      h.fake.commands.some((command) => command.kind === "native_terminal"),
    ).toBe(false);
    h.emit("did_begin", 8);
    await settle();
    expect(h.surface.attach).not.toHaveBeenCalled();
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    await expect(h.coordinator.shutdown()).resolves.toBe("retained");
  });

  it("keeps the original end watchdog when a cancelled attempt receives a late did_begin", async () => {
    const h = harness();
    await engaging(h);
    h.coordinator.requestLocalEnd("suspend");
    await settle();
    await h.advance(5_000);
    h.emit("did_begin", 2);
    await settle();
    expect(h.surface.attach).not.toHaveBeenCalled();
    await h.advance(9_999);
    expect(h.coordinator.readView().protection.cleanup).toBe("pending");
    await h.advance(1);
    await settle();
    expect(h.coordinator.readView().protection).toMatchObject({
      phase: "recovery_required",
      cleanup: "unconfirmed",
      nativeEndObserved: false,
    });
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    expect(h.native.requestEnd).toHaveBeenCalledOnce();
    expect(
      h.fake.commands.some((command) => command.kind === "native_terminal"),
    ).toBe(false);
    expect(h.surface.attach).not.toHaveBeenCalled();
  });

  it("adopts three ordinary issued maintenance observations without extra reads, attachment or journal facts", async () => {
    const h = harness();
    await locked(h);
    const commandCount = h.fake.commands.length;
    const reads = h.fake.student.readFreshAdmission.mock.calls.length;
    const publications: string[] = [];
    h.coordinator.subscribe((value) => {
      publications.push(value.protection.phase);
    });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await h.advance(15_000);
      h.fake.observe();
      await settle();
    }
    expect(h.coordinator.readView().protection.phase).toBe("locked");
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.surface.detach).not.toHaveBeenCalled();
    expect(h.native.requestEnd).not.toHaveBeenCalled();
    expect(h.fake.student.readFreshAdmission).toHaveBeenCalledTimes(reads);
    expect(h.fake.commands).toHaveLength(commandCount);
    expect(publications.every((phase) => phase === "locked")).toBe(true);
  });

  it("expires visible content even after the originating shell action becomes stale", async () => {
    const h = harness();
    let shellCurrent = true;
    const starting = h.coordinator.start(
      h.coordinator.readView().revision,
      () => shellCurrent,
    );
    await settle();
    h.emit("did_begin", 2);
    await starting;
    await settle();
    expect(h.displayed()).toBe(true);
    const receipt = h.student.readProtectionContext().freshAdmission;
    if (receipt === null) throw new Error("expected issued lock admission");
    shellCurrent = false;
    h.events.length = 0;
    await h.advance(receipt.observationDeadline);
    expect(h.student.isCurrentAdmission(receipt)).toBe(false);
    expect(h.displayed()).toBe(false);
    expect(h.events.indexOf("surface.detach")).toBeLessThan(
      h.events.indexOf("native.requestEnd"),
    );
    expect(h.native.requestEnd).toHaveBeenCalledOnce();
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
    expect(
      h.fake.commands.some((command) => command.kind === "native_terminal"),
    ).toBe(false);
    h.fake.observe();
    await settle();
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.displayed()).toBe(false);
  });

  it("invalidates before public admission listeners, including a listener that throws", async () => {
    const h = harness();
    await locked(h);
    h.fake.student.subscribe(() => {
      expect(h.displayed()).toBe(false);
      expect(h.native.requestEnd).toHaveBeenCalled();
      throw new Error("synthetic public observer");
    });
    expect(() => h.fake.invalidate()).toThrow("synthetic public observer");
    expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
    h.fake.observe();
    await settle();
    expect(h.surface.attach).toHaveBeenCalledOnce();
  });

  it("the emergency accelerator reviews only, cancel is inert, and current confirmation ends before backend work", async () => {
    const h = harness();
    await locked(h);
    h.emergencyShortcut();
    expect(h.coordinator.readView().protection.emergencyReview).toBe(true);
    expect(h.native.requestEnd).not.toHaveBeenCalled();
    const oldRevision = h.coordinator.readView().revision;
    h.coordinator.cancelEmergency(oldRevision, current);
    expect(h.coordinator.readView().protection.emergencyReview).toBe(false);
    await h.coordinator.confirmEmergency(oldRevision, current);
    expect(h.native.requestEnd).not.toHaveBeenCalled();
    h.coordinator.reviewEmergency(h.coordinator.readView().revision, current);
    const confirmation = h.coordinator.confirmEmergency(
      h.coordinator.readView().revision,
      current,
    );
    expect(h.displayed()).toBe(false);
    expect(h.native.requestEnd).toHaveBeenCalled();
    await confirmation;
    await settle();
    expect(h.events.indexOf("surface.detach")).toBeLessThan(
      h.events.indexOf("student.forfeit"),
    );
    expect(h.fake.student.forfeit).toHaveBeenCalledExactlyOnceWith(71);
  });

  it("blocks replacement Student joins while a native attempt is retained", async () => {
    const h = harness();
    void engaging(h);
    await settle();
    await h.coordinator.joinInitial("0123456789AB", current);
    await h.coordinator.beginTargetedReadmission(
      "0123456789AB",
      h.coordinator.readView().revision,
      current,
    );
    await h.coordinator.start(h.coordinator.readView().revision, current);
    expect(h.fake.student.joinInitial).not.toHaveBeenCalled();
    expect(h.fake.student.beginTargetedReadmission).not.toHaveBeenCalled();
    expect(h.native.begin).toHaveBeenCalledOnce();
  });

  it("forwards the captured underlying Student revision rather than the composed revision", async () => {
    const h = harness();
    const composed = h.coordinator.readView().revision;
    expect(composed).not.toBe(h.fake.student.readView().revision);
    await h.coordinator.forfeit(composed, current);
    expect(h.fake.student.forfeit).toHaveBeenCalledExactlyOnceWith(71);
    expect(h.fake.student.forfeit).not.toHaveBeenCalledWith(composed);
  });
  it.each([24, 25] as const)(
    "reserves eight of the 32 durable fact slots before beginning (%s already queued)",
    async (factCount) => {
      const protection = previousJournal(factCount);
      const h = harness({ protection });
      const before = JSON.stringify(protection);
      await h.coordinator.start(h.coordinator.readView().revision, current);
      await settle();
      if (factCount === 24) expect(h.native.begin).toHaveBeenCalledOnce();
      else {
        expect(h.native.begin).not.toHaveBeenCalled();
        expect(h.fake.commands).toHaveLength(0);
        expect(h.coordinator.readView().protection.evidence).toBe("full");
      }
      expect(JSON.stringify(protection)).toBe(before);
      expect(h.surface.attach).not.toHaveBeenCalled();
    },
  );

  it("keeps prior-process unfinished protection detached without clearing the existing Student admission", async () => {
    const historical = previousJournal(24);
    const protection: StoredNativeProtection = {
      policyVersion: 1,
      revision: 7,
      nextFactSequence: 8,
      facts: [
        ...historical.facts.slice(0, 6),
        {
          sequence: 7,
          eventId: "82000000-0000-4000-8000-000000000007",
          attemptId: attempt,
          scope,
          policyVersion: 1,
          slot: "engaging",
          phase: "engaging",
          nativeEvent: null,
          nativeSequence: null,
          categories: confirmed,
          cause: "none",
        },
      ],
      latestAttempt: {
        attemptId: attempt,
        scope,
        phase: "engaging",
        nativeDisposition: "pending",
        nativeSequence: null,
        cleanup: "not_requested",
        abandonment: "none",
      },
    };
    const h = harness({ protection });
    expect(h.coordinator.readView().admission.phase).toBe("active");
    expect(h.coordinator.readView().protection.phase).toBe("recovery_required");
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    await h.coordinator.start(h.coordinator.readView().revision, current);
    expect(h.native.begin).not.toHaveBeenCalled();
    expect(h.prepareCalculator).not.toHaveBeenCalled();
    await expect(h.coordinator.shutdown()).resolves.toBe("retained");
    expect(h.fake.student.dispose).not.toHaveBeenCalled();
    expect(
      h.fake.commands.some(
        (command) => command.kind === "disposed_without_terminal_observation",
      ),
    ).toBe(false);
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
  });

  it("releases a fresh failed begin only after successful disposal and the finite durable nonterminal-observation command", async () => {
    const h = harness();
    h.failNativeBegin();
    const durability = deferred();
    h.fake.holdCommit(
      "disposed_without_terminal_observation",
      durability.promise,
    );
    const starting = h.coordinator.start(
      h.coordinator.readView().revision,
      current,
    );
    await settle();
    expect(h.native.disposeAfterEnd).toHaveBeenCalled();
    expect(h.surface.close).toHaveBeenCalled();
    expect(h.window.restore).toHaveBeenCalled();
    expect(h.shortcuts.unregister).toHaveBeenCalled();
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
    expect(
      h.fake.commands.some((command) => command.kind === "native_terminal"),
    ).toBe(false);
    durability.resolve();
    await starting;
    await settle();
    expect(h.coordinator.readView().protection).toMatchObject({
      phase: "failed",
      cleanup: "complete",
      nativeEndObserved: false,
      calculatorVisible: false,
    });
    expect(h.coordinator.hasRetainedAttempt()).toBe(false);
    expect(h.surface.attach).not.toHaveBeenCalled();
    expect(
      h.fake.commands.filter(
        (command) => command.kind === "disposed_without_terminal_observation",
      ),
    ).toHaveLength(1);
  });

  it.each(["disposal", "surface", "durability"])(
    "does not release a failed begin while %s cleanup is failed or held",
    async (stage) => {
      const h = harness();
      h.failNativeBegin();
      const held = deferred();
      if (stage === "disposal") h.failNativeDisposal();
      if (stage === "surface") h.holdClose(held.promise);
      if (stage === "durability")
        h.fake.holdCommit(
          "disposed_without_terminal_observation",
          held.promise,
        );
      const starting = h.coordinator.start(
        h.coordinator.readView().revision,
        current,
      );
      await settle();
      expect(h.coordinator.hasRetainedAttempt()).toBe(true);
      expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
      expect(h.coordinator.readView().protection.nativeEndObserved).toBe(false);
      expect(h.surface.attach).not.toHaveBeenCalled();
      held.resolve();
      await starting;
      await settle();
      if (stage === "disposal") {
        await expect(h.coordinator.shutdown()).resolves.toBe("retained");
        expect(
          h.fake.commands.some(
            (command) =>
              command.kind === "disposed_without_terminal_observation",
          ),
        ).toBe(false);
      }
    },
  );
});

// This composition uses the real Student coordinator, durable store, request
// signer and response decoder. The native record bytes and HTTP responses below
// are synthetic in-memory boundaries: no platform module or network is invoked.
function realStudent(options: { readonly latency?: number } = {}) {
  const configuration = {
    environment: "local",
    url: "http://127.0.0.1:43175",
  } as const;
  const crypto = createStudentSessionCrypto(configuration);
  const latency = options.latency ?? 5;
  let bytes: Buffer | null = null;
  let elapsed = 0;
  let denied = false;
  let heldWrite: {
    predicate: (value: StudentSessionRecord) => boolean;
    promise: Promise<void>;
  } | null = null;
  const responseGates = new Map<string, Promise<void>[]>();
  const requests: {
    route: string;
    body: Record<string, unknown>;
    durable: StudentSessionRecord;
  }[] = [];
  const events: string[] = [];
  function decode(value: Buffer | null = bytes): StudentSessionRecord {
    if (value === null) throw new Error("synthetic record not yet initialized");
    return JSON.parse(value.toString().slice(10)) as StudentSessionRecord;
  }
  const recordHandle: NativeStudentRecordHandle = {
    async loadEncryptedRecord() {
      return bytes === null ? null : Buffer.from(bytes);
    },
    async replaceEncryptedRecord(value) {
      const next = decode(value);
      events.push("write:start");
      if (heldWrite !== null && heldWrite.predicate(next))
        await heldWrite.promise;
      elapsed += latency;
      bytes = Buffer.from(value);
      events.push("write:durable");
    },
    async quarantineEncryptedRecord() {
      throw new Error("unexpected quarantine in active admission fixture");
    },
    async close() {
      events.push("store.close");
    },
  };
  const store = createStudentSessionStore({
    apiOrigin: configuration.url,
    openNativeStore: async () => recordHandle,
    codec: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from("synthetic:" + value),
      decryptString: (value) => value.toString().slice(10),
    },
    validateDevice: crypto.validateDevice,
    validateCandidates: crypto.validateCandidates,
  });
  const fetchRequest: StudentSessionFetch = async (url, init) => {
    const route = String(url).split("-").at(-1) ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const durable = decode();
    requests.push({ route, body, durable });
    events.push("http:" + route);
    const gate = responseGates.get(route)?.shift();
    if (gate !== undefined) await gate;
    elapsed += latency;
    if (denied)
      return Response.json(
        { status: "denied", code: "STUDENT_SESSION_DENIED" },
        { status: 403 },
      );
    const serverNowMs = 1_000_000 + elapsed;
    if (route === "challenge")
      return Response.json({
        challengeId: "10000000-0000-4000-8000-000000000099",
        expiresAtMs: serverNowMs + 15_000,
      });
    if (route === "join") {
      const pending = durable.pending;
      if (pending?.kind !== "join")
        throw new Error("durable join reservation required");
      const logicalOperationDigest = crypto.digestLogicalOperation({
        kind: "join",
        admissionMode: pending.admissionMode,
        requestId: pending.requestId,
        deviceSessionId: durable.device.deviceSessionId,
        joinMaterialDigest: crypto.digestJoinCode(pending.joinCode),
        capabilityDigest: pending.candidates.capabilityDigest,
        reconnectDigest: pending.candidates.reconnectDigest,
      });
      return Response.json({
        status: "accepted",
        code: "STUDENT_SESSION_ACCEPTED",
        requestId: pending.requestId,
        logicalOperationDigest,
        scope: { ...scope, deviceSessionId: durable.device.deviceSessionId },
        sessionRevision: 1,
        syntheticDisplayName: "Student ABC",
        serverNowMs,
        capabilityIssuedAtMs: serverNowMs,
        capabilityExpiresAtMs: serverNowMs + 300_000,
        reconnectExpiresAtMs: serverNowMs + 900_000,
        allowedIntents: ["state.read", "session.forfeit"],
      });
    }
    const currentAuthority = durable.current;
    if (currentAuthority === null)
      throw new Error("durable current authority required");
    const proof = body.deviceProof as { counter: number };
    expect(proof.counter).toBe(durable.lastReservedCounter);
    if (route === "read")
      return Response.json({
        status: "accepted",
        code: "STUDENT_SESSION_CURRENT",
        requestId: body.requestId,
        acceptedProofCounter: proof.counter,
        scope: currentAuthority.scope,
        sessionRevision: currentAuthority.sessionRevision,
        syntheticDisplayName: currentAuthority.syntheticDisplayName,
        testLifecycle: "open",
        state: "active",
        serverNowMs,
        capabilityExpiresAtMs: currentAuthority.capabilityExpiresAtMs,
      });
    if (route === "forfeit")
      return Response.json({
        status: "accepted",
        code: "STUDENT_SESSION_FORFEITED",
        requestId: body.requestId,
        acceptedProofCounter: proof.counter,
      });
    const pending = durable.pending;
    if (route !== "reconnect" || pending?.kind !== "reconnect")
      throw new Error("durable reconnect reservation required");
    const logicalOperationDigest = crypto.digestLogicalOperation({
      kind: "reconnect",
      requestId: pending.requestId,
      scope: currentAuthority.scope,
      expectedSessionRevision: pending.expectedSessionRevision,
      reconnectDigest: crypto.digestReconnectGrant(
        currentAuthority.reconnectGrant,
      ),
      nextCapabilityDigest: pending.candidates.capabilityDigest,
      nextReconnectDigest: pending.candidates.reconnectDigest,
    });
    return Response.json({
      status: "accepted",
      code: "STUDENT_SESSION_ACCEPTED",
      requestId: pending.requestId,
      logicalOperationDigest,
      scope: currentAuthority.scope,
      sessionRevision: pending.expectedSessionRevision + 1,
      syntheticDisplayName: currentAuthority.syntheticDisplayName,
      serverNowMs,
      capabilityIssuedAtMs: serverNowMs,
      capabilityExpiresAtMs: serverNowMs + 300_000,
      reconnectExpiresAtMs: serverNowMs + 900_000,
      allowedIntents: ["state.read", "session.forfeit"],
      acceptedProofCounter: proof.counter,
    });
  };
  const transport = createStudentSessionTransport(configuration, fetchRequest);
  const student = createStudentSessionCoordinator({
    apiOrigin: configuration.url,
    store,
    crypto,
    transport,
    monotonicNow: () => elapsed,
    drainTimeoutMs: 20,
  });
  return {
    student,
    requests,
    events,
    record: decode,
    now: () => elapsed,
    async initialize() {
      await student.initialize();
      await student.joinInitial("0123456789AB");
      expect(student.readView().phase).toBe("active");
    },
    async advance(ms: number) {
      elapsed += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    deny(value: boolean) {
      denied = value;
    },
    holdWrite(
      predicate: (value: StudentSessionRecord) => boolean,
      promise: Promise<void>,
    ) {
      heldWrite = { predicate, promise };
    },
    gateResponses(route: string, ...gates: Promise<void>[]) {
      responseGates.set(route, gates);
    },
    reads: () => requests.filter((request) => request.route === "read"),
  };
}

describe("real Student and native coordinator composition", () => {
  it("sustains one lock across three 15-second maintenance cycles with transport and durability latency", async () => {
    const real = realStudent({ latency: 7 });
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    await locked(h);
    const before = real.record();
    const journal = JSON.stringify(before.nativeProtection);
    const reads = real.reads().length;
    const phases: string[] = [];
    h.coordinator.subscribe((value) => {
      phases.push(value.protection.phase);
    });
    const issued: FreshStudentAdmission[] = [];
    real.student.subscribeAdmissionObservation((value) => {
      if (value.status === "fresh") issued.push(value.authority);
    });
    for (let index = 0; index < 3; index += 1) {
      await real.advance(15_000);
      await h.coordinator.refresh();
      await settle();
    }
    expect(real.reads()).toHaveLength(reads + 3);
    expect(issued).toHaveLength(3);
    expect(
      issued.every(
        (receipt) =>
          receipt.observationDeadline ===
          Math.min(receipt.capabilityDeadline, receipt.readStartedAt + 30_000),
      ),
    ).toBe(true);
    expect(real.record().lastReservedCounter).toBe(
      before.lastReservedCounter + 3,
    );
    expect(JSON.stringify(real.record().nativeProtection)).toBe(journal);
    expect(h.coordinator.readView().protection.phase).toBe("locked");
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.surface.detach).not.toHaveBeenCalled();
    expect(h.native.requestEnd).not.toHaveBeenCalled();
    expect(phases.every((phase) => phase === "locked")).toBe(true);
  });

  it("renews through the same Student owner and issues no new authority until the follow-up read is durable", async () => {
    const real = realStudent({ latency: 5 });
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    await locked(h);
    // Sustain the canonical five-minute capability until the renewal threshold.
    for (let index = 0; index < 15; index += 1) {
      await real.advance(15_000);
      await h.coordinator.refresh();
      await settle();
    }
    expect(
      real.requests.filter((request) => request.route === "reconnect"),
    ).toHaveLength(0);
    const old = real.student.readProtectionContext().freshAdmission;
    expect(old).not.toBeNull();
    const reconnect = deferred();
    const successor = deferred();
    const read = deferred();
    real.gateResponses("reconnect", reconnect.promise);
    real.gateResponses("read", read.promise);
    real.holdWrite(
      (value) => value.current?.sessionRevision === 2 && value.pending === null,
      successor.promise,
    );
    const before = real.record();
    const journal = JSON.stringify(before.nativeProtection);
    const count = real.reads().length;
    await real.advance(15_000);
    const refreshing = h.coordinator.refresh();
    await settle();
    expect(
      real.requests.filter((request) => request.route === "reconnect"),
    ).toHaveLength(1);
    expect(real.student.readProtectionContext().freshAdmission).toBe(old);
    reconnect.resolve();
    await settle();
    expect(real.student.readProtectionContext().freshAdmission).toBe(old);
    expect(real.reads()).toHaveLength(count);
    successor.resolve();
    await settle();
    expect(real.reads()).toHaveLength(count + 1);
    expect(real.student.readProtectionContext().freshAdmission).toBe(old);
    expect(h.coordinator.readView().protection.phase).toBe("locked");
    read.resolve();
    await refreshing;
    await settle();
    const fresh = real.student.readProtectionContext().freshAdmission;
    expect(fresh).not.toBe(old);
    expect(fresh?.sessionRevision).toBe(2);
    expect(real.record().lastReservedCounter).toBe(
      before.lastReservedCounter + 2,
    );
    expect(JSON.stringify(real.record().nativeProtection)).toBe(journal);
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.surface.detach).not.toHaveBeenCalled();
    expect(h.native.requestEnd).not.toHaveBeenCalled();
    expect(h.coordinator.readView().protection.phase).toBe("locked");
  });

  it("uses the real read-start sequence fence when a pre-begin read has exactly the same monotonic timestamp", async () => {
    const real = realStudent({ latency: 0 });
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    void engaging(h);
    await settle();
    const old = deferred();
    const newer = deferred();
    real.gateResponses("read", old.promise, newer.promise);
    const admission = real.student.readProtectionContext().admission;
    if (admission === null) throw new Error("expected real active admission");
    const earlier = real.student.readFreshAdmission(admission);
    await settle();
    const startedBeforeBegin =
      real.student.readProtectionContext().observationSequence;
    const before = real.reads().length;
    h.emit("did_begin", 2);
    await settle();
    expect(h.surface.attach).not.toHaveBeenCalled();
    old.resolve();
    await earlier;
    await settle();
    expect(real.reads()).toHaveLength(before + 1);
    expect(h.surface.attach).not.toHaveBeenCalled();
    newer.resolve();
    await settle();
    expect(
      real.student.readProtectionContext().freshAdmission?.observationSequence,
    ).toBeGreaterThan(startedBeforeBegin);
    expect(
      real.student.readProtectionContext().freshAdmission?.readStartedAt,
    ).toBe(0);
    expect(h.surface.attach).toHaveBeenCalledOnce();
  });

  it("records actual native end in the view before a blocked real terminal-journal write", async () => {
    const real = realStudent();
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    await locked(h);
    const terminal = deferred();
    real.holdWrite(
      (value) =>
        value.nativeProtection?.facts.some(
          (fact) => fact.slot === "native_terminal",
        ) === true,
      terminal.promise,
    );
    h.coordinator.requestLocalEnd("application_quit");
    await settle();
    h.emit("did_end", 5);
    expect(h.coordinator.readView().protection.nativeEndObserved).toBe(true);
    expect(h.displayed()).toBe(false);
    await settle();
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    expect(
      real
        .record()
        .nativeProtection?.facts.some(
          (fact) => fact.slot === "native_terminal",
        ),
    ).toBe(false);
    terminal.resolve();
    await settle();
    expect(h.coordinator.readView().protection).toMatchObject({
      nativeEndObserved: true,
      cleanup: "complete",
      phase: "ended",
    });
    expect(
      real
        .record()
        .nativeProtection?.facts.filter(
          (fact) => fact.slot === "native_terminal",
        ),
    ).toHaveLength(1);
    expect(
      real
        .record()
        .nativeProtection?.facts.filter((fact) => fact.slot === "cleanup"),
    ).toHaveLength(1);
  });

  it.each(["shutdown", "emergency"] as const)(
    "keeps final cleanup last when %s arrives while its real durable write is held",
    async (action) => {
      const real = realStudent();
      await real.initialize();
      const h = harness({ student: real.student, now: real.now });
      await locked(h);
      const cleanup = deferred();
      real.holdWrite(
        (value) =>
          value.nativeProtection?.latestAttempt?.cleanup === "complete",
        cleanup.promise,
      );
      // An unsolicited actual end has no failure or abandonment queued yet.
      h.emit("did_end", 7);
      await settle();
      expect(h.native.disposeAfterEnd).toHaveBeenCalledOnce();
      expect(h.coordinator.readView().protection.nativeEndObserved).toBe(true);
      expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
      expect(h.coordinator.hasRetainedAttempt()).toBe(true);
      let confirmation: Promise<void> | undefined;
      if (action === "shutdown") {
        expect(await h.coordinator.shutdown()).toBe("retained");
      } else {
        h.coordinator.reviewEmergency(
          h.coordinator.readView().revision,
          current,
        );
        confirmation = h.coordinator.confirmEmergency(
          h.coordinator.readView().revision,
          current,
        );
      }
      cleanup.resolve();
      await settle();
      await confirmation;
      await settle();
      const protection = real.record().nativeProtection;
      expect(protection?.latestAttempt).toMatchObject({
        phase: "ended",
        cleanup: "complete",
      });
      expect(protection?.facts.at(-1)?.slot).toBe("cleanup");
      expect(
        protection?.facts.filter((fact) => fact.slot === "cleanup"),
      ).toHaveLength(1);
      expect(
        protection?.facts.some(
          (fact) => fact.slot === "failure" || fact.slot === "abandoned",
        ),
      ).toBe(false);
      expect(h.coordinator.hasRetainedAttempt()).toBe(false);
      expect(h.coordinator.readView().protection).toMatchObject({
        phase: "ended",
        cleanup: "complete",
        emergencyReview: false,
      });
    },
  );

  it("persists fresh-process disposal through the real Student writer without inventing a native terminal event", async () => {
    const real = realStudent();
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    h.failNativeBegin();
    const cleanup = deferred();
    real.holdWrite(
      (value) =>
        value.nativeProtection?.latestAttempt?.nativeDisposition ===
        "disposed_without_terminal_observation",
      cleanup.promise,
    );
    const starting = h.coordinator.start(
      h.coordinator.readView().revision,
      current,
    );
    await settle();
    expect(h.native.disposeAfterEnd).toHaveBeenCalledOnce();
    expect(h.coordinator.hasRetainedAttempt()).toBe(true);
    expect(h.coordinator.readView().protection.cleanup).not.toBe("complete");
    expect(
      real
        .record()
        .nativeProtection?.facts.some(
          (fact) => fact.slot === "native_terminal" || fact.slot === "cleanup",
        ),
    ).toBe(false);
    cleanup.resolve();
    await starting;
    await settle();
    const protection = real.record().nativeProtection;
    expect(protection?.latestAttempt).toMatchObject({
      phase: "failed",
      nativeDisposition: "disposed_without_terminal_observation",
      cleanup: "complete",
    });
    expect(
      protection?.facts.filter((fact) => fact.slot === "cleanup"),
    ).toHaveLength(1);
    expect(protection?.facts.every((fact) => fact.nativeEvent === null)).toBe(
      true,
    );
    expect(
      protection?.facts.some((fact) => fact.slot === "native_terminal"),
    ).toBe(false);
    expect(h.coordinator.readView().protection).toMatchObject({
      phase: "failed",
      failure: "native_failure",
      nativeEndObserved: false,
      cleanup: "complete",
    });
    expect(h.coordinator.hasRetainedAttempt()).toBe(false);
    expect(h.surface.attach).not.toHaveBeenCalled();
  });

  it("real negative maintenance detaches before a throwing public listener and a later read cannot reattach", async () => {
    const real = realStudent();
    await real.initialize();
    const h = harness({ student: real.student, now: real.now });
    await locked(h);
    let observed = false;
    real.student.subscribe((view) => {
      if (view.phase !== "active") {
        observed = true;
        expect(h.displayed()).toBe(false);
        expect(h.native.requestEnd).toHaveBeenCalled();
        throw new Error("synthetic public listener failure");
      }
    });
    real.deny(true);
    await real.advance(15_000);
    await h.coordinator.refresh();
    await settle();
    expect(observed).toBe(true);
    expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
    real.deny(false);
    await real.advance(15_000);
    await h.coordinator.refresh();
    await settle();
    expect(h.surface.attach).toHaveBeenCalledOnce();
    expect(h.coordinator.readView().protection.calculatorVisible).toBe(false);
  });
});
