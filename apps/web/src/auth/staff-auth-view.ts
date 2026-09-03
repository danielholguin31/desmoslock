import type {
  StaffAuthController,
  StaffAuthSnapshot,
} from "./staff-auth-controller.js";

export type StaffAuthViewActionId =
  | "accept_invitation"
  | "back_to_sign_in"
  | "begin_totp_enrollment"
  | "cancel_totp"
  | "complete_password_recovery"
  | "request_recovery"
  | "resend_email_verification"
  | "retry"
  | "revoke_all_sessions"
  | "sign_in"
  | "sign_out_local"
  | "verify_totp";

export interface StaffAuthViewAction {
  readonly id: StaffAuthViewActionId;
  readonly label: string;
}

export interface StaffAuthViewField {
  readonly autocomplete: HTMLInputElement["autocomplete"];
  readonly id: "email" | "new_password" | "password" | "totp";
  readonly label: string;
  readonly type: "email" | "password" | "text";
}

export interface StaffAuthViewModel {
  readonly actions: readonly StaffAuthViewAction[];
  readonly fields: readonly StaffAuthViewField[];
  readonly heading: string;
  readonly message: string;
  readonly status: StaffAuthSnapshot["kind"];
  readonly tone: "danger" | "info" | "success" | "warning";
}

export type StaffAuthViewIntent =
  | {
      readonly email: string;
      readonly password: string;
      readonly type: "sign_in";
    }
  | { readonly email: string; readonly type: "request_password_recovery" }
  | { readonly type: "resend_email_verification" }
  | { readonly password: string; readonly type: "accept_invitation" }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly code: string; readonly type: "verify_totp" }
  | { readonly type: "cancel_totp" }
  | { readonly type: "sign_out_local" }
  | { readonly type: "revoke_all_sessions" }
  | { readonly type: "retry" }
  | { readonly type: "bootstrap" }
  | { readonly password: string; readonly type: "complete_password_recovery" };

const emailField: StaffAuthViewField = {
  autocomplete: "email",
  id: "email",
  label: "Email",
  type: "email",
};

const passwordField: StaffAuthViewField = {
  autocomplete: "current-password",
  id: "password",
  label: "Password",
  type: "password",
};

const newPasswordField: StaffAuthViewField = {
  autocomplete: "new-password",
  id: "new_password",
  label: "Create password",
  type: "password",
};

const totpField: StaffAuthViewField = {
  autocomplete: "one-time-code",
  id: "totp",
  label: "Authenticator code",
  type: "text",
};

