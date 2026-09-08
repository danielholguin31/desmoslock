import { describe, expect, it, vi } from "vitest";

import {
  bindStaffAuthView,
  createStaffAuthViewModel,
  renderStaffAuthView,
  type StaffAuthViewIntent,
} from "../src/auth/staff-auth-view.js";
import type {
  StaffAuthController,
  StaffAuthSnapshot,
} from "../src/auth/staff-auth-controller.js";

class FakeElement {
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, (event: Event) => void>();
  autocomplete = "";
  alt = "";
  className = "";
  disabled = false;
  name = "";
  noValidate = false;
  required = false;
  selected = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  src = "";
  tabIndex = 0;
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

  focus() {
    this.ownerDocument.activeElement = this;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElement(tagName: string) {
    return new FakeElement(this, tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function namedControl(root: FakeElement, name: string): FakeElement {
  const element = descendants(root).find((node) => node.name === name);
  if (element === undefined) throw new Error(`expected ${name} control`);
  return element;
}

function activateAuthAction(root: FakeElement, action: string): void {
  const nodes = descendants(root);
  const button = nodes.find(({ dataset }) => dataset.authAction === action);
  if (button === undefined || button.disabled) {
    throw new Error(`expected enabled ${action} action`);
  }
  const eventTarget =
    button.type === "submit"
      ? nodes.find(
          (node) =>
            node.tagName === "form" && descendants(node).includes(button),
        )
      : button;
  const listener = eventTarget?.listeners.get(
    button.type === "submit" ? "submit" : "click",
  );
  if (listener === undefined)
    throw new Error(`expected ${action} event handler`);
  listener({ preventDefault() {} } as Event);
}

function authenticatedSnapshot(role: "administrator" | "owner" | "teacher") {
  const roleId = role === "administrator" ? "admin" : role;
  return {
    assuranceLevel: "aal2" as const,
    identity: {
      accountId: `account-${roleId}`,
      email: `${roleId}@example.test`,
      profile: {
        displayName: `${role} Staff`,
        id: `profile-${roleId}`,
      },
      membership: {
        id: `membership-${roleId}`,
        role,
        status: "active" as const,
      },
      school: {
        id: "school-1",
        label: "Synthetic High School",
        settingsRevision: 1,
      },
    },
    identityGeneration: `identity-${role}`,
    kind: "authenticated" as const,
    manageableInvitations:
      role !== "teacher"
        ? [
            {
              email: "pending@example.test",
              expiresAt: "2026-09-04T12:00:00.000Z",
              invitationId: "invitation-pending",
              role: "teacher" as const,
              schoolId: "school-1",
              state: "pending" as const,
            },
          ]
        : [],
    manageableStaff:
      role !== "teacher"
        ? [
            {
              profile: {
                displayName:
                  role === "owner" ? "Ada Administrator" : "Terry Teacher",
                email:
                  role === "owner" ? "ada@example.test" : "terry@example.test",
                id: "profile-target",
              },
              role:
                role === "owner"
                  ? ("administrator" as const)
                  : ("teacher" as const),
              roleRevision: 1,
              schoolId: "school-1",
            },
          ]
        : [],
    revision: 1,
    sessionGeneration: `session-${role}`,
  };
}

describe("staff auth view", () => {
  it("renders a neutral callback confirmation and emits only an explicit continue intent", () => {
    const snapshot = {
      kind: "callback_confirmation_required",
      revision: 1,
    } as const;
    const view = createStaffAuthViewModel(snapshot);

    expect(view).toEqual({
      actions: [{ id: "confirm_callback", label: "Continue securely" }],
      fields: [],
      heading: "Continue securely",
      message:
        "Confirm that you opened this page before continuing with authentication.",
      status: "callback_confirmation_required",
      tone: "info",
    });
    expect(JSON.stringify(view)).not.toMatch(
      /invite|recovery|verification|token|code/i,
    );

    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(root as unknown as HTMLElement, snapshot, (intent) => {
      intents.push(intent);
    });
    const form = descendants(root).find(({ tagName }) => tagName === "form");
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([{ type: "confirm_callback" }]);
  });

  it("renders generic reopen-email guidance after an unconfirmed callback reload", () => {
    const view = createStaffAuthViewModel({
      kind: "callback_link_lost",
      revision: 1,
    });

    expect(view).toEqual({
      actions: [{ id: "back_to_sign_in", label: "Back to sign in" }],
      fields: [],
      heading: "Reopen your email",
      message:
        "This page was reloaded before authentication finished. Reopen the authentication link in your email.",
      status: "callback_link_lost",
      tone: "warning",
    });
    expect(JSON.stringify(view)).not.toMatch(/token|code|hash|flow|state/i);
  });

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

  it("renders only local factor choices and emits the explicit selection", () => {
    const snapshot = {
      choices: [
        { choiceId: "factor-1", label: "Phone (Authenticator 1)" },
        { choiceId: "factor-2", label: "Security key (Authenticator 2)" },
      ],
      kind: "totp_factor_selection",
      revision: 1,
      role: "owner",
    } as const;
    const view = createStaffAuthViewModel(snapshot);
    expect(view).toMatchObject({
      actions: [{ id: "select_totp_factor", label: "Continue" }],
      heading: "Choose an authenticator",
      selects: [
        {
          id: "totp_factor",
          options: [
            { label: "Phone (Authenticator 1)", value: "factor-1" },
            { label: "Security key (Authenticator 2)", value: "factor-2" },
          ],
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/receipt|51000000/i);

    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(root as unknown as HTMLElement, snapshot, (intent) => {
      intents.push(intent);
    });
    const nodes = descendants(root);
    const factor = nodes.find(({ name }) => name === "totp_factor");
    const form = nodes.find(
      (node) =>
        node.tagName === "form" &&
        descendants(node).some(({ name }) => name === "totp_factor"),
    );
    if (factor === undefined || form === undefined) {
      throw new Error("expected factor-selection controls");
    }
    factor.value = "factor-2";
    form.listeners.get("submit")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([
      { choiceId: "factor-2", type: "select_totp_factor" },
    ]);
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
      intendedEmail: "admin@example.test",
      kind: "invitation_ready",
      revision: 1,
      role: "administrator",
      schoolLabel: "Synthetic High School",
    });

    expect(view).toMatchObject({
      actions: [{ id: "accept_invitation", label: "Accept invitation" }],
      fields: [
        {
          autocomplete: "name",
          id: "display_name",
          label: "Your name",
          type: "text",
        },
        {
          autocomplete: "new-password",
          id: "new_password",
          label: "Create password",
          type: "password",
        },
      ],
      heading: "Join Synthetic High School",
      status: "invitation_ready",
    });
    expect(view.message).toContain(
      "admin@example.test was invited as an Administrator.",
    );
    expect(view.message).not.toContain("as an admin");
  });

  it.each(["", " Leading", "Trailing ", "Bad\u0000Name", "😀".repeat(41)])(
    "blocks invalid invitation display name %j in the visible form",
    (displayName) => {
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const intents: StaffAuthViewIntent[] = [];
      renderStaffAuthView(
        root as unknown as HTMLElement,
        {
          intendedEmail: "teacher@example.test",
          kind: "invitation_ready",
          revision: 1,
          role: "teacher",
          schoolLabel: "Synthetic High School",
        },
        (intent) => {
          intents.push(intent);
        },
      );
      const nodes = descendants(root);
      const name = nodes.find(({ name }) => name === "display_name");
      const password = nodes.find(({ name }) => name === "new_password");
      const form = nodes.find(({ tagName }) => tagName === "form");
      if (name === undefined || password === undefined || form === undefined) {
        throw new Error("expected invitation form");
      }
      name.value = displayName;
      password.value = "new-password";
      form.listeners.get("submit")?.({ preventDefault() {} } as Event);

      expect(intents).toEqual([]);
      expect(name.attributes["aria-invalid"]).toBe("true");
      expect(document.activeElement).toBe(name);
      expect(
        nodes.find(({ tagName }) => tagName === "p")?.textContent,
      ).toContain("160 UTF-8 bytes");
    },
  );

  it("submits and clears a valid 160-byte invitation display name", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        intendedEmail: "teacher@example.test",
        kind: "invitation_ready",
        revision: 1,
        role: "teacher",
        schoolLabel: "Synthetic High School",
      },
      (intent) => {
        intents.push(intent);
      },
    );
    const nodes = descendants(root);
    const name = nodes.find(({ name }) => name === "display_name");
    const password = nodes.find(({ name }) => name === "new_password");
    const form = nodes.find(({ tagName }) => tagName === "form");
    if (name === undefined || password === undefined || form === undefined) {
      throw new Error("expected invitation form");
    }
    name.value = "😀".repeat(40);
    password.value = "new-password";
    form.listeners.get("submit")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([
      {
        displayName: "😀".repeat(40),
        password: "new-password",
        type: "accept_invitation",
      },
    ]);
    expect(name.value).toBe("");
    expect(password.value).toBe("");
  });

  it("renders an explicit recoverable invitation step-up notice", () => {
    expect(
      createStaffAuthViewModel({
        kind: "invitation_step_up_required",
        revision: 1,
      }),
    ).toMatchObject({
      heading: "Additional verification required",
      tone: "warning",
    });
  });

  it("renders password-recovery request and callback failures without identity or provider detail", () => {
    const notice = createStaffAuthViewModel({
      kind: "recovery_notice",
      revision: 1,
    });
    const rejectedCallback = createStaffAuthViewModel({
      code: "recovery_state_mismatch",
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
        "This authentication link could not be accepted. Return to sign in to request a new one.",
      tone: "danger",
    });
    expect(JSON.stringify([notice, rejectedCallback])).not.toContain(
      "recovery_state_mismatch",
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
      feedback: "none",
      kind: "totp_enrollment_required",
      revision: 1,
      role: "administrator",
    });
    const challenge = createStaffAuthViewModel({
      feedback: "rejected",
      kind: "totp_challenge",
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
    const view = createStaffAuthViewModel(
      authenticatedSnapshot("administrator"),
    );

    expect(view).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "sign_out_local",
          label: "Sign out here",
        }),
        expect.objectContaining({
          id: "revoke_all_sessions",
          label: "Sign out everywhere",
        }),
      ]),
      fields: [{ id: "target_email" }],
      heading: "Administrator access",
      message:
        "Signed in as admin@example.test at Synthetic High School with step-up verification.",
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

  it.each(["local_logout", "revoke_all_sessions"] as const)(
    "describes uncertain %s without claiming no change or offering replay",
    (operation) => {
      expect(
        createStaffAuthViewModel({
          code: "dependency_unavailable",
          kind: "dependency_failure",
          operation,
          retryable: false,
          revision: 1,
        }),
      ).toMatchObject({
        actions: [{ id: "back_to_sign_in", label: "Start again" }],
        heading: "Sign out unconfirmed",
        message:
          "We couldn’t confirm sign-out. Start again to check your session.",
      });
    },
  );

  it("renders a retry only for retryable dependency failures without provider detail", () => {
    const retryable = createStaffAuthViewModel({
      code: "dependency_unavailable",
      kind: "dependency_failure",
      operation: "bootstrap",
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
        { id: "back_to_sign_in", label: "Start again" },
      ],
      heading: "Authentication temporarily unavailable",
      message: "No access change was confirmed. Try again.",
      tone: "danger",
    });
    expect(terminal.actions).toEqual([
      { id: "back_to_sign_in", label: "Start again" },
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
      { kind: "processing_recovery_callback", revision: 1 } as const,
      "Checking recovery link",
    ],
    [
      { kind: "sending_email_verification", revision: 1 } as const,
      "Sending verification email",
    ],
    [
      {
        kind: "creating_staff_invitation",
        revision: 1,
        targetRole: "administrator",
      } as const,
      "Creating Administrator invitation",
    ],
    [
      {
        kind: "revoking_staff_membership",
        revision: 1,
        targetRole: "teacher",
      } as const,
      "Revoking Teacher membership",
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
    const form = nodes.find((node) => node.tagName === "form");
    if (email === undefined || password === undefined || form === undefined) {
      throw new Error("expected rendered login controls");
    }
    email.value = "teacher@example.test";
    password.value = "SENTINEL-password";

    form.listeners.get("submit")?.({
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

  it("renders an ephemeral TOTP provisioning QR without a seed or enrollment receipt", () => {
    const view = createStaffAuthViewModel({
      kind: "totp_provisioning",
      qrBlobUrl: "blob:https://app.example.test/opaque-presentation",
      revision: 1,
      role: "administrator",
    });

    expect(view).toMatchObject({
      actions: [
        { id: "verify_totp", label: "Verify setup" },
        { id: "cancel_totp", label: "Cancel" },
      ],
      image: {
        alt: "Authenticator enrollment QR code",
        src: "blob:https://app.example.test/opaque-presentation",
      },
    });
    expect(JSON.stringify(view)).not.toMatch(
      /otpauth|enrollment.?receipt|shared.?secret/i,
    );
  });

  it("gives Owners both managed roles and Administrators Teacher-only commands", () => {
    const owner = createStaffAuthViewModel(authenticatedSnapshot("owner"));
    const administrator = createStaffAuthViewModel(
      authenticatedSnapshot("administrator"),
    );

    expect(owner.actions.map(({ id }) => id)).toEqual([
      "create_administrator_invitation",
      "create_teacher_invitation",
      "review_staff_invitation_revocation",
      "review_staff_membership_revocation",
      "review_staff_membership_role_change",
      "sign_out_local",
      "revoke_all_sessions",
    ]);
    expect(owner.fields.map(({ id }) => id)).toEqual(["target_email"]);
    expect(
      owner.selects?.find(({ id }) => id === "staff_membership"),
    ).toMatchObject({
      id: "staff_membership",
      options: [
        {
          label: "Ada Administrator — ada@example.test — Administrator",
          profileId: "profile-target",
          schoolId: "school-1",
          value: "profile-target",
        },
      ],
    });
    expect(
      owner.selects?.find(({ id }) => id === "staff_invitation"),
    ).toMatchObject({
      id: "staff_invitation",
      options: [
        {
          invitationId: "invitation-pending",
          schoolId: "school-1",
          value: "invitation-pending",
        },
      ],
    });
    expect(owner.actions.map(({ id }) => id)).not.toContain("invite_owner");
    expect(administrator.actions.map(({ id }) => id)).toEqual([
      "create_teacher_invitation",
      "review_staff_invitation_revocation",
      "review_staff_membership_revocation",
      "sign_out_local",
      "revoke_all_sessions",
    ]);
    expect(administrator.fields.map(({ id }) => id)).toEqual(["target_email"]);
    expect(administrator.selects?.map(({ options }) => options)).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ invitationId: "invitation-pending" }),
      ]),
      expect.arrayContaining([
        expect.objectContaining({
          label: "Terry Teacher — terry@example.test — Teacher",
        }),
      ]),
    ]);
    expect(administrator.actions.map(({ id }) => id)).not.toContain(
      "review_staff_membership_role_change",
    );
  });

  it.each(["owner", "administrator", "teacher"] as const)(
    "does not expose management controls to an AAL1 %s",
    (role) => {
      const view = createStaffAuthViewModel({
        ...authenticatedSnapshot(role),
        assuranceLevel: "aal1",
      });

      expect(view.fields).toEqual([]);
      expect(view.selects ?? []).toEqual([]);
      expect(view.actions.map(({ id }) => id)).toEqual([
        "sign_out_local",
        "revoke_all_sessions",
      ]);
    },
  );

  it("keeps Teacher access free of management controls even at AAL2", () => {
    const view = createStaffAuthViewModel(authenticatedSnapshot("teacher"));

    expect(view.fields).toEqual([]);
    expect(view.selects ?? []).toEqual([]);
    expect(view.actions.map(({ id }) => id)).toEqual([
      "sign_out_local",
      "revoke_all_sessions",
    ]);
  });

  it("filters Administrator targets to Teachers even when a supplied list contains Administrators", () => {
    const administrator = authenticatedSnapshot("administrator");
    const owner = authenticatedSnapshot("owner");
    const view = createStaffAuthViewModel({
      ...administrator,
      manageableInvitations: [
        ...administrator.manageableInvitations,
        {
          email: "pending-admin@example.test",
          expiresAt: "2026-09-14T12:00:00.000Z",
          invitationId: "invitation-admin",
          role: "administrator",
          schoolId: "school-1",
          state: "pending",
        },
      ],
      manageableStaff: [
        ...administrator.manageableStaff,
        ...owner.manageableStaff.map((entry) => ({
          ...entry,
          profile: { ...entry.profile, id: "profile-admin" },
        })),
      ],
    });

    expect(
      view.selects?.find(({ id }) => id === "staff_membership")?.options,
    ).toEqual([
      expect.objectContaining({
        label: "Terry Teacher — terry@example.test — Teacher",
        value: "profile-target",
      }),
    ]);
    expect(
      view.selects?.find(({ id }) => id === "staff_invitation")?.options,
    ).toEqual([expect.objectContaining({ value: "invitation-pending" })]);
    expect(JSON.stringify(view)).not.toContain("pending-admin@example.test");
    expect(JSON.stringify(view)).not.toContain("ada@example.test");
  });

  it.each(["owner", "administrator"] as const)(
    "explains empty %s lists and disables actions that need a target",
    (role) => {
      const snapshot = {
        ...authenticatedSnapshot(role),
        manageableInvitations: [],
        manageableStaff: [],
      };
      const view = createStaffAuthViewModel(snapshot);
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const intents: StaffAuthViewIntent[] = [];
      renderStaffAuthView(
        root as unknown as HTMLElement,
        snapshot,
        (intent) => {
          intents.push(intent);
        },
      );
      const nodes = descendants(root);

      expect(view.groupMessages?.invitation).toEqual(expect.any(String));
      expect(view.groupMessages?.membership).toEqual(expect.any(String));
      expect(view.groupMessages?.invitation?.length).toBeGreaterThan(0);
      expect(view.groupMessages?.membership?.length).toBeGreaterThan(0);
      for (const action of view.actions.filter(({ id }) =>
        id.startsWith("review_"),
      )) {
        expect(action.disabled).toBe(true);
        expect(
          nodes.find(({ dataset }) => dataset.authAction === action.id)
            ?.disabled,
        ).toBe(true);
      }
      expect(
        nodes.find(({ name }) => name === "staff_invitation")?.disabled,
      ).toBe(true);
      expect(
        nodes.find(({ name }) => name === "staff_membership")?.disabled,
      ).toBe(true);
      expect(
        view.actions.find(({ id }) => id === "create_teacher_invitation")
          ?.disabled,
      ).not.toBe(true);
      const membershipForm = nodes.find(
        (node) =>
          node.tagName === "form" &&
          descendants(node).some(({ name }) => name === "staff_membership"),
      );
      membershipForm?.listeners.get("submit")?.({
        preventDefault() {},
      } as Event);
      expect(intents).toEqual([]);
    },
  );

  it.each([
    [
      {
        kind: "staff_invitation_revoked",
        revision: 1,
        schoolLabel: "Synthetic High School",
        targetRole: "teacher",
      } as const,
      "Invitation revoked",
      "Teacher invitation revoked for Synthetic High School.",
    ],
    [
      {
        kind: "staff_invitation_created",
        revision: 1,
        schoolLabel: "Synthetic High School",
        targetRole: "administrator",
      } as const,
      "Invitation created",
      "Administrator invitation created for Synthetic High School. The email provider accepted dispatch; mailbox delivery is not confirmed.",
    ],
    [
      { kind: "staff_invitation_revocation_rejected", revision: 1 } as const,
      "Invitation not revoked",
      "The pending invitation revocation was not authorized or could not be completed.",
    ],
    [
      {
        kind: "staff_membership_revoked",
        revision: 1,
        schoolLabel: "Synthetic High School",
        targetRole: "teacher",
      } as const,
      "Membership revoked",
      "Teacher membership revoked for Synthetic High School.",
    ],
    [
      { kind: "staff_invitation_rejected", revision: 1 } as const,
      "Invitation not created",
      "The staff invitation was not authorized or could not be created.",
    ],
    [
      { kind: "staff_membership_revocation_rejected", revision: 1 } as const,
      "Membership not revoked",
      "The staff membership revocation was not authorized or could not be completed.",
    ],
  ])("renders the Owner command result %s", (snapshot, heading, message) => {
    expect(createStaffAuthViewModel(snapshot)).toMatchObject({
      heading,
      message,
    });
  });

  it("renders a form with status semantics and focuses the first input", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");

    renderStaffAuthView(
      root as unknown as HTMLElement,
      { kind: "signed_out", notice: null, revision: 1 },
      () => undefined,
    );

    const nodes = descendants(root);
    const form = nodes.find(({ tagName }) => tagName === "form");
    const status = nodes.find(({ attributes }) => attributes.role === "status");
    const email = nodes.find(({ name }) => name === "email");
    expect(form).toBeDefined();
    expect(status?.attributes["aria-live"]).toBe("polite");
    expect(document.activeElement).toBe(email);
  });

