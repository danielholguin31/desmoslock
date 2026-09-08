-- Generation 4 binds the reviewed staff-auth lifecycle to the reproducible
-- synthetic baseline. Runtime identities and lifecycle rows remain outside the
-- fixture; every security-relevant field on a seeded profile or membership is
-- part of the deterministic digest.

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'ce79427901195258897e0b75c80acfb7b50699eb223af5289cf5d5d59958f2b7'::text;
$$;
-- desmoslock-migration-set-sha256:end

revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;

alter table desmoslock_v2.internal_release_attestation
  drop constraint internal_release_attestation_generation;

update desmoslock_v2.internal_release_attestation
set
  schema_generation = 4,
  migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;

alter table desmoslock_v2.internal_release_attestation
  add constraint internal_release_attestation_generation
  check (schema_generation = 4);

alter table desmoslock_v2.baseline_fixture_state
  drop constraint baseline_fixture_state_generation,
  drop constraint baseline_fixture_state_version,
  drop constraint baseline_fixture_state_digest;

update desmoslock_v2.baseline_fixture_state
set
  schema_generation = 4,
  fixture_version = 'internal-baseline-v2',
  fixture_digest = 'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
where id = 1;

alter table desmoslock_v2.baseline_fixture_state
  add constraint baseline_fixture_state_generation
    check (schema_generation = 4),
  add constraint baseline_fixture_state_version
    check (fixture_version = 'internal-baseline-v2'),
  add constraint baseline_fixture_state_digest
    check (
      fixture_digest = 'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
    );

create or replace function desmoslock_v2.internal_baseline_status()
returns table (
  schema_generation integer,
  fixture_version text,
  fixture_digest text,
  migration_set_sha256 text,
  fixture_valid boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with canonical_lines (entity_order, seed_key, line) as (
    select
      0,
      '',
      desmoslock_v2.internal_frame_text(array[
        'fixture',
        'internal-baseline-v2',
        '4',
        'baseline_fixture_state',
        (select count(*)::text from desmoslock_v2.baseline_fixture_state),
        'foundation_seed',
        (select count(*)::text from desmoslock_v2.foundation_seed),
        'memberships',
        (
          select count(*)::text
          from desmoslock_v2.memberships
          where seed_key is not null
        ),
        'profiles',
        (
          select count(*)::text
          from desmoslock_v2.profiles
          where seed_key is not null
        ),
        'student_sessions',
        (
          select count(*)::text
          from desmoslock_v2.student_sessions
          where seed_key is not null
        ),
        'tests',
        (
          select count(*)::text
          from desmoslock_v2.tests
          where seed_key is not null
        ),
        'workspaces',
        (
          select count(*)::text
          from desmoslock_v2.workspaces
          where seed_key is not null
        )
      ])
    union all
    select
      1,
      workspace.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'school',
        workspace.seed_key,
        workspace.id::text,
        workspace.slug,
        workspace.display_name
      ])
    from desmoslock_v2.workspaces as workspace
    where workspace.seed_key is not null
    union all
    select
      2,
      profile.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'profile',
        profile.seed_key,
        profile.id::text,
        profile.display_name,
        coalesce(profile.auth_user_id::text, '')
      ])
    from desmoslock_v2.profiles as profile
    where profile.seed_key is not null
    union all
    select
      3,
      membership.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'membership',
        membership.seed_key,
        membership.workspace_id::text,
        membership.profile_id::text,
        membership.role,
        membership.status,
        membership.role_revision::text,
        coalesce(membership.accepted_at::text, ''),
        coalesce(membership.revoked_at::text, ''),
        coalesce(membership.revoked_by_profile_id::text, ''),
        coalesce(membership.revocation_reason_code, ''),
        coalesce(membership.updated_at::text, '')
      ])
    from desmoslock_v2.memberships as membership
    where membership.seed_key is not null
    union all
    select
      4,
      school_test.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'test',
        school_test.seed_key,
        school_test.id::text,
        school_test.workspace_id::text,
        school_test.created_by_profile_id::text,
        school_test.title
      ])
    from desmoslock_v2.tests as school_test
    where school_test.seed_key is not null
    union all
    select
      5,
      school_session.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'session',
        school_session.seed_key,
        school_session.id::text,
        school_session.workspace_id::text,
        school_session.test_id::text,
        school_session.state
      ])
    from desmoslock_v2.student_sessions as school_session
    where school_session.seed_key is not null
  ),
  observed_fixture as (
    select encode(
      sha256(
        convert_to(
          string_agg(line, '' order by entity_order, seed_key),
          'UTF8'
        )
      ),
      'hex'
    ) as fixture_digest
    from canonical_lines
  )
  select
    fixture_state.schema_generation,
    fixture_state.fixture_version,
    fixture_state.fixture_digest,
    attestation.migration_set_sha256,
    coalesce(
      fixture_state.fixture_digest =
        'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
        and observed_fixture.fixture_digest = fixture_state.fixture_digest
        and attestation.schema_generation = 4
        and attestation.migration_set_sha256 =
          desmoslock_v2.expected_migration_set_sha256()
        and (
          select count(*) = 1
          from desmoslock_v2.foundation_seed as foundation
          where foundation.id = 1
            and foundation.schema_generation = 2
            and foundation.fixture_namespace = 'desmoslock-v2-foundation'
        ),
      false
    )
  from desmoslock_v2.baseline_fixture_state as fixture_state
  cross join observed_fixture
  left join desmoslock_v2.internal_release_attestation as attestation
    on attestation.id = 1
  where fixture_state.id = 1;
$$;

revoke all on function desmoslock_v2.internal_baseline_status()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.internal_baseline_status() to service_role;

comment on function desmoslock_v2.internal_baseline_status() is
  'Service-only generation-4 verification of the seven-table synthetic fixture and seeded staff authorization state; runtime rows are excluded.';
