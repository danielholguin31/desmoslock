import { randomUUID } from "node:crypto";

import type { DesktopStudentView } from "../assessment-protection-view-state.js";
import type { CalculatorSurface } from "./calculator-surface.js";
import type {
  CleanupState,
  LocalEndCause,
  ProtectionCategories,
  ProtectionPhase,
} from "./assessment-protection-types.js";
import type {
  NativeAssessmentEvent,
  NativeProtectionAdapter,
} from "./native-protection-adapter.js";
import type {
  FreshStudentAdmission,
  PreflightReportReceipt,
  StudentAdmissionSnapshot,
  StudentSessionCoordinator,
} from "./student-session-coordinator.js";
import {
  protectionFactCapacity,
  protectionFactReservation,
  parseBootSessionId,
  type ProtectionTransition,
  type StoredNativeProtection,
} from "./student-session-store.js";

export interface AssessmentProtectionCoordinatorOptions {
  readonly student: StudentSessionCoordinator;
  readonly native: NativeProtectionAdapter;
  readonly prepareCalculator: () => Promise<CalculatorSurface>;
  readonly window: {
    prepare(): Promise<void>;
    isReady(): boolean;
    showRecovery(): void;
    restore(): Promise<void>;
  };
  readonly shortcuts: {
    register(listener: () => void): boolean;
    isRegistered(): boolean;
    unregister(): void;
  };
  readonly monotonicNow?: () => number;
  readonly attemptId?: () => string;
}
export interface AssessmentProtectionCoordinator {
  readView(): DesktopStudentView;
  subscribe(listener: (view: DesktopStudentView) => void): () => void;
  hasRetainedAttempt(): boolean;
  start(revision: number, isCurrent: () => boolean): Promise<void>;
  reviewEmergency(revision: number, isCurrent: () => boolean): void;
  cancelEmergency(revision: number, isCurrent: () => boolean): void;
  confirmEmergency(revision: number, isCurrent: () => boolean): Promise<void>;
  requestLocalEnd(cause: LocalEndCause): void;
  shutdown(): Promise<"complete" | "retained">;
  joinInitial(code: string, isCurrent: () => boolean): Promise<void>;
  beginTargetedReadmission(
    code: string,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<void>;
  retryPending(isCurrent: () => boolean): Promise<void>;
  refresh(): Promise<void>;
  forfeit(revision: number, isCurrent: () => boolean): Promise<void>;
}

type Command = ProtectionTransition extends infer T
  ? T extends ProtectionTransition
    ? Omit<T, "attemptId" | "expectedProtectionRevision">
    : never
  : never;
type Timer = ReturnType<typeof setTimeout>;
interface Attempt {
  readonly id: string;
  readonly admission: StudentAdmissionSnapshot | null;
  readonly isCurrent: () => boolean;
  readonly priorProcess: boolean;
  live: boolean;
  phase: ProtectionPhase;
  categories: ProtectionCategories;
  failure: LocalEndCause | null;
  cleanup: CleanupState;
  receipt: FreshStudentAdmission | null;
  reportReceipt: PreflightReportReceipt | null;
  preflightFailure: Extract<
    ProtectionTransition,
    { kind: "preflight_failure" }
  > | null;
  preflightWrite: Promise<boolean> | null;
  preflightWritePending: boolean;
  preflightCommitted: boolean;
  visible: boolean;
  startRunning: boolean;
  preparing: boolean;
  preparationFailed: boolean;
  engagingAttempted: boolean;
  engaged: boolean;
  nativeInvoked: boolean;
  beginFailed: boolean;
  nativeDisposed: boolean;
  lastSequence: number;
  beganSequence: number | null;
  terminal: Extract<
    NativeAssessmentEvent,
    { type: "did_end" | "failed_to_begin" }
  > | null;
  terminalCommitted: boolean;
  nativeEndObserved: boolean;
  endRequested: boolean;
  failureQueued: boolean;
  persistenceFailed: boolean;
  surface: CalculatorSurface | null;
  surfaceClose: Promise<boolean> | null;
  surfaceClosed: boolean;
  windowOwned: boolean;
  windowRestored: boolean;
  shortcutOwned: boolean;
  unsubscribeNative: (() => void) | null;
  unsubscribeApplications: (() => void) | null;
  observationTimer: Timer | null;
  lifecycleTimer: Timer | null;
  finalizing: Promise<void> | null;
  finalCommitStarted: boolean;
}
const confirmed = Object.freeze({ status: "confirmed", code: "none" } as const);
const pending = Object.freeze({ status: "pending", code: "none" } as const);
function initialCategories(): ProtectionCategories {
  return Object.freeze({
    aac: Object.freeze({ status: "pending", code: "awaiting_native_begin" }),
    shortcuts: pending,
    applications: pending,
    persistence: pending,
    windowNetwork: pending,
  });
}
function sameAdmission(
  a: StudentAdmissionSnapshot | null,
  b: StudentAdmissionSnapshot | null,
): boolean {
  if (
    a === null ||
    b === null ||
    a.admissionGeneration !== b.admissionGeneration
  )
    return false;
  return (
    a.scope.schoolId === b.scope.schoolId &&
    a.scope.testId === b.scope.testId &&
    a.scope.studentSessionId === b.scope.studentSessionId &&
    a.scope.deviceSessionId === b.scope.deviceSessionId &&
    a.scope.epoch === b.scope.epoch
  );
}
function callCurrent(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

export function createAssessmentProtectionCoordinator(
  options: AssessmentProtectionCoordinatorOptions,
): AssessmentProtectionCoordinator {
  const now = options.monotonicNow ?? (() => performance.now());
  const newAttemptId = options.attemptId ?? randomUUID;
  const listeners = new Set<(view: DesktopStudentView) => void>();
  let studentView = options.student.readView();
  let protection: Readonly<StoredNativeProtection> | null = null;
  let delivery: "none" | "pending" | "acknowledged" | "blocked" = "none";
  let unreadableRecovery = false;
  let writeUncertain = false;
  let bootRecoveryWork: Promise<void> | null = null;
  let attempt: Attempt | null = null;
  let review: {
    readonly attempt: Attempt;
    readonly studentRevision: number;
    readonly admission: StudentAdmissionSnapshot | null;
  } | null = null;
  let stopping = false;
  let disposed = false;
  let studentDispose: Promise<boolean> | null = null;
  let transitionTail: Promise<void> = Promise.resolve();
  let lastProtection: DesktopStudentView["protection"] = Object.freeze({
    phase: "idle",
    categories: initialCategories(),
    calculatorVisible: false,
    failure: null,
    nativeEndObserved: false,
    cleanup: "not_requested",
    evidence: "none",
    emergencyReview: false,
  });
  let view: DesktopStudentView = Object.freeze({
    revision: 1,
    admission: Object.freeze({
      phase: studentView.phase,
      session: studentView.session,
      pendingOperation: studentView.pendingOperation,
    }),
    protection: lastProtection,
  });

  function localRecoveryBlocked(): boolean {
    return unreadableRecovery || writeUncertain;
  }
  function publish(): void {
    if (disposed) return;
    const t = attempt;
    const evidence: DesktopStudentView["protection"]["evidence"] =
      t?.persistenceFailed
        ? "unconfirmed"
        : (protection?.facts.length ?? 0) >
            protectionFactCapacity - protectionFactReservation
          ? "full"
          : (protection?.facts.length ?? 0) > 0
            ? delivery === "acknowledged" || delivery === "blocked"
              ? delivery
              : "queued"
            : "none";
    const projected: DesktopStudentView["protection"] =
      t === null
        ? localRecoveryBlocked()
          ? {
              phase: "recovery_required",
              categories: Object.freeze({
                ...initialCategories(),
                persistence: Object.freeze({
                  status: "unavailable",
                  code: "durability_unavailable",
                }),
              }),
              calculatorVisible: false,
              failure: "persistence_unavailable",
              nativeEndObserved: false,
              cleanup: "unconfirmed",
              evidence: "unconfirmed",
              emergencyReview: false,
            }
          : { ...lastProtection, evidence, emergencyReview: false }
        : {
            phase: t.phase,
            categories: t.categories,
            calculatorVisible: t.visible,
            failure: t.failure,
            nativeEndObserved: t.nativeEndObserved,
            cleanup: t.cleanup,
            evidence,
            emergencyReview: review?.attempt === t,
          };
    const admission = Object.freeze({
      phase: studentView.phase,
      session: studentView.session,
      pendingOperation: studentView.pendingOperation,
    });
    if (
      JSON.stringify({ admission, protection: projected }) ===
      JSON.stringify({ admission: view.admission, protection: view.protection })
    )
      return;
    if (view.revision === Number.MAX_SAFE_INTEGER) {
      if (t?.live) requestLocalEnd("renderer_lost");
      return;
    }
    view = Object.freeze({
      revision: view.revision + 1,
      admission,
      protection: Object.freeze(projected),
    });
    let listenerFailed = false;
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        listenerFailed = true;
      }
    }
    if (listenerFailed && attempt?.live) requestLocalEnd("renderer_lost");
  }
  function trusted(
    revision: number,
    current: () => boolean,
    allowStopping = false,
  ): boolean {
    return (
      (!stopping || allowStopping) &&
      !disposed &&
      Number.isSafeInteger(revision) &&
      revision === view.revision &&
      callCurrent(current) &&
      revision === view.revision
    );
  }
  function currentAttempt(t: Attempt): boolean {
    return (
      attempt === t &&
      t.live &&
      !disposed &&
      callCurrent(t.isCurrent) &&
      attempt === t &&
      t.live
    );
  }
  function setCategory(
    t: Attempt,
    key: keyof ProtectionCategories,
    value: ProtectionCategories[typeof key],
  ): void {
    t.categories = Object.freeze({
      ...t.categories,
      [key]: Object.freeze(value),
    });
  }
  function clearTimers(t: Attempt): void {
    if (t.observationTimer !== null) clearTimeout(t.observationTimer);
    if (t.lifecycleTimer !== null) clearTimeout(t.lifecycleTimer);
    t.observationTimer = null;
    t.lifecycleTimer = null;
  }
  function armObservation(t: Attempt, receipt: FreshStudentAdmission): void {
    if (t.observationTimer !== null) clearTimeout(t.observationTimer);
    const deadline = Math.min(
      receipt.capabilityDeadline,
      receipt.observationDeadline,
      receipt.readStartedAt + 30_000,
    );
    const expire = (): void => {
      if (attempt !== t || !t.live || t.receipt !== receipt || disposed) return;
      if (!callCurrent(t.isCurrent)) {
        requestLocalEnd("window_lost");
        return;
      }
      if (now() < deadline) {
        t.observationTimer = setTimeout(expire, deadline - now());
        t.observationTimer.unref?.();
        return;
      }
      requestLocalEnd(
        now() >= receipt.capabilityDeadline
          ? "capability_expired"
          : "observation_timeout",
      );
    };
    t.observationTimer = setTimeout(expire, Math.max(0, deadline - now()));
    t.observationTimer.unref?.();
  }
  function armLifecycle(t: Attempt, stage: "begin" | "end"): void {
    if (t.lifecycleTimer !== null) clearTimeout(t.lifecycleTimer);
    t.lifecycleTimer = setTimeout(() => {
      t.lifecycleTimer = null;
      if (attempt !== t || t.terminal !== null || t.nativeDisposed) return;
      if (stage === "begin") requestLocalEnd("observation_timeout");
      else {
        t.failure ??= "observation_timeout";
        t.phase = "recovery_required";
        t.cleanup = "unconfirmed";
        queueFailure(t);
        publish();
      }
    }, 15_000);
    t.lifecycleTimer.unref?.();
  }
  function markPersistenceFailure(t: Attempt): void {
    t.persistenceFailed = true;
    t.failure ??= "persistence_unavailable";
    setCategory(t, "persistence", {
      status: "unavailable",
      code: "durability_unavailable",
    });
    if (!t.live) {
      t.phase = "recovery_required";
      t.cleanup = "unconfirmed";
    }
    publish();
  }
  function enqueue(t: Attempt, command: () => Command): Promise<boolean> {
    // A reconstructed attempt owns no local lifecycle callbacks. Its history
    // can change only through the separate boot-recovery writer command.
    if (t.priorProcess) return Promise.resolve(false);
    let result = false;
    const work = transitionTail.then(async () => {
      if (attempt !== t || disposed) return;
      const body = command();
      if (
        (body.kind === "engaging" || body.kind === "locked") &&
        !currentAttempt(t)
      )
        return;
      try {
        const before = options.student.readProtectionContext();
        protection = before.protection;
        delivery = before.delivery;
        const outcome = await options.student.commitProtectionTransition({
          ...body,
          attemptId: t.id,
          expectedProtectionRevision: protection?.revision ?? 0,
        } as ProtectionTransition);
        const after = options.student.readProtectionContext();
        protection = after.protection;
        delivery = after.delivery;
        t.engaged ||= protection?.latestAttempt?.attemptId === t.id;
        if (outcome.status !== "committed") {
          markPersistenceFailure(t);
          return;
        }
        result = true;
      } catch {
        markPersistenceFailure(t);
      }
    });
    transitionTail = work.catch(() => {
      markPersistenceFailure(t);
    });
    return transitionTail.then(() => result);
  }
  function queueFailure(t: Attempt): void {
    if (t.failureQueued || t.failure === null) return;
    if (!t.engagingAttempted) {
      if (
        t.reportReceipt === null ||
        t.nativeInvoked ||
        t.lastSequence !== 0 ||
        t.terminal !== null ||
        (t.failure !== "application_policy" &&
          t.failure !== "shortcut_unavailable")
      )
        return;
      t.failureQueued = true;
      t.preflightFailure = Object.freeze({
        kind: "preflight_failure",
        receipt: t.reportReceipt,
        attemptId: t.id,
        expectedProtectionRevision: protection?.revision ?? 0,
        cause: t.failure,
        categories: t.categories,
      });
      writePreflightFailure(t);
      return;
    }
    t.failureQueued = true;
    const cause = t.failure;
    void enqueue(t, () => ({ kind: "failure", cause }));
  }
  function writePreflightFailure(t: Attempt): void {
    if (
      t.preflightFailure === null ||
      t.preflightWritePending ||
      t.preflightCommitted
    )
      return;
    t.preflightWritePending = true;
    const command = t.preflightFailure;
    // This is the first journal command for this attempt. Invoke the Student
    // owner now so it marks the original report reservation before any observer
    // can reenter or identity replacement can wait behind its durable writer.
    t.preflightWrite = (async () => {
      try {
        const outcome =
          await options.student.commitProtectionTransition(command);
        const context = options.student.readProtectionContext();
        protection = context.protection;
        delivery = context.delivery;
        if (outcome.status !== "committed") {
          markPersistenceFailure(t);
          return false;
        }
        t.preflightCommitted = true;
        return true;
      } catch {
        markPersistenceFailure(t);
        return false;
      } finally {
        t.preflightWritePending = false;
      }
    })();
    transitionTail = t.preflightWrite.then(() => undefined);
  }
  function applicationFailure(t: Attempt, blocked = false): false {
    if (!currentAttempt(t)) return false;
    setCategory(t, "applications", {
      status: blocked ? "failed" : "unavailable",
      code: blocked
        ? "prohibited_application"
        : "application_observation_unavailable",
    });
    requestLocalEnd("application_policy");
    return false;
  }
  function checkApplications(t: Attempt): boolean {
    try {
      const status = options.native.readApplicationStatus().status;
      if (!currentAttempt(t)) return false;
      if (status !== "clear")
        return applicationFailure(t, status === "blocked");
      setCategory(t, "applications", confirmed);
      return true;
    } catch {
      return applicationFailure(t);
    }
  }
  function shortcutFailure(t: Attempt): false {
    if (!currentAttempt(t)) return false;
    setCategory(t, "shortcuts", {
      status: "unavailable",
      code: "emergency_shortcut_unavailable",
    });
    requestLocalEnd("shortcut_unavailable");
    return false;
  }
  function checkShortcut(t: Attempt): boolean {
    if (!currentAttempt(t)) return false;
    try {
      if (!t.shortcutOwned || !options.shortcuts.isRegistered())
        return shortcutFailure(t);
      if (!currentAttempt(t)) return false;
      setCategory(t, "shortcuts", confirmed);
      return true;
    } catch {
      return shortcutFailure(t);
    }
  }
  function hide(t: Attempt): void {
    t.live = false;
    t.visible = false;
    if (t.observationTimer !== null) clearTimeout(t.observationTimer);
    t.observationTimer = null;
    if (t.surface === null) {
      t.surfaceClosed = !t.preparing && !t.preparationFailed;
      return;
    }
    if (t.surfaceClose !== null) return;
    let detached = true;
    try {
      t.surface.detach();
    } catch {
      detached = false;
    }
    // close() requests destruction immediately; its cleanup promise must confirm
    // actual destruction before this owner can present recovery or dispose.
    try {
      const close = t.surface.close();
      t.surfaceClose = Promise.resolve(close).then(
        () => {
          t.surfaceClosed = true;
          return true;
        },
        () => {
          t.surfaceClosed = false;
          return false;
        },
      );
    } catch {
      t.surfaceClose = Promise.resolve(false);
      t.surfaceClosed = false;
    }
    if (!detached) t.cleanup = "unconfirmed";
    void t.surfaceClose.then((closed) => {
      if (attempt !== t) return;
      if (!closed) {
        t.cleanup = "unconfirmed";
        t.phase = "recovery_required";
      } else {
        try {
          options.window.showRecovery();
        } catch {
          t.cleanup = "unconfirmed";
        }
      }
      publish();
    });
  }
  function requestLocalEnd(cause: LocalEndCause): void {
    const t = attempt;
    if (t === null || disposed || t.finalCommitStarted) return;
    t.failure ??= cause;
    // Capture the first observed preflight report before even synchronous owned
    // containment callbacks can reenter. The writer returns a promise; local
    // containment and native end still do not wait for persistence.
    if (!t.engagingAttempted) queueFailure(t);
    t.phase = t.priorProcess ? "recovery_required" : "ending";
    t.cleanup = t.priorProcess ? "unconfirmed" : "pending";
    hide(t);
    // Queueing is inert until the next microtask. This preserves event order if
    // requestEnd delivers did_end synchronously, while native end still precedes disk.
    if (!t.endRequested && t.engagingAttempted && t.terminal === null) {
      void enqueue(t, () => ({ kind: "ending", cause }));
    }
    if (!t.endRequested) {
      t.endRequested = true;
      if (t.nativeInvoked && t.terminal === null && !t.priorProcess) {
        try {
          options.native.requestEnd(t.id);
        } catch {
          t.cleanup = "unconfirmed";
        }
        if (t.terminal === null) armLifecycle(t, "end");
      }
    }
    queueFailure(t);
    publish();
    void finalize(t);
  }
  function localGate(
    t: Attempt,
    receipt: FreshStudentAdmission,
    active: boolean,
    use: "grant" | "sustain" = "grant",
  ): boolean {
    if (!currentAttempt(t) || !sameAdmission(t.admission, receipt))
      return false;
    if (
      !options.student.isCurrentAdmission(receipt, use) ||
      now() >=
        Math.min(
          receipt.observationDeadline,
          receipt.capabilityDeadline,
          receipt.readStartedAt + 30_000,
        )
    )
      return false;
    if (!checkApplications(t) || !checkShortcut(t)) return false;
    try {
      if (!options.window.isReady() || t.surface === null) {
        setCategory(t, "windowNetwork", {
          status: "unavailable",
          code: "window_unavailable",
        });
        requestLocalEnd("window_lost");
        return false;
      }
      setCategory(t, "windowNetwork", confirmed);
      if (
        active &&
        (t.beganSequence === null ||
          !options.native.isAttemptActive(t.id, t.beganSequence))
      ) {
        setCategory(t, "aac", {
          status: "unavailable",
          code: "native_inactive",
        });
        requestLocalEnd("native_failure");
        return false;
      }
      return (
        currentAttempt(t) &&
        options.student.isCurrentAdmission(receipt, use) &&
        t.live
      );
    } catch {
      requestLocalEnd("native_failure");
      return false;
    }
  }
  function checkReceipt(t: Attempt, receipt: FreshStudentAdmission): boolean {
    if (
      !currentAttempt(t) ||
      !sameAdmission(t.admission, receipt) ||
      !options.student.isCurrentAdmission(receipt)
    ) {
      if (t.live) requestLocalEnd("admission_changed");
      return false;
    }
    return true;
  }
  async function began(
    t: Attempt,
    event: Extract<NativeAssessmentEvent, { type: "did_begin" }>,
    fence: number,
  ): Promise<void> {
    if (!(await enqueue(t, () => ({ kind: "began", event })))) {
      requestLocalEnd("persistence_unavailable");
      return;
    }
    if (!currentAttempt(t)) {
      if (attempt === t && t.live) requestLocalEnd("window_lost");
      return;
    }
    if (!options.native.isAttemptActive(t.id, event.sequence)) {
      requestLocalEnd("native_failure");
      return;
    }
    const expected = options.student.readProtectionContext().admission;
    if (!sameAdmission(t.admission, expected) || expected === null) {
      requestLocalEnd("admission_changed");
      return;
    }
    const fresh = await options.student.readFreshAdmission(expected, fence);
    if (!currentAttempt(t)) {
      if (attempt === t && t.live) requestLocalEnd("window_lost");
      return;
    }
    if (
      fresh.status !== "fresh" ||
      fresh.authority.observationSequence <= fence ||
      !checkReceipt(t, fresh.authority)
    ) {
      requestLocalEnd("backend_unavailable");
      return;
    }
    t.receipt = fresh.authority;
    armObservation(t, fresh.authority);
    if (!localGate(t, fresh.authority, true)) {
      if (t.live) requestLocalEnd("admission_changed");
      return;
    }
    setCategory(t, "aac", confirmed);
    setCategory(t, "persistence", confirmed);
    const authority = fresh.authority;
    if (
      !(await enqueue(t, () => ({
        kind: "locked",
        authority,
        nativeSequence: event.sequence,
        categories: t.categories,
      })))
    ) {
      requestLocalEnd("persistence_unavailable");
      return;
    }
    // No await or public listener occurs between this final private fence and attach.
    if (!localGate(t, authority, true)) {
      if (t.live) requestLocalEnd("admission_changed");
      return;
    }
    t.surface!.attach();
    if (!currentAttempt(t)) {
      if (attempt === t) requestLocalEnd("window_lost");
      return;
    }
    t.visible = true;
    t.phase = "locked";
    t.cleanup = "not_requested";
    publish();
  }
  function nativeEvent(t: Attempt, event: NativeAssessmentEvent): void {
    if (attempt !== t || t.priorProcess || event.attemptId !== t.id || disposed)
      return;
    if (!t.nativeInvoked) {
      requestLocalEnd("native_failure");
      return;
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      requestLocalEnd("native_failure");
      return;
    }
    if (event.sequence <= t.lastSequence || t.terminal !== null) return;
    t.lastSequence = event.sequence;
    if (event.type === "did_begin") {
      const fence = options.student.readProtectionContext().observationSequence;
      t.beganSequence = event.sequence;
      if (t.live) {
        if (t.lifecycleTimer !== null) clearTimeout(t.lifecycleTimer);
        t.lifecycleTimer = null;
      } else if (t.lifecycleTimer === null) armLifecycle(t, "end");
      void began(t, event, fence).catch(() =>
        requestLocalEnd("native_failure"),
      );
    } else if (event.type === "interrupted") {
      requestLocalEnd("native_interrupted");
    } else {
      t.terminal = event;
      t.nativeEndObserved = event.type === "did_end";
      if (event.type === "failed_to_begin") t.failure ??= "native_failure";
      clearTimers(t);
      hide(t);
      t.phase = "ending";
      t.cleanup = "pending";
      // Local end evidence and containment are immediate even with a held writer.
      publish();
      void finalize(t);
    }
  }
  async function finalize(t: Attempt): Promise<void> {
    if (
      attempt !== t ||
      t.live ||
      t.priorProcess ||
      t.startRunning ||
      t.preparing
    )
      return;
    if (t.finalizing !== null) return t.finalizing;
    const work = async (): Promise<void> => {
      if (t.terminal === null && t.nativeInvoked && !t.beginFailed) return;
      if (t.preflightWrite !== null && !(await t.preflightWrite)) return;
      if (t.terminal !== null && !t.terminalCommitted) {
        const event = t.terminal;
        t.terminalCommitted = await enqueue(t, () => ({
          kind: "native_terminal",
          event,
        }));
        if (!t.terminalCommitted) return;
      }
      if (t.surfaceClose !== null && !(await t.surfaceClose)) {
        t.phase = "recovery_required";
        t.cleanup = "unconfirmed";
        publish();
        return;
      }
      if (!t.surfaceClosed) {
        t.phase = "recovery_required";
        t.cleanup = "unconfirmed";
        publish();
        return;
      }
      if (!t.nativeDisposed) {
        try {
          options.native.disposeAfterEnd();
          t.nativeDisposed = true;
        } catch {
          t.phase = "recovery_required";
          t.cleanup = "unconfirmed";
          publish();
          return;
        }
      }
      clearTimers(t);
      let clean = true;
      for (const key of [
        "unsubscribeNative",
        "unsubscribeApplications",
      ] as const) {
        const unsubscribe = t[key];
        if (unsubscribe !== null) {
          try {
            unsubscribe();
            t[key] = null;
          } catch {
            clean = false;
          }
        }
      }
      if (t.shortcutOwned) {
        try {
          options.shortcuts.unregister();
          t.shortcutOwned = false;
        } catch {
          clean = false;
        }
      }
      if (t.windowOwned && !t.windowRestored) {
        try {
          await options.window.restore();
          t.windowRestored = true;
        } catch {
          clean = false;
        }
      }
      if (!clean) {
        t.phase = "recovery_required";
        t.cleanup = "unconfirmed";
        publish();
        return;
      }
      // Physical containment and every owned restoration have completed. Close
      // command admission before the final durable fact so a late quit or
      // emergency cannot append uncertainty after cleanup and recreate ownership.
      t.finalCommitStarted = true;
      if (review?.attempt === t) review = null;
      publish();
      if (t.engagingAttempted || t.preflightCommitted) {
        const committed =
          t.terminal !== null
            ? await enqueue(t, () => ({ kind: "cleanup", outcome: "complete" }))
            : await enqueue(t, () => ({
                kind: "disposed_without_terminal_observation",
              }));
        if (!committed) return;
      }
      if (t.reportReceipt !== null && t.preflightFailure === null) {
        options.student.releasePreflightReport(t.reportReceipt);
        t.reportReceipt = null;
      }
      t.cleanup = "complete";
      t.phase = t.nativeEndObserved ? "ended" : "failed";
      t.persistenceFailed = false;
      lastProtection = Object.freeze({
        phase: t.phase,
        categories: t.categories,
        calculatorVisible: false,
        failure: t.failure,
        nativeEndObserved: t.nativeEndObserved,
        cleanup: "complete",
        evidence: (protection?.facts.length ?? 0) > 0 ? "queued" : "none",
        emergencyReview: false,
      });
      if (review?.attempt === t) review = null;
      if (attempt === t) attempt = null;
      publish();
    };
    t.finalizing = work()
      .catch(() => {
        t.phase = "recovery_required";
        t.cleanup = "unconfirmed";
        publish();
      })
      .finally(() => {
        t.finalizing = null;
      });
    return t.finalizing;
  }
  function makeAttempt(
    id: string,
    admission: StudentAdmissionSnapshot | null,
    current: () => boolean,
    priorProcess = false,
  ): Attempt {
    return {
      id,
      admission,
      isCurrent: current,
      priorProcess,
      live: !priorProcess,
      phase: priorProcess ? "recovery_required" : "preflight",
      categories: initialCategories(),
      failure: priorProcess ? "native_failure" : null,
      cleanup: priorProcess ? "unconfirmed" : "not_requested",
      receipt: null,
      reportReceipt: null,
      preflightFailure: null,
      preflightWrite: null,
      preflightWritePending: false,
      preflightCommitted: false,
      visible: false,
      startRunning: false,
      preparing: false,
      preparationFailed: false,
      engagingAttempted: priorProcess,
      engaged: priorProcess,
      nativeInvoked: false,
      beginFailed: false,
      nativeDisposed: false,
      lastSequence: 0,
      beganSequence: null,
      terminal: null,
      terminalCommitted: false,
      nativeEndObserved: false,
      endRequested: false,
      failureQueued: false,
      persistenceFailed: false,
      surface: null,
      surfaceClose: null,
      surfaceClosed: true,
      windowOwned: false,
      windowRestored: false,
      shortcutOwned: false,
      unsubscribeNative: null,
      unsubscribeApplications: null,
      observationTimer: null,
      lifecycleTimer: null,
      finalizing: null,
      finalCommitStarted: false,
    };
  }
  function synchronizeContext(releasePriorBoot = false): void {
    const context = options.student.readProtectionContext();
    protection = context.protection;
    delivery = context.delivery;
    // Student owns exact preimage/postimage reconciliation. Temporary load or
    // write unavailability blocks only while that uncertainty remains current;
    // rejected or mismatched records retain an irreversible local barrier.
    writeUncertain = context.bootRecovery.status === "write_uncertain";
    if (
      context.bootRecovery.status === "record_rejected" ||
      (studentView.phase === "recovery_required" && protection === null)
    )
      unreadableRecovery = true;
    const latest = protection?.latestAttempt;
    const recovered =
      !localRecoveryBlocked() &&
      context.maySupersedeLatest &&
      context.bootRecovery.status === "prior_boot_recovery_observed" &&
      context.bootRecovery.attemptId === latest?.attemptId;
    if (
      releasePriorBoot &&
      bootRecoveryWork === null &&
      recovered &&
      attempt?.priorProcess &&
      attempt.id === latest?.attemptId
    ) {
      attempt = null;
      review = null;
    }
    const first =
      latest === undefined || latest === null
        ? undefined
        : protection?.facts.find((fact) => fact.attemptId === latest.attemptId);
    if (attempt === null && recovered) {
      // This is current eligibility, never historical cleanup or an AAC end.
      lastProtection = Object.freeze({
        phase: "idle",
        categories: initialCategories(),
        failure: null,
        calculatorVisible: false,
        nativeEndObserved: false,
        cleanup: "not_requested",
        evidence: "queued",
        emergencyReview: false,
      });
    } else if (
      attempt === null &&
      latest != null &&
      latest.cleanup !== "complete"
    ) {
      attempt = makeAttempt(
        latest.attemptId,
        context.admission,
        () => true,
        true,
      );
      if (first?.slot === "failure" && first.cause !== "none") {
        attempt.categories = first.categories;
        attempt.failure = first.cause;
      }
      // Only reconstruction starts an automatic comparison. Delivery-only
      // publications cannot repeatedly retry a retained prior-process attempt.
      void recoverPriorBoot();
    } else if (
      attempt === null &&
      latest?.cleanup === "complete" &&
      first?.slot === "failure" &&
      first.cause !== "none"
    ) {
      // Historical client report only. Cleanup permits a fresh explicit Start;
      // neither the original admission nor native engagement is restored here.
      lastProtection = Object.freeze({
        phase: "failed",
        categories: first.categories,
        failure: first.cause,
        calculatorVisible: false,
        nativeEndObserved: false,
        cleanup: "complete",
        evidence: "queued",
        emergencyReview: false,
      });
    }
  }
  function recoverPriorBoot(): Promise<void> {
    if (bootRecoveryWork !== null) return bootRecoveryWork;
    let recoveredAttempt: Attempt | null = null;
    // Reserve before invoking Student: its durable commit may synchronously
    // publish the new context before the returned promise acknowledges it.
    bootRecoveryWork = Promise.resolve()
      .then(async () => {
        const t = attempt;
        if (
          disposed ||
          stopping ||
          localRecoveryBlocked() ||
          t === null ||
          !t.priorProcess
        )
          return;
        const context = options.student.readProtectionContext();
        const recovery = context.bootRecovery;
        if (
          recovery.status === "prior_boot_recovery_observed" &&
          recovery.attemptId === t.id &&
          context.maySupersedeLatest
        ) {
          recoveredAttempt = t;
          return;
        }
        if (
          recovery.status !== "prior_process" ||
          recovery.attemptId !== t.id ||
          context.protection?.latestAttempt?.attemptId !== t.id ||
          context.protection.revision !== recovery.expectedProtectionRevision ||
          parseBootSessionId(recovery.engagingBootSessionId) === null
        )
          return;
        const observedBootSessionId = parseBootSessionId(
          options.native.readBootSessionId(),
        );
        if (
          observedBootSessionId === null ||
          observedBootSessionId === recovery.engagingBootSessionId
        )
          return;
        const current = options.student.readProtectionContext().bootRecovery;
        if (
          disposed ||
          stopping ||
          localRecoveryBlocked() ||
          attempt !== t ||
          current.status !== "prior_process" ||
          current.attemptId !== recovery.attemptId ||
          current.expectedProtectionRevision !==
            recovery.expectedProtectionRevision ||
          current.engagingBootSessionId !== recovery.engagingBootSessionId
        )
          return;
        const outcome = await options.student.commitBootRecovery({
          attemptId: recovery.attemptId,
          expectedProtectionRevision: recovery.expectedProtectionRevision,
          observedBootSessionId,
        });
        const after = options.student.readProtectionContext();
        if (
          outcome.status === "committed" &&
          after.maySupersedeLatest &&
          after.protection?.revision === outcome.protectionRevision &&
          after.bootRecovery.status === "prior_boot_recovery_observed" &&
          after.bootRecovery.attemptId === t.id
        )
          recoveredAttempt = t;
      })
      .catch(() => {
        // An unavailable read or write retains exactly the existing barrier.
      })
      .finally(() => {
        bootRecoveryWork = null;
        if (
          !disposed &&
          recoveredAttempt !== null &&
          attempt === recoveredAttempt
        ) {
          try {
            synchronizeContext(true);
          } catch {
            unreadableRecovery = true;
          }
          publish();
        }
      });
    return bootRecoveryWork;
  }
  const unsubscribeObservation = options.student.subscribeAdmissionObservation(
    (observation) => {
      const t = attempt;
      if (t === null || !t.live) return;
      if (observation.status === "invalidated") {
        requestLocalEnd("admission_changed");
        return;
      }
      if (t.phase !== "locked") return;
      try {
        if (!localGate(t, observation.authority, true, "sustain")) {
          if (t.live) requestLocalEnd("admission_changed");
          return;
        }
        t.receipt = observation.authority;
        armObservation(t, observation.authority);
        // The existing maintenance owner already did the read and durable write.
        // Adopting its issuer-bound receipt neither polls nor journals nor reattaches.
      } catch {
        requestLocalEnd("backend_unavailable");
      }
    },
  );
  const unsubscribeStudent = options.student.subscribe((next) => {
    studentView = next;
    try {
      synchronizeContext();
    } catch {
      if (attempt?.live) requestLocalEnd("persistence_unavailable");
    }
    publish();
  });
  synchronizeContext();
  publish();

