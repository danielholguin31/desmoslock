begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(52);

select has_table('desmoslock_v2', 'internal_release_attestation', 'migration attestation exists');
select has_table('desmoslock_v2', 'local_restore_target_attestation', 'local restore attestation exists');
select has_table('desmoslock_v2', 'workspaces', 'synthetic School workspaces exist');
select has_table('desmoslock_v2', 'profiles', 'synthetic profiles exist');
select has_table('desmoslock_v2', 'memberships', 'synthetic memberships exist');
select has_table('desmoslock_v2', 'tests', 'synthetic tests exist');
select has_table('desmoslock_v2', 'student_sessions', 'synthetic Student Sessions exist');
select has_table('desmoslock_v2', 'baseline_fixture_state', 'synthetic baseline state exists');

select ok(
  (
    select bool_and(class.relrowsecurity)
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'desmoslock_v2'
      and class.relname in (
        'internal_release_attestation', 'local_restore_target_attestation',
        'workspaces', 'profiles', 'memberships', 'tests',
        'student_sessions', 'baseline_fixture_state'
      )
  ),
  'every generation-4 fixture table enables RLS'
);
select is(
  (
    select count(*)::bigint
    from pg_policy as policy
    join pg_class as class on class.oid = policy.polrelid
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'desmoslock_v2'
      and class.relname in (
        'internal_release_attestation', 'local_restore_target_attestation',
        'workspaces', 'profiles', 'memberships', 'tests',
        'student_sessions', 'baseline_fixture_state'
      )
  ),
  0::bigint,
  'generation-4 tables have no direct allow policy'
);
select results_eq(
  $$
    select id, schema_generation, migration_set_sha256
    from desmoslock_v2.internal_release_attestation
  $$,
  $$values (1::smallint, 4, '2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b')$$,
  'the database records the exact versioned migration attestation'
);
select is_empty(
  $$select * from desmoslock_v2.local_restore_target_attestation$$,
  'a migrated database is not local-attested by default'
);
select results_eq(
  $$
    select
      (select count(*) from desmoslock_v2.workspaces)::bigint,
      (select count(*) from desmoslock_v2.profiles)::bigint,
      (select count(*) from desmoslock_v2.memberships)::bigint,
      (select count(*) from desmoslock_v2.tests)::bigint,
      (select count(*) from desmoslock_v2.student_sessions)::bigint
  $$,
  $$values (2::bigint, 6::bigint, 6::bigint, 2::bigint, 2::bigint)$$,
  'the fixture has exactly two Schools and its representative rows'
);
select results_eq(
  $$
    select id::text, kind, slug, display_name, seed_key
    from desmoslock_v2.workspaces
    order by seed_key
  $$,
  $$values
    ('10000000-0000-4000-8000-000000000001', 'school', 'synthetic-alpha', 'Synthetic Alpha School', 'school.alpha'),
    ('10000000-0000-4000-8000-000000000002', 'school', 'synthetic-beta', 'Synthetic Beta School', 'school.beta')
  $$,
  'the two synthetic Schools are fixed and fictional'
);
select results_eq(
  $$
    select id::text, display_name, seed_key
    from desmoslock_v2.profiles
    order by seed_key
  $$,
  $$values
    ('20000000-0000-4000-8000-000000000002', 'Synthetic Alpha Admin', 'profile.alpha.admin'),
    ('20000000-0000-4000-8000-000000000001', 'Synthetic Alpha Owner', 'profile.alpha.owner'),
    ('20000000-0000-4000-8000-000000000003', 'Synthetic Alpha Teacher', 'profile.alpha.teacher'),
    ('20000000-0000-4000-8000-000000000012', 'Synthetic Beta Admin', 'profile.beta.admin'),
    ('20000000-0000-4000-8000-000000000011', 'Synthetic Beta Owner', 'profile.beta.owner'),
    ('20000000-0000-4000-8000-000000000013', 'Synthetic Beta Teacher', 'profile.beta.teacher')
  $$,
  'the six synthetic staff profiles are deterministic'
);
select results_eq(
  $$
    select workspace_id::text, profile_id::text, role, seed_key
    from desmoslock_v2.memberships
    order by seed_key
  $$,
  $$values
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'admin', 'membership.alpha.admin'),
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'owner', 'membership.alpha.owner'),
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'teacher', 'membership.alpha.teacher'),
    ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000012', 'admin', 'membership.beta.admin'),
    ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000011', 'owner', 'membership.beta.owner'),
    ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000013', 'teacher', 'membership.beta.teacher')
  $$,
  'each School has exactly Owner, Admin, and Teacher fixtures'
);
select results_eq(
  $$
    select id::text, workspace_id::text, created_by_profile_id::text, title, seed_key
    from desmoslock_v2.tests
    order by seed_key
  $$,
  $$values
    ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'Synthetic Alpha Algebra Test', 'test.alpha.algebra'),
    ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000013', 'Synthetic Beta Algebra Test', 'test.beta.algebra')
  $$,
  'each School has one deterministic synthetic Test'
);
select results_eq(
  $$
    select id::text, workspace_id::text, test_id::text, state, seed_key
    from desmoslock_v2.student_sessions
    order by seed_key
  $$,
  $$values
    ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'created', 'session.alpha.algebra'),
    ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'created', 'session.beta.algebra')
  $$,
  'each School has one deterministic synthetic Student Session'
);
select ok(
  (select count(*) = 2 and coalesce(bool_and(
    state = 'created' and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
    and epoch = 1 and revision = 1 and last_accepted_proof_counter = 0
    and maintenance_accepted_at = '{}'::timestamptz[]
    and synthetic_display_name is null
    and device_session_id is null
    and device_public_key is null
    and capability_digest is null
    and capability_issued_at is null
    and capability_expires_at is null
    and reconnect_digest is null
    and reconnect_expires_at is null
    and join_request_id is null
    and join_operation_digest is null
    and join_admission_mode is null
    and join_material_digest is null
    and rotation_request_id is null
    and rotation_operation_digest is null
    and previous_reconnect_digest is null
  ), false) from desmoslock_v2.student_sessions),
  'both seeded Student Sessions have every pristine metadata field and no runtime authority'
);
select ok(
  not exists (select 1 from desmoslock_v2.student_join_materials)
    and not exists (select 1 from desmoslock_v2.student_device_bindings)
    and not exists (select 1 from desmoslock_v2.student_bootstrap_challenges)
    and not exists (select 1 from desmoslock_v2.student_bootstrap_limits)
    and not exists (select 1 from desmoslock_v2.student_device_proof_state)
    and not exists (select 1 from desmoslock_v2.student_protection_events),
  'all six runtime StudentSession authority and evidence stores start empty'
);