  it("focuses a heading when a state has no input", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      { kind: "session_expired", revision: 1 },
      () => undefined,
    );

    expect(document.activeElement?.tagName).toBe("h1");
    expect(document.activeElement?.tabIndex).toBe(-1);
  });

  it("dispatches an explicit provider-session reset from Back to sign in", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(
      root as unknown as HTMLElement,
      { kind: "session_expired", revision: 1 },
      (intent) => {
        intents.push(intent);
      },
    );
    const form = descendants(root).find(({ tagName }) => tagName === "form");
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([{ type: "back_to_sign_in" }]);
  });

  it("returns from authenticated management feedback without signing out", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        kind: "staff_membership_revoked",
        revision: 1,
        schoolLabel: "North High",
        targetRole: "teacher",
      },
      (intent) => {
        intents.push(intent);
      },
    );
    const form = descendants(root).find(({ tagName }) => tagName === "form");
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([{ type: "bootstrap" }]);
  });

  it("renders a closed authentication view without actions", () => {
    expect(
      createStaffAuthViewModel({ kind: "disposed", revision: 2 }),
    ).toMatchObject({
      actions: [],
      heading: "Authentication view closed",
      status: "disposed",
    });
  });

  it("maps Owner invite and authoritative staff-selection controls without exposing an ID", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(
      root as unknown as HTMLElement,
      authenticatedSnapshot("owner"),
      (intent) => {
        intents.push(intent);
      },
    );
    const nodes = descendants(root);
    const email = nodes.find(({ name }) => name === "target_email");
    const pendingInvitation = nodes.find(
      ({ name }) => name === "staff_invitation",
    );
    const membership = nodes.find(({ name }) => name === "staff_membership");
    const inviteTeacher = nodes.find(
      ({ dataset }) => dataset.authAction === "create_teacher_invitation",
    );
    const reviewRevocation = nodes.find(
      ({ dataset }) =>
        dataset.authAction === "review_staff_membership_revocation",
    );
    const reviewInvitationRevocation = nodes.find(
      ({ dataset }) =>
        dataset.authAction === "review_staff_invitation_revocation",
    );
    const reviewRoleChange = nodes.find(
      ({ dataset }) =>
        dataset.authAction === "review_staff_membership_role_change",
    );
    if (
      email === undefined ||
      pendingInvitation === undefined ||
      membership === undefined ||
      inviteTeacher === undefined ||
      reviewRevocation === undefined ||
      reviewInvitationRevocation === undefined ||
      reviewRoleChange === undefined
    ) {
      throw new Error("expected Owner staff-management controls");
    }
    email.value = "teacher@example.test";

    const membershipForm = nodes.find(
      (node) =>
        node.tagName === "form" &&
        descendants(node).some(({ name }) => name === "staff_membership"),
    );
    membershipForm?.listeners.get("submit")?.({
      preventDefault() {},
    } as Event);
    expect(intents).toEqual([]);

    reviewInvitationRevocation.listeners.get("click")?.({
      preventDefault() {},
    } as Event);
    expect(intents).toEqual([]);

    pendingInvitation.value = "invitation-pending";
    membership.value = "profile-target";
    inviteTeacher.listeners.get("click")?.({ preventDefault() {} } as Event);
    reviewInvitationRevocation.listeners.get("click")?.({
      preventDefault() {},
    } as Event);
    membershipForm?.listeners.get("submit")?.({
      preventDefault() {},
    } as Event);
    reviewRoleChange.listeners.get("click")?.({ preventDefault() {} } as Event);

    expect(intents).toEqual([
      {
        email: "teacher@example.test",
        schoolId: "school-1",
        targetRole: "teacher",
        type: "create_staff_invitation",
      },
      {
        invitationId: "invitation-pending",
        schoolId: "school-1",
        type: "review_staff_invitation_revocation",
      },
      {
        profileId: "profile-target",
        schoolId: "school-1",
        type: "review_staff_membership_revocation",
      },
      {
        profileId: "profile-target",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      },
    ]);
    expect(reviewRoleChange.type).toBe("button");
    expect(JSON.stringify(intents)).not.toContain("roleRevision");
    expect(JSON.stringify(intents)).not.toContain('"targetRole":"owner"');
    expect(
      nodes
        .map(({ textContent }) => textContent)
        .filter(Boolean)
        .join(" "),
    ).not.toContain("profile-target");
    expect(
      nodes
        .map(({ textContent }) => textContent)
        .filter(Boolean)
        .join(" "),
    ).not.toContain("invitation-pending");
    expect(reviewRevocation.dataset.authActionTone).toBe("danger");
    expect(reviewInvitationRevocation.dataset.authActionTone).toBe("danger");
  });

  it("retains input and select nodes, draft, caret and focus while an unrelated staff entry changes", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const intents: StaffAuthViewIntent[] = [];
    const onIntent = (intent: StaffAuthViewIntent) => {
      intents.push(intent);
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    const invitation = namedControl(root, "staff_invitation");
    email.value = "new-teacher@example.test";
    email.selectionStart = 4;
    email.selectionEnd = 11;
    membership.value = "profile-target";
    invitation.value = "invitation-pending";
    email.focus();

    const refreshed = {
      ...original,
      manageableStaff: [
        ...original.manageableStaff,
        {
          profile: {
            displayName: "New Teacher",
            email: "other@example.test",
            id: "profile-other",
          },
          role: "teacher" as const,
          roleRevision: 2,
          schoolId: "school-1",
        },
      ],
      revision: original.revision + 1,
    };
    renderStaffAuthView(root as unknown as HTMLElement, refreshed, onIntent);

    expect(namedControl(root, "target_email")).toBe(email);
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(namedControl(root, "staff_invitation")).toBe(invitation);
    expect(email.value).toBe("new-teacher@example.test");
    expect(email.selectionStart).toBe(4);
    expect(email.selectionEnd).toBe(11);
    expect(membership.value).toBe("profile-target");
    expect(invitation.value).toBe("invitation-pending");
    expect(document.activeElement).toBe(email);
    expect(
      membership.children.some(({ value }) => value === "profile-other"),
    ).toBe(true);
    membership.value = "profile-other";
    const review = descendants(root).find(
      ({ dataset }) =>
        dataset.authAction === "review_staff_membership_role_change",
    );
    review?.listeners.get("click")?.({ preventDefault() {} } as Event);
    expect(intents).toEqual([
      {
        profileId: "profile-other",
        schoolId: "school-1",
        type: "review_staff_membership_role_change",
      },
    ]);
  });

  it.each(["account", "session"] as const)(
    "discards the old management draft and selected target when the %s changes",
    (change) => {
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const original = authenticatedSnapshot("owner");
      renderStaffAuthView(
        root as unknown as HTMLElement,
        original,
        () => undefined,
      );
      const email = namedControl(root, "target_email");
      const membership = namedControl(root, "staff_membership");
      email.value = "old-draft@example.test";
      membership.value = "profile-target";
      membership.focus();
      const replacement = {
        ...original,
        ...(change === "account"
          ? {
              identity: {
                ...original.identity,
                accountId: "account-other-owner",
                email: "other-owner@example.test",
                profile: {
                  displayName: "Other Owner",
                  id: "profile-other-owner",
                },
              },
              identityGeneration: "identity-other-owner",
            }
          : { sessionGeneration: "session-other-owner" }),
        revision: original.revision + 1,
      };
      renderStaffAuthView(
        root as unknown as HTMLElement,
        replacement,
        () => undefined,
      );

      const nextEmail = namedControl(root, "target_email");
      const nextMembership = namedControl(root, "staff_membership");
      expect(nextEmail).not.toBe(email);
      expect(nextMembership).not.toBe(membership);
      expect(nextEmail.value).toBe("");
      expect(nextMembership.value).toBe("");
      expect(document.activeElement).toBe(nextEmail);
    },
  );

  it("clears a selected staff target whose revision changed while keeping the unrelated invitation draft", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      original,
      () => undefined,
    );
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    email.value = "new-teacher@example.test";
    membership.value = "profile-target";
    membership.focus();

    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        ...original,
        manageableStaff: original.manageableStaff.map((entry) => ({
          ...entry,
          roleRevision: entry.roleRevision + 1,
        })),
        notice: "staff_selection_changed",
        revision: original.revision + 1,
      },
      () => undefined,
    );

    expect(namedControl(root, "target_email")).toBe(email);
    expect(email.value).toBe("new-teacher@example.test");
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(membership.value).toBe("");
    expect(document.activeElement).toBe(membership);
  });

  it("restores the unchanged management draft and review-button focus after Cancel", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const intents: StaffAuthViewIntent[] = [];
    const onIntent = (intent: StaffAuthViewIntent): void => {
      intents.push(intent);
      if (intent.type === "review_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "confirming_staff_membership_role_change",
            revision: 2,
            schoolLabel: "Synthetic High School",
            target: {
              displayName: "Ada Administrator",
              email: "ada@example.test",
              role: "administrator",
            },
            targetRole: "teacher",
          },
          onIntent,
        );
      } else if (intent.type === "cancel_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          { ...original, revision: 3 },
          onIntent,
        );
      }
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    email.value = "new-teacher@example.test";
    membership.value = "profile-target";
    const review = descendants(root).find(
      ({ dataset }) =>
        dataset.authAction === "review_staff_membership_role_change",
    );
    if (review === undefined) throw new Error("expected role-review button");
    review.focus();
    review.listeners.get("click")?.({ preventDefault() {} } as Event);
    const cancel = descendants(root).find(
      ({ dataset }) =>
        dataset.authAction === "cancel_staff_membership_role_change",
    );
    if (cancel === undefined)
      throw new Error("expected role-change cancellation");
    cancel.listeners.get("click")?.({ preventDefault() {} } as Event);

    expect(namedControl(root, "target_email")).toBe(email);
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(email.value).toBe("new-teacher@example.test");
    expect(membership.value).toBe("profile-target");
    expect(document.activeElement).toBe(review);
    expect(intents.map(({ type }) => type)).toEqual([
      "review_staff_membership_role_change",
      "cancel_staff_membership_role_change",
    ]);
  });

  it("preserves unrelated drafts through a preconfirm role conflict and refreshes to an unselected staff control", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const intents: StaffAuthViewIntent[] = [];
    const onIntent = (intent: StaffAuthViewIntent): void => {
      intents.push(intent);
      if (intent.type === "review_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "confirming_staff_membership_role_change",
            revision: 2,
            schoolLabel: "Synthetic High School",
            target: {
              displayName: "Ada Administrator",
              email: "ada@example.test",
              role: "administrator",
            },
            targetRole: "teacher",
          },
          onIntent,
        );
      } else if (intent.type === "confirm_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "staff_membership_revision_conflict",
            revision: 3,
          },
          onIntent,
        );
      } else if (intent.type === "refresh_staff") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "bootstrapping",
            revision: 4,
          },
          onIntent,
        );
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            ...original,
            manageableStaff: original.manageableStaff.map((entry) => ({
              ...entry,
              roleRevision: entry.roleRevision + 1,
            })),
            revision: 5,
          },
          onIntent,
        );
      }
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    const invitation = namedControl(root, "staff_invitation");
    email.value = "unrelated-draft@example.test";
    membership.value = "profile-target";
    invitation.value = "invitation-pending";

    activateAuthAction(root, "review_staff_membership_role_change");
    activateAuthAction(root, "confirm_staff_membership_role_change");
    expect(descendants(root).some(({ name }) => name === "target_email")).toBe(
      false,
    );
    activateAuthAction(root, "refresh_staff");

    expect(namedControl(root, "target_email")).toBe(email);
    expect(email.value).toBe("unrelated-draft@example.test");
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(membership.value).toBe("");
    expect(namedControl(root, "staff_invitation")).toBe(invitation);
    expect(invitation.value).toBe("invitation-pending");
    expect(document.activeElement).toBe(membership);
    expect(intents.map(({ type }) => type)).toEqual([
      "review_staff_membership_role_change",
      "confirm_staff_membership_role_change",
      "refresh_staff",
    ]);
  });

  it("preserves a valid draft when changed invitation facts cancel an open confirmation", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const intents: StaffAuthViewIntent[] = [];
    const onIntent = (intent: StaffAuthViewIntent): void => {
      intents.push(intent);
      if (intent.type === "review_staff_invitation_revocation") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "confirming_staff_invitation_revocation",
            revision: 2,
            schoolLabel: "Synthetic High School",
            target: { email: "pending@example.test", role: "teacher" },
          },
          onIntent,
        );
      }
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    const invitation = namedControl(root, "staff_invitation");
    email.value = "unrelated-draft@example.test";
    membership.value = "profile-target";
    invitation.value = "invitation-pending";
    activateAuthAction(root, "review_staff_invitation_revocation");

    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        ...original,
        manageableInvitations: original.manageableInvitations.map((entry) => ({
          ...entry,
          expiresAt: "2026-09-15T12:00:00.000Z",
        })),
        notice: "staff_selection_changed",
        revision: 3,
      },
      onIntent,
    );

    expect(namedControl(root, "target_email")).toBe(email);
    expect(email.value).toBe("unrelated-draft@example.test");
    expect(namedControl(root, "staff_invitation")).toBe(invitation);
    expect(invitation.value).toBe("");
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(membership.value).toBe("profile-target");
    expect(document.activeElement).toBe(invitation);
    expect(
      descendants(root).some(
        ({ dataset }) =>
          dataset.authAction === "confirm_staff_invitation_revocation",
      ),
    ).toBe(false);
    expect(intents.map(({ type }) => type)).toEqual([
      "review_staff_invitation_revocation",
    ]);
  });

  it("discards the retained management form once a confirmed role change enters its busy state", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const onIntent = (intent: StaffAuthViewIntent): void => {
      if (intent.type === "review_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "confirming_staff_membership_role_change",
            revision: 2,
            schoolLabel: "Synthetic High School",
            target: {
              displayName: "Ada Administrator",
              email: "ada@example.test",
              role: "administrator",
            },
            targetRole: "teacher",
          },
          onIntent,
        );
      } else if (intent.type === "confirm_staff_membership_role_change") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          {
            kind: "changing_staff_membership_role",
            revision: 3,
            targetRole: "teacher",
          },
          onIntent,
        );
      } else if (intent.type === "refresh_staff") {
        renderStaffAuthView(
          root as unknown as HTMLElement,
          { kind: "bootstrapping", revision: 5 },
          onIntent,
        );
        renderStaffAuthView(
          root as unknown as HTMLElement,
          { ...original, revision: 6 },
          onIntent,
        );
      }
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    email.value = "old-draft@example.test";
    membership.value = "profile-target";
    activateAuthAction(root, "review_staff_membership_role_change");
    activateAuthAction(root, "confirm_staff_membership_role_change");
    expect(
      descendants(root).filter(({ tagName }) => tagName === "button"),
    ).toEqual([]);
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        kind: "staff_membership_revision_conflict",
        revision: 4,
      },
      onIntent,
    );
    activateAuthAction(root, "refresh_staff");

    expect(namedControl(root, "target_email")).not.toBe(email);
    expect(namedControl(root, "target_email").value).toBe("");
    expect(namedControl(root, "staff_membership")).not.toBe(membership);
    expect(namedControl(root, "staff_membership").value).toBe("");
  });

  it("removes management controls and their focused draft when an Administrator becomes a Teacher", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("administrator");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      original,
      () => undefined,
    );
    const email = namedControl(root, "target_email");
    email.value = "old-draft@example.test";
    email.focus();
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        ...original,
        identity: {
          ...original.identity,
          membership: { ...original.identity.membership, role: "teacher" },
        },
        manageableInvitations: [],
        manageableStaff: [],
        notice: "staff_access_changed",
        revision: original.revision + 1,
      },
      () => undefined,
    );

    expect(descendants(root).some(({ name }) => name === "target_email")).toBe(
      false,
    );
    expect(
      descendants(root).some(({ name }) => name === "staff_membership"),
    ).toBe(false);
    expect(document.activeElement).not.toBe(email);
    expect(document.activeElement?.tagName).toBe("h1");
  });

  it("requires an identity-and-School confirmation before destructive revocation", () => {
    const view = createStaffAuthViewModel({
      kind: "confirming_staff_membership_revocation",
      revision: 2,
      schoolLabel: "Synthetic High School",
      target: {
        displayName: "Ada Administrator",
        email: "ada@example.test",
        role: "administrator",
      },
    });

    expect(view).toMatchObject({
      actions: [
        {
          id: "confirm_staff_membership_revocation",
          label: "Revoke staff access",
          tone: "danger",
        },
        { id: "cancel_staff_membership_revocation", label: "Cancel" },
      ],
      heading: "Confirm staff access revocation",
      message:
        "Revoke Administrator access for Ada Administrator (ada@example.test) at Synthetic High School?",
    });
    expect(JSON.stringify(view)).not.toContain("profile-target");
  });

  it("shows the person, School and both roles before a role change and emits only explicit confirmation or cancellation", () => {
    const snapshot: StaffAuthSnapshot = {
      kind: "confirming_staff_membership_role_change",
      revision: 2,
      schoolLabel: "Synthetic High School",
      target: {
        displayName: "Ada Administrator",
        email: "ada@example.test",
        role: "administrator",
      },
      targetRole: "teacher",
    };
    const view = createStaffAuthViewModel(snapshot);
    expect(view.actions.map(({ id }) => id)).toEqual([
      "confirm_staff_membership_role_change",
      "cancel_staff_membership_role_change",
    ]);
    expect(view.message).toContain("Ada Administrator");
    expect(view.message).toContain("ada@example.test");
    expect(view.message).toContain("Synthetic High School");
    expect(view.message).toContain("Administrator");
    expect(view.message).toContain("Teacher");
    expect(view.fields).toEqual([]);
    expect(view.selects ?? []).toEqual([]);
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(root as unknown as HTMLElement, snapshot, (intent) => {
      intents.push(intent);
    });
    const nodes = descendants(root);
    const form = nodes.find(({ tagName }) => tagName === "form");
    const cancel = nodes.find(
      ({ dataset }) =>
        dataset.authAction === "cancel_staff_membership_role_change",
    );
    expect(intents).toEqual([]);
    expect(document.activeElement?.tagName).toBe("h1");
    cancel?.listeners.get("click")?.({ preventDefault() {} } as Event);
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);
    expect(intents).toEqual([
      { type: "cancel_staff_membership_role_change" },
      { type: "confirm_staff_membership_role_change" },
    ]);
  });

  it("withholds role-change commands while the change is pending", () => {
    const view = createStaffAuthViewModel({
      kind: "changing_staff_membership_role",
      revision: 3,
      targetRole: "teacher",
    });

    expect(view.actions).toEqual([]);
    expect(view.fields).toEqual([]);
    expect(`${view.heading} ${view.message}`).toContain("Teacher");
    expect(view.tone).not.toBe("success");
  });

  it("identifies the confirmed role change and requires a read before returning to staff management", () => {
    const view = createStaffAuthViewModel({
      kind: "staff_membership_role_changed",
      manageableStaff: [],
      revision: 4,
      schoolLabel: "Synthetic High School",
      targetName: "Ada Administrator",
      targetRole: "teacher",
    });

    expect(view.tone).toBe("success");
    expect(view.message).toBe(
      "Changed Ada Administrator’s role to Teacher at Synthetic High School.",
    );
    expect(view.actions.map(({ id }) => id)).toContain("refresh_staff");
    expect(view.actions.map(({ id }) => id)).not.toContain(
      "confirm_staff_membership_role_change",
    );
  });

  it("describes the completed change historically when the authoritative list has a newer opposite role", () => {
    const confirmedRoleRevision = 7;
    const view = createStaffAuthViewModel({
      kind: "staff_membership_role_changed",
      manageableStaff: [
        {
          profile: {
            displayName: "Taylor Staff",
            email: "taylor@example.test",
            id: "profile-target",
          },
          role: "administrator",
          roleRevision: confirmedRoleRevision + 2,
          schoolId: "school-1",
        },
      ],
      revision: 4,
      schoolLabel: "Synthetic High School",
      targetName: "Taylor Staff",
      targetRole: "teacher",
    });

    expect(view.message).toBe(
      "Changed Taylor Staff’s role to Teacher at Synthetic High School.",
    );
    expect(view.message).not.toMatch(/is now|currently|current role/i);
    expect(view.actions).toEqual([
      { id: "refresh_staff", label: "Refresh staff" },
    ]);
    expect(view.tone).toBe("success");
  });

  it("distinguishes a rejected role change, an unconfirmed write and a stale target without replay actions", () => {
    const kinds = [
      "staff_membership_role_change_rejected",
      "staff_membership_role_change_unconfirmed",
      "staff_membership_revision_conflict",
    ] as const;
    const views = kinds.map((kind) =>
      createStaffAuthViewModel({ kind, revision: 4 }),
    );

    expect(new Set(views.map(({ heading }) => heading)).size).toBe(3);
    for (const view of views) {
      expect(view.tone).not.toBe("success");
      expect(view.actions.map(({ id }) => id)).toContain("refresh_staff");
      expect(view.actions.map(({ id }) => id)).not.toContain("retry");
      expect(view.actions.map(({ id }) => id)).not.toContain(
        "confirm_staff_membership_role_change",
      );
    }
    expect(views[1]?.message).toMatch(/confirm|unknown|uncertain/i);
    expect(views[1]?.message).not.toMatch(
      /no (?:access |role )?change was made/i,
    );
    expect(`${views[2]?.heading} ${views[2]?.message}`).toMatch(
      /changed|stale|refresh/i,
    );
  });

  it("refreshes staff after an unconfirmed role change without resubmitting the write", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const intents: StaffAuthViewIntent[] = [];
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        kind: "staff_membership_role_change_unconfirmed",
        revision: 4,
      },
      (intent) => {
        intents.push(intent);
      },
    );
    const nodes = descendants(root);
    const refresh = nodes.find(
      ({ dataset }) => dataset.authAction === "refresh_staff",
    );
    if (refresh === undefined) throw new Error("expected staff refresh action");
    expect(intents).toEqual([]);
    if (refresh.type === "submit") {
      const form = nodes.find(
        (node) =>
          node.tagName === "form" && descendants(node).includes(refresh),
      );
      form?.listeners.get("submit")?.({ preventDefault() {} } as Event);
    } else {
      refresh.listeners.get("click")?.({ preventDefault() {} } as Event);
    }
    expect(intents).toEqual([{ type: "refresh_staff" }]);
  });

  it("requires email, role, and School confirmation before revoking an invitation", () => {
    const view = createStaffAuthViewModel({
      kind: "confirming_staff_invitation_revocation",
      revision: 2,
      schoolLabel: "Synthetic High School",
      target: { email: "pending@example.test", role: "teacher" },
    });
    expect(view).toMatchObject({
      actions: [
        {
          id: "confirm_staff_invitation_revocation",
          label: "Revoke pending invitation",
          tone: "danger",
        },
        { id: "cancel_staff_invitation_revocation", label: "Cancel" },
      ],
      heading: "Confirm pending invitation revocation",
      message:
        "Revoke the pending Teacher invitation for pending@example.test at Synthetic High School?",
    });
    expect(JSON.stringify(view)).not.toContain("invitation-pending");
  });

  it("makes the binding disposer idempotently own controller and DOM teardown", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const dispose = vi.fn();
    const unsubscribe = vi.fn();
    const initial: StaffAuthSnapshot = {
      kind: "signed_out",
      notice: null,
      revision: 1,
    };
    const controller: StaffAuthController = {
      async dispatch() {
        return initial;
      },
      dispose,
      getSnapshot() {
        return initial;
      },
      async refreshMembership() {
        return { kind: "unavailable" } as const;
      },
      getProductAccess() {
        return { kind: "unavailable" };
      },
      subscribe() {
        return unsubscribe;
      },
    };

    const unbind = bindStaffAuthView(
      root as unknown as HTMLElement,
      controller,
    );
    expect(root.children).toHaveLength(1);
    unbind();
    unbind();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(root.children).toEqual([]);
  });

  it("catches a rejected intent and announces a sanitized failure", async () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      { kind: "signed_out", notice: null, revision: 1 },
      async () => {
        throw new Error("SENTINEL-renderer-detail");
      },
    );
    const form = descendants(root).find(({ tagName }) => tagName === "form");
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);
    await Promise.resolve();
    await Promise.resolve();

    const nodes = descendants(root);
    const status = nodes.find(({ attributes }) => attributes.role === "status");
    expect(status?.textContent).toBe(
      "Authentication could not be completed. No access change was confirmed.",
    );
    expect(status?.textContent).not.toContain("SENTINEL");
    expect(status?.attributes["aria-live"]).toBe("assertive");
  });

  it("has the DOM binder catch a rejected controller dispatch", async () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const initial: StaffAuthSnapshot = {
      kind: "signed_out",
      notice: null,
      revision: 1,
    };
    const controller: StaffAuthController = {
      async dispatch() {
        throw new Error("SENTINEL-controller-detail");
      },
      dispose() {},
      getSnapshot() {
        return initial;
      },
      async refreshMembership() {
        return { kind: "unavailable" } as const;
      },
      getProductAccess() {
        return { kind: "unavailable" };
      },
      subscribe() {
        return () => undefined;
      },
    };
    bindStaffAuthView(root as unknown as HTMLElement, controller);
    const form = descendants(root).find(({ tagName }) => tagName === "form");
    form?.listeners.get("submit")?.({ preventDefault() {} } as Event);
    await Promise.resolve();
    await Promise.resolve();

    const text = descendants(root)
      .map(({ textContent }) => textContent)
      .join(" ");
    expect(text).toContain("Authentication temporarily unavailable");
    expect(text).not.toContain("SENTINEL");
  });
});

