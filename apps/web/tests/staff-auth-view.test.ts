import { describe, expect, it } from "vitest";

import {
  createStaffAuthViewModel,
  renderStaffAuthView,
  type StaffAuthViewIntent,
} from "../src/auth/staff-auth-view.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, (event: Event) => void>();
  autocomplete = "";
  name = "";
  textContent: string | null = null;
  type = "";
  value = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length, ...children);
  }
}

class FakeDocument {
  createElement(tagName: string) {
    return new FakeElement(this, tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("staff auth view", () => {
  it("renders a signed-out staff login without self-signup or account-link actions", () => {
    const view = createStaffAuthViewModel({
      kind: "signed_out",
      notice: null,
      revision: 1,
    });

    expect(view).toMatchObject({
      actions: [
        { id: "sign_in", label: "Sign in" },
        { id: "request_recovery", label: "Forgot password?" },
      ],
      fields: [
        { autocomplete: "email", id: "email", label: "Email", type: "email" },
        {
          autocomplete: "current-password",
          id: "password",
          label: "Password",
          type: "password",
        },
      ],
      heading: "Staff sign in",
      status: "signed_out",
    });
    expect(view.actions.map(({ id }) => id)).not.toContain("sign_up");
    expect(view.actions.map(({ id }) => id)).not.toContain("link_account");
    expect(view.actions.map(({ id }) => id)).not.toContain("invite_owner");
  });

  it.each([
    ["invalid", "This invitation link is invalid."],
    ["expired", "This invitation link has expired."],
    ["replayed", "This invitation link has already been used."],
  ] as const)(
    "renders a sanitized %s invitation failure",
    (reason, message) => {
      const view = createStaffAuthViewModel({
        kind: "invitation_rejected",
        reason,
        revision: 1,
      });

      expect(view).toMatchObject({
        actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
        fields: [],
        heading: "Invitation unavailable",
        message,
        status: "invitation_rejected",
        tone: "danger",
      });
    },
  );

  it("labels storage role admin as Administrator on invitation acceptance", () => {
    const view = createStaffAuthViewModel({
      kind: "invitation_ready",
      revision: 1,
      role: "administrator",
      schoolLabel: "Synthetic High School",
    });

    expect(view).toMatchObject({
      actions: [{ id: "accept_invitation", label: "Accept invitation" }],
      fields: [
        {
          autocomplete: "new-password",
          id: "new_password",
          label: "Create password",
          type: "password",
        },
      ],
      heading: "Join Synthetic High School",
      message: "You were invited as an Administrator.",
      status: "invitation_ready",
    });
    expect(view.message).not.toContain("admin");
  });

  it("renders password-recovery request and callback failures without identity or provider detail", () => {
    const notice = createStaffAuthViewModel({
      kind: "recovery_notice",
      revision: 1,
    });
    const rejectedCallback = createStaffAuthViewModel({
      code: "state_mismatch",
      kind: "callback_rejected",
      revision: 2,
    });

    expect(notice).toMatchObject({
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      heading: "Check your email",
      message:
        "If that address can receive recovery email, instructions are on the way.",
      tone: "success",
    });
    expect(rejectedCallback).toMatchObject({
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      heading: "Authentication link unavailable",
      message:
        "This authentication link could not be accepted. Request a new one.",
      tone: "danger",
    });
    expect(JSON.stringify([notice, rejectedCallback])).not.toContain(
      "state_mismatch",
    );
  });

  it.each([
    [
      { kind: "sign_in_rejected", revision: 1 } as const,
      "Sign-in failed",
      "Email or password was not accepted.",
      ["sign_in", "request_recovery"],
    ],
    [
      { kind: "email_verification_required", revision: 1 } as const,
      "Verify your email",
      "Verify your email before signing in.",
      ["resend_email_verification", "back_to_sign_in"],
    ],
    [
      { kind: "email_verification_sent", revision: 1 } as const,
      "Verification email sent",
      "Check your email for a new verification link.",
      ["resend_email_verification", "back_to_sign_in"],
    ],
    [
      { kind: "password_recovery_ready", revision: 1 } as const,
      "Set a new password",
      "Choose a new password for this staff account.",
      ["complete_password_recovery"],
    ],
    [
      { kind: "password_recovery_complete", revision: 1 } as const,
      "Password updated",
      "Your password was updated. Sign in again to continue.",
      ["back_to_sign_in"],
    ],
    [
      { kind: "password_recovery_rejected", revision: 1 } as const,
      "Password not updated",
      "The password could not be updated. Request a new recovery link.",
      ["back_to_sign_in"],
    ],
  ])("renders the %s state", (snapshot, heading, message, actionIds) => {
    const view = createStaffAuthViewModel(snapshot);

    expect(view).toMatchObject({ heading, message, status: snapshot.kind });
    expect(view.actions.map(({ id }) => id)).toEqual(actionIds);
  });

  it("renders enrollment and challenge states without exposing a TOTP seed", () => {
    const enrollment = createStaffAuthViewModel({
      kind: "totp_enrollment_required",
      revision: 1,
      role: "administrator",
    });
    const challenge = createStaffAuthViewModel({
      feedback: "rejected",
      kind: "totp_challenge",
      purpose: "step_up",
      revision: 2,
      role: "administrator",
    });

    expect(enrollment).toMatchObject({
      actions: [{ id: "begin_totp_enrollment", label: "Set up authenticator" }],
      fields: [],
      heading: "Secure Administrator access",
    });
    expect(challenge).toMatchObject({
      actions: [
        { id: "verify_totp", label: "Verify" },
        { id: "cancel_totp", label: "Cancel" },
      ],
      fields: [
        {
          autocomplete: "one-time-code",
          id: "totp",
          label: "Authenticator code",
          type: "text",
        },
      ],
      heading: "Verify Administrator access",
      message: "That authenticator code was not accepted. Try again.",
    });
    expect(JSON.stringify([enrollment, challenge])).not.toMatch(
      /totp[_-]?secret|otpauth|shared[_-]?secret/i,
    );
  });

  it("renders authenticated Administrator controls with local and all-session logout", () => {
    const view = createStaffAuthViewModel({
      assuranceLevel: "aal2",
      email: "admin@example.test",
      kind: "authenticated",
      revision: 1,
      role: "administrator",
    });

    expect(view).toMatchObject({
      actions: [
        { id: "sign_out_local", label: "Sign out here" },
        { id: "revoke_all_sessions", label: "Sign out everywhere" },
      ],
      fields: [],
      heading: "Administrator access",
      message: "Signed in as admin@example.test with step-up verification.",
      tone: "success",
    });
  });

  it.each([
    [
      { kind: "session_expired", revision: 1 } as const,
      "Session expired",
      "Your session expired. Sign in again to continue.",
    ],
    [
      { kind: "session_revoked", revision: 1 } as const,
      "Session revoked",
      "This session was revoked. Sign in again if access is still allowed.",
    ],
    [
      { kind: "membership_inactive", revision: 1 } as const,
      "School access inactive",
      "Your School Membership is not active. Contact a School Owner.",
    ],
  ])(
    "renders the authoritative %s access loss",
    (snapshot, heading, message) => {
      const view = createStaffAuthViewModel(snapshot);

      expect(view).toMatchObject({
        actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
        fields: [],
        heading,
        message,
        tone: "danger",
      });
    },
  );

  it("renders a retry only for retryable dependency failures without provider detail", () => {
    const retryable = createStaffAuthViewModel({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "revoke_all_sessions",
      retryable: true,
      revision: 1,
    });
    const terminal = createStaffAuthViewModel({
      code: "invalid_backend_result",
      kind: "dependency_failure",
      operation: "sign_in",
      retryable: false,
      revision: 2,
    });

    expect(retryable).toMatchObject({
      actions: [
        { id: "retry", label: "Retry" },
        { id: "back_to_sign_in", label: "Back to sign in" },
      ],
      heading: "Authentication temporarily unavailable",
      message: "No access change was confirmed. Try again.",
      tone: "danger",
    });
    expect(terminal.actions).toEqual([
      { id: "back_to_sign_in", label: "Back to sign in" },
    ]);
    expect(JSON.stringify([retryable, terminal])).not.toMatch(
      /dependency_unavailable|invalid_backend_result|revoke_all_sessions/i,
    );
  });

  it.each([
    [{ kind: "bootstrapping", revision: 1 } as const, "Checking staff access"],
    [{ kind: "signing_in", revision: 1 } as const, "Signing in"],
    [
      { kind: "signing_out", revision: 1, scope: "local" } as const,
      "Signing out",
    ],
    [
      { kind: "signing_out", revision: 1, scope: "all" } as const,
      "Revoking all sessions",
    ],
    [
      { kind: "requesting_recovery", revision: 1 } as const,
      "Requesting recovery",
    ],
    [
      { kind: "inspecting_invitation", revision: 1 } as const,
      "Checking invitation",
    ],
    [
      { kind: "accepting_invitation", revision: 1 } as const,
      "Accepting invitation",
    ],
    [
      { kind: "enrolling_totp", revision: 1 } as const,
      "Preparing authenticator",
    ],
    [
      { kind: "verifying_totp", revision: 1 } as const,
      "Verifying authenticator",
    ],
    [
      { kind: "processing_pkce_callback", revision: 1 } as const,
      "Checking recovery link",
    ],
    [{ kind: "updating_password", revision: 1 } as const, "Updating password"],
  ])("renders pending state %s", (snapshot, heading) => {
    const view = createStaffAuthViewModel(snapshot);

    expect(view).toMatchObject({
      actions: [],
      fields: [],
      heading,
      status: snapshot.kind,
      tone: "info",
    });
  });

  it("renders DOM controls, emits transient sign-in input, and clears the password field", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];

    renderStaffAuthView(
      root as unknown as HTMLElement,
      { kind: "signed_out", notice: null, revision: 1 },
      (intent) => {
        intents.push(intent);
      },
    );
    const nodes = descendants(root);
    const email = nodes.find((node) => node.name === "email");
    const password = nodes.find((node) => node.name === "password");
    const signIn = nodes.find((node) => node.dataset.authAction === "sign_in");
    if (email === undefined || password === undefined || signIn === undefined) {
      throw new Error("expected rendered login controls");
    }
    email.value = "teacher@example.test";
    password.value = "SENTINEL-password";

    signIn.listeners.get("click")?.({
      preventDefault() {},
    } as unknown as Event);

    expect(intents).toEqual([
      {
        email: "teacher@example.test",
        password: "SENTINEL-password",
        type: "sign_in",
      },
    ]);
    expect(password.value).toBe("");
    expect(
      descendants(root)
        .map(({ textContent }) => textContent)
        .join(" "),
    ).not.toContain("SENTINEL");
  });
});
