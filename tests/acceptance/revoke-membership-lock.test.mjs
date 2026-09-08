import { randomUUID } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  check,
  openConnection,
  parseJson,
  sql,
  sqlUuid,
  verifyDisposableDatabase,
} from "./revoke-membership-lock-db.mjs";

// Real PostgreSQL lock contention with synthetic Auth-table fixtures. This does
// not attest GoTrue login, JWT signature validation, mail, or browser behavior.
// B's committed transitions are direct fixture SQL. The separate final provider
// journey covers competing RPC commits that retain their immutable audits.
const scenarios = [
  { action: "unchanged", expected: "membership_revoked" },
  { action: "membership", expected: "membership_inactive" },
  { action: "session", expected: "session_expired" },
  { action: "factor", expected: "step_up_required" },
  {
    action: "admin-revoke",
    actorRole: "admin",
    expected: "membership_revoked",
  },
  {
    action: "admin-promoted-target",
    actorRole: "admin",
    mutation: "promote-target",
    expected: "forbidden",
  },
  {
    action: "revoke-stale-target",
    mutation: "promote-target",
    expected: "membership_revision_conflict",
  },
  {
    action: "role-change-stale-target",
    operation: "role-change",
    mutation: "promote-target",
    expected: "membership_revision_conflict",
  },
  {
    action: "role-change",
    operation: "role-change",
    expected: "membership_role_changed",
  },
  {
    action: "role-change-session",
    operation: "role-change",
    mutation: "session",
    expected: "session_expired",
  },
  {
    action: "role-change-factor",
    operation: "role-change",
    mutation: "factor",
    expected: "step_up_required",
  },
  {
    action: "role-change-membership",
    operation: "role-change",
    mutation: "membership",
    expected: "membership_inactive",
  },
];
const reportableCodes = new Set([
  ...scenarios.map((scenario) => scenario.expected),
  "session_revoked",
  "forbidden",
  "conflict",
  "invalid_request",
  "unauthenticated",
]);

function freshBaseline() {
  check(
    sql(`select (not exists (select 1 from auth.users))
and coalesce((select fixture_valid from desmoslock_v2.internal_baseline_status()), false);`) ===
      "t",
    "Concurrency acceptance requires an empty Auth table and valid canonical baseline",
  );
}

function snapshotQuery(fixture) {
  return `select jsonb_build_object(
'membership', (select to_jsonb(m) || jsonb_build_object('tuple', m.ctid::text)
from desmoslock_v2.memberships m where m.workspace_id = ${sqlUuid(fixture.workspace)} and m.profile_id = ${sqlUuid(fixture.target)}),
'audit', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('tuple', e.ctid::text) order by e.id)
from desmoslock_v2.staff_audit_events e where e.subject_profile_id = ${sqlUuid(fixture.target)}), '[]'::jsonb));`;
}

function setupQuery(fixture) {
  check(
    ["owner", "admin", "teacher"].includes(fixture.actorRole),
    "Invalid synthetic actor role",
  );
  return `begin;
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('00000000-0000-0000-0000-000000000000',${sqlUuid(fixture.user)},'authenticated','authenticated','lock-${fixture.user}@example.invalid','',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp());
insert into auth.mfa_factors (id,user_id,friendly_name,factor_type,status,created_at,updated_at)
values (${sqlUuid(fixture.factor)},${sqlUuid(fixture.user)},'Synthetic lock factor','totp','verified',clock_timestamp(),clock_timestamp());
insert into auth.sessions (id,user_id,created_at,updated_at,aal,factor_id,not_after)
values (${sqlUuid(fixture.session)},${sqlUuid(fixture.user)},clock_timestamp(),clock_timestamp(),'aal2',${sqlUuid(fixture.factor)},clock_timestamp()+interval '1 hour');
insert into desmoslock_v2.workspaces (id,kind,slug,display_name,seed_key)
values (${sqlUuid(fixture.workspace)},'school','lock-${fixture.workspace}','Synthetic Lock School',null);
insert into desmoslock_v2.profiles (id,display_name,seed_key,auth_user_id)
values (${sqlUuid(fixture.owner)},'Synthetic Lock Owner',null,${sqlUuid(fixture.user)}),
(${sqlUuid(fixture.target)},'Synthetic Lock Teacher',null,null);
insert into desmoslock_v2.memberships (workspace_id,profile_id,role,seed_key)
values (${sqlUuid(fixture.workspace)},${sqlUuid(fixture.owner)},'${fixture.actorRole}',null),
(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)},'teacher',null);
commit;`;
}

