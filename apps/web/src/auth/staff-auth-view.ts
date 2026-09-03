import type {
  ManagedStaffRole,
  StaffAuthController,
  StaffAuthSnapshot,
} from "./staff-auth-controller.js";

export type StaffAuthViewActionId =
  | "accept_invitation"
  | "back_to_sign_in"
  | "begin_totp_enrollment"
  | "cancel_totp"
  | "complete_password_recovery"
  | "create_administrator_invitation"
  | "create_teacher_invitation"
  | "request_recovery"
  | "resend_email_verification"
  | "retry"
  | "revoke_administrator_membership"
  | "revoke_all_sessions"
  | "revoke_teacher_membership"
  | "sign_in"
  | "sign_out_local"
  | "verify_totp";

export interface StaffAuthViewAction {
  readonly group?: "invitation" | "membership" | "session";
  readonly id: StaffAuthViewActionId;
  readonly label: string;
}

export interface StaffAuthViewField {
  readonly autocomplete: HTMLInputElement["autocomplete"];
  readonly id:
    | "email"
    | "membership_id"
    | "new_password"
    | "password"
    | "target_email"
    | "totp";
  readonly group?: "invitation" | "membership";
  readonly label: string;
  readonly type: "email" | "password" | "text";
}

export interface StaffAuthViewImage {
  readonly alt: string;
  readonly src: string;
}

export interface StaffAuthViewModel {
  readonly actions: readonly StaffAuthViewAction[];
  readonly fields: readonly StaffAuthViewField[];
  readonly heading: string;
  readonly image?: StaffAuthViewImage;
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
  | { readonly password: string; readonly type: "complete_password_recovery" }
  | {
      readonly email: string;
      readonly targetRole: "admin" | "teacher";
      readonly type: "create_staff_invitation";
    }
  | {
      readonly membershipId: string;
      readonly targetRole: "admin" | "teacher";
      readonly type: "revoke_staff_membership";
    };

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

const targetEmailField: StaffAuthViewField = {
  autocomplete: "email",
  group: "invitation",
  id: "target_email",
  label: "Staff email",
  type: "email",
};

const membershipIdField: StaffAuthViewField = {
  autocomplete: "off",
  group: "membership",
  id: "membership_id",
  label: "Membership ID",
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
      actions: [{ id: "complete_password_recovery", label: "Update password" }],
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
    const message =
      snapshot.feedback === "rejected"
        ? "That setup code was not accepted. Start a new authenticator setup."
        : snapshot.feedback === "cancelled"
          ? "Authenticator setup was cancelled and its QR code was revoked."
          : "Privileged staff must set up authenticator verification before School access.";
    return {
      actions: [{ id: "begin_totp_enrollment", label: "Set up authenticator" }],
      fields: [],
      heading: `Secure ${roleLabel(snapshot.role)} access`,
      message,
      status: snapshot.kind,
      tone: snapshot.feedback === "none" ? "warning" : "danger",
    };
  }

