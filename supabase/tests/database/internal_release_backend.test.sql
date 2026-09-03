begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(47);

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
  $$values (1::smallint, 4, '0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66')$$,
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
select results_eq(
  $$
    select schema_generation, fixture_version, fixture_digest, migration_set_sha256, fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (4, 'internal-baseline-v2', 'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201', '0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66', true)$$,
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

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000001';
select results_eq(
  $$
    select school_id::text, school_slug, school_name, membership_role, test_count, student_session_count
    from desmoslock_v2.current_school_summary()
  $$,
  $$values ('10000000-0000-4000-8000-000000000001', 'synthetic-alpha', 'Synthetic Alpha School', 'owner', 1::bigint, 1::bigint)$$,
  'Alpha Owner observes only Alpha through the public read model'
);
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000012';
select results_eq(
  $$
    select school_id::text, school_slug, school_name, membership_role, test_count, student_session_count
    from desmoslock_v2.current_school_summary()
  $$,
  $$values ('10000000-0000-4000-8000-000000000002', 'synthetic-beta', 'Synthetic Beta School', 'admin', 1::bigint, 1::bigint)$$,
  'Beta Admin observes only Beta through the public read model'
);
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000099';
select is_empty(
  $$select * from desmoslock_v2.current_school_summary()$$,
  'an unknown authenticated identity observes no School'
);
set local "request.jwt.claim.role" = 'service_role';
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
      id, workspace_id, created_by_profile_id, title, seed_key
    ) values (
      '90000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000013',
      'Rejected cross-School Test',
      'rejected.cross-school-test'
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
