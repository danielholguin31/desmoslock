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
const scenarios = [
  { action: "unchanged", expected: "membership_revoked" },
  { action: "membership", expected: "membership_inactive" },
  { action: "session", expected: "session_expired" },
  { action: "factor", expected: "step_up_required" },
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
values (${sqlUuid(fixture.workspace)},${sqlUuid(fixture.owner)},'owner',null),
(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)},'teacher',null);
commit;`;
}

function authorityMutation(fixture, action) {
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
    "The actual revoke RPC never demonstrated the required target lock wait",
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
  "revoke_membership rechecks authority after an observed PostgreSQL lock wait",
  { timeout: 120_000 },
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
          const resultPromise = actor.query(`begin;
set local "request.jwt.claim.sub"='';
set local "request.jwt.claims"='${claims}';
set local role authenticated;
select code from desmoslock_v2.revoke_membership(${sqlUuid(fixture.workspace)},${sqlUuid(fixture.target)});
reset role;
${snapshotQuery(fixture)}
rollback;`);
          // A can fail while B is observing the wait; attach rejection handling
          // immediately and still inspect the original promise after releasing B.
          void resultPromise.catch(() => {});
          await waitForTargetLock(blocker, actor);
          await blocker.query(
            `${authorityMutation(fixture, scenario.action)}\ncommit;`,
          );
          const results = await resultPromise;
          const observedCode = reportableCodes.has(results[0])
            ? results[0]
            : "unrecognized";
          check(
            results.length === 2 && results[0] === scenario.expected,
            `Actual revoke result violated post-lock authorization (expected ${scenario.expected}; observed ${observedCode}; rows ${Math.min(results.length, 999)})`,
          );
          const after = parseJson(results[1]);
          if (scenario.action === "unchanged") {
            check(
              after.membership?.status === "revoked" &&
                after.membership.role_revision ===
                  before.membership.role_revision + 1 &&
                after.membership.revoked_by_profile_id === fixture.owner &&
                after.audit?.length === 1 &&
                after.audit[0].event_type === "membership_revoked" &&
                after.audit[0].actor_profile_id === fixture.owner &&
                after.audit[0].subject_profile_id === fixture.target,
              "Unchanged-authority positive control did not revoke and audit the target",
            );
          } else {
            check(
              isDeepStrictEqual(after, before),
              "Denied post-lock revocation changed a target Membership or audit tuple",
            );
          }
          const restoredRows = await blocker.query(snapshotQuery(fixture));
          check(
            restoredRows.length === 1 &&
              isDeepStrictEqual(parseJson(restoredRows[0]), before),
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
