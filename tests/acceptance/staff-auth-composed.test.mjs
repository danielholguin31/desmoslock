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
  createRuntimeHealthCheck,
  loopbackFetch,
  openDisposableStack,
  password,
  recoverySession,
  requireUuid,
  rpc,
  rpcDenied,
  rpcRows,
  sessionClaims,
  sql,
  sqlUuid,
  stepUp,
} from "./staff-auth-loopback.mjs";
import {
  openConnection,
  verifyDisposableDatabase,
} from "./revoke-membership-lock-db.mjs";
import { runMembershipBrowserAcceptance } from "./staff-membership-browser.mjs";

// Source-handler integration with real GoTrue/PostgREST. Invitation mail uses an
// in-memory transport; PKCE recovery mail reaches the disposable local SMTP sink.
// The final Membership group also runs the production browser entrypoint. This
// does not attest deployed Edge, external email delivery or hosted configuration.
test(
  "real provider composes authentication and School Membership administration",
  { timeout: 420_000 },
  async (t) => {
    const { publishableKey, serviceKey } = openDisposableStack();
    const admin = client(serviceKey);
    const checkRuntimeHealth = createRuntimeHealthCheck(admin, serviceKey);
    await checkRuntimeHealth("before runtime provisioning");
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
insert into desmoslock_v2.workspaces (id,kind,slug,display_name,seed_key) values (${sqlUuid(workspaceId)},'school','composed-${namespace}','Disposable Acceptance School',null);
insert into desmoslock_v2.profiles (id,display_name,seed_key) values (${sqlUuid(ownerProfileId)},'Disposable Owner',null);
insert into desmoslock_v2.memberships (workspace_id,profile_id,role,seed_key) values (${sqlUuid(workspaceId)},${sqlUuid(ownerProfileId)},'owner',null);
commit;`);
    await checkRuntimeHealth("after runtime provisioning");
    code(
      await rpc(admin, "internal_bind_initial_owner", {
        workspace_id: workspaceId,
        profile_id: ownerProfileId,
        auth_user_id: userIds[0],
      }),
      "initial_owner_bound",
    );
    await checkRuntimeHealth("after initial owner binding");
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
        await checkRuntimeHealth("after invitation acceptance and replay");
      },
    );
    check(
      invitationId !== undefined && teacherProfileId !== undefined,
      "Invitation group did not establish its fixture",
    );

    await t.test(
      "real PKCE recovery AMR stays denied; a lost password response is reconciled by fresh sign-in",
      async () => {
        let dropped = false;
        let sentS256Recovery = false;
        const recovery = client(
          publishableKey,
          async (input, init) => {
            if (
              new URL(input instanceof Request ? input.url : input).pathname ===
              "/auth/v1/recover"
            ) {
              let body;
              try {
                body = JSON.parse(init?.body);
              } catch {
                throw new Error("Malformed recovery request; details redacted");
              }
              check(
                init?.method === "POST" &&
                  body.email === teacherEmail &&
                  body.code_challenge_method === "s256" &&
                  /^[A-Za-z0-9_-]{43}$/u.test(body.code_challenge ?? ""),
                "Real recovery request did not use the expected S256 challenge",
              );
              sentS256Recovery = true;
            }
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
          },
          "pkce",
        );
        await recoverySession(teacherEmail, recovery);
        check(
          sentS256Recovery,
          "Recovery did not exercise the real S256 request",
        );
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
        await checkRuntimeHealth("after password recovery and cleanup");
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
            expected_role_revision: 1,
          }),
          "step_up_required",
        );
        code(
          await rpc(owner, "revoke_membership", {
            workspace_id: workspaceId,
            profile_id: teacherProfileId,
            expected_role_revision: 1,
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
        await checkRuntimeHealth("after membership and session revocation");
      },
    );
    await runMembershipAcceptance(t, {
      admin,
      publishableKey,
      checkRuntimeHealth,
    });
    // Audit rows are deliberately append-only. This suite must run last against
    // the fresh disposable stack; CI owns unconditional shutdown and the next
    // run must reset it. Never disable production audit protections for cleanup.
  },
);

async function runMembershipAcceptance(
  t,
  { admin, publishableKey, checkRuntimeHealth },
) {
  const namespace = randomUUID();
  const schoolA = randomUUID();
  const schoolB = randomUUID();
  sql(`insert into desmoslock_v2.workspaces(id,kind,slug,display_name,seed_key) values
(${sqlUuid(schoolA)},'school','membership-a-${namespace}','Disposable Membership School A',null),
(${sqlUuid(schoolB)},'school','membership-b-${namespace}','Disposable Membership School B',null);`);

  async function actor(label, schoolId, role, privileged = false) {
    const email = `membership-${label}-${namespace}@example.invalid`;
    const secret = password();
    const created = await auth(() =>
      admin.auth.admin.createUser({
        email,
        password: secret,
        email_confirm: true,
      }),
    );
    const userId = requireUuid(created.user?.id);
    const profileId = randomUUID();
    if (schoolId) {
      sql(`begin;
insert into desmoslock_v2.profiles(id,display_name,seed_key,auth_user_id)
values(${sqlUuid(profileId)},'Disposable ${label}',null,${sqlUuid(userId)});
insert into desmoslock_v2.memberships(workspace_id,profile_id,role,seed_key)
values(${sqlUuid(schoolId)},${sqlUuid(profileId)},'${role}',null);
commit;`);
    }
    const sessionClient = client(publishableKey);
    await auth(() =>
      sessionClient.auth.signInWithPassword({ email, password: secret }),
    );
    const factor = privileged ? await stepUp(sessionClient) : undefined;
    return {
      email,
      password: secret,
      userId,
      profileId,
      schoolId,
      client: sessionClient,
      factor,
    };
  }
  // These run-owned scaffolds exercise real signed provider identities; none
  // reuse or bind the canonical baseline's six health-check profiles.
  const ownerA = await actor("owner-a", schoolA, "owner", true);
  const ownerB = await actor("owner-b", schoolB, "owner", true);
  const administrator = await actor("admin", schoolA, "admin", true);
  const teacher = await actor("teacher", schoolA, "teacher", true);
  const foreignTeacher = await actor("foreign-teacher", schoolB, "teacher");
  const browserActor = await actor("browser-admin", schoolA, "admin", true);
  const uninvited = await actor("uninvited", null, null, true);
  const anonymous = client(publishableKey);
  const ownerAal1 = client(publishableKey);
  await auth(() =>
    ownerAal1.auth.signInWithPassword({
      email: ownerA.email,
      password: ownerA.password,
    }),
  );

  function targetArgs(target, expected = 1, schoolId = schoolA) {
    return {
      workspace_id: schoolId,
      profile_id: target.profileId,
      expected_role_revision: expected,
    };
  }
  function snapshot(target) {
    return sql(`select jsonb_build_object(
'membership',(select to_jsonb(m)||jsonb_build_object('tuple',m.ctid::text) from desmoslock_v2.memberships m where workspace_id=${sqlUuid(target.schoolId ?? schoolA)} and profile_id=${sqlUuid(target.profileId)}),
'audit',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('tuple',e.ctid::text) order by e.id) from desmoslock_v2.staff_audit_events e where subject_profile_id=${sqlUuid(target.profileId)}),'[]'::jsonb));`);
  }
  async function denialDoesNotWrite(operation, target, expected) {
    const before = snapshot(target);
    code(await operation(), expected);
    check(
      snapshot(target) === before,
      "Denied Membership operation changed data or audit",
    );
  }
  function addTarget() {
    const profileId = randomUUID();
    sql(`begin;
