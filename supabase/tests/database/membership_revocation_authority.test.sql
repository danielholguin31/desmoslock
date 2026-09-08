begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

-- Deterministic fault injection models authority changes after a genuine first
-- authorization result. This is not actual multi-connection lock coverage.
-- Independent NULL-seed runtime fixtures keep the canonical baseline unchanged.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'a8100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'revocation-owner@staff.invalid', '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
  clock_timestamp(), clock_timestamp()
);
insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at
) values (
  'b8100000-0000-4000-8000-000000000001',
  'a8100000-0000-4000-8000-000000000001',
  'Synthetic revocation Owner factor', 'totp', 'verified',
  clock_timestamp(), clock_timestamp()
);
insert into auth.sessions (
  id, user_id, created_at, updated_at, factor_id, aal, not_after
) values (
  'c8100000-0000-4000-8000-000000000001',
  'a8100000-0000-4000-8000-000000000001',
  clock_timestamp(), clock_timestamp(),
  'b8100000-0000-4000-8000-000000000001', 'aal2',
  clock_timestamp() + interval '1 hour'
);
insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key)
values (
  '12000000-0000-4000-8000-000000000001', 'school',
  'runtime-revocation-authority', 'Runtime Revocation School', null
);
insert into desmoslock_v2.profiles (id, display_name, auth_user_id, seed_key)
values
  (
    '22000000-0000-4000-8000-000000000001', 'Runtime Revocation Owner',
    'a8100000-0000-4000-8000-000000000001', null
  ),
  ('22000000-0000-4000-8000-000000000002', 'Runtime Revocation Teacher', null, null);
insert into desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key)
values
  (
    '12000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001', 'owner', null
  ),
  (
    '12000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000002', 'teacher', null
  );
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a8100000-0000-4000-8000-000000000001',
  'session_id', 'c8100000-0000-4000-8000-000000000001',
  'role', 'authenticated', 'aal', 'aal2',
  'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
)::text, true);
set local role authenticated;
select results_eq(
  $$select code, profile_id, membership_role from desmoslock_v2.current_staff_context()$$,
  $$values ('ok'::text, '22000000-0000-4000-8000-000000000001'::uuid, 'owner'::text)$$,
  'the synthetic provider-schema session and runtime membership establish the initial Owner authority'
);
reset role;

create temporary table membership_revocation_probe (
  action text not null,
  calls integer not null default 0,
  first_code text,
  observed_at timestamp with time zone
) on commit drop;
insert into membership_revocation_probe (action) values ('expired_session');
create temporary table membership_revocation_snapshots (
  label text primary key,
  state jsonb not null
) on commit drop;
create temporary table membership_revocation_original_helper on commit drop as
select function_info.oid as function_oid, function_info.proacl as function_acl
from pg_proc as function_info
where function_info.oid =
  to_regprocedure('desmoslock_v2.internal_authorize_staff(uuid,text[],boolean)');

-- Only the test owner reads this helper; tuple locations detect physical writes
-- even if logical values are unchanged. Audits are scoped to the target staff.
create function pg_temp.membership_revocation_snapshot(target_profile_id uuid)
returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'membership', (
      select to_jsonb(membership) || jsonb_build_object('tuple', membership.ctid::text)
      from desmoslock_v2.memberships as membership
      where membership.workspace_id = '12000000-0000-4000-8000-000000000001'
        and membership.profile_id = $1
    ),
    'audit', (
      select jsonb_agg(to_jsonb(event) order by event.id)
      from desmoslock_v2.staff_audit_events as event
      where event.workspace_id = '12000000-0000-4000-8000-000000000001'
        and event.subject_profile_id = $1
    )
  );
$$;
insert into membership_revocation_snapshots (label, state)
values ('active-teacher', pg_temp.membership_revocation_snapshot(
  '22000000-0000-4000-8000-000000000002'
));