  async function start(
    revision: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      !trusted(revision, isCurrent) ||
      attempt !== null ||
      localRecoveryBlocked()
    )
      return;
    const context = options.student.readProtectionContext();
    const admission = context.admission;
    protection = context.protection;
    if (
      !trusted(revision, isCurrent) ||
      admission === null ||
      !context.maySupersedeLatest ||
      studentView.phase !== "active" ||
      (protection?.facts.length ?? 0) >
        protectionFactCapacity - protectionFactReservation
    ) {
      publish();
      return;
    }
    const id = newAttemptId();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        id,
      )
    )
      return;
    const t = makeAttempt(id, admission, isCurrent);
    attempt = t;
    t.startRunning = true;
    publish();
    try {
      const fresh = await options.student.readFreshAdmission(admission);
      if (fresh.status !== "fresh" || !checkReceipt(t, fresh.authority)) {
        requestLocalEnd("backend_unavailable");
        return;
      }
      t.receipt = fresh.authority;
      armObservation(t, fresh.authority);
      t.reportReceipt = options.student.reservePreflightReport(
        fresh.authority,
        t.id,
      );
      if (t.reportReceipt === null) {
        setCategory(t, "persistence", {
          status: "unavailable",
          code: "durability_unavailable",
        });
        requestLocalEnd("persistence_unavailable");
        return;
      }
      t.unsubscribeNative = options.native.subscribe((event) => {
        try {
          nativeEvent(t, event);
        } catch {
          requestLocalEnd("native_failure");
        }
      });
      try {
        t.unsubscribeApplications = options.native.observeApplicationStatus(
          (value) => {
            if (currentAttempt(t) && value.status !== "clear")
              applicationFailure(t, value.status === "blocked");
          },
        );
      } catch {
        applicationFailure(t);
        return;
      }
      if (!currentAttempt(t)) return;
      if (!options.native.inspectSupport().available) {
        setCategory(t, "aac", {
          status: "unavailable",
          code: "native_unavailable",
        });
        requestLocalEnd("native_failure");
        return;
      }
      if (!checkApplications(t)) return;
      try {
        t.shortcutOwned = options.shortcuts.register(() => {
          if (attempt === t) reviewEmergency(view.revision, () => true);
        });
      } catch {
        shortcutFailure(t);
        return;
      }
      if (!checkShortcut(t)) return;
      if (!checkReceipt(t, fresh.authority)) return;
      t.windowOwned = true;
      await options.window.prepare();
      if (!checkReceipt(t, fresh.authority)) return;
      t.preparing = true;
      t.surfaceClosed = false;
      try {
        t.surface = await options.prepareCalculator();
      } catch (error) {
        t.preparationFailed = true;
        throw error;
      } finally {
        t.preparing = false;
      }
      if (!checkReceipt(t, fresh.authority)) {
        hide(t);
        return;
      }
      if (!localGate(t, fresh.authority, false)) return;
      const engagingBootSessionId = parseBootSessionId(
        options.native.readBootSessionId(),
      );
      if (engagingBootSessionId === null)
        throw new Error("Boot session unavailable");
      if (!localGate(t, fresh.authority, false)) return;
      setCategory(t, "persistence", confirmed);
      t.engagingAttempted = true;
      if (
        !(await enqueue(t, () => ({
          kind: "engaging",
          engagingBootSessionId,
          authority: fresh.authority,
          categories: t.categories,
        })))
      ) {
        requestLocalEnd("persistence_unavailable");
        return;
      }
      t.engaged = true;
      if (!localGate(t, fresh.authority, false)) {
        if (t.live) requestLocalEnd("admission_changed");
        return;
      }
      t.phase = "engaging";
      publish();
      if (!localGate(t, fresh.authority, false)) {
        if (t.live) requestLocalEnd("admission_changed");
        return;
      }
      t.nativeInvoked = true;
      try {
        options.native.begin(t.id);
      } catch {
        t.beginFailed = true;
        throw new Error("Native begin failed");
      }
      if (t.beganSequence === null && t.live) armLifecycle(t, "begin");
    } catch {
      requestLocalEnd("native_failure");
    } finally {
      t.startRunning = false;
      if (!t.live) void finalize(t);
    }
  }
  function reviewEmergency(revision: number, isCurrent: () => boolean): void {
    if (
      !trusted(revision, isCurrent, true) ||
      attempt === null ||
      attempt.finalCommitStarted
    )
      return;
    const t = attempt;
    const context = options.student.readProtectionContext();
    const underlyingRevision = options.student.readView().revision;
    if (!trusted(revision, isCurrent, true) || attempt !== t) return;
    review = Object.freeze({
      attempt: t,
      studentRevision: underlyingRevision,
      admission: context.admission,
    });
    publish();
  }
  async function confirmEmergency(
    revision: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      !trusted(revision, isCurrent, true) ||
      review === null ||
      review.attempt !== attempt ||
      review.attempt.finalCommitStarted
    )
      return;
    const captured = review;
    review = null;
    requestLocalEnd("emergency_abandonment");
    const t = captured.attempt;
    if (t.engagingAttempted)
      void enqueue(t, () => ({
        kind: "abandoned",
        cause: "emergency_abandonment",
      }));
    // Only the original same admission and underlying Student revision may be
    // forfeited. The composed revision and replacement identities never forward.
    if (
      callCurrent(isCurrent) &&
      sameAdmission(
        captured.admission,
        options.student.readProtectionContext().admission,
      ) &&
      options.student.readView().revision === captured.studentRevision
    ) {
      await options.student.forfeit(captured.studentRevision);
    }
    publish();
  }
  return Object.freeze({
    readView: () => view,
    subscribe(listener: (snapshot: DesktopStudentView) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasRetainedAttempt: () =>
      attempt !== null || localRecoveryBlocked() || bootRecoveryWork !== null,
    start,
    reviewEmergency,
    confirmEmergency,
    requestLocalEnd,
    cancelEmergency(revision: number, isCurrent: () => boolean) {
      if (trusted(revision, isCurrent, true) && review?.attempt === attempt) {
        review = null;
        publish();
      }
    },
    async joinInitial(code: string, isCurrent: () => boolean) {
      if (
        stopping ||
        localRecoveryBlocked() ||
        attempt !== null ||
        !callCurrent(isCurrent) ||
        !options.student.readProtectionContext().maySupersedeLatest
      )
        return;
      const capturedRevision = options.student.readView().revision;
      if (
        !callCurrent(isCurrent) ||
        attempt !== null ||
        localRecoveryBlocked() ||
        !options.student.readProtectionContext().maySupersedeLatest ||
        capturedRevision !== options.student.readView().revision
      )
        return;
      await options.student.joinInitial(code);
    },
    async beginTargetedReadmission(
      code: string,
      revision: number,
      isCurrent: () => boolean,
    ) {
      if (
        !trusted(revision, isCurrent) ||
        localRecoveryBlocked() ||
        attempt !== null ||
        !options.student.readProtectionContext().maySupersedeLatest
      )
        return;
      const capturedRevision = options.student.readView().revision;
      const capturedAdmission =
        options.student.readProtectionContext().admission;
      if (
        !trusted(revision, isCurrent) ||
        attempt !== null ||
        localRecoveryBlocked() ||
        !options.student.readProtectionContext().maySupersedeLatest ||
        options.student.readView().revision !== capturedRevision ||
        capturedAdmission !== options.student.readProtectionContext().admission
      )
        return;
      await options.student.beginTargetedReadmission(code, capturedRevision);
    },
    async retryPending(isCurrent: () => boolean) {
      if (stopping || !callCurrent(isCurrent)) return;
      await recoverPriorBoot();
      if (stopping || disposed || !callCurrent(isCurrent)) return;
      const capturedRevision = options.student.readView().revision;
      if (attempt?.live) requestLocalEnd("admission_changed");
      if (
        !callCurrent(isCurrent) ||
        options.student.readView().revision !== capturedRevision
      )
        return;
      await options.student.retryPending();
      if (!stopping && !disposed) await recoverPriorBoot();
      if (attempt !== null && !attempt.live) {
        writePreflightFailure(attempt);
        void finalize(attempt);
      }
    },
    async refresh() {
      if (disposed || (stopping && attempt === null)) return;
      const t = attempt;
      try {
        if (
          t?.live &&
          t.phase === "locked" &&
          (t.receipt === null || !localGate(t, t.receipt, true, "sustain"))
        ) {
          if (t.live) requestLocalEnd("backend_unavailable");
        }
      } catch {
        requestLocalEnd("backend_unavailable");
      }
      try {
        await options.student.refresh();
      } catch {
        requestLocalEnd("backend_unavailable");
      }
      if (!stopping && !disposed) await recoverPriorBoot();
      if (
        attempt !== null &&
        !attempt.live &&
        attempt.preflightFailure !== null
      ) {
        writePreflightFailure(attempt);
        void finalize(attempt);
      }
    },
    async forfeit(revision: number, isCurrent: () => boolean) {
      if (!trusted(revision, isCurrent)) return;
      const capturedRevision = options.student.readView().revision;
      const capturedAdmission =
        options.student.readProtectionContext().admission;
      if (!trusted(revision, isCurrent)) return;
      requestLocalEnd("admission_changed");
      if (
        !callCurrent(isCurrent) ||
        options.student.readView().revision !== capturedRevision ||
        !sameAdmission(
          capturedAdmission,
          options.student.readProtectionContext().admission,
        )
      )
        return;
      await options.student.forfeit(capturedRevision);
    },
    async shutdown() {
      if (disposed) return "complete";
      stopping = true;
      if (attempt !== null) {
        requestLocalEnd("application_quit");
        void finalize(attempt);
        return "retained";
      }
      studentDispose ??= options.student.dispose().catch(() => false);
      if (!(await studentDispose)) return "retained";
      unsubscribeObservation();
      unsubscribeStudent();
      listeners.clear();
      disposed = true;
      return "complete";
    },
  });
}