select results_eq(
  $$
    select schema_generation, fixture_version, fixture_digest, migration_set_sha256, fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (4, 'internal-baseline-v2', 'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201', '2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b', true)$$,
  'service baseline status verifies the pinned fixture digest'
);

select ok(
  concat_ws('|', 'school', 'school.alpha', 'id', 'slug|display', 'name') =
    concat_ws('|', 'school', 'school.alpha', 'id', 'slug', 'display|name')
    and desmoslock_v2.internal_frame_text(
      array['school', 'school.alpha', 'id', 'slug|display', 'name']
    ) <>
    desmoslock_v2.internal_frame_text(
      array['school', 'school.alpha', 'id', 'slug', 'display|name']
    ),
  'length framing distinguishes values that collide under delimiter joining'
);

savepoint embedded_newline;
update desmoslock_v2.workspaces
set display_name = E'Synthetic Alpha\nSchool'
where seed_key = 'school.alpha';
select results_eq(
  $$select fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (false)$$,
  'embedded newlines cannot preserve fixture readiness'
);
rollback to savepoint embedded_newline;

savepoint missing_foundation;
delete from desmoslock_v2.foundation_seed;
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values ('f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201', false)$$,
  'service baseline status fails closed when the foundation marker is absent'
);
rollback to savepoint missing_foundation;

savepoint missing_attestation;
delete from desmoslock_v2.internal_release_attestation;
select results_eq(
  $$select migration_set_sha256, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (null::text, false)$$,
  'service baseline status fails closed without migration attestation'
);
rollback to savepoint missing_attestation;

savepoint wrong_attestation;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = repeat('0', 64)
where id = 1;
select results_eq(
  $$select migration_set_sha256, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (repeat('0', 64), false)$$,
  'service baseline status fails closed on migration attestation drift'
);
rollback to savepoint wrong_attestation;