  if (snapshot.kind === "totp_provisioning") {
    return {
      actions: [
        { id: "verify_totp", label: "Verify setup" },
        { id: "cancel_totp", label: "Cancel" },
      ],
      fields: [totpField],
      heading: "Scan and confirm authenticator",
      image: {
        alt: "Authenticator enrollment QR code",
        src: snapshot.qrBlobUrl,
      },
      message:
        "Scan this one-time QR code, then enter the code from your authenticator.",
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
          : "Enter your authenticator code to continue.";
    return {
      actions: [
        { id: "verify_totp", label: "Verify" },
        { id: "cancel_totp", label: "Cancel" },
      ],
      fields: [totpField],
      heading: `Verify ${roleLabel(snapshot.role)} access`,
      message,
      status: snapshot.kind,
      tone: snapshot.feedback === "rejected" ? "danger" : "warning",
    };
  }

  if (snapshot.kind === "authenticated") {
    const role = snapshot.identity.membership.role;
    const ownerActions: StaffAuthViewAction[] =
      role === "owner"
        ? [
            {
              group: "invitation",
              id: "create_administrator_invitation",
              label: "Invite Administrator",
            },
            {
              group: "invitation",
              id: "create_teacher_invitation",
              label: "Invite Teacher",
            },
            {
              group: "membership",
              id: "revoke_administrator_membership",
              label: "Revoke Administrator",
            },
            {
              group: "membership",
              id: "revoke_teacher_membership",
              label: "Revoke Teacher",
            },
          ]
        : [];
    return {
      actions: [
        ...ownerActions,
        {
          ...(role === "owner" ? { group: "session" as const } : {}),
          id: "sign_out_local",
          label: "Sign out here",
        },
        {
          ...(role === "owner" ? { group: "session" as const } : {}),
          id: "revoke_all_sessions",
          label: "Sign out everywhere",
        },
      ],
      fields: role === "owner" ? [targetEmailField, membershipIdField] : [],
      heading: `${roleLabel(role)} access`,
      message: `Signed in as ${snapshot.identity.email} at ${snapshot.identity.school.label}${
        snapshot.assuranceLevel === "aal2" ? " with step-up verification" : ""
      }.`,
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (
    snapshot.kind === "staff_invitation_created" ||
    snapshot.kind === "staff_membership_revoked"
  ) {
    const invited = snapshot.kind === "staff_invitation_created";
    return {
      actions: [{ id: "back_to_sign_in", label: "Continue" }],
      fields: [],
      heading: invited ? "Invitation created" : "Membership revoked",
      message: invited
        ? `${roleLabel(snapshot.targetRole)} invitation created for ${snapshot.schoolLabel}.`
        : `${roleLabel(snapshot.targetRole)} membership revoked for ${snapshot.schoolLabel}.`,
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (
    snapshot.kind === "staff_invitation_rejected" ||
    snapshot.kind === "staff_membership_revocation_rejected"
  ) {
    const invitation = snapshot.kind === "staff_invitation_rejected";
    return {
      actions: [{ id: "back_to_sign_in", label: "Continue" }],
      fields: [],
      heading: invitation ? "Invitation not created" : "Membership not revoked",
      message: invitation
        ? "The staff invitation was not authorized or could not be created."
        : "The staff membership revocation was not authorized or could not be completed.",
      status: snapshot.kind,
      tone: "danger",
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
            { id: "back_to_sign_in", label: "Start again" },
          ]
        : [{ id: "back_to_sign_in", label: "Start again" }],
      fields: [],
      heading: "Authentication temporarily unavailable",
      message: snapshot.retryable
        ? "No access change was confirmed. Try again."
        : "No access change was confirmed. Start again.",
      status: snapshot.kind,
      tone: "danger",
    };
  }

  if (snapshot.kind === "disposed") {
    return {
      actions: [],
      fields: [],
      heading: "Authentication view closed",
      message: "This authentication view is no longer active.",
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (
    snapshot.kind === "bootstrapping" ||
    snapshot.kind === "signing_in" ||
    snapshot.kind === "signing_out" ||
    snapshot.kind === "sending_email_verification" ||
    snapshot.kind === "requesting_recovery" ||
    snapshot.kind === "inspecting_invitation" ||
    snapshot.kind === "accepting_invitation" ||
    snapshot.kind === "enrolling_totp" ||
    snapshot.kind === "verifying_totp" ||
    snapshot.kind === "processing_pkce_callback" ||
    snapshot.kind === "updating_password" ||
    snapshot.kind === "creating_staff_invitation" ||
    snapshot.kind === "revoking_staff_membership"
  ) {
    const heading =
      snapshot.kind === "signing_out"
        ? snapshot.scope === "all"
          ? "Revoking all sessions"
          : "Signing out"
        : snapshot.kind === "creating_staff_invitation"
          ? `Creating ${roleLabel(snapshot.targetRole)} invitation`
          : snapshot.kind === "revoking_staff_membership"
            ? `Revoking ${roleLabel(snapshot.targetRole)} membership`
            : {
                accepting_invitation: "Accepting invitation",
                bootstrapping: "Checking staff access",
                enrolling_totp: "Preparing authenticator",
                inspecting_invitation: "Checking invitation",
                processing_pkce_callback: "Checking authentication link",
                requesting_recovery: "Requesting recovery",
                sending_email_verification: "Sending verification email",
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
  message.setAttribute(
    "aria-live",
    view.tone === "danger" ? "assertive" : "polite",
  );
  message.setAttribute("role", "status");
  section.append(heading, message);

  if (view.image !== undefined) {
    const image = document.createElement("img");
    image.alt = view.image.alt;
    image.src = view.image.src;
    section.append(image);
  }

  const inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>> =
    {};
  const reportIntentFailure = () => {
    section.dataset.authTone = "danger";
    message.setAttribute("aria-live", "assertive");
    message.textContent =
      "Authentication could not be completed. No access change was confirmed.";
    message.tabIndex = -1;
    message.focus();
  };
  const emit = (action: StaffAuthViewActionId) => {
    const intent = createIntent(action, inputs);
    let outcome: Promise<void> | void;
    try {
      outcome = onIntent(intent);
    } catch {
      reportIntentFailure();
      return;
    } finally {
      clearTransientInputs(inputs);
    }
    void Promise.resolve(outcome).catch(reportIntentFailure);
  };

  const groups = ["primary", "invitation", "membership", "session"] as const;
  for (const group of groups) {
    const fields = view.fields.filter(
      (field) => (field.group ?? "primary") === group,
    );
    const actions = view.actions.filter(
      (action) => (action.group ?? "primary") === group,
    );
    if (fields.length === 0 && actions.length === 0) {
      continue;
    }
    const controls = document.createElement("form");
    controls.noValidate = true;
    let container: HTMLElement = controls;
    if (group !== "primary") {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = {
        invitation: "Invite staff",
        membership: "Revoke staff Membership",
        session: "Session controls",
      }[group];
      fieldset.append(legend);
      controls.append(fieldset);
      container = fieldset;
    }
    for (const field of fields) {
      const label = document.createElement("label");
      const labelText = document.createElement("span");
      labelText.textContent = field.label;
      const input = document.createElement("input");
      input.autocomplete = field.autocomplete;
      input.name = field.id;
      input.required = true;
      input.type = field.type;
      inputs[field.id] = input;
      label.append(labelText, input);
      container.append(label);
    }

    const primaryAction =
      group === "primary" || actions.length === 1 ? actions[0] : undefined;
    controls.addEventListener("submit", (event) => {
      event.preventDefault();
      if (primaryAction !== undefined) {
        emit(primaryAction.id);
      }
    });
    for (const action of actions) {
      const button = document.createElement("button");
      const isPrimary = action === primaryAction;
      button.dataset.authAction = action.id;
      button.textContent = action.label;
      button.type = isPrimary ? "submit" : "button";
      if (!isPrimary) {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          emit(action.id);
        });
      }
      container.append(button);
    }
    section.append(controls);
  }
  root.replaceChildren(section);
  const firstInput = Object.values(inputs)[0];
  if (firstInput !== undefined) {
    firstInput.focus();
  } else {
    heading.tabIndex = -1;
    heading.focus();
  }
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
    case "create_administrator_invitation":
    case "create_teacher_invitation":
      return {
        email: inputs.target_email?.value ?? "",
        targetRole:
          action === "create_administrator_invitation" ? "admin" : "teacher",
        type: "create_staff_invitation",
      };
    case "revoke_administrator_membership":
    case "revoke_teacher_membership":
      return {
        membershipId: inputs.membership_id?.value ?? "",
        targetRole:
          action === "revoke_administrator_membership" ? "admin" : "teacher",
        type: "revoke_staff_membership",
      };
  }
}

export function bindStaffAuthView(
  root: HTMLElement,
  controller: StaffAuthController,
): () => void {
  const handleIntent = async (intent: StaffAuthViewIntent): Promise<void> => {
    try {
      await controller.dispatch(intent);
    } catch {
      const current = controller.getSnapshot();
      renderStaffAuthView(
        root,
        {
          code: "dependency_unavailable",
          kind: "dependency_failure",
          operation: "bootstrap",
          retryable: false,
          revision: current.revision,
        },
        handleIntent,
      );
    }
  };
  const render = (snapshot: StaffAuthSnapshot) => {
    renderStaffAuthView(root, snapshot, handleIntent);
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

function roleLabel(role: ManagedStaffRole | "owner"): string {
  if (role === "administrator") {
    return "Administrator";
  }
  if (role === "owner") {
    return "Owner";
  }
  return "Teacher";
}

function roleWithArticle(role: ManagedStaffRole): string {
  const label = roleLabel(role);
  return `${role === "teacher" ? "a" : "an"} ${label}`;
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unsupported staff authentication state");
}