insert into desmoslock_v2.profiles(id,display_name,seed_key) values(${sqlUuid(profileId)},'Disposable Competing Teacher',null);
insert into desmoslock_v2.memberships(workspace_id,profile_id,role,seed_key) values(${sqlUuid(schoolA)},${sqlUuid(profileId)},'teacher',null);
commit;`);
    return { profileId };
  }

  await t.test(
    "two real Schools enforce the Owner, Administrator, Teacher and unaffiliated matrix",
    async () => {
      await checkRuntimeHealth("after Membership runtime provisioning");
      for (const [staff, schoolId, expectedRole] of [
        [ownerA, schoolA, "owner"],
        [ownerB, schoolB, "owner"],
        [administrator, schoolA, "admin"],
        [teacher, schoolA, "teacher"],
        [foreignTeacher, schoolB, "teacher"],
      ]) {
        const context = await rpc(staff.client, "current_staff_context");
        code(context, "ok");
        check(
          context.school_id === schoolId &&
            context.membership_role === expectedRole,
          "Real provider session crossed its Membership authority",
        );
      }
      const ownerRows = await rpcRows(
        ownerA.client,
        "current_manageable_staff",
      );
      check(
        ownerRows.length === 3 &&
          ownerRows.every(
            (row) =>
              row.code === "ok" &&
              row.school_id === schoolA &&
              [
                administrator.profileId,
                teacher.profileId,
                browserActor.profileId,
              ].includes(row.profile_id) &&
              row.role_revision === 1,
          ),
        "Owner management selector crossed School or role scope",
      );
      const adminRows = await rpcRows(
        administrator.client,
        "current_manageable_staff",
      );
      check(
        adminRows.length === 1 &&
          adminRows[0].profile_id === teacher.profileId &&
          adminRows[0].membership_role === "teacher" &&
          adminRows[0].role_revision === 1,
        "Administrator management selector exposed a privileged or foreign target",
      );
      code(await rpc(teacher.client, "current_manageable_staff"), "forbidden");
      code(
        await rpc(uninvited.client, "current_staff_context"),
        "membership_inactive",
      );
      code(
        await rpc(uninvited.client, "current_manageable_staff"),
        "membership_inactive",
      );
      code(
        await rpc(ownerAal1, "current_manageable_staff"),
        "step_up_required",
      );
      await rpcDenied(anonymous, "current_manageable_staff", {}, ["42501"]);
      const mutation = { ...targetArgs(teacher), role: "admin" };
      for (const [caller, expected] of [
        [teacher.client, "forbidden"],
        [uninvited.client, "membership_inactive"],
        [ownerAal1, "step_up_required"],
        [administrator.client, "forbidden"],
        [ownerB.client, "membership_inactive"],
      ])
        await denialDoesNotWrite(
          () => rpc(caller, "change_membership_role", mutation),
          teacher,
          expected,
        );
      await rpcDenied(anonymous, "change_membership_role", mutation, ["42501"]);
      await denialDoesNotWrite(
        () =>
          rpc(ownerA.client, "change_membership_role", {
            ...targetArgs(foreignTeacher),
            role: "admin",
          }),
        foreignTeacher,
        "forbidden",
      );
      for (const target of [ownerA, browserActor])
        await denialDoesNotWrite(
          () =>
            rpc(administrator.client, "revoke_membership", targetArgs(target)),
          target,
          "forbidden",
        );
      await denialDoesNotWrite(
        () =>
          rpc(ownerA.client, "change_membership_role", {
            ...targetArgs(ownerA),
            role: "teacher",
          }),
        ownerA,
        "forbidden",
      );
      const before = snapshot(teacher);
      await rpcDenied(
        ownerA.client,
        "revoke_membership",
        {
          workspace_id: schoolA,
          profile_id: teacher.profileId,
        },
        ["PGRST202"],
      );
      check(
        snapshot(teacher) === before,
        "Retired revision-free revoke changed Membership or audit",
      );

      await auth(() =>
        teacher.client.auth.updateUser({
          data: {
            role: "owner",
            membership_role: "owner",
            workspace_id: schoolB,
            school_id: schoolB,
          },
        }),
      );
      await auth(() => teacher.client.auth.refreshSession());
      const forgedContext = await rpc(teacher.client, "current_staff_context");
      check(
        forgedContext.membership_role === "teacher" &&
          forgedContext.school_id === schoolA,
        "User-editable role metadata acquired School authority",
      );
      await denialDoesNotWrite(
        () => rpc(teacher.client, "change_membership_role", mutation),
        teacher,
        "forbidden",
      );
      code(
        await rpc(uninvited.client, "begin_staff_invitation", {
          workspace_id: schoolA,
          email: `membership-domain-${namespace}@example.invalid`,
          role: "teacher",
          request_key: randomUUID(),
        }),
        "membership_inactive",
      );
      code(
        await rpc(administrator.client, "begin_staff_invitation", {
          workspace_id: schoolA,
          email: `membership-admin-denied-${namespace}@example.invalid`,
          role: "admin",
          request_key: randomUUID(),
        }),
        "forbidden",
      );
      const invitations = [];
      for (const [issuer, schoolId, role, label] of [
        [ownerA, schoolA, "admin", "owner-admin"],
        [administrator, schoolA, "teacher", "admin-teacher"],
        [ownerB, schoolB, "teacher", "foreign"],
      ]) {
        const begun = await rpc(issuer.client, "begin_staff_invitation", {
          workspace_id: schoolId,
          email: `membership-invite-${label}-${namespace}@example.invalid`,
          role,
          request_key: randomUUID(),
        });
        code(begun, "invitation_pending");
        invitations.push(requireUuid(begun.invitation_id));
      }
      const ownerInvitations = await rpcRows(
        ownerA.client,
        "current_manageable_staff_invitations",
      );
      check(
        ownerInvitations.length === 2 &&
          ownerInvitations.every(
            (row) =>
              row.school_id === schoolA &&
              invitations.slice(0, 2).includes(row.invitation_id),
          ),
        "Owner invitation selector crossed the School boundary",
      );
      const adminInvitations = await rpcRows(
        administrator.client,
        "current_manageable_staff_invitations",
      );
      check(
        adminInvitations.length === 1 &&
          adminInvitations[0].invitation_id === invitations[1] &&
          adminInvitations[0].invited_role === "teacher",
        "Administrator invitation selector exposed an Administrator or foreign invitation",
      );
      code(
        await rpc(teacher.client, "current_manageable_staff_invitations"),
        "forbidden",
      );
      for (const invitationId of [invitations[0], invitations[2]]) {
        const query = `select jsonb_build_object('invitation',(select to_jsonb(i)||jsonb_build_object('tuple',i.ctid::text) from desmoslock_v2.staff_invitations i where id=${sqlUuid(invitationId)}),'audit',(select jsonb_agg(to_jsonb(e) order by e.id) from desmoslock_v2.staff_audit_events e where invitation_id=${sqlUuid(invitationId)}));`;
        const beforeInvitation = sql(query);
        code(
          await rpc(administrator.client, "revoke_staff_invitation", {
            invitation_id: invitationId,
          }),
          "invitation_not_found",
        );
        check(
          sql(query) === beforeInvitation,
          "Denied invitation revocation changed the hidden grant or audit",
        );
      }
      code(
        await rpc(administrator.client, "revoke_staff_invitation", {
          invitation_id: invitations[1],
        }),
        "invitation_revoked",
      );
      check(
        (
          await rpcRows(
            administrator.client,
            "current_manageable_staff_invitations",
          )
        ).length === 0,
        "Administrator empty invitation selector retained a revoked or privileged grant",
      );
    },
  );

  await t.test(
    "real Administrator revocation is attributable and cannot resurrect revoked staff",
    async () => {
      const revokee = addTarget();
      code(
        await rpc(
          administrator.client,
          "revoke_membership",
          targetArgs(revokee),
        ),
        "membership_revoked",
      );
      check(
        sql(`select m.status='revoked' and m.role_revision=2 and m.revocation_reason_code='administrator_action'