select ok(
  has_schema_privilege('authenticated', 'desmoslock_v2', 'USAGE'),
  'authenticated can reach the caller-scoped read model'
);
select ok(
  has_function_privilege('authenticated', 'desmoslock_v2.current_school_summary()', 'EXECUTE'),
  'authenticated can execute current School summary'
);
select ok(
  not has_table_privilege('authenticated', 'desmoslock_v2.workspaces', 'SELECT'),
  'authenticated has no direct fixture table privilege'
);
select ok(
  not has_function_privilege('authenticated', 'desmoslock_v2.internal_baseline_status()', 'EXECUTE'),
  'authenticated cannot execute the service baseline function'
);
select ok(
  not has_schema_privilege('anon', 'desmoslock_v2', 'USAGE'),
  'anon cannot use the v2 schema'
);
select ok(
  not has_function_privilege('anon', 'desmoslock_v2.current_school_summary()', 'EXECUTE'),
  'anon cannot execute current School summary'
);
select ok(
  has_function_privilege('service_role', 'desmoslock_v2.internal_baseline_status()', 'EXECUTE'),
  'service role can execute the internal baseline status'
);
select ok(
  has_schema_privilege('service_role', 'desmoslock_v2', 'USAGE'),
  'service role retains only the schema reachability needed for status execution'
);
select ok(
  not has_function_privilege(
    'service_role',
    'desmoslock_v2.expected_migration_set_sha256()',
    'EXECUTE'
  ),
  'service role cannot execute the private migration-hash function'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'foundation_seed',
      'internal_release_attestation',
      'local_restore_target_attestation',
      'workspaces',
      'profiles',
      'memberships',
      'tests',
      'student_sessions',
      'baseline_fixture_state'
    ]) as fixture_table(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as checked_privilege(privilege_name)
    where has_table_privilege(
      'service_role',
      'desmoslock_v2.' || fixture_table.table_name,
      checked_privilege.privilege_name
    )
  ),
  'service role has no direct fixture or attestation table privilege'
);
select ok(
  to_regprocedure('desmoslock_v2.current_school_summary(uuid)') is null,
  'the caller-scoped summary has no School-id overload'
);

-- Public School summaries require a verified provider identity, a live session,
-- and its explicit profile binding. A profile UUID in JWT metadata is not Auth.
-- Isolate these seeded authorization mutations so baseline checks below still
-- inspect the exact unbound generation-4 fixture after rollback.
savepoint caller_auth_fixtures;
create function pg_temp.set_backend_auth_claims(user_id uuid, session_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', user_id::text,
    'session_id', session_id::text,
    'role', 'authenticated',
    'aal', 'aal1',
    'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
  )::text, true);
end;
$$;

select pg_temp.set_backend_auth_claims(
  '20000000-0000-4000-8000-000000000001',
  'c2800000-0000-4000-8000-000000000001'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'unauthenticated',
  'a seeded profile UUID alone cannot substitute for a verified Auth identity'
);
reset role;

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
  ('a2800000-0000-4000-8000-000000000001'::uuid, 'backend-alpha-owner@staff.invalid'),
  ('a2800000-0000-4000-8000-000000000012'::uuid, 'backend-beta-admin@staff.invalid'),
  ('a2800000-0000-4000-8000-000000000099'::uuid, 'backend-unbound@staff.invalid')
) as fixture(user_id, email);
insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
select fixture.session_id, fixture.user_id, clock_timestamp(), clock_timestamp(),
  'aal1', clock_timestamp() + interval '1 hour'
from (values
  ('c2800000-0000-4000-8000-000000000001'::uuid, 'a2800000-0000-4000-8000-000000000001'::uuid),
  ('c2800000-0000-4000-8000-000000000012'::uuid, 'a2800000-0000-4000-8000-000000000012'::uuid),
  ('c2800000-0000-4000-8000-000000000099'::uuid, 'a2800000-0000-4000-8000-000000000099'::uuid)
) as fixture(session_id, user_id);
update desmoslock_v2.profiles
set auth_user_id = fixture.user_id
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, 'a2800000-0000-4000-8000-000000000001'::uuid),
  ('20000000-0000-4000-8000-000000000012'::uuid, 'a2800000-0000-4000-8000-000000000012'::uuid)
) as fixture(profile_id, user_id)
where profiles.id = fixture.profile_id;

select pg_temp.set_backend_auth_claims(
  'a2800000-0000-4000-8000-000000000001',
  'c2800000-0000-4000-8000-000000000098'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_expired',
  'a confirmed bound Owner without the claimed live session has no School authority'
);
reset role;

