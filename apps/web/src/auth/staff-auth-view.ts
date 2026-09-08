import {
  parseStaffDisplayName,
  type ManagedStaffRole,
  type StaffAuthController,
  type StaffAuthSnapshot,
} from "./staff-auth-controller.js";

export type StaffAuthViewActionId =
  | "accept_invitation"
  | "back_to_sign_in"
  | "begin_totp_enrollment"
  | "cancel_totp"
  | "complete_password_recovery"
  | "confirm_callback"
  | "continue_authenticated"
  | "create_administrator_invitation"
  | "create_teacher_invitation"
  | "confirm_staff_invitation_revocation"
  | "confirm_staff_membership_revocation"
  | "cancel_staff_invitation_revocation"
  | "cancel_staff_membership_revocation"
  | "request_recovery"
  | "review_staff_invitation_revocation"
  | "review_staff_membership_revocation"
  | "resend_email_verification"
  | "retry"
  | "revoke_all_sessions"
  | "sign_in"
  | "sign_out_local"
  | "select_totp_factor"
  | "verify_totp";

export interface StaffAuthViewAction {
  readonly group?: "invitation" | "membership" | "session";
  readonly id: StaffAuthViewActionId;
  readonly label: string;
  readonly tone?: "danger";
}

export interface StaffAuthViewField {
  readonly autocomplete: HTMLInputElement["autocomplete"];
  readonly id:
    | "display_name"
    | "email"
    | "new_password"
    | "password"
    | "target_email"
    | "totp";
  readonly group?: "invitation" | "membership";
  readonly label: string;
  readonly type: "email" | "password" | "text";
}

export type StaffAuthViewSelect =
  | {
      readonly group: "primary";
      readonly id: "totp_factor";
      readonly label: string;
      readonly options: readonly {
        readonly choiceId: string;
        readonly label: string;
        readonly value: string;
      }[];
    }
  | {
      readonly group: "membership";
      readonly id: "staff_membership";
      readonly label: string;
      readonly options: readonly {
        readonly label: string;
        readonly profileId: string;
        readonly schoolId: string;
        readonly value: string;
      }[];
    }
  | {
      readonly group: "invitation";
      readonly id: "staff_invitation";
      readonly label: string;
      readonly options: readonly {
        readonly invitationId: string;
        readonly label: string;
        readonly schoolId: string;
        readonly value: string;
      }[];
    };

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
  readonly selects?: readonly StaffAuthViewSelect[];
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
  | {
      readonly displayName: string;
      readonly password: string;
      readonly type: "accept_invitation";
    }
  | { readonly type: "begin_totp_enrollment" }
  | { readonly choiceId: string; readonly type: "select_totp_factor" }
  | { readonly code: string; readonly type: "verify_totp" }
  | { readonly type: "cancel_totp" }
  | { readonly type: "sign_out_local" }
  | { readonly type: "revoke_all_sessions" }
  | { readonly type: "retry" }
  | { readonly type: "confirm_callback" }
  | { readonly type: "bootstrap" }
  | { readonly type: "back_to_sign_in" }
  | { readonly password: string; readonly type: "complete_password_recovery" }
  | {
      readonly email: string;
      readonly schoolId: string;
      readonly targetRole: "admin" | "teacher";
      readonly type: "create_staff_invitation";
    }
  | {
      readonly profileId: string;
      readonly schoolId: string;
      readonly type: "review_staff_membership_revocation";
    }
  | {
      readonly invitationId: string;
      readonly schoolId: string;
      readonly type: "review_staff_invitation_revocation";
    }
  | { readonly type: "confirm_staff_invitation_revocation" }
  | { readonly type: "cancel_staff_invitation_revocation" }
  | { readonly type: "confirm_staff_membership_revocation" }
  | { readonly type: "cancel_staff_membership_revocation" };

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

