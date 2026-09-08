import {
  parseStudentJoinCode,
  parseStudentSessionViewState,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

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

type Operation = "join" | "recovery" | "retry" | "refresh" | "forfeit";

function sameSnapshot(
  left: StudentSessionViewState,
  right: StudentSessionViewState,
): boolean {
  return (
    left.phase === right.phase &&
    left.pendingOperation === right.pendingOperation &&
    left.session?.syntheticDisplayName ===
      right.session?.syntheticDisplayName &&
    left.session?.sessionRevision === right.session?.sessionRevision &&
    left.session?.capabilityExpiresAtMs === right.session?.capabilityExpiresAtMs
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
  const protection = make("aside", "student-session__protection");
  protection.append(
    make("h3", "", "Assessment protection unavailable"),
    make(
      "p",
      "",
      "The calculator remains unavailable. Follow your teacher’s instructions.",
    ),
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
  root.append(panel);

  let disposed = false;
  let current: StudentSessionViewState | null = null;
  let unavailable = bridge === undefined;
  let loading = bridge !== undefined;
  let publication = 0;
  let pending: Operation | null = null;
  let review: Review | null = null;
  let recoveryOpened = false;
  let message = "";
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
  const live = (snapshot: StudentSessionViewState) =>
    !disposed &&
    !unavailable &&
    pending === null &&
    current?.revision === snapshot.revision;

  function accept(value: StudentSessionViewState | null): boolean {
    const next = parseStudentSessionViewState(value);
    if (disposed || next === null) return false;
    if (current !== null && next.revision < current.revision) return true;
    if (
      current !== null &&
      next.revision === current.revision &&
      !sameSnapshot(current, next)
    )
      return false;
    if (
      current?.phase !== next.phase ||
      current?.session?.syntheticDisplayName !==
        next.session?.syntheticDisplayName
    ) {
      clearCode();
      review = null;
      recoveryOpened = false;
      message = "";
    }
    if (current === null || next.revision > current.revision) publication += 1;
    current = next;
    unavailable = false;
    loading = false;
    render();
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
    invoke: () => Promise<StudentSessionViewState | null>,
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

  function render() {
    if (disposed) return;
    const snapshot = unavailable ? null : current;
    const phase = snapshot?.phase ?? "unavailable";
    const renderedPublication = publication;
    const busy = pending !== null || loading || phase === "joining";
    const canOpenRecovery =
      snapshot !== null && (phase === "unavailable" || phase === "forfeited");
    const recovery =
      phase === "recovery_required" || (canOpenRecovery && recoveryOpened);
    const entry = phase === "entry";
    const reviewing = review !== null && snapshot !== null;
    panel.dataset.phase = loading ? "loading" : phase;
    heading.textContent = loading
      ? "Loading session…"
      : {
          entry: "Join a Test",
          joining:
            snapshot?.pendingOperation === "join"
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
          active:
            "Your session admission is confirmed. Assessment protection is still unavailable.",
          unconfirmed:
            snapshot?.pendingOperation === "forfeit"
              ? "Leaving has not been confirmed. Retry the saved attempt to check its result."
              : snapshot?.pendingOperation == null
                ? "Your session is not currently confirmed. Refresh to check again or ask your teacher for help."
                : "Your session is not currently confirmed. Retry the saved attempt without starting a new session.",
          unavailable:
            "Your session cannot currently be confirmed. Refresh to check again or ask your teacher for help.",
          recovery_required:
            "Ask your teacher for a private re-admission code to restore an existing session.",
          forfeited:
            "This session’s admission was given up. Ask your teacher if you need to return.",
        }[phase];
    identity.hidden = phase !== "active";
    identity.textContent =
      phase === "active" ? (snapshot?.session?.syntheticDisplayName ?? "") : "";
    const pendingCopy: Record<Operation, string> = {
      join: "Submitting your join attempt…",
      recovery: "Restoring your session…",
      retry: "Checking your saved attempt…",
      refresh: "Checking your session…",
      forfeit: "Leaving has not yet been confirmed…",
    };
    feedback.textContent = pending === null ? message : pendingCopy[pending];
    feedback.hidden = feedback.textContent === "";
    codeForm.hidden = (!entry && !recovery) || reviewing;
    codeLabel.textContent = recovery
      ? "Private re-admission code"
      : "Test join code";
    submit.textContent = recovery ? "Review recovery" : "Join Test";
    codeInput.readOnly = busy;
    submit.disabled = busy || snapshot === null;
    reviewPanel.hidden = !reviewing;
    retry.hidden =
      reviewing ||
      phase !== "unconfirmed" ||
      snapshot?.pendingOperation == null;
    refresh.hidden = reviewing || loading || entry || phase === "joining";
    leave.hidden = reviewing || phase !== "active";
    openRecovery.hidden = reviewing || !canOpenRecovery || recoveryOpened;
    cancelRecovery.hidden = reviewing || !canOpenRecovery || !recoveryOpened;
    retry.disabled = busy || bridge === undefined;
    refresh.disabled = busy || bridge === undefined;
    leave.disabled = busy;
    openRecovery.disabled = busy;
    cancelRecovery.disabled = busy;
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
        snapshot.session === null ||
        review !== null
      )
        return;
      review = {
        kind: "forfeit",
        revision: snapshot.revision,
        name: snapshot.session.syntheticDisplayName,
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
        snapshot.pendingOperation === null ||
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
    }
  };
}