function authorityMutation(fixture, action) {
  if (action === "promote-target")
    return `update desmoslock_v2.memberships set role='admin',role_revision=role_revision+1,updated_at=clock_timestamp()
where workspace_id=${sqlUuid(fixture.workspace)} and profile_id=${sqlUuid(fixture.target)};`;
  if (action === "membership")
    return `update desmoslock_v2.memberships
set status='revoked',role_revision=role_revision+1,revoked_at=clock_timestamp(),
revoked_by_profile_id=${sqlUuid(fixture.owner)},revocation_reason_code='owner_action',updated_at=clock_timestamp()
where workspace_id=${sqlUuid(fixture.workspace)} and profile_id=${sqlUuid(fixture.owner)};`;
  if (action === "session")
    return `update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=${sqlUuid(fixture.session)};`;
  if (action === "factor")
    return `update auth.mfa_factors set status='unverified' where id=${sqlUuid(fixture.factor)};`;
  return "";
}

async function waitForTargetLock(blocker, actor) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const rows = await blocker.query(`select pg_stat_clear_snapshot();
select a.state='active' and a.wait_event_type='Lock'
and pg_backend_pid() = any(pg_blocking_pids(a.pid))
from pg_stat_activity a where a.pid=${actor.pid} and a.application_name='${actor.name}';`);
    if (rows.length === 1 && rows[0] === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "The actual RPC never demonstrated the required target lock wait",
  );
}

function cleanup(fixture, names) {
  check(
    sql(
      `select not exists (select 1 from pg_stat_activity where application_name in ('${names[0]}','${names[1]}'));`,
    ) === "t",
    "Concurrency backends remain alive; CI must stop the disposable stack",
  );
  check(
    sql(`select not exists (select 1 from desmoslock_v2.staff_audit_events
where workspace_id=${sqlUuid(fixture.workspace)} or subject_profile_id in (${sqlUuid(fixture.owner)},${sqlUuid(fixture.target)}));`) ===
      "t",
    "Unexpected immutable concurrency audit residue; CI must stop the disposable stack",
  );
  // Every identifier is generated and owned by this scenario. Never bypass or
  // delete audit rows; even a buggy successful RPC was enclosed in A's rollback.
  sql(`begin;
set local statement_timeout='8s'; set local lock_timeout='3s';
delete from desmoslock_v2.memberships where workspace_id=${sqlUuid(fixture.workspace)} and profile_id in (${sqlUuid(fixture.owner)},${sqlUuid(fixture.target)});
delete from desmoslock_v2.profiles where id in (${sqlUuid(fixture.owner)},${sqlUuid(fixture.target)});
delete from desmoslock_v2.workspaces where id=${sqlUuid(fixture.workspace)};
delete from auth.sessions where user_id=${sqlUuid(fixture.user)};
delete from auth.mfa_factors where user_id=${sqlUuid(fixture.user)};
delete from auth.users where id=${sqlUuid(fixture.user)};
commit;`);
  check(
    sql(`select (not exists(select 1 from desmoslock_v2.workspaces where id=${sqlUuid(fixture.workspace)}))
and (not exists(select 1 from desmoslock_v2.profiles where id in (${sqlUuid(fixture.owner)},${sqlUuid(fixture.target)})));`) ===
      "t",
    "Concurrency runtime fixtures were not completely removed",
  );
  freshBaseline();
}

