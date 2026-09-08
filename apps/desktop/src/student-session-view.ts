import { parseStudentJoinCode } from "@desmoslock/contracts";

import {
  parseDesktopStudentView,
  type DesktopStudentView,
} from "./assessment-protection-view-state.js";

import type { TrustedDesktopBridge } from "./trusted-bridge.js";

type SessionBridge = Pick<
  TrustedDesktopBridge,
  | "readStudentSessionView"
  | "joinTest"
  | "beginTargetedReadmission"
  | "retryStudentSession"
  | "refreshStudentSession"
  | "forfeitStudentSession"
  | "onStudentSessionViewChanged"
  | "startAssessment"
  | "reviewEmergencyEnd"
  | "cancelEmergencyEnd"
  | "confirmEmergencyEnd"
>;

type Review =
  | {
      readonly kind: "recovery";
      readonly revision: number;
      readonly code: string;
    }
  | {
      readonly kind: "forfeit";
      readonly revision: number;
      readonly name: string;
    };

type Operation =
  "join" | "recovery" | "retry" | "refresh" | "forfeit" | "start";
type EmergencyOperation = "review" | "cancel" | "confirm";

function sameSnapshot(
  left: DesktopStudentView,
  right: DesktopStudentView,
): boolean {
  return (
    JSON.stringify(left.admission) === JSON.stringify(right.admission) &&
    JSON.stringify(left.protection) === JSON.stringify(right.protection)
  );
}