alter function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  rename to revocation_fixture_original_authorize_staff;
create function desmoslock_v2.internal_authorize_staff(
  workspace_id uuid,
  allowed_roles text[],
  require_step_up boolean
)
returns table (
  code text, user_id uuid, session_id uuid, profile_id uuid,
  membership_role text, role_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved_authorization record;
  probe record;
begin
  -- Save the genuine result first. Never manufacture an authorization success:
  -- only the real helper decides what each authorization check returns.
  select * into saved_authorization
  from desmoslock_v2.revocation_fixture_original_authorize_staff($1, $2, $3);
  update pg_temp.membership_revocation_probe set calls = calls + 1
  returning * into probe;
  if probe.calls = 1 then
    update pg_temp.membership_revocation_probe set first_code = saved_authorization.code;
    case probe.action
      when 'expired_session' then
        update auth.sessions set not_after = clock_timestamp() - interval '1 second'
        where id = 'c8100000-0000-4000-8000-000000000001';
      when 'revoked_session' then
        insert into desmoslock_v2.application_session_revocations (
          user_id, session_id, workspace_id, revoked_by_profile_id, reason_code
        ) values (
          'a8100000-0000-4000-8000-000000000001',
          'c8100000-0000-4000-8000-000000000001', null,
          '22000000-0000-4000-8000-000000000001', 'current_session'
        );
      when 'unverified_factor' then
        update auth.mfa_factors set status = 'unverified'
        where id = 'b8100000-0000-4000-8000-000000000001';
      when 'revoked_owner' then
        update desmoslock_v2.memberships as membership
        set status = 'revoked', role_revision = membership.role_revision + 1,
          revoked_at = clock_timestamp(),
          revoked_by_profile_id = '22000000-0000-4000-8000-000000000001',
          revocation_reason_code = 'owner_action'
        where membership.workspace_id = '12000000-0000-4000-8000-000000000001'
          and membership.profile_id = '22000000-0000-4000-8000-000000000001';
      when 'delayed_success' then
        perform pg_sleep(0.1);
        update pg_temp.membership_revocation_probe set observed_at = clock_timestamp();
      else
        null;
    end case;
  end if;
  return query select
    saved_authorization.code, saved_authorization.user_id,
    saved_authorization.session_id, saved_authorization.profile_id,
    saved_authorization.membership_role, saved_authorization.role_revision;
end;
$$;
revoke all on function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  from public, anon, authenticated, service_role;

savepoint revoked_application_session;
update membership_revocation_probe
set action = 'revoked_session', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'session_revoked',
  'revocation rejects concrete application-session revocation after genuine initial authorization'
);
reset role;
select results_eq(
  $$select first_code, calls,
      pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002') =
        (select state from membership_revocation_snapshots where label = 'active-teacher'),
      (select count(*) from desmoslock_v2.application_session_revocations
        where user_id = 'a8100000-0000-4000-8000-000000000001'
          and session_id = 'c8100000-0000-4000-8000-000000000001'
          and reason_code = 'current_session')
    from membership_revocation_probe$$,
  $$values ('ok'::text, 2, true, 1::bigint)$$,
  'the exact session revocation is persisted while the target tuple and target audit remain unchanged'
);
rollback to savepoint revoked_application_session;
release savepoint revoked_application_session;

set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'session_expired',
  'revocation rejects a provider session expired after genuine initial authorization'
);
reset role;
select results_eq(
  $$select first_code, calls,
      pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002') =
        (select state from membership_revocation_snapshots where label = 'active-teacher')
    from membership_revocation_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'session revalidation leaves the target Membership tuple unchanged and emits no target audit'
);
update auth.sessions set not_after = clock_timestamp() + interval '1 hour'
where id = 'c8100000-0000-4000-8000-000000000001';
update membership_revocation_probe
set action = 'unverified_factor', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'step_up_required',
  'revocation rejects TOTP verification lost after genuine initial authorization'
);
reset role;
select results_eq(
  $$select first_code, calls,
      pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002') =
        (select state from membership_revocation_snapshots where label = 'active-teacher')
    from membership_revocation_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'MFA revalidation leaves the target Membership tuple unchanged and emits no target audit'
);
update auth.mfa_factors set status = 'verified'
where id = 'b8100000-0000-4000-8000-000000000001';
update membership_revocation_probe
set action = 'revoked_owner', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'membership_inactive',
  'revocation rejects Owner membership removed after genuine initial authorization'
);
reset role;
select results_eq(
  $$select first_code, calls,
      pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002') =
        (select state from membership_revocation_snapshots where label = 'active-teacher')
    from membership_revocation_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'Owner revalidation leaves the separate target tuple unchanged and emits no target audit'
);
update desmoslock_v2.memberships
set status = 'active', role_revision = 1, revoked_at = null,
  revoked_by_profile_id = null, revocation_reason_code = null
