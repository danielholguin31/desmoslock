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
      school: { id: "school-1", label: "Synthetic High School" },
    },
    identityGeneration: `identity-${role}`,
    kind: "authenticated" as const,
    manageableInvitations:
      role === "owner"
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
      role === "owner"
        ? [
            {
              profile: {
                displayName: "Ada Administrator",
                email: "ada@example.test",
                id: "profile-target",
              },
              role: "administrator" as const,
              schoolId: "school-1",
            },
          ]
        : [],
    revision: 1,
    sessionGeneration: `session-${role}`,
  };
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
        "This authentication link could not be accepted. Request a new one.",
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
      actions: [
        { id: "sign_out_local", label: "Sign out here" },
        { id: "revoke_all_sessions", label: "Sign out everywhere" },
      ],
      fields: [],
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

  it("shows invitation and revocation commands only to an Owner", () => {
    const owner = createStaffAuthViewModel(authenticatedSnapshot("owner"));
    const administrator = createStaffAuthViewModel(
      authenticatedSnapshot("administrator"),
    );

    expect(owner.actions.map(({ id }) => id)).toEqual([
      "create_administrator_invitation",
      "create_teacher_invitation",
      "review_staff_invitation_revocation",
      "review_staff_membership_revocation",
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
      "sign_out_local",
      "revoke_all_sessions",
    ]);
  });

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
      "Administrator invitation created for Synthetic High School.",
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
    if (
      email === undefined ||
      pendingInvitation === undefined ||
      membership === undefined ||
      inviteTeacher === undefined ||
      reviewRevocation === undefined ||
      reviewInvitationRevocation === undefined
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
    ]);
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
