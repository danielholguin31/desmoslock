begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(23);

select results_eq(
  $$
    select
      id,
      schema_generation,
      migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256(),
      migration_set_sha256 ~ '^[0-9a-f]{64}$'
    from desmoslock_v2.internal_release_attestation
  $$,
  $$values (
    1::smallint,
    4,
    true,
    true
  )$$,
  'generation 4 records the exact well-formed expected migration-set attestation'
);

select results_eq(
  $$
    select id, schema_generation, fixture_version, fixture_digest
    from desmoslock_v2.baseline_fixture_state
  $$,
  $$values (
    1::smallint,
    4,
    'internal-baseline-v2'::text,
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text
  )$$,
  'generation 4 pins the exact internal-baseline-v2 fixture identity'
);

select results_eq(
  $$
    select relation.relname::text, constraint_info.conname::text
    from pg_constraint as constraint_info
    join pg_class as relation on relation.oid = constraint_info.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'desmoslock_v2'
      and constraint_info.contype = 'c'
      and (
        (relation.relname = 'internal_release_attestation'
          and constraint_info.conname = 'internal_release_attestation_generation')
        or
        (relation.relname = 'baseline_fixture_state'
          and constraint_info.conname in (
            'baseline_fixture_state_generation',
            'baseline_fixture_state_version',
            'baseline_fixture_state_digest'
          ))
      )
    order by relation.relname, constraint_info.conname
  $$,
  $$values
    ('baseline_fixture_state'::text, 'baseline_fixture_state_digest'::text),
    ('baseline_fixture_state'::text, 'baseline_fixture_state_generation'::text),
    ('baseline_fixture_state'::text, 'baseline_fixture_state_version'::text),
    ('internal_release_attestation'::text, 'internal_release_attestation_generation'::text)
  $$,
  'generation 4 installs the exact replacement constraint set'
);

select throws_ok(
  $$
    update desmoslock_v2.internal_release_attestation
    set schema_generation = 3
    where id = 1
  $$,
  '23514',
  null,
  'the release attestation accepts only schema generation 4'
);

select throws_ok(
  $$
    update desmoslock_v2.baseline_fixture_state
    set schema_generation = 3
    where id = 1
  $$,
  '23514',
  null,
  'the fixture state accepts only schema generation 4'
);

select throws_ok(
  $$
    update desmoslock_v2.baseline_fixture_state
    set fixture_version = 'internal-baseline-v1'
    where id = 1
  $$,
  '23514',
  null,
  'the fixture state accepts only internal-baseline-v2'
);

select throws_ok(
  $$
    update desmoslock_v2.baseline_fixture_state
    set fixture_digest = repeat('0', 64)
    where id = 1
  $$,
  '23514',
  null,
  'the fixture state accepts only the generation-4 fixture digest'
);

select ok(
  has_schema_privilege('service_role', 'desmoslock_v2', 'USAGE'),
  'service role can reach the generation-4 status seam'
);

select ok(
  has_function_privilege(
    'service_role',
    'desmoslock_v2.internal_baseline_status()',
    'EXECUTE'
  ),
  'service role can execute the generation-4 status function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'desmoslock_v2.internal_baseline_status()',
    'EXECUTE'
  ),
  'authenticated cannot execute the generation-4 status function'
);

select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.internal_baseline_status()',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the generation-4 status function'
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
      'baseline_fixture_state',
      'workspaces',
      'profiles',
      'memberships',
      'tests',
      'student_sessions'
    ]) as protected_table(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as checked_privilege(privilege_name)
    where has_table_privilege(
      'service_role',
      'desmoslock_v2.' || protected_table.table_name,
      checked_privilege.privilege_name
    )
  ),
  'service role reaches status without direct fixture or attestation table privileges'
);

set local role service_role;
select results_eq(
  $$
    select
      schema_generation,
      fixture_version,
      fixture_digest,
      migration_set_sha256 ~ '^[0-9a-f]{64}$',
      fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (
    4,
    'internal-baseline-v2'::text,
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true,
    true
  )$$,
  'service role verifies the exact valid generation-4 fixture'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select * from desmoslock_v2.internal_baseline_status()$$,
  '42501',
  null,
  'authenticated status execution is denied at the grant boundary'
);
reset role;