and (select count(*) from desmoslock_v2.staff_audit_events e where e.subject_profile_id=m.profile_id and e.workspace_id=m.workspace_id and e.actor_profile_id=${sqlUuid(administrator.profileId)} and e.event_type='membership_revoked' and e.session_id is not null)=1
from desmoslock_v2.memberships m where m.workspace_id=${sqlUuid(schoolA)} and m.profile_id=${sqlUuid(revokee.profileId)};`) ===
          "t",
        "Administrator revocation omitted its exact Membership revision or attributable audit",
      );
      await denialDoesNotWrite(
        () =>
          rpc(ownerA.client, "change_membership_role", {
            ...targetArgs(revokee, 2),
            role: "admin",
          }),
        revokee,
        "forbidden",
      );
    },
  );

  await t.test(
    "competing real RPC commits change exactly one revision and append one atomic audit",
    async () => {
      verifyDisposableDatabase();
      for (const competingRevoke of [false, true]) {
        const target = addTarget();
        const blocker = await openConnection(
          `composed-membership-${randomUUID().slice(0, 8)}`,
        );
        let requests = [];
        try {
          await blocker.query(
            `begin; select 1 from desmoslock_v2.memberships where workspace_id=${sqlUuid(schoolA)} and profile_id=${sqlUuid(target.profileId)} for update;`,
          );
          requests = [
            rpc(ownerA.client, "change_membership_role", {
              ...targetArgs(target),
              role: "admin",
            }),
            rpc(
              ownerA.client,
              competingRevoke ? "revoke_membership" : "change_membership_role",
              {
                ...targetArgs(target),
                ...(competingRevoke ? {} : { role: "admin" }),
              },
            ),
          ];
          // Attach rejection handlers immediately; the blocker must be released
          // even if either real PostgREST request fails before the observation.
          const settled = Promise.allSettled(requests);
          const deadline = Date.now() + 4_000;
          let observed = false;
          while (Date.now() < deadline) {
            const rows = await blocker.query(`select pg_stat_clear_snapshot();