/** The main process alone establishes admission and owns every saved intent. */
export function bindStudentSessionView(
  root: HTMLElement,
  bridge: SessionBridge | undefined,
): () => void {
  const document = root.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  };
  const button = (text: string, key: string) => {
    const element = make("button", "student-session__button", text);
    element.type = "button";
    element.dataset.action = key;
    return element;
  };

  const toolbar = make("header", "assessment-toolbar");
  const toolbarIdentity = make("div", "assessment-toolbar__identity");
  const brand = make("h1", "", "DesmosLock");
  const protectionStatus = make("p", "assessment-toolbar__status");
  protectionStatus.id = "protection-status";
  protectionStatus.setAttribute("role", "status");
  protectionStatus.setAttribute("aria-live", "polite");
  toolbarIdentity.append(brand, protectionStatus);
  const toolbarActions = make("div", "assessment-toolbar__actions");
  const start = button("Start assessment", "start-assessment");
  start.className += " student-session__button--primary";
  const emergency = button("Emergency", "review-emergency");
  emergency.setAttribute("aria-label", "Review emergency exit");
  toolbarActions.append(start, emergency);
  const emergencyPanel = make("section", "assessment-toolbar__review");
  emergencyPanel.setAttribute(
    "aria-labelledby",
    "assessment-emergency-heading",
  );
  const emergencyText = make("div", "assessment-toolbar__review-copy");
  const emergencyHeading = make("h2", "", "End assessment?");
  emergencyHeading.id = "assessment-emergency-heading";
  emergencyHeading.tabIndex = -1;
  const emergencyWarning = make("p", "", "Gives up admission.");
  emergencyWarning.setAttribute("role", "status");
  emergencyText.append(emergencyHeading, emergencyWarning);
  const emergencyActions = make("div", "assessment-toolbar__actions");
  const emergencyConfirm = button("End & leave", "confirm-emergency");
  const emergencyCancel = button("Cancel", "cancel-emergency");
  emergencyActions.append(emergencyConfirm, emergencyCancel);
  emergencyPanel.append(emergencyText, emergencyActions);
  toolbar.append(toolbarIdentity, toolbarActions, emergencyPanel);

  const panel = make("section", "student-session");
  panel.setAttribute("aria-labelledby", "student-session-heading");
  const heading = make("h2");
  heading.id = "student-session-heading";
  heading.tabIndex = -1;
  const summary = make("p", "student-session__summary");
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  summary.setAttribute("aria-atomic", "true");
  const identity = make("p", "student-session__identity");
  identity.dataset.sessionIdentity = "";
  const feedback = make("p", "student-session__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");

  const codeForm = make("form", "student-session__code-form");
  const codeLabel = make("label");
  codeLabel.htmlFor = "student-session-code";
  const codeInput = make("input", "student-session__code");
  codeInput.id = "student-session-code";
  codeInput.type = "text";
  codeInput.name = "code";
  codeInput.autocomplete = "off";
  codeInput.setAttribute("autocapitalize", "characters");
  codeInput.spellcheck = false;
  codeInput.setAttribute(
    "aria-describedby",
    "student-session-code-help student-session-code-error",
  );
  const codeHelp = make(
    "p",
    "student-session__help",
    "Enter the 12-character code exactly as provided, using uppercase letters and numbers.",
  );
  codeHelp.id = "student-session-code-help";
  const codeError = make("p", "student-session__feedback");
  codeError.id = "student-session-code-error";
  codeError.setAttribute("role", "status");
  const submit = button("Join Test", "submit-code");
  submit.type = "submit";
  submit.className += " student-session__button--primary";
  codeForm.append(codeLabel, codeInput, codeHelp, codeError, submit);

  const reviewPanel = make("section", "student-session__review");
  reviewPanel.setAttribute("aria-labelledby", "student-session-review-heading");
  const reviewHeading = make("h3");
  reviewHeading.id = "student-session-review-heading";
  reviewHeading.tabIndex = -1;
  const reviewCopy = make("p");
  const reviewWarning = make("p", "student-session__feedback");
  reviewWarning.setAttribute("role", "status");
  const reviewActions = make("div", "student-session__actions");
  const confirm = button("", "confirm-review");
  confirm.className += " student-session__button--primary";
  const cancel = button("Cancel", "cancel-review");
  reviewActions.append(confirm, cancel);
  reviewPanel.append(reviewHeading, reviewCopy, reviewWarning, reviewActions);

  const actions = make("div", "student-session__actions");
  const retry = button("Retry saved attempt", "retry");
  retry.className += " student-session__button--primary";
  const refresh = button("Refresh session", "refresh");
  const leave = button("Leave session", "review-forfeit");
  const openRecovery = button("Use private re-admission code", "open-recovery");
  const cancelRecovery = button("Cancel recovery", "cancel-recovery");
  actions.append(retry, refresh, leave, openRecovery, cancelRecovery);
  const protection = make("section", "student-session__protection");
  protection.setAttribute("aria-labelledby", "assessment-protection-heading");
  const protectionHeading = make("h3", "", "Assessment protection unavailable");
  protectionHeading.id = "assessment-protection-heading";
  const protectionSummary = make("p");
  const protectionFailure = make("p", "student-session__feedback");
  const evidence = make("p", "student-session__help");
  const categoryList = make("dl", "student-session__categories");
  type Category = keyof DesktopStudentView["protection"]["categories"];
  const categoryLabels: Record<Category, string> = {
    aac: "Native assessment protection",
    shortcuts: "Emergency shortcut",
    applications: "Permitted applications",
    persistence: "Local session records",
    windowNetwork: "Assessment window and network",
  };
  const categories = new Map<Category, HTMLElement>();
  for (const category of Object.keys(categoryLabels) as Category[]) {
    const row = make("div", "student-session__category");
    row.dataset.protectionCategory = category;
    const label = make("dt", "", categoryLabels[category]);
    const detail = make("dd");
    categories.set(category, detail);
    row.append(label, detail);
    categoryList.append(row);
  }
  protection.append(
    protectionHeading,
    protectionSummary,
    protectionFailure,
    categoryList,
    evidence,
  );
  panel.append(
    heading,
    summary,
    identity,
    feedback,
    codeForm,
    reviewPanel,
    actions,
    protection,
  );
  root.append(toolbar, panel);

  let disposed = false;
  let current: DesktopStudentView | null = null;
  let unavailable = bridge === undefined;
  let loading = bridge !== undefined;
  let publication = 0;
  let pending: Operation | null = null;
  let review: Review | null = null;
  let recoveryOpened = false;
  let message = "";
  let emergencyMessage = "";
  let protectionUnconfirmed = false;
  let emergencyReviewRevision: number | null = null;
  const emergencyPending = new Set<EmergencyOperation>();
  const bindings = new Map<
    HTMLElement,
    { type: string; listener: (event: Event) => void }
  >();

  const bind = (element: HTMLElement, type: string, action: () => void) => {
    const old = bindings.get(element);
    if (old !== undefined) element.removeEventListener(old.type, old.listener);
    const listener = (event: Event) => {
      event.preventDefault();
      if (!disposed) action();
    };
    bindings.set(element, { type, listener });
    element.addEventListener(type, listener);
  };
  const clearCode = () => {
    if (codeInput.value !== "") codeInput.value = "";
    codeError.textContent = "";
    codeError.hidden = true;
    codeInput.removeAttribute("aria-invalid");
  };
  const live = (snapshot: DesktopStudentView) =>
    !disposed &&
    !unavailable &&
    pending === null &&
    !retainedProtection(snapshot) &&
    current?.revision === snapshot.revision;

  function accept(value: DesktopStudentView | null): boolean {
    const next = parseDesktopStudentView(value);
    if (disposed || next === null) return false;
    if (current !== null && next.revision < current.revision) return true;
    if (
      current !== null &&
      next.revision === current.revision &&
      !sameSnapshot(current, next)
    )
      return false;
    const openedEmergency =
      next.protection.emergencyReview && !current?.protection.emergencyReview;
    if (!next.protection.emergencyReview) emergencyReviewRevision = null;
    else if (openedEmergency) emergencyReviewRevision = next.revision;
    if (
      current?.admission.phase !== next.admission.phase ||
      current?.admission.session?.syntheticDisplayName !==
        next.admission.session?.syntheticDisplayName
    ) {
      clearCode();
      review = null;
      recoveryOpened = false;
      message = "";
    }
    if (retainedProtection(next) || next.protection.emergencyReview) {
      review = null;
      recoveryOpened = false;
      clearCode();
    }
    if (current === null || next.revision > current.revision) {
      publication += 1;
      protectionUnconfirmed = false;
    }
    current = next;
    unavailable = false;
    loading = false;
    render();
    if (openedEmergency && !emergencyPending.has("review"))
      emergencyHeading.focus({ preventScroll: true });
    return true;
  }

  function fail() {
    unavailable = true;
    loading = false;
    review = null;
    recoveryOpened = false;
    clearCode();
    message = "The session could not be checked. Refresh to try again.";
    render();
  }

  async function request(
    operation: Operation | null,
    invoke: () => Promise<DesktopStudentView | null>,
  ) {
    if (disposed || (operation !== null && pending !== null)) return;
    const startedAt = publication;
    if (operation !== null) {
      pending = operation;
      message = "";
      render();
    }
    try {
      const result = await invoke();
      if (disposed) return;
      if (!accept(result) && publication === startedAt) fail();
    } catch {
      if (!disposed && publication === startedAt) fail();
    } finally {
      if (!disposed) {
        if (operation !== null) pending = null;
        loading = false;
        render();
      }
    }
  }

  function retainedProtection(snapshot: DesktopStudentView): boolean {
    const state = snapshot.protection;
    return (
      state.phase === "preflight" ||
      state.phase === "engaging" ||
      state.phase === "locked" ||
      state.phase === "ending" ||
      state.phase === "recovery_required" ||
      (state.phase === "failed" && state.cleanup !== "complete")
    );
  }

  function canStart(snapshot: DesktopStudentView): boolean {
    const state = snapshot.protection;
    const eligiblePhase =
      state.phase === "idle" ||
      (state.phase === "ended" &&
        state.nativeEndObserved &&
        state.cleanup === "complete") ||
      (state.phase === "failed" && state.cleanup === "complete");
    return (
      live(snapshot) &&
      review === null &&
      !loading &&
      !protectionUnconfirmed &&
      eligiblePhase &&
      snapshot.admission.phase === "active" &&
      snapshot.admission.pendingOperation === null &&
      !state.emergencyReview &&
      emergencyPending.size === 0 &&
      state.evidence !== "full" &&
      state.evidence !== "unconfirmed"
    );
  }

  async function requestEmergency(
    operation: EmergencyOperation,
    invoke: () => Promise<DesktopStudentView | null>,
  ) {
    if (disposed || emergencyPending.has(operation)) return;
    const origin = document.activeElement;
    const startedAt = publication;
    emergencyPending.add(operation);
    emergencyMessage = "";
    render();
    try {
      const value = await invoke();
      if (disposed) return;
      const superseded = publication !== startedAt;
      const accepted = accept(value);
      if (!accepted && publication === startedAt) {
        emergencyMessage =
          "The result is unconfirmed. Try the emergency action again.";
        if (operation === "confirm") protectionUnconfirmed = true;
      } else if (
        operation === "review" &&
        accepted &&
        !superseded &&
        value?.revision === current?.revision &&
        !current?.protection.emergencyReview
      ) {
        emergencyMessage =
          "Emergency review is unavailable. Ask your teacher or operator for help.";
      } else if (document.activeElement === origin) {
        if (operation === "review" && current?.protection.emergencyReview)
          emergencyHeading.focus({ preventScroll: true });
        else if (
          operation === "cancel" &&
          !current?.protection.emergencyReview &&
          !emergency.hidden &&
          !emergency.disabled
        )
          emergency.focus({ preventScroll: true });
      }
    } catch {
      if (!disposed && publication === startedAt) {
        emergencyMessage =
          "The result is unconfirmed. Try the emergency action again.";
        if (operation === "confirm") protectionUnconfirmed = true;
      }
    } finally {
      emergencyPending.delete(operation);
      if (!disposed) render();
    }
  }

  function renderProtection() {
    // Reserving the last visible calculator space is layout only. On an IPC
    // failure the label becomes unconfirmed; the renderer cannot detach or
    // certify a native surface. Main owns the actual child and native gate.
    const value = current;
    const state = value?.protection;
    const known = value !== null && !unavailable && !protectionUnconfirmed;
    const reserved = state?.calculatorVisible === true;
    panel.hidden = reserved;
    root.setAttribute("data-calculator-space-reserved", String(reserved));
    root.setAttribute(
      "data-protection-phase",
      known ? state!.phase : "unconfirmed",
    );
    const status = !known
      ? "Protection status unconfirmed"
      : {
          idle: "Protection not started",
          preflight: "Checking protection",
          engaging: "Starting protection",
          locked: "Assessment protected",
          ending: "Ending protection",
          ended: "Assessment protection ended",
          failed: "Protection unavailable",
          recovery_required: "Recovery required",
        }[state!.phase];
    protectionStatus.textContent = status;
    protectionStatus.setAttribute("title", status);
    const reviewing = state?.emergencyReview === true;
    toolbarIdentity.hidden = reviewing;
    toolbarActions.hidden = reviewing;
    emergencyPanel.hidden = !reviewing;
    const eligiblePhase =
      state?.phase === "idle" ||
      state?.phase === "ended" ||
      state?.phase === "failed";
    start.hidden = !known || !eligiblePhase || pending === "start";
    start.disabled = value === null || bridge === undefined || !canStart(value);
    const emergencyAvailable =
      value !== null && (retainedProtection(value) || pending === "start");
    emergency.hidden = !emergencyAvailable;
    emergency.disabled = bridge === undefined;
    emergency.setAttribute(
      "aria-disabled",
      String(emergencyPending.has("review")),
    );
    emergencyConfirm.disabled =
      bridge === undefined ||
      !reviewing ||
      emergencyPending.has("cancel") ||
      emergencyReviewRevision !== value?.revision;
    emergencyConfirm.setAttribute(
      "aria-disabled",
      String(emergencyPending.has("confirm")),
    );
    emergencyCancel.disabled =
      bridge === undefined || emergencyPending.has("confirm");
    emergencyCancel.setAttribute(
      "aria-disabled",
      String(emergencyPending.has("cancel")),
    );
    emergencyConfirm.textContent = emergencyPending.has("confirm")
      ? "Ending…"
      : "End & leave";
    emergencyWarning.textContent =
      emergencyMessage ||
      (emergencyReviewRevision !== value?.revision
        ? "Session changed. Cancel and review again."
        : "Gives up admission.");
    protectionHeading.textContent = !known
      ? "Protection status unconfirmed"
      : {
          idle: "Assessment protection unavailable",
          preflight: "Checking assessment protection",
          engaging: "Waiting for native confirmation",
          locked: "Assessment protected",
          ending: "Assessment protection is ending",
          ended: "Assessment protection ended",
          failed: "Protection unavailable",
          recovery_required: "Assessment recovery required",
        }[state!.phase];
    protectionSummary.textContent = !known
      ? "The calculator remains unavailable. Protection could not be checked. Follow your teacher’s instructions."
      : state!.phase === "recovery_required"
        ? state!.nativeEndObserved
          ? "Native end was observed, but local cleanup is not confirmed. Keep this app open and ask your teacher or operator for help."
          : "The previous assessment’s end could not be confirmed. Keep this app open and ask your teacher or operator for help. A new assessment cannot start here."
        : state!.phase === "ended"
          ? "Native end was observed and local cleanup is complete. This does not confirm the session’s admission was given up."
          : state!.phase === "ending"
            ? state!.nativeEndObserved
              ? "Native end was observed. Waiting for confirmed local cleanup."
              : "Ending has been requested. Native end and local cleanup are not yet confirmed."
            : state!.phase === "failed" && state!.cleanup === "complete"
              ? "The attempt did not establish confirmed protection. Local cleanup is complete. A new Start checks protection again."
              : state!.phase === "preflight" || state!.phase === "engaging"
                ? "The calculator remains unavailable until native confirmation and all five checks are confirmed."
                : "The calculator remains unavailable. Join a Test, then choose Start assessment to check protection.";
    type Code =
      DesktopStudentView["protection"]["categories"][Category]["code"];
    const categoryCopy: Record<Code, string> = {
      none: "Not checked",
      awaiting_native_begin: "Waiting for native confirmation",
      native_unavailable:
        "Native support is unavailable; this app’s authorization to begin protection is not confirmed",
      native_inactive: "Native protection is not currently confirmed",
      emergency_shortcut_unavailable: "The emergency shortcut is unavailable",
      prohibited_application:
        "A prohibited application prevents assessment protection",
      application_observation_unavailable:
        "Permitted applications could not be checked",
      durability_unavailable: "Local session records could not be confirmed",
      evidence_capacity: "Local evidence capacity is reached",
      window_unavailable: "The assessment window is unavailable",
      network_policy_unavailable:
        "The assessment network boundary is unavailable",
      backend_unavailable: "Session access cannot currently be confirmed",
    };
    for (const [category, detail] of categories) {
      const observation = known ? state!.categories[category] : null;
      detail.textContent =
        observation === null
          ? "Unconfirmed"
          : observation.status === "confirmed"
            ? "Confirmed"
            : observation.code === "none"
              ? "Pending"
              : categoryCopy[observation.code];
      detail.dataset.status = observation?.status ?? "unavailable";
    }
    const cause = known ? state!.failure : null;
    protectionFailure.hidden = cause === null && emergencyMessage === "";
    protectionFailure.textContent =
      emergencyMessage ||
      (cause === "backend_unavailable" || cause === "admission_changed"
        ? "Session access cannot currently be confirmed. Follow your teacher’s instructions."
        : cause === "persistence_unavailable"
          ? "Local session records could not be confirmed. Emergency exit remains available while recovery is needed."
          : cause === null
            ? ""
            : "Assessment protection could not be maintained. Follow the recovery guidance above.");
    evidence.hidden = !known || state!.evidence === "none";
    evidence.textContent =
      !known || state!.evidence === "none"
        ? ""
        : {
            queued:
              "Session evidence is saved locally and queued. Server receipt is not confirmed.",
            acknowledged:
              "The server acknowledged the reports currently saved on this device. This does not confirm native protection or release.",
            blocked:
              "Reports cannot currently be delivered. Saved reports remain on this device.",
            full: "Local evidence capacity is reached. Another assessment cannot start.",
            unconfirmed:
              "Local evidence could not be confirmed. Another assessment cannot start.",
          }[state!.evidence];

    bind(start, "click", () => {
      if (value === null || bridge === undefined || !canStart(value)) return;
      void request("start", () =>
        bridge.startAssessment({ snapshotRevision: value.revision }),
      );
    });
    bind(emergency, "click", () => {
      if (
        value === null ||
        bridge === undefined ||
        current?.revision !== value.revision ||
        !emergencyAvailable ||
        reviewing ||
        emergencyPending.has("review")
      )
        return;
      void requestEmergency("review", () =>
        bridge.reviewEmergencyEnd({ snapshotRevision: value.revision }),
      );
    });
    const capturedReviewRevision = emergencyReviewRevision;
    bind(emergencyConfirm, "click", () => {
      if (
        value === null ||
        bridge === undefined ||
        !reviewing ||
        current?.revision !== value.revision ||
        capturedReviewRevision !== value.revision ||
        emergencyReviewRevision !== capturedReviewRevision ||
        emergencyPending.has("confirm") ||
        emergencyPending.has("cancel")
      )
        return;
      void requestEmergency("confirm", () =>
        bridge.confirmEmergencyEnd({
          snapshotRevision: capturedReviewRevision,
        }),
      );
    });
    bind(emergencyCancel, "click", () => {
      if (
        value === null ||
        bridge === undefined ||
        !reviewing ||
        current?.revision !== value.revision ||
        emergencyPending.has("cancel") ||
        emergencyPending.has("confirm")
      )
        return;
      void requestEmergency("cancel", () =>
        bridge.cancelEmergencyEnd({ snapshotRevision: value.revision }),
      );
    });
  }

  function render() {
    if (disposed) return;
    const snapshot = unavailable ? null : current;
    const phase = snapshot?.admission.phase ?? "unavailable";
    const renderedPublication = publication;
    const busy = pending !== null || loading || phase === "joining";
    const admissionBlocked = current !== null && retainedProtection(current);
    const canOpenRecovery =
      snapshot !== null && (phase === "unavailable" || phase === "forfeited");
    const recovery =
      phase === "recovery_required" || (canOpenRecovery && recoveryOpened);
    const entry = phase === "entry";
    const reviewing = review !== null && snapshot !== null;
    panel.dataset.phase = loading ? "loading" : phase;
    root.setAttribute("data-admission-phase", loading ? "loading" : phase);
    heading.textContent = loading
      ? "Loading session…"
      : {
          entry: "Join a Test",
          joining:
            snapshot?.admission.pendingOperation === "join"
              ? "Joining…"
              : "Restoring your saved attempt…",
          active: "Session confirmed",
          unconfirmed: "Session result unconfirmed",
          unavailable: "Session unavailable",
          recovery_required: "Saved session needs recovery",
          forfeited: "You left this Test session.",
        }[phase];
    summary.textContent = loading
      ? "Checking this device’s saved session."
      : {
          entry: "Ask your teacher for the Test join code.",
          joining:
            "Wait while your saved attempt is checked. Your session is not yet confirmed.",
          active: "Your session admission is confirmed.",
          unconfirmed:
            snapshot?.admission.pendingOperation === "forfeit"
              ? "Leaving has not been confirmed. Retry the saved attempt to check its result."
              : snapshot?.admission.pendingOperation == null
                ? "Your session is not currently confirmed. Refresh to check again or ask your teacher for help."
                : "Your session is not currently confirmed. Retry the saved attempt without starting a new session.",
          unavailable:
            "Your session cannot currently be confirmed. Refresh to check again or ask your teacher for help.",
          recovery_required: admissionBlocked
            ? "Local protection recovery is required before session recovery. Ask your teacher or operator for help."
            : "Ask your teacher for a private re-admission code to restore an existing session.",
          forfeited:
            "This session’s admission was given up. Ask your teacher if you need to return.",
        }[phase];
    identity.hidden = phase !== "active";
    identity.textContent =
      phase === "active"
        ? (snapshot?.admission.session?.syntheticDisplayName ?? "")
        : "";
    const pendingCopy: Record<Operation, string> = {
      join: "Submitting your join attempt…",
      recovery: "Restoring your session…",
      retry: "Checking your saved attempt…",
      refresh: "Checking your session…",
      forfeit: "Leaving has not yet been confirmed…",
      start: "Checking assessment protection…",
    };
    feedback.textContent = pending === null ? message : pendingCopy[pending];
    feedback.hidden = feedback.textContent === "";
    codeForm.hidden = (!entry && !recovery) || reviewing || admissionBlocked;
    codeLabel.textContent = recovery
      ? "Private re-admission code"
      : "Test join code";
    submit.textContent = recovery ? "Review recovery" : "Join Test";
    codeInput.readOnly = busy;
    submit.disabled = busy || snapshot === null || admissionBlocked;
    reviewPanel.hidden = !reviewing;
    retry.hidden =
      reviewing ||
      phase !== "unconfirmed" ||
      snapshot?.admission.pendingOperation == null;
    refresh.hidden = reviewing || loading || entry || phase === "joining";
    leave.hidden = reviewing || phase !== "active";
    openRecovery.hidden =
      reviewing || !canOpenRecovery || recoveryOpened || admissionBlocked;
    cancelRecovery.hidden = reviewing || !canOpenRecovery || !recoveryOpened;
    retry.disabled = busy || bridge === undefined || admissionBlocked;
    refresh.disabled = busy || bridge === undefined;
    leave.disabled = busy || admissionBlocked;
    openRecovery.disabled = busy || admissionBlocked;
    cancelRecovery.disabled = busy || admissionBlocked;
    confirm.disabled =
      busy || !reviewing || review?.revision !== snapshot?.revision;
    cancel.disabled = busy;

    const selectedReview = review;
    if (selectedReview !== null) {
      reviewHeading.textContent =
        selectedReview.kind === "recovery"
          ? "Review recovery"
          : "Leave this session?";
      reviewCopy.textContent =
        selectedReview.kind === "recovery"
          ? "Your teacher’s private code restores an existing session. The previous saved record will be preserved before recovery begins."
          : `Leave ${selectedReview.name}? This gives up this session’s admission to the Test. This changes this session’s admission only.`;
      confirm.textContent =
        selectedReview.kind === "recovery"
          ? "Restore session"
          : "Leave session";
      reviewWarning.textContent =
        selectedReview.revision === snapshot?.revision
          ? ""
          : "The session changed. Cancel this review and review the current session before continuing.";
      reviewWarning.hidden = reviewWarning.textContent === "";
    }

    bind(codeForm, "submit", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        (!entry && !recovery) ||
        review !== null ||
        bridge === undefined
      )
        return;
      const code = parseStudentJoinCode(codeInput.value);
      if (code === null) {
        codeError.textContent =
          "Enter the exact 12-character code. Use uppercase letters and numbers; I, L, O and U are not used.";
        codeError.hidden = false;
        codeInput.setAttribute("aria-invalid", "true");
        return;
      }
      if (recovery) {
        review = { kind: "recovery", revision: snapshot.revision, code };
        render();
        reviewHeading.focus({ preventScroll: true });
      } else {
        clearCode();
        void request("join", () => bridge.joinTest({ code }));
      }
    });
    bind(leave, "click", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        phase !== "active" ||
        snapshot.admission.session === null ||
        review !== null
      )
        return;
      review = {
        kind: "forfeit",
        revision: snapshot.revision,
        name: snapshot.admission.session.syntheticDisplayName,
      };
      render();
      reviewHeading.focus({ preventScroll: true });
    });
    bind(confirm, "click", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        bridge === undefined ||
        selectedReview === null ||
        review !== selectedReview ||
        selectedReview.revision !== snapshot.revision
      )
        return;
      review = null;
      clearCode();
      if (selectedReview.kind === "recovery" && recovery)
        void request("recovery", () =>
          bridge.beginTargetedReadmission({
            code: selectedReview.code,
            snapshotRevision: selectedReview.revision,
          }),
        );
      else if (selectedReview.kind === "forfeit" && phase === "active")
        void request("forfeit", () =>
          bridge.forfeitStudentSession({
            snapshotRevision: selectedReview.revision,
          }),
        );
    });
    bind(cancel, "click", () => {
      if (
        pending !== null ||
        review !== selectedReview ||
        selectedReview === null
      )
        return;
      review = null;
      render();
      const invoker = selectedReview.kind === "recovery" ? submit : leave;
      if (
        !invoker.hidden &&
        !invoker.disabled &&
        invoker.isConnected &&
        (selectedReview.kind === "forfeit" || !codeForm.hidden)
      )
        invoker.focus({ preventScroll: true });
    });
    bind(retry, "click", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        phase !== "unconfirmed" ||
        snapshot.admission.pendingOperation === null ||
        review !== null ||
        bridge === undefined
      )
        return;
      void request("retry", () => bridge.retryStudentSession());
    });
    bind(refresh, "click", () => {
      if (
        publication !== renderedPublication ||
        pending !== null ||
        loading ||
        phase === "joining" ||
        entry ||
        review !== null ||
        bridge === undefined
      )
        return;
      void request("refresh", () => bridge.refreshStudentSession());
    });
    bind(openRecovery, "click", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        !canOpenRecovery ||
        review !== null
      )
        return;
      recoveryOpened = true;
      render();
      codeInput.focus({ preventScroll: true });
    });
    bind(cancelRecovery, "click", () => {
      if (
        snapshot === null ||
        !live(snapshot) ||
        !canOpenRecovery ||
        review !== null
      )
        return;
      recoveryOpened = false;
      clearCode();
      render();
      openRecovery.focus({ preventScroll: true });
    });
    renderProtection();
  }

  bind(codeInput, "input", () => {
    codeError.textContent = "";
    codeError.hidden = true;
    codeInput.removeAttribute("aria-invalid");
  });
  render();
  let unsubscribe: (() => void) | undefined;
  if (bridge !== undefined) {
    try {
      unsubscribe = bridge.onStudentSessionViewChanged((next) => {
        if (!disposed && !accept(next)) fail();
      });
      void request(null, () => bridge.readStudentSessionView());
    } catch {
      fail();
    }
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe?.();
    } finally {
      for (const [element, binding] of bindings)
        element.removeEventListener(binding.type, binding.listener);
      bindings.clear();
      clearCode();
      current = null;
      review = null;
      identity.textContent = "";
      panel.remove();
      toolbar.remove();
      emergencyPending.clear();
      emergencyReviewRevision = null;
      root.removeAttribute("data-admission-phase");
      root.removeAttribute("data-protection-phase");
      root.removeAttribute("data-calculator-space-reserved");
    }
  };
}