test(
  "Membership mutations recheck authority, target role, and revision after an observed PostgreSQL lock wait",
  { timeout: 180_000 },
  async (t) => {
    verifyDisposableDatabase();
    freshBaseline();
    for (const scenario of scenarios) {
      await t.test(scenario.action, { timeout: 25_000 }, async () => {
        const fixture = Object.fromEntries(
          ["user", "session", "factor", "workspace", "owner", "target"].map(
            (key) => [key, randomUUID()],
          ),
        );
        fixture.actorRole = scenario.actorRole ?? "owner";
        const namespace = randomUUID();
        const names = [`lock-${namespace}-actor`, `lock-${namespace}-blocker`];
        let actor;
        let blocker;
        try {
          blocker = await openConnection(names[1]);
          await blocker.query(setupQuery(fixture));
          const beforeRows = await blocker.query(snapshotQuery(fixture));
          check(
            beforeRows.length === 1,
            "Initial target snapshot is incomplete",
          );
          const before = parseJson(beforeRows[0]);
          check(
            before.membership?.status === "active" &&
              before.membership.role_revision === 1 &&
              before.audit?.length === 0,
            "Concurrency fixture did not begin with an active unaudited target",
          );
          const lockedRows = await blocker.query(`begin;
select profile_id::text from desmoslock_v2.memberships
where workspace_id=${sqlUuid(fixture.workspace)} and profile_id=${sqlUuid(fixture.target)} for update;`);
          check(
            lockedRows.length === 1 && lockedRows[0] === fixture.target,
            "The blocker did not lock the exact target Membership",
          );
          actor = await openConnection(names[0]);
          const claims = JSON.stringify({
            sub: fixture.user,
            session_id: fixture.session,
            role: "authenticated",
            aal: "aal2",
            exp: Math.floor(Date.now() / 1000) + 3600,
          });
          // Both operations carry the revision observed before B's transition.
          const mutation =
            scenario.operation === "role-change"
              ? `select code from desmoslock_v2.change_membership_role(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)},'admin',1);`
              : `select code from desmoslock_v2.revoke_membership(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)},1);`;
          const resultPromise = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${claims}';
set local role authenticated;
${mutation}
reset role;
${snapshotQuery(fixture)}
rollback;`);
          // A can fail while B is observing the wait; attach rejection handling
          // immediately and still inspect the original promise after releasing B.
          void resultPromise.catch(() => {});
          await waitForTargetLock(blocker, actor);
          const competitorRows = await blocker.query(
            `${authorityMutation(fixture, scenario.mutation ?? scenario.action)}\n${snapshotQuery(fixture)}`,
          );
          check(
            competitorRows.length === 1,
            "Committed competitor snapshot is incomplete",
          );
          const competitorState = parseJson(competitorRows[0]);
          await blocker.query("commit;");
          const results = await resultPromise;
          const observedCode = reportableCodes.has(results[0])
            ? results[0]
            : "unrecognized";
          check(
            results.length === 2 && results[0] === scenario.expected,
            `Actual Membership result violated post-lock authorization (expected ${scenario.expected}; observed ${observedCode}; rows ${Math.min(results.length, 999)})`,
          );
          const after = parseJson(results[1]);
          if (scenario.expected === "membership_revoked") {
            check(
              after.membership?.status === "revoked" &&
                after.membership.role_revision ===
                  before.membership.role_revision + 1 &&
                after.membership.revoked_by_profile_id === fixture.owner &&
                after.membership.revocation_reason_code ===
                  (fixture.actorRole === "admin"
                    ? "administrator_action"
                    : "owner_action") &&
                after.audit?.length === 1 &&
                after.audit[0].event_type === "membership_revoked" &&
                after.audit[0].actor_profile_id === fixture.owner &&
                after.audit[0].subject_profile_id === fixture.target,
              "Unchanged-authority positive control did not revoke and audit the target",
            );
          } else if (scenario.expected === "membership_role_changed") {
            check(
              after.membership?.status === "active" &&
                after.membership.role === "admin" &&
                after.membership.role_revision === 2 &&
                after.audit?.length === 1 &&
                after.audit[0].event_type === "membership_role_changed" &&
                after.audit[0].result_code === "membership_role_changed" &&
                after.audit[0].actor_profile_id === fixture.owner &&
                after.audit[0].subject_profile_id === fixture.target &&
                after.audit[0].session_id === fixture.session &&
                after.audit[0].previous_role === "teacher" &&
                after.audit[0].new_role === "admin" &&
                after.audit[0].previous_role_revision === 1 &&
                after.audit[0].new_role_revision === 2 &&
                after.audit[0].occurred_at === after.membership.updated_at,
              "Role-change positive control did not produce the atomic typed audit",
            );
          } else {
            check(
              isDeepStrictEqual(after, competitorState),
              "Denied post-lock mutation changed the competitor's Membership or audit tuple",
            );
          }
          const restoredRows = await blocker.query(snapshotQuery(fixture));
          check(
            restoredRows.length === 1 &&
              isDeepStrictEqual(parseJson(restoredRows[0]), competitorState),
            "The actor transaction did not roll back its target and audit changes",
          );
        } finally {
          const closed = await Promise.allSettled([
            actor?.close(),
            blocker?.close(),
          ]);
          check(
            closed.every((result) => result.status === "fulfilled"),
            "Concurrency backend shutdown failed; CI must stop the disposable stack",
          );
          cleanup(fixture, names);
        }
      });
    }
  },
);

const schoolScenarios = [
  { action: "owner-update", expected: "school_display_name_updated" },
  {
    action: "admin-update",
    actorRole: "admin",
    expected: "school_display_name_updated",
  },
  {
    action: "unchanged-name",
    name: "Synthetic Lock School",
    expected: "school_display_name_unchanged",
  },
  {
    action: "stale-revision",
    mutation: "rename",
    expected: "school_settings_revision_conflict",
  },
  {
    action: "stale-same-name",
    mutation: "rename-same",
    expected: "school_settings_revision_conflict",
  },
  {
    action: "admin-downgrade",
    actorRole: "admin",
    mutation: "downgrade",
    expected: "forbidden",
  },
  {
    action: "actor-revocation",
    mutation: "membership",
    expected: "membership_inactive",
  },
  {
    action: "session-expiry",
    mutation: "session",
    expected: "session_expired",
  },
  { action: "mfa-loss", mutation: "factor", expected: "step_up_required" },
];
const schoolReportableCodes = new Set([
  ...schoolScenarios.map((scenario) => scenario.expected),
  ...reportableCodes,
]);

function schoolSnapshotQuery(fixture) {
  return `select jsonb_build_object(
'school', (select to_jsonb(w) || jsonb_build_object('tuple', w.ctid::text)
from desmoslock_v2.workspaces w where w.id = ${sqlUuid(fixture.workspace)}),
'audit', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('tuple', e.ctid::text) order by e.id)
from desmoslock_v2.staff_audit_events e where e.workspace_id = ${sqlUuid(fixture.workspace)}), '[]'::jsonb));`;
}

function schoolCompetitorMutation(fixture, action) {
  if (action === "rename" || action === "rename-same")
    return `update desmoslock_v2.workspaces set display_name='${action === "rename-same" ? "Renamed Lock School" : "Competing School Name"}',settings_revision=settings_revision+1
where id=${sqlUuid(fixture.workspace)};`;
  if (action === "downgrade")
    return `update desmoslock_v2.memberships set role='teacher',role_revision=role_revision+1,updated_at=clock_timestamp()
where workspace_id=${sqlUuid(fixture.workspace)} and profile_id=${sqlUuid(fixture.owner)};`;
  return authorityMutation(fixture, action);
}

// These cases contend on the School row itself. The second connection proves
// the real RPC is blocked before committing its synthetic competitor transition.
// No helper replacement, artificial authorization result, or audit deletion is used.
test(
  "School settings recheck live authority and settings revision after an observed PostgreSQL School-row lock wait",
  { timeout: 180_000 },
  async (t) => {
    verifyDisposableDatabase();
    freshBaseline();
    for (const scenario of schoolScenarios) {
      await t.test(scenario.action, { timeout: 25_000 }, async () => {
        const fixture = Object.fromEntries(
          ["user", "session", "factor", "workspace", "owner", "target"].map(
            (key) => [key, randomUUID()],
          ),
        );
        fixture.actorRole = scenario.actorRole ?? "owner";
        const namespace = randomUUID();
        const names = [`lock-${namespace}-actor`, `lock-${namespace}-blocker`];
        let actor;
        let blocker;
        try {
          blocker = await openConnection(names[1]);
          await blocker.query(setupQuery(fixture));
          const beforeRows = await blocker.query(schoolSnapshotQuery(fixture));
          check(
            beforeRows.length === 1,
            "Initial School snapshot is incomplete",
          );
          const before = parseJson(beforeRows[0]);
          check(
            before.school?.seed_key === null &&
              before.school.settings_revision === 1 &&
              before.school.display_name === "Synthetic Lock School" &&
              before.audit?.length === 0,
            "School concurrency fixture did not begin with an unaudited runtime School",
          );
          const lockedRows = await blocker.query(`begin;
select id::text from desmoslock_v2.workspaces
where id=${sqlUuid(fixture.workspace)} for update;`);
          check(
            lockedRows.length === 1 && lockedRows[0] === fixture.workspace,
            "The blocker did not lock the exact target School",
          );
          actor = await openConnection(names[0]);
          const claims = JSON.stringify({
            sub: fixture.user,
            session_id: fixture.session,
            role: "authenticated",
            aal: "aal2",
            exp: Math.floor(Date.now() / 1000) + 3600,
          });
          const resultPromise = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${claims}';
set local role authenticated;
select code from desmoslock_v2.update_school_display_name(${sqlUuid(fixture.workspace)},'${scenario.name ?? "Renamed Lock School"}',1);
reset role;
${schoolSnapshotQuery(fixture)}
rollback;`);
          void resultPromise.catch(() => {});
          await waitForTargetLock(blocker, actor);
          const competitorRows = await blocker.query(
            `${schoolCompetitorMutation(fixture, scenario.mutation)}\n${schoolSnapshotQuery(fixture)}`,
          );
          check(
            competitorRows.length === 1,
            "School competitor snapshot is incomplete",
          );
          const competitorState = parseJson(competitorRows[0]);
          // A successful audit must use a new clock after this observed wait,
          // rather than the actor transaction's earlier statement timestamp.
          const releaseRows = await blocker.query(
            "select clock_timestamp()::text;",
          );
          check(
            releaseRows.length === 1,
            "School lock release clock is absent",
          );
          const releaseTime = Date.parse(releaseRows[0]);
          check(
            Number.isFinite(releaseTime),
            "School lock release clock is invalid",
          );
          await blocker.query("commit;");
          const results = await resultPromise;
          const observedCode = schoolReportableCodes.has(results[0])
            ? results[0]
            : "unrecognized";
          check(
            results.length === 2 && results[0] === scenario.expected,
            `Actual School result violated post-lock authorization (expected ${scenario.expected}; observed ${observedCode}; rows ${Math.min(results.length, 999)})`,
          );
          const after = parseJson(results[1]);
          if (scenario.expected === "school_display_name_updated") {
            const event = after.audit?.[0];
            check(
              after.school?.display_name === "Renamed Lock School" &&
                after.school.settings_revision === 2 &&
                after.school.tuple !== before.school.tuple &&
                after.audit?.length === 1 &&
                event.event_type === "school_display_name_updated" &&
                event.result_code === "school_display_name_updated" &&
                event.workspace_id === fixture.workspace &&
                event.actor_profile_id === fixture.owner &&
                event.session_id === fixture.session &&
                event.subject_profile_id === null &&
                event.invitation_id === null &&
                event.previous_settings_revision === 1 &&
                event.new_settings_revision === 2 &&
                event.previous_role === null &&
                event.new_role === null &&
                event.previous_role_revision === null &&
                event.new_role_revision === null &&
                Date.parse(event.occurred_at) >= releaseTime,
              "School positive control did not produce one revision and the fresh typed audit",
            );
            const expectedSchool = {
              ...before.school,
              display_name: "Renamed Lock School",
              settings_revision: 2,
              tuple: after.school.tuple,
            };
            check(
              isDeepStrictEqual(after.school, expectedSchool),
              "School rename changed identity or unrelated columns",
            );
          } else {
            check(
              isDeepStrictEqual(after, competitorState),
              "Denied or unchanged post-lock School mutation changed the competitor's School or audit tuple",
            );
          }
          const restoredRows = await blocker.query(
            schoolSnapshotQuery(fixture),
          );
          check(
            restoredRows.length === 1 &&
              isDeepStrictEqual(parseJson(restoredRows[0]), competitorState),
            "The actor transaction did not roll back its School and audit changes",
          );
        } finally {
          const closed = await Promise.allSettled([
            actor?.close(),
            blocker?.close(),
          ]);
          check(
            closed.every((result) => result.status === "fulfilled"),
            "School concurrency backend shutdown failed; CI must stop the disposable stack",
          );
          cleanup(fixture, names);
        }
      });
    }
  },
);

