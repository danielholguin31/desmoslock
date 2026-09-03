-- Generation 3 is the deterministic synthetic backend used by local and staging
-- internal-release verification. It contains no customer, student, or credential data.

grant usage on schema desmoslock_v2 to authenticated;

-- desmoslock-migration-set-sha256:begin
create function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66'::text;
$$;
-- desmoslock-migration-set-sha256:end

revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;

create table desmoslock_v2.internal_release_attestation (
  id smallint primary key,
  schema_generation integer not null,
  migration_set_sha256 text not null,
  constraint internal_release_attestation_singleton check (id = 1),
  constraint internal_release_attestation_generation check (schema_generation = 3),
  constraint internal_release_attestation_sha256 check (
    migration_set_sha256 ~ '^[0-9a-f]{64}$'
  )
);

insert into desmoslock_v2.internal_release_attestation (
  id,
  schema_generation,
  migration_set_sha256
)
values (1, 3, desmoslock_v2.expected_migration_set_sha256());

create table desmoslock_v2.local_restore_target_attestation (
  id smallint primary key,
  marker text not null,
  database_name text not null,
  system_identifier text not null,
  constraint local_restore_target_attestation_singleton check (id = 1),
  constraint local_restore_target_attestation_marker check (
    marker ~ '^[A-Za-z0-9][A-Za-z0-9._-]{31,127}$'
  ),
  constraint local_restore_target_attestation_database check (
    database_name ~ '^[A-Za-z0-9_.-]{1,63}$'
  ),
  constraint local_restore_target_attestation_system check (
    system_identifier ~ '^[0-9]{10,32}$'
  )
);

create table desmoslock_v2.workspaces (
  id uuid primary key,
  kind text not null,
  slug text not null unique,
  display_name text not null,
  seed_key text not null unique,
  constraint workspaces_school_only check (kind = 'school'),
  constraint workspaces_seed_key_not_blank check (seed_key <> '')
);

create table desmoslock_v2.profiles (
  id uuid primary key,
  display_name text not null,
  seed_key text not null unique,
  constraint profiles_seed_key_not_blank check (seed_key <> '')
);

create table desmoslock_v2.memberships (
  workspace_id uuid not null references desmoslock_v2.workspaces (id),
  profile_id uuid not null references desmoslock_v2.profiles (id),
  role text not null,
  seed_key text not null unique,
  primary key (workspace_id, profile_id),
  constraint memberships_role check (role in ('owner', 'admin', 'teacher')),
  constraint memberships_seed_key_not_blank check (seed_key <> '')
);

create table desmoslock_v2.tests (
  id uuid primary key,
  workspace_id uuid not null,
  created_by_profile_id uuid not null,
  title text not null,
  seed_key text not null unique,
  unique (workspace_id, id),
  constraint tests_creator_membership foreign key (workspace_id, created_by_profile_id)
    references desmoslock_v2.memberships (workspace_id, profile_id),
  constraint tests_seed_key_not_blank check (seed_key <> '')
);

create table desmoslock_v2.student_sessions (
  id uuid primary key,
  workspace_id uuid not null,
  test_id uuid not null,
  state text not null,
  seed_key text not null unique,
  constraint student_sessions_test_workspace foreign key (workspace_id, test_id)
    references desmoslock_v2.tests (workspace_id, id),
  constraint student_sessions_created_only check (state = 'created'),
  constraint student_sessions_seed_key_not_blank check (seed_key <> '')
);

create table desmoslock_v2.baseline_fixture_state (
  id smallint primary key,
  schema_generation integer not null,
  fixture_version text not null,
  fixture_digest text not null,
  constraint baseline_fixture_state_singleton check (id = 1),
  constraint baseline_fixture_state_generation check (schema_generation = 3),
  constraint baseline_fixture_state_version check (
    fixture_version = 'internal-baseline-v1'
  ),
  constraint baseline_fixture_state_digest check (
    fixture_digest = '7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca'
  )
);

alter table desmoslock_v2.internal_release_attestation enable row level security;
alter table desmoslock_v2.local_restore_target_attestation enable row level security;
alter table desmoslock_v2.workspaces enable row level security;
alter table desmoslock_v2.profiles enable row level security;
alter table desmoslock_v2.memberships enable row level security;
alter table desmoslock_v2.tests enable row level security;
alter table desmoslock_v2.student_sessions enable row level security;
alter table desmoslock_v2.baseline_fixture_state enable row level security;

