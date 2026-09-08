begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

-- These are synthetic database fixtures for the service-only bootstrap RPC.
-- They are not a GoTrue login, a live provider session, or a replacement RPC.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.user_id, 'authenticated', 'authenticated', fixture.email, '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, clock_timestamp(), clock_timestamp()
from (values
  ('a8000000-0000-4000-8000-000000000001'::uuid, 'runtime-owner@staff.invalid'),
  ('a8000000-0000-4000-8000-000000000002'::uuid, 'other-runtime-owner@staff.invalid')
) as fixture(user_id, email);

insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key)
values (
  '18000000-0000-4000-8000-000000000001', 'school',
  'runtime-owner-bootstrap', 'Runtime Bootstrap School', null
);
insert into desmoslock_v2.profiles (id, display_name, seed_key)
values (
  '28000000-0000-4000-8000-000000000001', 'Runtime Bootstrap Owner', null
);
insert into desmoslock_v2.memberships (
  workspace_id, profile_id, role, seed_key, status, role_revision
) values (
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001', 'owner', null, 'active', 1
);

create temporary table owner_bootstrap_snapshots (
  label text primary key,
  state jsonb not null
) on commit drop;

-- Invoker-only inspection, called only after RESET ROLE. Tuple locations detect
-- no-op UPDATEs as well as logical changes; row locks alone do not move tuples.
create function pg_temp.owner_bootstrap_snapshot(workspace_id uuid, profile_id uuid)
returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'workspace', to_jsonb(workspace) ||
      jsonb_build_object('tuple', workspace.ctid::text),
    'profile', (
      select to_jsonb(profile) || jsonb_build_object('tuple', profile.ctid::text)
      from desmoslock_v2.profiles as profile where profile.id = $2
    ),
    'membership', (
      select to_jsonb(membership) ||
        jsonb_build_object('tuple', membership.ctid::text)
      from desmoslock_v2.memberships as membership
      where membership.workspace_id = $1 and membership.profile_id = $2
    ),
    'audit', (
      select jsonb_agg(
        to_jsonb(event) || jsonb_build_object('tuple', event.ctid::text)
        order by event.id
      )
      from desmoslock_v2.staff_audit_events as event
      where event.workspace_id = $1 or event.subject_profile_id = $2
    )
  )
  from desmoslock_v2.workspaces as workspace where workspace.id = $1;
$$;

set local role service_role;
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'unbound runtime bootstrap rows leave the exact canonical fixture valid'
);
reset role;

insert into owner_bootstrap_snapshots (label, state)
select 'canonical', pg_temp.owner_bootstrap_snapshot(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'invalid_request',
  'the service bootstrap RPC rejects the canonical seeded School and Owner'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'canonical'),
  'canonical rejection creates no binding or audit and writes no fixture row'
);

savepoint mixed_workspace_seed;
update desmoslock_v2.workspaces set seed_key = 'bootstrap.mixed.workspace'
where id = '18000000-0000-4000-8000-000000000001';
insert into owner_bootstrap_snapshots (label, state)
select 'mixed-workspace', pg_temp.owner_bootstrap_snapshot(
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'invalid_request',
  'a seeded School is rejected even when its Owner profile and Membership are runtime rows'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'mixed-workspace'),
  'mixed School rejection leaves the unbound profile, Membership, and audit untouched'
);
rollback to savepoint mixed_workspace_seed;

savepoint mixed_profile_seed;
update desmoslock_v2.profiles set seed_key = 'bootstrap.mixed.profile'
where id = '28000000-0000-4000-8000-000000000001';
insert into owner_bootstrap_snapshots (label, state)
select 'mixed-profile', pg_temp.owner_bootstrap_snapshot(
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'invalid_request',
  'a seeded Owner profile is rejected even when its School and Membership are runtime rows'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'mixed-profile'),
  'mixed profile rejection leaves the unbound profile, Membership, and audit untouched'
);
rollback to savepoint mixed_profile_seed;