const testScenarios = [
  { action: "teacher-open", actorRole: "teacher", expected: "test_opened" },
  { action: "administrator-open", actorRole: "admin", expected: "test_opened" },
  {
    action: "stale-title",
    mutation: "title",
    expected: "test_revision_conflict",
  },
  {
    action: "revoked-actor",
    mutation: "membership",
    expected: "membership_inactive",
  },
  {
    action: "expired-session",
    mutation: "session",
    expected: "session_expired",
  },
  { action: "lost-mfa", mutation: "factor", expected: "step_up_required" },
  {
    action: "promoted-teacher-requires-mfa",
    actorRole: "teacher",
    mutation: "promote-actor",
    expected: "step_up_required",
  },
  {
    action: "end-stale-title",
    operation: "end",
    mutation: "title",
    expected: "test_revision_conflict",
  },
];

function testFixture(actorRole = "owner") {
  return {
    ...Object.fromEntries(
      [
        "user",
        "session",
        "factor",
        "workspace",
        "owner",
        "target",
        "test",
        "child",
        "creation",
        "created",
        "initialRequest",
      ].map((key) => [key, randomUUID()]),
    ),
    actorRole,
  };
}

function testClaims(fixture) {
  return JSON.stringify({
    sub: fixture.user,
    session_id: fixture.session,
    role: "authenticated",
    aal: fixture.actorRole === "teacher" ? "aal1" : "aal2",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

function setupTestQuery(fixture, lifecycle = "draft") {
  check(
    ["draft", "open"].includes(lifecycle),
    "Invalid initial Test lifecycle",
  );
  const teacherSession =
    fixture.actorRole === "teacher"
      ? `update auth.sessions set aal='aal1',factor_id=null where id=${sqlUuid(fixture.session)};`
      : "";
  return `${setupQuery(fixture)}
begin;
${teacherSession}
insert into desmoslock_v2.tests (
id,workspace_id,created_by_profile_id,title,seed_key,lifecycle,revision,created_at,opened_at,ended_at,creation_request_id
) values (${sqlUuid(fixture.test)},${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)},'Synthetic colleague Test',null,
'${lifecycle}',1,clock_timestamp()-interval '2 seconds',
${lifecycle === "open" ? "clock_timestamp()-interval '1 second'" : "null"},null,${sqlUuid(fixture.initialRequest)});
insert into desmoslock_v2.student_sessions (id,workspace_id,test_id,state,seed_key)
values (${sqlUuid(fixture.child)},${sqlUuid(fixture.workspace)},${sqlUuid(fixture.test)},'created',null);
commit;`;
}

function testSnapshotQuery(fixture) {
  return `select jsonb_build_object(
'tests',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('tuple',t.ctid::text) order by t.id)
from desmoslock_v2.tests t where t.workspace_id=${sqlUuid(fixture.workspace)}),'[]'::jsonb),
'children',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('tuple',s.ctid::text) order by s.id)
from desmoslock_v2.student_sessions s where s.workspace_id=${sqlUuid(fixture.workspace)}),'[]'::jsonb),
'audit',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('tuple',e.ctid::text) order by e.id)
from desmoslock_v2.staff_audit_events e where e.workspace_id=${sqlUuid(fixture.workspace)}),'[]'::jsonb));`;
}

function cleanupTest(fixture, names) {
  check(
    sql(`select not exists(select 1 from pg_stat_activity where application_name in ('${names[0]}','${names[1]}'))
and not exists(select 1 from desmoslock_v2.staff_audit_events where workspace_id=${sqlUuid(fixture.workspace)});`) ===
      "t",
    "Test concurrency connections or immutable audit remain; CI must stop the stack",
  );
  // The entire School and every child were generated by this one fixture.
  // Never delete audit rows or disable their append-only protections.
  sql(`begin;
delete from desmoslock_v2.student_sessions where workspace_id=${sqlUuid(fixture.workspace)};
delete from desmoslock_v2.tests where workspace_id=${sqlUuid(fixture.workspace)};
commit;`);
  cleanup(fixture, names);
}

async function closeTestConnections(actor, blocker, fixture, names) {
  const results = await Promise.allSettled([actor?.close(), blocker?.close()]);
  check(
    results.every((result) => result.status === "fulfilled"),
    "Test concurrency backend shutdown failed; CI must stop the stack",
  );
  cleanupTest(fixture, names);
}

function testCompetitorMutation(fixture, mutation) {
  if (mutation === "title") {
    return `update desmoslock_v2.tests set title='Competing Test title',revision=revision+1
where id=${sqlUuid(fixture.test)} and workspace_id=${sqlUuid(fixture.workspace)};`;
  }
  if (mutation === "promote-actor") {
    return `update desmoslock_v2.memberships set role='admin',role_revision=role_revision+1
where workspace_id=${sqlUuid(fixture.workspace)} and profile_id=${sqlUuid(fixture.owner)};`;
  }
  return authorityMutation(fixture, mutation);
}

test(
  "Test mutations recheck live role-dependent authority and target revision after observed Test-row waits",
  { timeout: 180_000 },
  async (t) => {
    verifyDisposableDatabase();
    freshBaseline();
    for (const scenario of testScenarios) {
      await t.test(scenario.action, { timeout: 25_000 }, async () => {
        const fixture = testFixture(scenario.actorRole);
        const namespace = randomUUID();
        const names = [`test-${namespace}-actor`, `test-${namespace}-blocker`];
        let actor;
        let blocker;
        try {
          blocker = await openConnection(names[1]);
          await blocker.query(
            setupTestQuery(
              fixture,
              scenario.operation === "end" ? "open" : "draft",
            ),
          );
          await blocker.query(`begin;
select id from desmoslock_v2.tests where workspace_id=${sqlUuid(fixture.workspace)} and id=${sqlUuid(fixture.test)} for update;`);
          actor = await openConnection(names[0]);
          const rpc = scenario.operation === "end" ? "end_test" : "open_test";
          const pending = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${testClaims(fixture)}';
set local role authenticated;
select code from desmoslock_v2.${rpc}(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.test)},1);
reset role;
${testSnapshotQuery(fixture)}
rollback;`);
          void pending.catch(() => {});
          await waitForTargetLock(blocker, actor);
          const competitorRows =
            await blocker.query(`${testCompetitorMutation(fixture, scenario.mutation)}
${testSnapshotQuery(fixture)}`);
          check(
            competitorRows.length === 1,
            "Test competitor snapshot is incomplete",
          );
          const before = parseJson(competitorRows[0]);
          await blocker.query("commit;");
          const rows = await pending;
          check(
            rows.length === 2 && rows[0] === scenario.expected,
            "Post-lock Test mutation did not return the selected result",
          );
          const after = parseJson(rows[1]);
          if (scenario.expected === "test_opened") {
            const changed = after.tests.find(
              (item) => item.id === fixture.test,
            );
            const old = before.tests.find((item) => item.id === fixture.test);
            check(
              changed?.lifecycle === "open" &&
                changed.revision === 2 &&
                changed.title === old.title &&
                changed.created_at === old.created_at &&
                changed.created_by_profile_id === fixture.target &&
                changed.opened_at !== null &&
                changed.ended_at === null &&
                isDeepStrictEqual(after.children, before.children),
              "Test opening changed attribution, child state, or the expected revision",
            );
            check(
              after.audit.length === 1 &&
                after.audit[0].event_type === "test_opened" &&
                after.audit[0].result_code === "test_opened" &&
                after.audit[0].actor_profile_id === fixture.owner &&
                after.audit[0].session_id === fixture.session &&
                after.audit[0].test_id === fixture.test &&
                after.audit[0].previous_test_revision === 1 &&
                after.audit[0].new_test_revision === 2 &&
                after.audit[0].previous_test_lifecycle === "draft" &&
                after.audit[0].new_test_lifecycle === "open",
              "Test opening lacks its exact atomic initiating-actor audit",
            );
          } else {
            check(
              isDeepStrictEqual(after, before),
              "Denied Test mutation changed Test, child, or audit tuples",
            );
          }
          const restored = await blocker.query(testSnapshotQuery(fixture));
          check(
            restored.length === 1 &&
              isDeepStrictEqual(parseJson(restored[0]), before),
            "Test mutation rollback did not preserve competitor state",
          );
        } finally {
          await closeTestConnections(actor, blocker, fixture, names);
        }
      });
    }
  },
);

// A committed competitor below is direct fixture SQL, not a second GoTrue/RPC
// creation. It proves reconciliation of a key that appeared during the School
// lock wait. The separate real-provider journey owns concurrent RPC commits.
test(
  "Test creation rechecks School-lock authority and reconciles a retained creation key",
  { timeout: 90_000 },
  async (t) => {
    verifyDisposableDatabase();
    freshBaseline();
    for (const scenario of ["fresh", "expired-session", "recorded-key"]) {
      await t.test(scenario, { timeout: 25_000 }, async () => {
        const fixture = testFixture();
        const namespace = randomUUID();
        const names = [
          `create-${namespace}-actor`,
          `create-${namespace}-blocker`,
        ];
        let actor;
        let blocker;
        try {
          blocker = await openConnection(names[1]);
          await blocker.query(setupTestQuery(fixture));
          await blocker.query(
            `begin; select id from desmoslock_v2.workspaces where id=${sqlUuid(fixture.workspace)} for update;`,
          );
          actor = await openConnection(names[0]);
          const pending = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${testClaims(fixture)}';
set local role authenticated;
select row_to_json(result) from desmoslock_v2.create_school_test(
${sqlUuid(fixture.workspace)},${sqlUuid(fixture.creation)},'Original retained create title') as result;
reset role;
${testSnapshotQuery(fixture)}
rollback;`);
          void pending.catch(() => {});
          await waitForTargetLock(blocker, actor);
          let mutation = "";
          if (scenario === "expired-session")
            mutation = authorityMutation(fixture, "session");
          if (scenario === "recorded-key") {
            mutation = `insert into desmoslock_v2.tests (
id,workspace_id,created_by_profile_id,title,seed_key,lifecycle,revision,created_at,opened_at,ended_at,creation_request_id)
values (${sqlUuid(fixture.created)},${sqlUuid(fixture.workspace)},${sqlUuid(fixture.owner)},
'Already edited creation',null,'open',2,clock_timestamp()-interval '2 seconds',
clock_timestamp()-interval '1 second',null,${sqlUuid(fixture.creation)});`;
          }
          const competitorRows = await blocker.query(`${mutation}
${testSnapshotQuery(fixture)}`);
          check(
            competitorRows.length === 1,
            "Create competitor snapshot is incomplete",
          );
          const before = parseJson(competitorRows[0]);
          await blocker.query("commit;");
          const rows = await pending;
          check(rows.length === 2, "Create lock result is incomplete");
          const result = parseJson(rows[0]);
          const after = parseJson(rows[1]);
          if (scenario === "fresh") {
            const created = after.tests.find(
              (item) => item.id === result.test_id,
            );
            check(
              result.code === "test_created" &&
                created?.lifecycle === "draft" &&
                created.revision === 1 &&
                created.creation_request_id === fixture.creation &&
                created.created_by_profile_id === fixture.owner &&
                created.title === "Original retained create title" &&
                after.tests.length === before.tests.length + 1 &&
                after.audit.length === 1 &&
                after.audit[0].event_type === "test_created" &&
                after.audit[0].test_id === result.test_id &&
                after.audit[0].actor_profile_id === fixture.owner &&
                after.audit[0].session_id === fixture.session &&
                isDeepStrictEqual(after.children, before.children),
              "Fresh creation did not produce exactly one attributed Test and audit",
            );
          } else {
            check(
              result.code ===
                (scenario === "recorded-key"
                  ? "test_creation_already_recorded"
                  : "session_expired") &&
                result.test_id ===
                  (scenario === "recorded-key" ? fixture.created : null) &&
                isDeepStrictEqual(after, before),
              "Create denial/reconciliation changed prior Test facts or added an audit",
            );
          }
          const restored = await blocker.query(testSnapshotQuery(fixture));
          check(
            restored.length === 1 &&
              isDeepStrictEqual(parseJson(restored[0]), before),
            "Create actor rollback left Test or audit changes",
          );
        } finally {
          await closeTestConnections(actor, blocker, fixture, names);
        }
      });
    }
  },
);