describe("auth outcome honesty", () => {
  it("does not portray unknown password update as failure or successful completion", () => {
    const view = createStaffAuthViewModel({
      kind: "password_recovery_uncertain",
      passwordOutcome: "unknown",
      cleanupComplete: false,
      revision: 1,
    });
    expect(view.message).toContain(
      "could not confirm whether your password was updated",
    );
    expect(view.message).toContain(
      "could not confirm that all session cleanup completed",
    );
    expect(view.actions).toEqual([
      { id: "back_to_sign_in", label: "Back to sign in" },
    ]);
    expect(view.fields).toEqual([]);
  });
  it("explains accepted Membership and unknown password separately", () => {
    const view = createStaffAuthViewModel({
      kind: "invitation_accepted",
      passwordOutcome: "unknown",
      revision: 1,
    });
    expect(view.heading).toBe("Invitation accepted");
    expect(view.message).toContain("school membership was accepted");
    expect(view.message).toContain(
      "could not confirm whether your password was set",
    );
    expect(view.fields).toEqual([]);
  });
  it.each(["unconfirmed", "rejected"] as const)(
    "keeps %s delivery usable without an automatic resend action",
    (outcome) => {
      const view = createStaffAuthViewModel({
        kind: "staff_invitation_delivery",
        outcome,
        revision: 1,
      });
      expect(view.message).toContain("invitation is saved");
      expect(view.actions).toEqual([
        { id: "continue_authenticated", label: "Continue" },
      ]);
    },
  );
});