savepoint mixed_membership_seed;
update desmoslock_v2.memberships set seed_key = 'bootstrap.mixed.membership'
where workspace_id = '18000000-0000-4000-8000-000000000001'
  and profile_id = '28000000-0000-4000-8000-000000000001';
insert into owner_bootstrap_snapshots (label, state)
select 'mixed-membership', pg_temp.owner_bootstrap_snapshot(
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'invalid_request',
  'a seeded Owner Membership is rejected even when its School and profile are runtime rows'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'mixed-membership'),
  'mixed Membership rejection leaves the unbound profile, Membership, and audit untouched'
);
rollback to savepoint mixed_membership_seed;

set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'initial_owner_bound',
  'a confirmed Auth identity binds an active Owner across three runtime rows'
);
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'successful runtime Owner binding preserves the exact canonical fixture readiness'
);
reset role;
select results_eq(
  $$select profile.auth_user_id, membership.role, membership.status,
      workspace.seed_key, profile.seed_key, membership.seed_key
    from desmoslock_v2.workspaces as workspace
    join desmoslock_v2.memberships as membership on membership.workspace_id = workspace.id
    join desmoslock_v2.profiles as profile on profile.id = membership.profile_id
    where workspace.id = '18000000-0000-4000-8000-000000000001'
      and profile.id = '28000000-0000-4000-8000-000000000001'$$,
  $$values (
    'a8000000-0000-4000-8000-000000000001'::uuid, 'owner'::text, 'active'::text,
    null::text, null::text, null::text
  )$$,
  'bootstrap binds only the requested runtime identity and preserves Owner eligibility'
);
select results_eq(
  $$select event_type, result_code, workspace_id, subject_profile_id,
      actor_profile_id, invitation_id, session_id
    from desmoslock_v2.staff_audit_events
    where workspace_id = '18000000-0000-4000-8000-000000000001'
      or subject_profile_id = '28000000-0000-4000-8000-000000000001'$$,
  $$values (
    'initial_owner_bound'::text, 'initial_owner_bound'::text,
    '18000000-0000-4000-8000-000000000001'::uuid,
    '28000000-0000-4000-8000-000000000001'::uuid,
    null::uuid, null::uuid, null::uuid
  )$$,
  'successful bootstrap emits exactly one system-attributed binding audit'
);

insert into owner_bootstrap_snapshots (label, state)
select 'bound', pg_temp.owner_bootstrap_snapshot(
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'initial_owner_bound',
  'exact runtime Owner replay reconciles the original binding'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'bound'),
  'exact replay writes no workspace, profile, Membership, or audit tuple'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000002'
  )),
  'conflict',
  'another confirmed Auth identity cannot replace the bound runtime Owner'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'bound'),
  'a mismatched identity leaves the original binding and audit untouched'
);

savepoint revoked_runtime_owner;
update desmoslock_v2.memberships
set status = 'revoked', role_revision = role_revision + 1,
  revoked_at = clock_timestamp(),
  revoked_by_profile_id = '28000000-0000-4000-8000-000000000001',
  revocation_reason_code = 'owner_action', updated_at = clock_timestamp()
where workspace_id = '18000000-0000-4000-8000-000000000001'
  and profile_id = '28000000-0000-4000-8000-000000000001';
insert into owner_bootstrap_snapshots (label, state)
select 'revoked', pg_temp.owner_bootstrap_snapshot(
  '18000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_bind_initial_owner(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000001'
  )),
  'invalid_request',
  'a revoked Owner Membership is ineligible even for exact identity replay'
);
reset role;
select is(
  pg_temp.owner_bootstrap_snapshot(
    '18000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000001'
  ),
  (select state from owner_bootstrap_snapshots where label = 'revoked'),
  'bootstrap cannot resurrect the revoked Membership or change its binding or audit'
);
rollback to savepoint revoked_runtime_owner;

set local role service_role;
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'isolated rejection fixtures roll back without invalidating the canonical baseline'
);
reset role;

select * from finish();
rollback;