const displayNameField: StaffAuthViewField = {
  autocomplete: "name",
  id: "display_name",
  label: "Your name",
  type: "text",
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

export function createStaffAuthViewModel(
  snapshot: StaffAuthSnapshot,
): StaffAuthViewModel {
  if (snapshot.kind === "callback_confirmation_required") {
    return {
      actions: [{ id: "confirm_callback", label: "Continue securely" }],
      fields: [],
      heading: "Continue securely",
      message:
        "Confirm that you opened this page before continuing with authentication.",
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "callback_link_lost") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Reopen your email",
      message:
        "This page was reloaded before authentication finished. Reopen the authentication link in your email.",
      status: snapshot.kind,
      tone: "warning",
    };
  }

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
      fields: [displayNameField, newPasswordField],
      heading: `Join ${snapshot.schoolLabel}`,
      message: `${snapshot.intendedEmail} was invited as ${roleWithArticle(snapshot.role)}. Enter the name staff will see and create a password.`,
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "invitation_step_up_required") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Additional verification required",
      message:
        "This invitation needs a new verified session. Sign in, then request a fresh invitation link.",
      status: snapshot.kind,
      tone: "warning",
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
        "This authentication link could not be accepted. Return to sign in to request a new one.",
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

  if (snapshot.kind === "invitation_accepted") {
    const detail =
      snapshot.passwordOutcome === "updated"
        ? "Your password was updated. Sign in again to verify access."
        : snapshot.passwordOutcome === "rejected"
          ? "Your password was not set. Request a password recovery link from sign in."
          : "We could not confirm whether your password was set. Try signing in with the new password, or request a password recovery link.";
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Invitation accepted",
      message: `Your school membership was accepted. ${detail}`,
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "invitation_acceptance_uncertain") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Invitation result unconfirmed",
      message:
        "We could not confirm whether your school membership was accepted. Sign in again to check, or request a password recovery link if you have not set a password.",
      status: snapshot.kind,
      tone: "info",
    };
  }

  if (snapshot.kind === "password_recovery_uncertain") {
    const detail =
      snapshot.passwordOutcome === "updated"
        ? "Your password was updated."
        : snapshot.passwordOutcome === "rejected"
          ? "Your password was not updated."
          : "We could not confirm whether your password was updated.";
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading:
        snapshot.passwordOutcome === "updated"
          ? "Password updated; sign in again"
          : "Check your password by signing in",
      message: `${detail} ${snapshot.cleanupComplete ? "Recovery session cleanup completed." : "We could not confirm that all session cleanup completed."} Try signing in with the new password, or request a new recovery link.`,
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

  if (snapshot.kind === "totp_factor_selection") {
    return {
      actions: [{ id: "select_totp_factor", label: "Continue" }],
      fields: [],
      heading: "Choose an authenticator",
      message: "Choose the authenticator you can use to continue.",
      selects: [
        {
          group: "primary",
          id: "totp_factor",
          label: "Authenticator",
          options: snapshot.choices.map((choice) => ({
            choiceId: choice.choiceId,
            label: choice.label,
            value: choice.choiceId,
          })),
        },
      ],
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

  if (snapshot.kind === "step_up_required") {
    return {
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Additional verification required",
      message:
        "Your current session cannot continue this protected action. Sign in again to restart it.",
      status: snapshot.kind,
      tone: "warning",
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
              group: "invitation",
              id: "review_staff_invitation_revocation",
              label: "Review pending invitation revocation",
              tone: "danger",
            },
            {
              group: "membership",
              id: "review_staff_membership_revocation",
              label: "Review staff access revocation",
              tone: "danger",
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
          tone: "danger",
        },
      ],
      fields: role === "owner" ? [targetEmailField] : [],
      heading: `${roleLabel(role)} access`,
      message: `Signed in as ${snapshot.identity.email} at ${snapshot.identity.school.label}${
        snapshot.assuranceLevel === "aal2" ? " with step-up verification" : ""
      }.`,
      status: snapshot.kind,
      ...(role === "owner"
        ? {
            selects: [
              {
                group: "invitation" as const,
                id: "staff_invitation" as const,
                label: "Pending Administrator or Teacher invitation",
                options: snapshot.manageableInvitations.map((entry) => ({
                  invitationId: entry.invitationId,
                  label: `${entry.email} — ${roleLabel(entry.role)} — ${entry.state === "delivery_unconfirmed" ? "email dispatch unconfirmed" : "email provider accepted dispatch"} — expires ${entry.expiresAt}`,
                  schoolId: entry.schoolId,
                  value: entry.invitationId,
                })),
              },
              {
                group: "membership" as const,
                id: "staff_membership" as const,
                label: "Administrator or Teacher",
                options: snapshot.manageableStaff.map((entry) => ({
                  label: `${entry.profile.displayName} — ${entry.profile.email} — ${roleLabel(entry.role)}`,
                  profileId: entry.profile.id,
                  schoolId: entry.schoolId,
                  value: entry.profile.id,
                })),
              },
            ],
          }
        : {}),
      tone: "success",
    };
  }

  if (snapshot.kind === "confirming_staff_invitation_revocation") {
    return {
      actions: [
        {
          id: "confirm_staff_invitation_revocation",
          label: "Revoke pending invitation",
          tone: "danger",
        },
        { id: "cancel_staff_invitation_revocation", label: "Cancel" },
      ],
      fields: [],
      heading: "Confirm pending invitation revocation",
      message: `Revoke the pending ${roleLabel(snapshot.target.role)} invitation for ${snapshot.target.email} at ${snapshot.schoolLabel}?`,
      status: snapshot.kind,
      tone: "warning",
    };
  }

  if (snapshot.kind === "confirming_staff_membership_revocation") {
    return {
      actions: [
        {
          id: "confirm_staff_membership_revocation",
          label: "Revoke staff access",
          tone: "danger",
        },
        { id: "cancel_staff_membership_revocation", label: "Cancel" },
      ],
      fields: [],
      heading: "Confirm staff access revocation",
      message: `Revoke ${roleLabel(snapshot.target.role)} access for ${snapshot.target.displayName} (${snapshot.target.email}) at ${snapshot.schoolLabel}?`,
      status: snapshot.kind,
      tone: "warning",
    };
  }

  if (
    snapshot.kind === "staff_invitation_created" ||
    snapshot.kind === "staff_invitation_revoked" ||
    snapshot.kind === "staff_membership_revoked"
  ) {
    const created = snapshot.kind === "staff_invitation_created";
    const revokedInvitation = snapshot.kind === "staff_invitation_revoked";
    return {
      actions: [{ id: "continue_authenticated", label: "Continue" }],
      fields: [],
      heading: created
        ? "Invitation created"
        : revokedInvitation
          ? "Invitation revoked"
          : "Membership revoked",
      message: created
        ? `${roleLabel(snapshot.targetRole)} invitation created for ${snapshot.schoolLabel}. The email provider accepted dispatch; mailbox delivery is not confirmed.`
        : revokedInvitation
          ? `${roleLabel(snapshot.targetRole)} invitation revoked for ${snapshot.schoolLabel}.`
          : `${roleLabel(snapshot.targetRole)} membership revoked for ${snapshot.schoolLabel}.`,
      status: snapshot.kind,
      tone: "success",
    };
  }

  if (snapshot.kind === "staff_invitation_delivery") {
    return {
      actions: [{ id: "continue_authenticated", label: "Continue" }],
      fields: [],
      heading:
        snapshot.outcome === "unconfirmed"
          ? "Email dispatch unconfirmed"
          : "Email provider rejected dispatch",
      message:
        snapshot.outcome === "unconfirmed"
          ? "The invitation is saved and any email already sent remains usable. Check pending invitations before trying again; automatic resend is unavailable."
          : "The invitation is saved, but the email provider did not accept this dispatch. Check pending invitations before trying again; automatic resend is unavailable.",
      status: snapshot.kind,
      tone: "warning",
    };
  }

  if (
    snapshot.kind === "staff_invitation_rejected" ||
    snapshot.kind === "staff_invitation_revocation_rejected" ||
    snapshot.kind === "staff_membership_revocation_rejected"
  ) {
    const invitationCreation = snapshot.kind === "staff_invitation_rejected";
    const invitationRevocation =
      snapshot.kind === "staff_invitation_revocation_rejected";
    return {
      actions: [{ id: "continue_authenticated", label: "Continue" }],
      fields: [],
      heading: invitationCreation
        ? "Invitation not created"
        : invitationRevocation
          ? "Invitation not revoked"
          : "Membership not revoked",
      message: invitationCreation
        ? "The staff invitation was not authorized or could not be created."
        : invitationRevocation
          ? "The pending invitation revocation was not authorized or could not be completed."
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
    snapshot.kind === "processing_email_verification_callback" ||
    snapshot.kind === "requesting_recovery" ||
    snapshot.kind === "inspecting_invitation" ||
    snapshot.kind === "accepting_invitation" ||
    snapshot.kind === "enrolling_totp" ||
    snapshot.kind === "verifying_totp" ||
    snapshot.kind === "processing_recovery_callback" ||
    snapshot.kind === "updating_password" ||
    snapshot.kind === "creating_staff_invitation" ||
    snapshot.kind === "revoking_staff_invitation" ||
    snapshot.kind === "revoking_staff_membership"
  ) {
    const heading =
      snapshot.kind === "signing_out"
        ? snapshot.scope === "all"
          ? "Revoking all sessions"
          : "Signing out"
        : snapshot.kind === "creating_staff_invitation"
          ? `Creating ${roleLabel(snapshot.targetRole)} invitation`
          : snapshot.kind === "revoking_staff_invitation"
            ? `Revoking ${roleLabel(snapshot.targetRole)} invitation`
            : snapshot.kind === "revoking_staff_membership"
              ? `Revoking ${roleLabel(snapshot.targetRole)} membership`
              : {
                  accepting_invitation: "Accepting invitation",
                  bootstrapping: "Checking staff access",
                  enrolling_totp: "Preparing authenticator",
                  inspecting_invitation: "Checking invitation",
                  processing_email_verification_callback:
                    "Checking verification link",
                  processing_recovery_callback: "Checking recovery link",
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
  section.className = "staff-auth";
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
    image.className = "staff-auth__qr";
    image.alt = view.image.alt;
    image.src = view.image.src;
    section.append(image);
  }

  const inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>> =
    {};
  const selects: Partial<Record<StaffAuthViewSelect["id"], HTMLSelectElement>> =
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
    if (
      action === "accept_invitation" &&
      parseStaffDisplayName(inputs.display_name?.value) === null
    ) {
      section.dataset.authTone = "danger";
      message.setAttribute("aria-live", "assertive");
      message.textContent =
        "Enter your name without leading, trailing, or control characters and keep it within 160 UTF-8 bytes.";
      inputs.display_name?.setAttribute("aria-invalid", "true");
      inputs.display_name?.focus();
      return;
    }
    inputs.display_name?.removeAttribute("aria-invalid");
    const intent = createIntent(action, inputs, selects, view, snapshot);
    if (intent === null) {
      const pendingInvitation = action === "review_staff_invitation_revocation";
      const pendingFactor = action === "select_totp_factor";
      message.setAttribute("aria-live", "assertive");
      message.textContent = pendingFactor
        ? "Select an authenticator to continue."
        : pendingInvitation
          ? "Select a pending Administrator or Teacher invitation to continue."
          : "Select an Administrator or Teacher to continue.";
      (pendingFactor
        ? selects.totp_factor
        : pendingInvitation
          ? selects.staff_invitation
          : selects.staff_membership
      )?.focus();
      return;
    }
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
    const groupSelects = (view.selects ?? []).filter(
      (select) => select.group === group,
    );
    if (
      fields.length === 0 &&
      actions.length === 0 &&
      groupSelects.length === 0
    ) {
      continue;
    }
    const controls = document.createElement("form");
    controls.className = "staff-auth__form";
    controls.noValidate = true;
    let container: HTMLElement = controls;
    if (group !== "primary") {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "staff-auth__group";
      const legend = document.createElement("legend");
      legend.textContent = {
        invitation: "Manage staff invitations",
        membership: "Revoke staff access",
        session: "Session controls",
      }[group];
      fieldset.append(legend);
      controls.append(fieldset);
      container = fieldset;
    }
    for (const field of fields) {
      const label = document.createElement("label");
      label.className = "staff-auth__field";
      const labelText = document.createElement("span");
      labelText.textContent = field.label;
      const input = document.createElement("input");
      input.autocomplete = field.autocomplete;
      input.name = field.id;
      input.required = true;
      input.type = field.type;
      if (field.id === "display_name") {
        input.maxLength = 160;
      }
      inputs[field.id] = input;
      label.append(labelText, input);
      container.append(label);
    }
    for (const field of groupSelects) {
      const label = document.createElement("label");
      label.className = "staff-auth__field";
      const labelText = document.createElement("span");
      labelText.textContent = field.label;
      const select = document.createElement("select");
      select.name = field.id;
      select.required = true;
      const placeholder = document.createElement("option");
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent =
        field.id === "staff_invitation"
          ? "Select pending invitation"
          : field.id === "totp_factor"
            ? "Select authenticator"
            : "Select staff member";
      placeholder.value = "";
      select.append(placeholder);
      for (const optionModel of field.options) {
        const option = document.createElement("option");
        option.textContent = optionModel.label;
        option.value = optionModel.value;
        select.append(option);
      }
      selects[field.id] = select;
      label.append(labelText, select);
      container.append(label);
    }

    const primaryAction = actions[0];
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
      if (action.tone !== undefined) {
        button.dataset.authActionTone = action.tone;
      }
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
  const firstControl = firstInput ?? Object.values(selects)[0];
  if (firstControl !== undefined) {
    firstControl.focus();
  } else {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function createIntent(
  action: StaffAuthViewActionId,
  inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>>,
  selects: Partial<Record<StaffAuthViewSelect["id"], HTMLSelectElement>>,
  view: StaffAuthViewModel,
  snapshot: StaffAuthSnapshot,
): StaffAuthViewIntent | null {
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
        displayName: inputs.display_name?.value ?? "",
        password: inputs.new_password?.value ?? "",
        type: "accept_invitation",
      };
    case "begin_totp_enrollment":
      return { type: "begin_totp_enrollment" };
    case "select_totp_factor": {
      const selectedValue = selects.totp_factor?.value ?? "";
      const selected = view.selects
        ?.find((model) => model.id === "totp_factor")
        ?.options.find((option) => option.value === selectedValue);
      return selected === undefined
        ? null
        : { choiceId: selected.choiceId, type: "select_totp_factor" };
    }
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
    case "confirm_callback":
      return { type: "confirm_callback" };
    case "back_to_sign_in":
      return { type: "back_to_sign_in" };
    case "continue_authenticated":
      return { type: "bootstrap" };
    case "complete_password_recovery":
      return {
        password: inputs.new_password?.value ?? "",
        type: "complete_password_recovery",
      };
    case "create_administrator_invitation":
    case "create_teacher_invitation": {
      if (
        snapshot.kind !== "authenticated" ||
        snapshot.identity.membership.role !== "owner"
      ) {
        return null;
      }
      return {
        email: inputs.target_email?.value ?? "",
        schoolId: snapshot.identity.school.id,
        targetRole:
          action === "create_administrator_invitation" ? "admin" : "teacher",
        type: "create_staff_invitation",
      };
    }
    case "review_staff_membership_revocation": {
      const selectedValue = selects.staff_membership?.value ?? "";
      const selected = view.selects
        ?.find((model) => model.id === "staff_membership")
        ?.options.find((option) => option.value === selectedValue);
      return selected === undefined
        ? null
        : {
            profileId: selected.profileId,
            schoolId: selected.schoolId,
            type: "review_staff_membership_revocation",
          };
    }
    case "review_staff_invitation_revocation": {
      const selectedValue = selects.staff_invitation?.value ?? "";
      const selected = view.selects
        ?.find((model) => model.id === "staff_invitation")
        ?.options.find((option) => option.value === selectedValue);
      return selected === undefined
        ? null
        : {
            invitationId: selected.invitationId,
            schoolId: selected.schoolId,
            type: "review_staff_invitation_revocation",
          };
    }
    case "confirm_staff_invitation_revocation":
      return { type: "confirm_staff_invitation_revocation" };
    case "cancel_staff_invitation_revocation":
      return { type: "cancel_staff_invitation_revocation" };
    case "confirm_staff_membership_revocation":
      return { type: "confirm_staff_membership_revocation" };
    case "cancel_staff_membership_revocation":
      return { type: "cancel_staff_membership_revocation" };
  }
}

/**
 * Binds one controller to one component root. The returned idempotent disposer
 * owns controller teardown, including revoking any ephemeral TOTP presentation.
 */
export function bindStaffAuthView(
  root: HTMLElement,
  controller: StaffAuthController,
): () => void {
  let bound = true;
  const handleIntent = async (intent: StaffAuthViewIntent): Promise<void> => {
    try {
      await controller.dispatch(intent);
    } catch {
      if (!bound) {
        return;
      }
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
    if (bound) {
      renderStaffAuthView(root, snapshot, handleIntent);
    }
  };
  render(controller.getSnapshot());
  const unsubscribe = controller.subscribe(render);
  return () => {
    if (!bound) {
      return;
    }
    bound = false;
    unsubscribe();
    controller.dispose();
    root.replaceChildren();
  };
}

function clearTransientInputs(
  inputs: Partial<Record<StaffAuthViewField["id"], HTMLInputElement>>,
): void {
  if (inputs.display_name !== undefined) {
    inputs.display_name.value = "";
  }
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
