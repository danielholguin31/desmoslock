import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createStaffInvitationDependencies,
  handleRequest,
} from "../../supabase/functions/staff-invitations/index.ts";
import {
  API_ORIGIN,
  WEB_ORIGIN,
  auth,
  authDenied,
  check,
  client,
  code,
  loopbackFetch,
  openDisposableStack,
  password,
  recoverySession,
  requireUuid,
  rpc,
  sessionClaims,
  sql,
  sqlUuid,
  stepUp,
} from "./staff-auth-loopback.mjs";

// Source-handler integration with real GoTrue/PostgREST. Only the mail transport
// is in memory; this does not attest deployed Edge, email delivery, or browser UI.
test(
  "real provider composes invitation, recovery, and revocation",
  { timeout: 180_000 },
  async (t) => {
    const { publishableKey, serviceKey } = openDisposableStack();
    const admin = client(serviceKey);
    const owner = client(publishableKey);
    let loseAcceptanceResponse = false;
    let observedAcceptanceCommit = false;
    const teacher = client(publishableKey, async (input, init) => {
      const response = await loopbackFetch(input, init);
      if (
        loseAcceptanceResponse &&
        new URL(input instanceof Request ? input.url : input).pathname ===
          "/rest/v1/rpc/accept_staff_invitation" &&
        response.ok
      ) {
        loseAcceptanceResponse = false;
        let rows;
        try {
          rows = await response.json();
        } catch {
          throw new Error("Malformed acceptance result; details redacted");
        }
        check(
          Array.isArray(rows) &&
            rows.length === 1 &&
            rows[0].code === "invitation_accepted",
          "Response loss requires an actual committed acceptance",
        );
        observedAcceptanceCommit = true;
        throw new Error("Synthetic lost invitation-acceptance response");
      }
      return response;
    });
    const outsider = client(publishableKey);
    const workspaceId = randomUUID();
    const ownerProfileId = randomUUID();
    const namespace = randomUUID();
    const ownerEmail = `composed-owner-${namespace}@example.invalid`;
    const teacherEmail = `composed-teacher-${namespace}@example.invalid`;
    const outsiderEmail = `composed-outsider-${namespace}@example.invalid`;
    const ownerPassword = password();
    const teacherPassword = password();
    let currentTeacherPassword = teacherPassword;
    const outsiderPassword = password();
    const userIds = [];
    let invitationId;
    let teacherProfileId;

    for (const [email, secret] of [
      [ownerEmail, ownerPassword],
      [outsiderEmail, outsiderPassword],
    ]) {
      const created = await auth(() =>
        admin.auth.admin.createUser({
          email,
          password: secret,
          email_confirm: true,
        }),
      );
      userIds.push(requireUuid(created.user?.id));
    }
    sql(`begin;
insert into desmoslock_v2.workspaces (id,kind,slug,display_name,seed_key) values (${sqlUuid(workspaceId)},'school','composed-${namespace}','Disposable Acceptance School','composed.school.${namespace}');
insert into desmoslock_v2.profiles (id,display_name,seed_key) values (${sqlUuid(ownerProfileId)},'Disposable Owner','composed.owner.${namespace}');
insert into desmoslock_v2.memberships (workspace_id,profile_id,role,seed_key) values (${sqlUuid(workspaceId)},${sqlUuid(ownerProfileId)},'owner','composed.membership.${namespace}');
commit;`);
    code(
      await rpc(admin, "internal_bind_initial_owner", {
        workspace_id: workspaceId,
        profile_id: ownerProfileId,
        auth_user_id: userIds[0],
      }),
      "initial_owner_bound",
    );
    await auth(() =>
      owner.auth.signInWithPassword({
        email: ownerEmail,
        password: ownerPassword,
      }),
    );
    await auth(() =>
      outsider.auth.signInWithPassword({
        email: outsiderEmail,
        password: outsiderPassword,
      }),
    );

    await t.test(
      "real TOTP gates invitation; verified acceptance is replayable without granting a nonmember access",
      async () => {
        code(
          await rpc(outsider, "current_staff_context"),
          "membership_inactive",
        );
        code(
          await rpc(owner, "begin_staff_invitation", {
            workspace_id: workspaceId,
            email: teacherEmail,
            role: "teacher",
            request_key: randomUUID(),
          }),
          "step_up_required",
        );
        await stepUp(owner);
        let delivered;
        const dependencies = createStaffInvitationDependencies(
          {
            DESMOSLOCK_ALLOWED_WEB_ORIGIN: WEB_ORIGIN,
            DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: API_ORIGIN,
            DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: API_ORIGIN,
            DESMOSLOCK_STAFF_INVITATION_CALLBACK: `${WEB_ORIGIN}/`,
            DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS: "3600",
            DESMOSLOCK_STAFF_INVITATION_FROM: undefined,
            DESMOSLOCK_STAFF_INVITATION_REPLY_TO: undefined,
            RESEND_API_KEY: undefined,
            SUPABASE_ANON_KEY: publishableKey,
            SUPABASE_SERVICE_ROLE_KEY: serviceKey,
            SUPABASE_URL: API_ORIGIN,
          },
          loopbackFetch,
          Date.now,
          {
            deliver: async (message) => {
              check(
                delivered === undefined,
                "Invitation generated more than one logical delivery",
              );
              delivered = message;
              return "delivered";
            },
          },
        );
        const { session } = await auth(() => owner.auth.getSession());
        const response = await handleRequest(
          new Request(`${API_ORIGIN}/functions/v1/staff-invitations`, {
            method: "POST",
            headers: {
              origin: WEB_ORIGIN,
              authorization: `Bearer ${session.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: teacherEmail,
              role: "teacher",
              schoolId: workspaceId,
            }),
          }),
          dependencies,
        );
        check(
          response.status === 201,
          "Real source invitation handler did not create an invitation",
        );
        const body = await response.json();
        check(
          body.code === "invitation_created" &&
            body.ok === true &&
            delivered?.recipientEmail === teacherEmail,
          "Source invitation result did not match its synthetic recipient",
        );
        invitationId = requireUuid(delivered.invitationId);
        let callback;
        try {
          callback = new URL(delivered.callbackUrl);
        } catch {
          throw new Error("Malformed invitation callback; details redacted");
        }
        check(
          callback.origin === WEB_ORIGIN &&
            callback.pathname === "/" &&
            callback.search === "?auth=invite",
          "Invitation callback violated the clean query contract",
        );
        const tokenHash = new URLSearchParams(callback.hash.slice(1)).get(
          "token_hash",
        );
        check(
          typeof tokenHash === "string" && /^[0-9a-f]{56}$/u.test(tokenHash),
          "Invitation callback omitted its memory-only credential",
        );
        const verified = await auth(() =>
          teacher.auth.verifyOtp({ token_hash: tokenHash, type: "invite" }),
        );
        userIds.push(requireUuid(verified.user?.id));
        code(
          await rpc(teacher, "current_staff_context"),
          "membership_inactive",
        );
        code(
          await rpc(outsider, "accept_staff_invitation", {
            invitation_id: invitationId,
            display_name: "Wrong Recipient",
          }),
          "invitation_not_found",
        );
        loseAcceptanceResponse = true;
        let acceptanceResult;
        try {
          acceptanceResult = await teacher
            .schema("desmoslock_v2")
            .rpc("accept_staff_invitation", {
              invitation_id: invitationId,
              display_name: "Disposable Teacher",
            });
        } catch {
          acceptanceResult = null;
        }
        check(
          observedAcceptanceCommit &&
            (acceptanceResult === null || acceptanceResult.error !== null),
          "Invitation acceptance response loss was not exercised",
        );
        code(
          await rpc(teacher, "accept_staff_invitation", {
            invitation_id: invitationId,
            display_name: "Replay Must Not Rename",
          }),
          "invitation_accepted",
        );
        const context = await rpc(teacher, "current_staff_context");
        code(context, "ok");
        check(
          context.display_name === "Disposable Teacher" &&
            context.school_id === workspaceId &&
            context.membership_role === "teacher",
          "Invitation replay changed the accepted Membership",
        );
        teacherProfileId = requireUuid(context.profile_id);
        check(
          sql(
            `select (select count(*) from desmoslock_v2.memberships where workspace_id=${sqlUuid(workspaceId)} and profile_id=${sqlUuid(teacherProfileId)})=1 and (select count(*) from desmoslock_v2.staff_audit_events where invitation_id=${sqlUuid(invitationId)} and event_type='invitation_accepted')=1;`,
          ) === "t",
          "Acceptance replay duplicated Membership or acceptance audit",
        );
        await authDenied(
          () =>
            client(publishableKey).auth.verifyOtp({
              token_hash: tokenHash,
              type: "invite",
            }),
          "otp_expired",
        );
        await auth(() =>
          teacher.auth.updateUser({ password: teacherPassword }),
        );
        const fresh = client(publishableKey);
        await auth(() =>
          fresh.auth.signInWithPassword({
            email: teacherEmail,
            password: teacherPassword,
          }),
        );
        code(await rpc(fresh, "current_staff_context"), "ok");
        code(
          await rpc(outsider, "current_staff_context"),
          "membership_inactive",
        );
      },
    );
    check(
      invitationId !== undefined && teacherProfileId !== undefined,
      "Invitation group did not establish its fixture",
    );

    await t.test(
      "real recovery AMR stays denied; a lost password response is reconciled by fresh sign-in",
      async () => {
        let dropped = false;
        const recovery = client(publishableKey, async (input, init) => {
          const response = await loopbackFetch(input, init);
          if (
            !dropped &&
            new URL(input instanceof Request ? input.url : input).pathname ===
              "/auth/v1/user" &&
            init?.method === "PUT" &&
            response.ok
          ) {
            dropped = true;
            await response.body?.cancel();
            throw new Error("Synthetic lost password-update response");
          }
          return response;
        });
        await recoverySession(admin, teacherEmail, recovery);
        code(await rpc(recovery, "current_staff_context"), "forbidden");
        const started = await rpc(recovery, "begin_staff_password_recovery", {
          requested_operation_id: randomUUID(),
        });
        code(started, "recovery_sessions_revoked");
        const operationId = requireUuid(started.operation_id);
        const resumed = await rpc(recovery, "begin_staff_password_recovery", {
          requested_operation_id: randomUUID(),
        });
        code(resumed, "recovery_sessions_revoked");
        check(
          resumed.operation_id === operationId,
          "Recovery did not adopt the canonical same-session operation",
        );
        code(await rpc(teacher, "current_staff_context"), "session_revoked");
        const replacement = password();
        let unknown;
        try {
          unknown = await recovery.auth.updateUser({ password: replacement });
        } catch {
          unknown = null;
        }
        check(
          dropped && (unknown === null || unknown.error !== null),
          "Password response-loss boundary was not exercised",
        );
        const reconciled = client(publishableKey);
        await auth(() =>
          reconciled.auth.signInWithPassword({
            email: teacherEmail,
            password: replacement,
          }),
        );
        code(await rpc(reconciled, "current_staff_context"), "ok");
        await authDenied(
          () =>
            client(publishableKey).auth.signInWithPassword({
              email: teacherEmail,
              password: teacherPassword,
            }),
          "invalid_credentials",
        );
        code(await rpc(recovery, "current_staff_context"), "forbidden");
        code(
          await rpc(recovery, "finish_staff_password_recovery", {
            operation_id: operationId,
          }),
          "recovery_completed",
        );
        code(await rpc(recovery, "current_staff_context"), "forbidden");
        code(await rpc(reconciled, "current_staff_context"), "session_revoked");
        code(
          await rpc(recovery, "finish_staff_password_recovery", {
            operation_id: operationId,
          }),
          "recovery_completed",
        );
        // Cleanup status alone never serves as password-commit evidence.
        await auth(() =>
          teacher.auth.signInWithPassword({
            email: teacherEmail,
            password: replacement,
          }),
        );
        code(await rpc(teacher, "current_staff_context"), "ok");
        currentTeacherPassword = replacement;
      },
    );

    await t.test(
      "two real sessions lose backend access on revocation and invitation replay cannot revive Membership",
      async () => {
        const first = client(publishableKey);
        const second = client(publishableKey);
        // Owner sessions use ordinary password sign-in independently of the
        // already verified owner client retained for the privileged mutation.
        const firstLogin = await auth(() =>
          first.auth.signInWithPassword({
            email: ownerEmail,
            password: ownerPassword,
          }),
        );
        const secondLogin = await auth(() =>
          second.auth.signInWithPassword({
            email: ownerEmail,
            password: ownerPassword,
          }),
        );
        check(
          sessionClaims(firstLogin.session).session_id !==
            sessionClaims(secondLogin.session).session_id,
          "Independent sign-ins reused one session",
        );
        code(await rpc(first, "current_staff_context"), "ok");
        code(await rpc(second, "current_staff_context"), "ok");
        const secondTeacher = client(publishableKey);
        const secondTeacherLogin = await auth(() =>
          secondTeacher.auth.signInWithPassword({
            email: teacherEmail,
            password: currentTeacherPassword,
          }),
        );
        const firstTeacherLogin = await auth(() => teacher.auth.getSession());
        check(
          sessionClaims(firstTeacherLogin.session).session_id !==
            sessionClaims(secondTeacherLogin.session).session_id,
          "Teacher contexts must use independent real sessions",
        );
        code(await rpc(secondTeacher, "current_staff_context"), "ok");
        code(
          await rpc(first, "revoke_membership", {
            workspace_id: workspaceId,
            profile_id: teacherProfileId,
          }),
          "step_up_required",
        );
        code(
          await rpc(owner, "revoke_membership", {
            workspace_id: workspaceId,
            profile_id: teacherProfileId,
          }),
          "membership_revoked",
        );
        code(
          await rpc(teacher, "current_staff_context"),
          "membership_inactive",
        );
        code(
          await rpc(secondTeacher, "current_staff_context"),
          "membership_inactive",
        );
        const freshTeacher = client(publishableKey);
        await auth(() =>
          freshTeacher.auth.signInWithPassword({
            email: teacherEmail,
            password: currentTeacherPassword,
          }),
        );
        code(
          await rpc(freshTeacher, "current_staff_context"),
          "membership_inactive",
        );
        code(
          await rpc(teacher, "accept_staff_invitation", {
            invitation_id: invitationId,
            display_name: "Must Not Revive",
          }),
          "invitation_accepted",
        );
        code(
          await rpc(teacher, "current_staff_context"),
          "membership_inactive",
        );
        code(await rpc(first, "revoke_all_current_user_staff_sessions"), "ok");
        code(await rpc(first, "current_staff_context"), "session_revoked");
        code(await rpc(second, "current_staff_context"), "session_revoked");
        code(await rpc(owner, "current_staff_context"), "session_revoked");
      },
    );
    // Audit rows are deliberately append-only. This suite must run last against
    // the fresh disposable stack; CI owns unconditional shutdown and the next
    // run must reset it. Never disable production audit protections for cleanup.
  },
);