select count(*)=2 and bool_or(${blocker.pid}=any(pg_blocking_pids(a.pid)))
from pg_stat_activity a where a.pid<>pg_backend_pid() and a.state='active' and a.wait_event_type='Lock'
and (a.query like '%"change_membership_role"%' or a.query like '%"revoke_membership"%');`);
            if (rows.length === 1 && rows[0] === "t") {
              observed = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          check(
            observed,
            "Both actual Membership RPCs did not demonstrate target lock contention",
          );
          await blocker.query("commit;");
          const results = await settled;
          check(
            results.every((entry) => entry.status === "fulfilled"),
            "Competing real Membership RPC did not complete",
          );
          const codes = results.map((entry) => entry.value.code);
          check(
            codes.filter((value) =>
              ["membership_role_changed", "membership_revoked"].includes(value),
            ).length === 1,
            "Competing RPCs did not produce exactly one committed mutation",
          );
          check(
            codes.includes("membership_revision_conflict") ||
              (competingRevoke &&
                codes.includes("membership_revoked") &&
                codes.includes("forbidden")),
            "Losing Membership RPC did not reject stale or inactive intent",
          );
          check(
            sql(`select m.role_revision=2 and ((m.status='active' and m.role='admin') or (m.status='revoked' and m.role='teacher'))