where workspace_id = '12000000-0000-4000-8000-000000000001'
  and profile_id = '22000000-0000-4000-8000-000000000001';

update membership_revocation_probe
set action = 'expired_session', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000099'
  )),
  'session_expired',
  'post-lock authorization precedes disclosure of a missing target Membership'
);
reset role;
select results_eq(
  $$select first_code, calls,
      (select count(*) from desmoslock_v2.staff_audit_events
        where workspace_id = '12000000-0000-4000-8000-000000000001')
    from membership_revocation_probe$$,
  $$values ('ok'::text, 2, 0::bigint)$$,
  'missing-target denial uses fresh authority and produces no audit'
);
update auth.sessions set not_after = clock_timestamp() + interval '1 hour'
where id = 'c8100000-0000-4000-8000-000000000001';
update membership_revocation_probe
set action = 'delayed_success', calls = 0, first_code = null, observed_at = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'membership_revoked',
  'an Owner whose real authority remains valid can revoke the Teacher after the delay'
);
reset role;
select results_eq(
  $$select probe.first_code, probe.calls, membership.status, membership.role_revision,
      membership.revoked_by_profile_id,
      membership.revocation_reason_code,
      membership.revoked_at >= probe.observed_at,
      membership.updated_at = membership.revoked_at
    from desmoslock_v2.memberships as membership
    cross join membership_revocation_probe as probe
    where membership.workspace_id = '12000000-0000-4000-8000-000000000001'
      and membership.profile_id = '22000000-0000-4000-8000-000000000002'$$,
  $$values (
    'ok'::text, 2, 'revoked'::text, 2::bigint,
    '22000000-0000-4000-8000-000000000001'::uuid, 'owner_action'::text, true, true
  )$$,
  'successful revocation advances the target once and stamps both mutation times after the delay'
);
select results_eq(
  $$select event_type, result_code, actor_profile_id, subject_profile_id, session_id
    from desmoslock_v2.staff_audit_events
    where workspace_id = '12000000-0000-4000-8000-000000000001'$$,
  $$values (
    'membership_revoked'::text, 'membership_revoked'::text,
    '22000000-0000-4000-8000-000000000001'::uuid,
    '22000000-0000-4000-8000-000000000002'::uuid,
    'c8100000-0000-4000-8000-000000000001'::uuid
  )$$,
  'successful revocation emits exactly one audit bound to the real Owner, target, and session'
);
insert into membership_revocation_snapshots (label, state)
values
  ('revoked-teacher', pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002')),
  ('active-owner', pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000001'));
update membership_revocation_probe set action = 'none', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002'
  )),
  'membership_inactive',
  'a valid Owner receives the existing inactive result for an already-revoked Teacher'
);
reset role;
select is(
  pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000002'),
  (select state from membership_revocation_snapshots where label = 'revoked-teacher'),
  'repeating revocation neither rewrites the target nor duplicates its audit'
);
update membership_revocation_probe set action = 'none', calls = 0, first_code = null;
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_membership(
    '12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001'
  )),
  'forbidden',
  'valid Owner authority does not permit revoking an Owner target'
);
reset role;
select is(
  pg_temp.membership_revocation_snapshot('22000000-0000-4000-8000-000000000001'),
  (select state from membership_revocation_snapshots where label = 'active-owner'),
  'the Owner-target denial leaves its Membership tuple and audit state unchanged'
);

-- Restore the genuine function object, preserving its exact existing grants.
drop function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean);
alter function desmoslock_v2.revocation_fixture_original_authorize_staff(uuid, text[], boolean)
  rename to internal_authorize_staff;
select ok(
  (
    select function_info.oid = original.function_oid
      and function_info.proacl is not distinct from original.function_acl
    from pg_proc as function_info
    cross join membership_revocation_original_helper as original
    where function_info.oid =
      to_regprocedure('desmoslock_v2.internal_authorize_staff(uuid,text[],boolean)')
  ),
  'the original authorization function and its exact ACL are restored'
);
select is(
  (select fixture_valid from desmoslock_v2.internal_baseline_status()),
  true,
  'runtime revocation fixtures leave the canonical baseline valid'
);

select * from finish();
rollback;