revoke all on table desmoslock_v2.workspaces from public, anon, authenticated;
revoke all on table desmoslock_v2.profiles from public, anon, authenticated;
revoke all on table desmoslock_v2.memberships from public, anon, authenticated;
revoke all on table desmoslock_v2.tests from public, anon, authenticated;
revoke all on table desmoslock_v2.student_sessions from public, anon, authenticated;
revoke all on table desmoslock_v2.baseline_fixture_state from public, anon, authenticated;
revoke all on table desmoslock_v2.internal_release_attestation
  from public, anon, authenticated, service_role;
revoke all on table desmoslock_v2.local_restore_target_attestation
  from public, anon, authenticated, service_role;
revoke all on table
  desmoslock_v2.foundation_seed,
  desmoslock_v2.workspaces,
  desmoslock_v2.profiles,
  desmoslock_v2.memberships,
  desmoslock_v2.tests,
  desmoslock_v2.student_sessions,
  desmoslock_v2.baseline_fixture_state
from service_role;

create function desmoslock_v2.current_school_summary()
returns table (
  school_id uuid,
  school_slug text,
  school_name text,
  membership_role text,
  test_count bigint,
  student_session_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    workspace.id,
    workspace.slug,
    workspace.display_name,
    membership.role,
    (
      select count(*)
      from desmoslock_v2.tests as school_test
      where school_test.workspace_id = workspace.id
    ),
    (
      select count(*)
      from desmoslock_v2.student_sessions as school_session
      where school_session.workspace_id = workspace.id
    )
  from desmoslock_v2.memberships as membership
  join desmoslock_v2.workspaces as workspace
    on workspace.id = membership.workspace_id
  where membership.profile_id = (select auth.uid())
  order by workspace.slug;
$$;

revoke all on function desmoslock_v2.current_school_summary()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_school_summary() to authenticated;

create function desmoslock_v2.internal_frame_text(parts text[])
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select cardinality(parts)::text || '#' || coalesce(
    string_agg(
      octet_length(convert_to(part, 'UTF8'))::text || ':' || part,
      ''
      order by ordinality
    ),
    ''
  )
  from unnest(parts) with ordinality as framed(part, ordinality);
$$;

revoke all on function desmoslock_v2.internal_frame_text(text[])
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_baseline_status()
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
        'internal-baseline-v1',
        '3',
        'baseline_fixture_state',
        (select count(*)::text from desmoslock_v2.baseline_fixture_state),
        'foundation_seed',
        (select count(*)::text from desmoslock_v2.foundation_seed),
        'memberships',
        (select count(*)::text from desmoslock_v2.memberships),
        'profiles',
        (select count(*)::text from desmoslock_v2.profiles),
        'student_sessions',
        (select count(*)::text from desmoslock_v2.student_sessions),
        'tests',
        (select count(*)::text from desmoslock_v2.tests),
        'workspaces',
        (select count(*)::text from desmoslock_v2.workspaces)
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
    union all
    select
      2,
      profile.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'profile',
        profile.seed_key,
        profile.id::text,
        profile.display_name
      ])
    from desmoslock_v2.profiles as profile
    union all
    select
      3,
      membership.seed_key,
      desmoslock_v2.internal_frame_text(array[
        'membership',
        membership.seed_key,
        membership.workspace_id::text,
        membership.profile_id::text,
        membership.role
      ])
    from desmoslock_v2.memberships as membership
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
        '7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca'
        and observed_fixture.fixture_digest = fixture_state.fixture_digest
        and attestation.schema_generation = 3
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

comment on table desmoslock_v2.workspaces is
  'Synthetic internal-release School fixtures; never customer data.';
comment on table desmoslock_v2.internal_release_attestation is
  'Migration-owned generation and normalized migration-file digest attestation.';
comment on table desmoslock_v2.local_restore_target_attestation is
  'Local-operator marker bound to one database and PostgreSQL cluster identity; empty by default.';
comment on function desmoslock_v2.current_school_summary() is
  'Caller-scoped generation-3 read model. It accepts no School identifier.';
comment on function desmoslock_v2.expected_migration_set_sha256() is
  'Private normalized digest of the exact canonical migration file set.';
comment on function desmoslock_v2.internal_frame_text(text[]) is
  'Private length-framed UTF-8 encoding for deterministic fixture hashing.';
comment on function desmoslock_v2.internal_baseline_status() is
  'Service-only deterministic fixture verification for the public health function.';