set local role anon;
select throws_ok(
  $$select * from desmoslock_v2.internal_baseline_status()$$,
  '42501',
  null,
  'anonymous status execution is denied at the grant boundary'
);
reset role;

savepoint runtime_rows;
insert into desmoslock_v2.workspaces (
  id,
  kind,
  slug,
  display_name,
  seed_key
) values (
  '91000000-0000-4000-8000-000000000001',
  'school',
  'runtime-generation-four',
  'Runtime Generation Four School',
  null
);

insert into desmoslock_v2.profiles (
  id,
  display_name,
  seed_key
) values (
  '92000000-0000-4000-8000-000000000001',
  'Runtime Generation Four Teacher',
  null
);

insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  seed_key,
  status,
  role_revision,
  accepted_at,
  updated_at
) values (
  '91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  'teacher',
  null,
  'active',
  1,
  '2026-09-03 12:00:00+00',
  '2026-09-03 12:00:00+00'
);

insert into desmoslock_v2.tests (
  id,
  workspace_id,
  created_by_profile_id,
  title,
  seed_key
) values (
  '93000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  'Runtime Generation Four Test',
  null
);

insert into desmoslock_v2.student_sessions (
  id,
  workspace_id,
  test_id,
  state,
  seed_key
) values (
  '94000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  'created',
  null
);

set local role service_role;
select results_eq(
  $$
    select fixture_digest, fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'runtime rows with null seed keys do not invalidate the fixture'
);
reset role;
rollback to savepoint runtime_rows;

savepoint seeded_profile_auth_binding;
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'a9000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'generation-four-corruption@staff.invalid',
  '',
  '2026-09-03 12:00:00+00',
  '{"provider":"email","providers":["email"]}',
  '{}',
  '2026-09-03 12:00:00+00',
  '2026-09-03 12:00:00+00'
);
update desmoslock_v2.profiles
set auth_user_id = 'a9000000-0000-4000-8000-000000000001'
where seed_key = 'profile.alpha.owner';
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    false
  )$$,
  'binding a seeded profile to an Auth identity invalidates the fixture'
);
rollback to savepoint seeded_profile_auth_binding;

savepoint seeded_membership_revision;
update desmoslock_v2.memberships
set role_revision = 2
where seed_key = 'membership.alpha.teacher';
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    false
  )$$,
  'changing a seeded membership role revision invalidates the fixture'
);
rollback to savepoint seeded_membership_revision;

savepoint seeded_membership_acceptance;
update desmoslock_v2.memberships
set accepted_at = '2026-09-03 12:00:00+00'
where seed_key = 'membership.alpha.teacher';
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    false
  )$$,
  'changing seeded membership acceptance state invalidates the fixture'
);
rollback to savepoint seeded_membership_acceptance;

savepoint seeded_membership_update_time;
update desmoslock_v2.memberships
set updated_at = '2026-09-03 12:00:00+00'
where seed_key = 'membership.alpha.teacher';
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    false
  )$$,
  'changing a seeded membership lifecycle timestamp invalidates the fixture'
);
rollback to savepoint seeded_membership_update_time;

savepoint seeded_membership_revocation;
update desmoslock_v2.memberships
set
  status = 'revoked',
  role_revision = 2,
  revoked_at = '2026-09-03 12:00:00+00',
  revoked_by_profile_id = '20000000-0000-4000-8000-000000000001',
  revocation_reason_code = 'owner_action',
  updated_at = '2026-09-03 12:00:00+00'
where seed_key = 'membership.alpha.teacher';
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    false
  )$$,
  'a valid seeded membership revocation lifecycle invalidates the fixture'
);
rollback to savepoint seeded_membership_revocation;

set local role service_role;
select results_eq(
  $$
    select fixture_digest, fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'rollback restores the exact valid generation-4 fixture'
);
reset role;

select * from finish();
rollback;