select pg_temp.set_backend_auth_claims(
  'a2800000-0000-4000-8000-000000000001',
  'c2800000-0000-4000-8000-000000000001'
);
set local role authenticated;
select results_eq(
  $$
    select school_id::text, school_slug, school_name, membership_role, test_count, student_session_count
    from desmoslock_v2.current_school_summary()
  $$,
  $$values ('10000000-0000-4000-8000-000000000001', 'synthetic-alpha', 'Synthetic Alpha School', 'owner', 1::bigint, 1::bigint)$$,
  'Alpha Owner observes only Alpha through the public read model'
);
reset role;
select pg_temp.set_backend_auth_claims(
  'a2800000-0000-4000-8000-000000000012',
  'c2800000-0000-4000-8000-000000000012'
);
set local role authenticated;
select results_eq(
  $$
    select school_id::text, school_slug, school_name, membership_role, test_count, student_session_count
    from desmoslock_v2.current_school_summary()
  $$,
  $$values ('10000000-0000-4000-8000-000000000002', 'synthetic-beta', 'Synthetic Beta School', 'admin', 1::bigint, 1::bigint)$$,
  'Beta Admin observes only Beta through the public read model'
);
reset role;
select pg_temp.set_backend_auth_claims(
  'a2800000-0000-4000-8000-000000000099',
  'c2800000-0000-4000-8000-000000000099'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'membership_inactive',
  'a verified live Auth identity without a bound staff profile has no School authority'
);
select is_empty(
  $$select * from desmoslock_v2.current_school_summary()$$,
  'an authenticated identity without a staff profile observes no School'
);
select set_config('request.jwt.claims', (
  current_setting('request.jwt.claims')::jsonb || jsonb_build_object('role', 'service_role')
)::text, true);
select throws_ok(
  $$select * from desmoslock_v2.internal_baseline_status()$$,
  '42501',
  null,
  'a forged JWT role claim does not grant service-only execution'
);
select throws_ok(
  $$select * from desmoslock_v2.workspaces$$,
  '42501',
  null,
  'authenticated cannot read fixture tables directly'
);
reset role;
rollback to savepoint caller_auth_fixtures;

grant select on table
  desmoslock_v2.workspaces,
  desmoslock_v2.profiles,
  desmoslock_v2.memberships,
  desmoslock_v2.tests,
  desmoslock_v2.student_sessions,
  desmoslock_v2.baseline_fixture_state
to authenticated;
set local role authenticated;
select results_eq(
  $$
    select table_name, row_count
    from (
      values
        ('baseline_fixture_state', (select count(*)::bigint from desmoslock_v2.baseline_fixture_state)),
        ('memberships', (select count(*)::bigint from desmoslock_v2.memberships)),
        ('profiles', (select count(*)::bigint from desmoslock_v2.profiles)),
        ('student_sessions', (select count(*)::bigint from desmoslock_v2.student_sessions)),
        ('tests', (select count(*)::bigint from desmoslock_v2.tests)),
        ('workspaces', (select count(*)::bigint from desmoslock_v2.workspaces))
    ) as observed(table_name, row_count)
    order by table_name
  $$,
  $$values
    ('baseline_fixture_state', 0::bigint),
    ('memberships', 0::bigint),
    ('profiles', 0::bigint),
    ('student_sessions', 0::bigint),
    ('tests', 0::bigint),
    ('workspaces', 0::bigint)
  $$,
  'RLS denies every direct authenticated read even after accidental grants'
);
reset role;

select throws_ok(
  $$
    insert into desmoslock_v2.tests (
      id, workspace_id, created_by_profile_id, title, seed_key,
      lifecycle, revision, created_at, opened_at, ended_at, creation_request_id
    ) values (
      '90000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000013',
      'Rejected cross-School Test',
      'rejected.cross-school-test',
      'draft', 1, '2000-01-01T00:00:00.000000Z'::timestamptz, null, null, null
    )
  $$,
  '23503',
  null,
  'a Test creator must belong to the same School'
);
select throws_ok(
  $$
    insert into desmoslock_v2.student_sessions (
      id, workspace_id, test_id, state, seed_key
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      'created',
      'rejected.cross-school-session'
    )
  $$,
  '23503',
  null,
  'a Student Session Test must belong to the same School'
);
select throws_ok(
  $$
    insert into desmoslock_v2.memberships (
      workspace_id, profile_id, role, seed_key
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      'student',
      'rejected.role'
    )
  $$,
  '23514',
  null,
  'generation 4 rejects unsupported role breadth'
);
select throws_ok(
  $$
    insert into desmoslock_v2.profiles (id, display_name, seed_key)
    values ('90000000-0000-4000-8000-000000000004', 'Rejected duplicate', 'profile.alpha.owner')
  $$,
  '23505',
  null,
  'fixture seed keys remain unique'
);
select throws_ok(
  $$
    insert into desmoslock_v2.baseline_fixture_state (
      id, schema_generation, fixture_version, fixture_digest
    ) values (
      2,
      4,
      'internal-baseline-v2',
      'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
    )
  $$,
  '23514',
  null,
  'baseline state is a singleton'
);
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values ('f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201', true)$$,
  'rejected mutations leave the pinned fixture digest valid'
);

select * from finish();
rollback;