export function createStaffAuthViewModel(
  snapshot: StaffAuthSnapshot,
): StaffAuthViewModel {
  if (snapshot.kind === "signed_out") {
    return {
      actions: [
        { id: "sign_in", label: "Sign in" },
        { id: "request_recovery", label: "Forgot password?" },
      ],
      fields: [emailField, passwordField],
      heading: "Staff sign in",
      message:
        snapshot.notice === "all_sessions_revoked"
          ? "All sessions were revoked."
          : snapshot.notice === "signed_out"
            ? "You signed out on this device."
            : "Use the staff account provided by your School.",
      status: snapshot.kind,
      tone: snapshot.notice === null ? "info" : "success",
    };
  }

  if (snapshot.kind === "invitation_rejected") {
    const message = {
      expired: "This invitation link has expired.",
      invalid: "This invitation link is invalid.",
      replayed: "This invitation link has already been used.",
    }[snapshot.reason];
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Invitation unavailable",
      message,
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (snapshot.kind === "invitation_ready") {
    return {
      actions: [{ id: "accept_invitation", label: "Accept invitation" }],
      fields: [newPasswordField],
      heading: `Join ${snapshot.schoolLabel}`,
      message: `You were invited as ${roleWithArticle(snapshot.role)}.`,
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "recovery_notice") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Check your email",
      message:
        "If that address can receive recovery email, instructions are on the way.",
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (snapshot.kind === "callback_rejected") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Authentication link unavailable",
      message:
        "This authentication link could not be accepted. Request a new one.",
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (snapshot.kind === "sign_in_rejected") {
    return {
      actions: [
        { id: "sign_in", label: "Try again" },
        { id: "request_recovery", label: "Forgot password?" },
      ],
      fields: [emailField, passwordField],
      heading: "Sign-in failed",
      message: "Email or password was not accepted.",
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (
    snapshot.kind === "email_verification_required" ||
    snapshot.kind === "email_verification_sent"
  ) {
    const sent = snapshot.kind === "email_verification_sent";
    return {
      actions: [
        {
          id: "resend_email_verification",
          label: sent ? "Send another link" : "Resend verification email",
        },
        { id: "back_to_sign_in", label: "Back to sign in" },
      ],
      fields: [],
      heading: sent ? "Verification email sent" : "Verify your email",
      message: sent
        ? "Check your email for a new verification link."
        : "Verify your email before signing in.",
      status: snapshot.kind,
      tone: sent ? "success" : "warning",
    };
  }

  if (snapshot.kind === "password_recovery_ready") {
    return {
      actions: [
        {
          id: "complete_password_recovery",
          label: "Update password",
        },
      ],
      fields: [{ ...newPasswordField, label: "New password" }],
      heading: "Set a new password",
      message: "Choose a new password for this staff account.",
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "password_recovery_complete") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Password updated",
      message: "Your password was updated. Sign in again to continue.",
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (snapshot.kind === "password_recovery_rejected") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Password not updated",
      message:
        "The password could not be updated. Request a new recovery link.",
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (snapshot.kind === "totp_enrollment_required") {
    return {
      actions: [{ id: "begin_totp_enrollment", label: "Set up authenticator" }],
      fields: [],
      heading: `Secure ${roleLabel(snapshot.role)} access`,
      message:
        "Privileged staff must set up authenticator verification before School access.",
      status: snapshot.kind,
      tone: "warning",
    };
  }

  if (snapshot.kind === "totp_challenge") {
    const message =
      snapshot.feedback === "rejected"
        ? "That authenticator code was not accepted. Try again."
        : snapshot.feedback === "cancelled"
          ? "Verification was cancelled. No access change was made."
          : snapshot.purpose === "enrollment"
            ? "Enter a code from the authenticator you just configured."
            : "Enter your authenticator code to continue.";
    return {
      actions: [
        { id: "verify_totp", label: "Verify" },
        { id: "cancel_totp", label: "Cancel" },
      ],
      fields: [totpField],
      heading:
        snapshot.purpose === "enrollment"
          ? "Confirm authenticator setup"
          : `Verify ${roleLabel(snapshot.role)} access`,
      message,
      status: snapshot.kind,
      tone: snapshot.feedback === "rejected" ? "danger" : "warning",
    };
  }

  if (snapshot.kind === "authenticated") {
    return {
      actions: [
        { id: "sign_out_local", label: "Sign out here" },
        { id: "revoke_all_sessions", label: "Sign out everywhere" },
      ],
      fields: [],
      heading: `${roleLabel(snapshot.role)} access`,
      message: `Signed in as ${snapshot.email}${
        snapshot.assuranceLevel === "aal2" ? " with step-up verification" : ""
      }.`,
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (
    snapshot.kind === "session_expired" ||
    snapshot.kind === "session_revoked" ||
    snapshot.kind === "membership_inactive"
  ) {
    const content = {
      membership_inactive: {
        heading: "School access inactive",
        message:
          "Your School Membership is not active. Contact a School Owner.",
      },
      session_expired: {
        heading: "Session expired",
        message: "Your session expired. Sign in again to continue.",
      },
      session_revoked: {
        heading: "Session revoked",
        message:
          "This session was revoked. Sign in again if access is still allowed.",
      },
    }[snapshot.kind];
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: content.heading,
      message: content.message,
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (snapshot.kind === "dependency_failure") {
    return {
      actions: snapshot.retryable
        ? [
            { id: "retry", label: "Retry" },
            { id: "back_to_sign_in", label: "Back to sign in" },
          ]
        : [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Authentication temporarily unavailable",
      message: snapshot.retryable
        ? "No access change was confirmed. Try again."
        : "No access change was confirmed. Start again.",
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (
    snapshot.kind === "bootstrapping" ||
    snapshot.kind === "signing_in" ||
    snapshot.kind === "signing_out" ||
    snapshot.kind === "requesting_recovery" ||
    snapshot.kind === "inspecting_invitation" ||
    snapshot.kind === "accepting_invitation" ||
    snapshot.kind === "enrolling_totp" ||
    snapshot.kind === "verifying_totp" ||
    snapshot.kind === "processing_pkce_callback" ||
    snapshot.kind === "updating_password"
  ) {
    const heading =
      snapshot.kind === "signing_out"
        ? snapshot.scope === "all"
          ? "Revoking all sessions"
          : "Signing out"
        : {
            accepting_invitation: "Accepting invitation",
            bootstrapping: "Checking staff access",
            enrolling_totp: "Preparing authenticator",
            inspecting_invitation: "Checking invitation",
            processing_pkce_callback: "Checking recovery link",
            requesting_recovery: "Requesting recovery",
            signing_in: "Signing in",
            updating_password: "Updating password",
            verifying_totp: "Verifying authenticator",
          }[snapshot.kind];
    return {
      actions: [],
      fields: [],
      heading,
      message: "Please wait.",
      status: snapshot.kind,
      tone: "info",
    };
  }

  return assertNever(snapshot);
}

export function renderStaffAuthView(
  root: HTMLElement,
  snapshot: StaffAuthSnapshot,
  onIntent: (intent: StaffAuthViewIntent) => Promise<void> | void,
): void {
  const document = root.ownerDocument;
  const view = createStaffAuthViewModel(snapshot);
  const section = document.createElement("section");
  section.dataset.authStatus = view.status;
  section.dataset.authTone = view.tone;

  const heading = document.createElement("h1");
  heading.textContent = view.heading;
  const message = document.createElement("p");
  message.textContent = view.message;
  section.append(heading, message);

  const controls = document.createElement("div");
  const inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>> =
    {};
  for (const field of view.fields) {
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = field.label;
    const input = document.createElement("input");
    input.autocomplete = field.autocomplete;
    input.name = field.id;
    input.type = field.type;
    inputs[field.id] = input;
    label.append(labelText, input);
    controls.append(label);
  }

  for (const action of view.actions) {
    const button = document.createElement("button");
    button.dataset.authAction = action.id;
    button.textContent = action.label;
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const intent = createIntent(action.id, inputs);
      try {
        void onIntent(intent);
      } finally {
        clearTransientInputs(inputs);
      }
    });
    controls.append(button);
  }

  section.append(controls);
  root.replaceChildren(section);
}

function createIntent(
  action: StaffAuthViewActionId,
  inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>>,
): StaffAuthViewIntent {
  switch (action) {
    case "sign_in":
      return {
        email: inputs.email?.value ?? "",
        password: inputs.password?.value ?? "",
        type: "sign_in",
      };
    case "request_recovery":
      return {
        email: inputs.email?.value ?? "",
        type: "request_password_recovery",
      };
    case "resend_email_verification":
      return { type: "resend_email_verification" };
    case "accept_invitation":
      return {
        password: inputs.new_password?.value ?? "",
        type: "accept_invitation",
      };
    case "begin_totp_enrollment":
      return { type: "begin_totp_enrollment" };
    case "verify_totp":
      return { code: inputs.totp?.value ?? "", type: "verify_totp" };
    case "cancel_totp":
      return { type: "cancel_totp" };
    case "sign_out_local":
      return { type: "sign_out_local" };
    case "revoke_all_sessions":
      return { type: "revoke_all_sessions" };
    case "retry":
      return { type: "retry" };
    case "back_to_sign_in":
      return { type: "bootstrap" };
    case "complete_password_recovery":
      return {
        password: inputs.new_password?.value ?? "",
        type: "complete_password_recovery",
      };
  }
}

export function bindStaffAuthView(
  root: HTMLElement,
  controller: StaffAuthController,
): () => void {
  const render = (snapshot: StaffAuthSnapshot) => {
    renderStaffAuthView(root, snapshot, async (intent) => {
      await controller.dispatch(intent);
    });
  };
  render(controller.getSnapshot());
  return controller.subscribe(render);
}

function clearTransientInputs(
  inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>>,
): void {
  if (inputs.password !== undefined) {
    inputs.password.value = "";
  }
  if (inputs.new_password !== undefined) {
    inputs.new_password.value = "";
  }
  if (inputs.totp !== undefined) {
    inputs.totp.value = "";
  }
}

function roleLabel(role: "administrator" | "owner" | "teacher"): string {
  if (role === "administrator") {
    return "Administrator";
  }
  if (role === "owner") {
    return "Owner";
  }
  return "Teacher";
}

function roleWithArticle(role: "administrator" | "owner" | "teacher"): string {
  const label = roleLabel(role);
  return `${role === "teacher" ? "a" : "an"} ${label}`;
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unsupported staff authentication state");
}