and (select count(*) from desmoslock_v2.staff_audit_events e where e.subject_profile_id=m.profile_id)=1
and not exists(select 1 from desmoslock_v2.staff_audit_events e where e.subject_profile_id=m.profile_id and (e.actor_profile_id is distinct from ${sqlUuid(ownerA.profileId)} or e.workspace_id is distinct from m.workspace_id or e.session_id is null or e.event_type is distinct from case when m.status='active' then 'membership_role_changed' else 'membership_revoked' end or e.result_code is distinct from e.event_type or (e.event_type='membership_role_changed' and (e.previous_role is distinct from 'teacher' or e.new_role is distinct from 'admin' or e.previous_role_revision is distinct from 1 or e.new_role_revision is distinct from 2 or e.occurred_at is distinct from m.updated_at))))
from desmoslock_v2.memberships m where m.workspace_id=${sqlUuid(schoolA)} and m.profile_id=${sqlUuid(target.profileId)};`) ===
              "t",
            "Competing commit split Membership state, revision or attributable audit",
          );
          const winningRevoke = codes.includes("membership_revoked");
          await denialDoesNotWrite(
            () =>
              rpc(ownerA.client, "change_membership_role", {
                ...targetArgs(target),
                role: "admin",
              }),
            target,
            winningRevoke ? "forbidden" : "membership_revision_conflict",
          );
        } finally {
          await blocker.close();
          await Promise.allSettled(requests);
        }
      }
    },
  );

  await t.test(
    "an audit insertion failure rolls back the entire role transition",
    async () => {
      const target = addTarget();
      const before = snapshot(target);
      const { session } = await auth(() => ownerA.client.auth.getSession());
      const claims = sessionClaims(session);
      // The claims name an actual provider-created session. A transaction-local
      // trigger injects the audit failure; rollback removes that trigger too.
      check(
        Number.isSafeInteger(claims.exp),
        "Provider expiry is not usable for audit rollback proof",
      );
      check(
        sql(`begin;