describe("School presentation updates in staff management", () => {
  const target = {
    displayName: "Taylor Staff",
    email: "taylor@example.test",
    role: "teacher" as const,
  };
  const confirmationCases = [
    {
      kind: "confirming_staff_membership_role_change",
      target,
      targetRole: "administrator",
    },
    { kind: "confirming_staff_membership_revocation", target },
    {
      kind: "confirming_staff_invitation_revocation",
      target: { email: target.email, role: target.role },
    },
  ] as const;
  const outcomeCases = [
    {
      kind: "staff_membership_role_changed",
      targetName: target.displayName,
      targetRole: "administrator",
      manageableStaff: [],
    },
    { kind: "staff_invitation_created", targetRole: "teacher" },
    { kind: "staff_invitation_revoked", targetRole: "teacher" },
    { kind: "staff_membership_revoked", targetRole: "teacher" },
  ] as const;

  it.each([...confirmationCases, ...outcomeCases])(
    "patches only the School text in $kind and keeps the latest action callback",
    (state) => {
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const original = {
        ...state,
        schoolLabel: "Original School",
        revision: 1,
      };
      const oldIntent = vi.fn();
      const newIntent = vi.fn();
      renderStaffAuthView(root as unknown as HTMLElement, original, oldIntent);
      const section = root.children[0];
      const buttons = descendants(root).filter(
        (node) => node.tagName === "button",
      );
      const active = buttons.at(-1);
      if (active === undefined) throw new Error("Expected an action");
      active.focus();
      renderStaffAuthView(
        root as unknown as HTMLElement,
        { ...original, schoolLabel: "Renamed School", revision: 2 },
        newIntent,
      );
      expect(root.children[0]).toBe(section);
      expect(
        descendants(root).filter((node) => node.tagName === "button"),
      ).toEqual(buttons);
      expect(document.activeElement).toBe(active);
      const text = descendants(root)
        .map((node) => node.textContent)
        .join(" ");
      expect(text).toContain("Renamed School");
      expect(text).not.toContain("Original School");
      activateAuthAction(root, active.dataset.authAction ?? "");
      expect(newIntent).toHaveBeenCalledTimes(1);
      expect(oldIntent).not.toHaveBeenCalled();
    },
  );

  it("keeps the authenticated invitation draft, caret and target choices when only School presentation changes", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      original,
      () => undefined,
    );
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    const invitation = namedControl(root, "staff_invitation");
    email.value = "new-teacher@example.test";
    email.selectionStart = 4;
    email.selectionEnd = 11;
    membership.value = "profile-target";
    invitation.value = "invitation-pending";
    email.focus();
    renderStaffAuthView(
      root as unknown as HTMLElement,
      {
        ...original,
        revision: 2,
        identity: {
          ...original.identity,
          school: {
            ...original.identity.school,
            label: "Renamed School",
            settingsRevision: 2,
          },
        },
      },
      () => undefined,
    );
    expect(namedControl(root, "target_email")).toBe(email);
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(namedControl(root, "staff_invitation")).toBe(invitation);
    expect(email.value).toBe("new-teacher@example.test");
    expect([email.selectionStart, email.selectionEnd]).toEqual([4, 11]);
    expect(membership.value).toBe("profile-target");
    expect(invitation.value).toBe("invitation-pending");
    expect(document.activeElement).toBe(email);
    expect(
      descendants(root)
        .map((node) => node.textContent)
        .join(" "),
    ).toContain("Renamed School");
  });

  it("retains the detached invitation draft and original review controls through rename then Cancel", () => {
    const document = new FakeDocument();
    const root = new FakeElement(document, "main");
    const original = authenticatedSnapshot("owner");
    const refreshed = {
      ...original,
      revision: 4,
      identity: {
        ...original.identity,
        school: {
          ...original.identity.school,
          label: "Renamed School",
          settingsRevision: 2,
        },
      },
    };
    const confirmation = {
      kind: "confirming_staff_membership_role_change",
      revision: 2,
      schoolLabel: original.identity.school.label,
      target: {
        displayName: "Ada Administrator",
        email: "ada@example.test",
        role: "administrator",
      },
      targetRole: "teacher",
    } as const;
    const onIntent = (intent: StaffAuthViewIntent) => {
      if (intent.type === "review_staff_membership_role_change")
        renderStaffAuthView(
          root as unknown as HTMLElement,
          confirmation,
          onIntent,
        );
      if (intent.type === "cancel_staff_membership_role_change")
        renderStaffAuthView(
          root as unknown as HTMLElement,
          refreshed,
          onIntent,
        );
    };
    renderStaffAuthView(root as unknown as HTMLElement, original, onIntent);
    const email = namedControl(root, "target_email");
    const membership = namedControl(root, "staff_membership");
    email.value = "draft@example.test";
    email.selectionStart = 2;
    email.selectionEnd = 6;
    membership.value = "profile-target";
    const review = descendants(root).find(
      (node) =>
        node.dataset.authAction === "review_staff_membership_role_change",
    );
    activateAuthAction(root, "review_staff_membership_role_change");
    renderStaffAuthView(
      root as unknown as HTMLElement,
      { ...confirmation, revision: 3, schoolLabel: "Renamed School" },
      onIntent,
    );
    activateAuthAction(root, "cancel_staff_membership_role_change");
    expect(namedControl(root, "target_email")).toBe(email);
    expect(email.value).toBe("draft@example.test");
    expect([email.selectionStart, email.selectionEnd]).toEqual([2, 6]);
    expect(namedControl(root, "staff_membership")).toBe(membership);
    expect(membership.value).toBe("profile-target");
    expect(document.activeElement).toBe(review);
  });

  it.each([
    "email",
    "current role",
    "target role",
    "authoritative list",
  ] as const)(
    "rebuilds when %s changes instead of treating it as presentation",
    (change) => {
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const confirmation = {
        ...confirmationCases[0],
        schoolLabel: "Original School",
        revision: 1,
      };
      const outcome = {
        ...outcomeCases[0],
        manageableStaff: authenticatedSnapshot("owner").manageableStaff,
        schoolLabel: "Original School",
        revision: 1,
      };
      const original = change === "authoritative list" ? outcome : confirmation;
      renderStaffAuthView(
        root as unknown as HTMLElement,
        original,
        () => undefined,
      );
      const section = root.children[0];
      const next =
        change === "authoritative list"
          ? {
              ...outcome,
              revision: 2,
              manageableStaff: outcome.manageableStaff.map((entry) => ({
                ...entry,
                roleRevision: entry.roleRevision + 1,
              })),
            }
          : {
              ...confirmation,
              revision: 2,
              target: {
                ...confirmation.target,
                ...(change === "email"
                  ? { email: "other@example.test" }
                  : change === "current role"
                    ? { role: "administrator" as const }
                    : {}),
              },
              ...(change === "target role"
                ? { targetRole: "teacher" as const }
                : {}),
            };
      renderStaffAuthView(
        root as unknown as HTMLElement,
        next,
        () => undefined,
      );
      expect(root.children[0]).not.toBe(section);
    },
  );

  it.each([
    {
      kind: "changing_staff_membership_role",
      revision: 2,
      targetRole: "administrator",
    },
    { kind: "staff_membership_revision_conflict", revision: 2 },
    { kind: "signed_out", revision: 2, notice: null },
  ] as const)(
    "does not retain confirmation controls through $kind",
    (transition) => {
      const document = new FakeDocument();
      const root = new FakeElement(document, "main");
      const confirmation = {
        ...confirmationCases[0],
        schoolLabel: "Original School",
        revision: 1,
      };
      renderStaffAuthView(
        root as unknown as HTMLElement,
        confirmation,
        () => undefined,
      );
      const section = root.children[0];
      renderStaffAuthView(
        root as unknown as HTMLElement,
        transition,
        () => undefined,
      );
      renderStaffAuthView(
        root as unknown as HTMLElement,
        { ...confirmation, schoolLabel: "Renamed School", revision: 3 },
        () => undefined,
      );
      expect(root.children[0]).not.toBe(section);
    },
  );
});