// These are SQL locking/predicate probes over today's placeholder child table.
// They are deliberately not join/reconnect handlers or device-release evidence.
test(
  "Test parent SHARE and ending UPDATE serialize before placeholder child inspection",
  { timeout: 60_000 },
  async (t) => {
    verifyDisposableDatabase();
    freshBaseline();
    for (const order of ["parent-share-first", "ended-parent-first"]) {
      await t.test(order, { timeout: 25_000 }, async () => {
        const fixture = testFixture();
        const namespace = randomUUID();
        const names = [
          `parent-${namespace}-actor`,
          `parent-${namespace}-blocker`,
        ];
        let actor;
        let blocker;
        try {
          blocker = await openConnection(names[1]);
          await blocker.query(setupTestQuery(fixture, "open"));
          const initialRows = await blocker.query(testSnapshotQuery(fixture));
          check(
            initialRows.length === 1,
            "Parent initial snapshot is incomplete",
          );
          const initial = parseJson(initialRows[0]);
          actor = await openConnection(names[0]);
          if (order === "parent-share-first") {
            await blocker.query(`begin;
select id from desmoslock_v2.tests where workspace_id=${sqlUuid(fixture.workspace)} and id=${sqlUuid(fixture.test)} for share;
select id from desmoslock_v2.student_sessions where workspace_id=${sqlUuid(fixture.workspace)}
and test_id=${sqlUuid(fixture.test)} and id=${sqlUuid(fixture.child)} for update;`);
            const pending = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${testClaims(fixture)}';
set local role authenticated;
select code from desmoslock_v2.end_test(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.test)},1);
reset role;
${testSnapshotQuery(fixture)}
rollback;`);
            void pending.catch(() => {});
            await waitForTargetLock(blocker, actor);
            const openRows = await blocker.query(
              `select lifecycle='open' from desmoslock_v2.tests where id=${sqlUuid(fixture.test)};`,
            );
            check(
              openRows.length === 1 && openRows[0] === "t",
              "Child-first probe lost its open parent predicate",
            );
            await blocker.query("commit;");
            const rows = await pending;
            check(
              rows.length === 2 && rows[0] === "test_ended",
              "End did not wait for and follow the parent SHARE lock",
            );
            const ended = parseJson(rows[1]);
            check(
              ended.tests[0]?.lifecycle === "ended" &&
                ended.tests[0].revision === 2 &&
                ended.tests[0].ended_at !== null &&
                isDeepStrictEqual(ended.children, initial.children) &&
                ended.audit.length === 1 &&
                ended.audit[0].event_type === "test_ended",
              "End did not atomically close the parent while preserving placeholder children",
            );
          } else {
            // Direct fixture transition commits the closed predicate without an
            // immutable audit residue; the first case exercises the real end RPC.
            await blocker.query(`begin;
update desmoslock_v2.tests set lifecycle='ended',revision=revision+1,ended_at=clock_timestamp()
where workspace_id=${sqlUuid(fixture.workspace)} and id=${sqlUuid(fixture.test)};`);
            const pending = actor.query(`begin;
create temporary table parent_gate_probe (allowed boolean not null, child_inspected boolean not null) on commit drop;
do $probe$
declare parent_open boolean; child_seen boolean := false;
begin
select lifecycle='open' into parent_open from desmoslock_v2.tests
where workspace_id=${sqlUuid(fixture.workspace)} and id=${sqlUuid(fixture.test)} for share;
if parent_open then
perform 1 from desmoslock_v2.student_sessions where workspace_id=${sqlUuid(fixture.workspace)}
and test_id=${sqlUuid(fixture.test)} and id=${sqlUuid(fixture.child)} for update;
child_seen := found;
end if;
insert into parent_gate_probe values (coalesce(parent_open,false),child_seen);
end;
$probe$;
select (not allowed and not child_inspected) from parent_gate_probe;
${testSnapshotQuery(fixture)}
rollback;`);
            void pending.catch(() => {});
            await waitForTargetLock(blocker, actor);
            await blocker.query("commit;");
            const rows = await pending;
            check(
              rows.length === 2 && rows[0] === "t",
              "Waiting child probe did not reject the ended parent before inspecting the child",
            );
            const ended = parseJson(rows[1]);
            check(
              ended.tests[0]?.lifecycle === "ended" &&
                ended.audit.length === 0 &&
                isDeepStrictEqual(ended.children, initial.children),
              "Closed parent probe mutated child state or invented transition audit",
            );
          }
        } finally {
          await closeTestConnections(actor, blocker, fixture, names);
        }
      });
    }
  },
);