create function pg_temp.reject_membership_audit() returns trigger language plpgsql as $$ begin
if new.subject_profile_id=${sqlUuid(target.profileId)} then raise exception using errcode='ZMA01', message='Synthetic targeted Membership audit failure'; end if; return new; end; $$;
create trigger composed_reject_membership_audit before insert on desmoslock_v2.staff_audit_events for each row execute function pg_temp.reject_membership_audit();
do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('sub',${sqlUuid(ownerA.userId)},'session_id',${sqlUuid(claims.session_id)},'role','authenticated','aal','aal2','exp',${claims.exp})::text,true); end $$;
set local role authenticated;
do $$ begin perform * from desmoslock_v2.change_membership_role(${sqlUuid(schoolA)},${sqlUuid(target.profileId)},'admin',1);
raise exception 'Expected audit failure'; exception when sqlstate 'ZMA01' then null; end $$;
reset role;
select role='teacher' and role_revision=1 and status='active' and not exists(select 1 from desmoslock_v2.staff_audit_events where subject_profile_id=${sqlUuid(target.profileId)})
from desmoslock_v2.memberships where workspace_id=${sqlUuid(schoolA)} and profile_id=${sqlUuid(target.profileId)};
rollback;`) === "t",
        "Role transition survived its failed audit insertion",
      );
      check(
        snapshot(target) === before,
        "Audit failure left a Membership or audit mutation",
      );
    },
  );

  await t.test(
    "authorized Administrator invitations survive issuer downgrade and removal",
    async () => {
      const original = await auth(() => administrator.client.auth.getSession());
      const originalSessionId = sessionClaims(original.session).session_id;
      for (const removal of [false, true]) {
        const recipient = await actor(
          removal ? "recipient-removed" : "recipient-downgraded",
          null,
          null,
        );
        const requestKey = randomUUID();
        const request = {
          workspace_id: schoolA,
          email: recipient.email,
          role: "teacher",
          request_key: requestKey,
        };
        const begun = await rpc(
          administrator.client,
          "begin_staff_invitation",
          request,
        );
        code(begun, "invitation_pending");
        const invitationId = requireUuid(begun.invitation_id);
        if (removal)
          code(
            await rpc(
              ownerA.client,
              "revoke_membership",
              targetArgs(administrator, 3),
            ),
            "membership_revoked",
          );
        else
          code(
            await rpc(ownerA.client, "change_membership_role", {
              ...targetArgs(administrator),
              role: "teacher",
            }),
            "membership_role_changed",
          );
        const sameSession = await auth(() =>
          administrator.client.auth.getSession(),
        );
        check(
          sessionClaims(sameSession.session).session_id === originalSessionId,
          "Issuer access loss was tested with a replacement provider session",
        );
        const changedContext = await rpc(
          administrator.client,
          "current_staff_context",
        );
        if (removal) code(changedContext, "membership_inactive");
        else
          check(
            changedContext.code === "ok" &&
              changedContext.membership_role === "teacher",
            "The existing provider session did not reflect its current Teacher role",
          );
        const denied = removal ? "membership_inactive" : "forbidden";
        code(
          await rpc(administrator.client, "current_manageable_staff"),
          denied,
        );
        const invitationQuery = `select jsonb_build_object('invitation',(select to_jsonb(i)||jsonb_build_object('tuple',i.ctid::text) from desmoslock_v2.staff_invitations i where id=${sqlUuid(invitationId)}),'audit',(select jsonb_agg(to_jsonb(e) order by e.id) from desmoslock_v2.staff_audit_events e where invitation_id=${sqlUuid(invitationId)}));`;
        const authorizedGrant = sql(invitationQuery);
        code(
          await rpc(administrator.client, "begin_staff_invitation", request),
          denied,
        );
        code(
          await rpc(administrator.client, "begin_staff_invitation", {
            ...request,
            email: `membership-new-${randomUUID()}@example.invalid`,
            request_key: randomUUID(),
          }),
          denied,
        );
        check(
          sql(invitationQuery) === authorizedGrant,
          "Denied issuer replay or new request changed its previously authorized grant",
        );
        code(
          await rpc(admin, "internal_prepare_staff_invitation", {
            invitation_id: invitationId,
            invited_user_id: recipient.userId,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          "invitation_delivery_ready",
        );
        code(
          await rpc(admin, "internal_publish_staff_invitation", {
            invitation_id: invitationId,
          }),
          "invitation_usable",
        );
        code(
          await rpc(recipient.client, "accept_staff_invitation", {
            invitation_id: invitationId,
            display_name: "Durable Invitation Recipient",
          }),
          "invitation_accepted",
        );
        const accepted = await rpc(recipient.client, "current_staff_context");
        check(
          accepted.code === "ok" &&
            accepted.school_id === schoolA &&
            accepted.membership_role === "teacher",
          "Issuer authority loss incorrectly cancelled an already authorized grant",
        );
        code(
          await rpc(recipient.client, "accept_staff_invitation", {
            invitation_id: invitationId,
            display_name: "Replay Must Not Rename",
          }),
          "invitation_accepted",
        );
        check(
          sql(
            `select count(*)=1 from desmoslock_v2.staff_audit_events where invitation_id=${sqlUuid(invitationId)} and event_type='invitation_accepted';`,
          ) === "t",
          "Durable invitation replay duplicated acceptance audit",
        );
        if (!removal)
          code(
            await rpc(ownerA.client, "change_membership_role", {
              ...targetArgs(administrator, 2),
              role: "admin",
            }),
            "membership_role_changed",
          );
      }
    },
  );

  await t.test(
    "an open production browser reflects real Administrator downgrade and revocation without reload",
    async () => {
      await runMembershipBrowserAcceptance({
        publishableKey,
        owner: ownerA.client,
        actor: browserActor,
        schoolId: schoolA,
      });
      await checkRuntimeHealth(
        "after real Membership browser downgrade and revocation",
      );
    },
  );
}
