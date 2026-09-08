begin;

select pg_advisory_xact_lock(hashtextextended('desmoslock-v2/internal-baseline-v2', 0));

do $$
begin
  if exists (select 1 from desmoslock_v2.workspaces)
    or exists (select 1 from desmoslock_v2.foundation_seed)
    or exists (select 1 from desmoslock_v2.profiles)
    or exists (select 1 from desmoslock_v2.memberships)
    or exists (select 1 from desmoslock_v2.tests)
    or exists (select 1 from desmoslock_v2.student_sessions)
    or exists (select 1 from desmoslock_v2.baseline_fixture_state)
  then
    if not exists (
      select 1
      from desmoslock_v2.internal_baseline_status() as baseline
      where baseline.fixture_valid
    ) then
      raise exception using
        errcode = '55000',
        message = 'refusing to seed a nonempty or altered generation-4 target';
    end if;
  end if;
end
$$;

insert into desmoslock_v2.foundation_seed (id, schema_generation, fixture_namespace)
values (1, 2, 'desmoslock-v2-foundation')
on conflict do nothing;

insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'school',
    'synthetic-alpha',
    'Synthetic Alpha School',
    'school.alpha'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'school',
    'synthetic-beta',
    'Synthetic Beta School',
    'school.beta'
  )
on conflict do nothing;

insert into desmoslock_v2.profiles (id, display_name, seed_key)
values
  (
    '20000000-0000-4000-8000-000000000001',
    'Synthetic Alpha Owner',
    'profile.alpha.owner'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Synthetic Alpha Admin',
    'profile.alpha.admin'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'Synthetic Alpha Teacher',
    'profile.alpha.teacher'
  ),
  (
    '20000000-0000-4000-8000-000000000011',
    'Synthetic Beta Owner',
    'profile.beta.owner'
  ),
  (
    '20000000-0000-4000-8000-000000000012',
    'Synthetic Beta Admin',
    'profile.beta.admin'
  ),
  (
    '20000000-0000-4000-8000-000000000013',
    'Synthetic Beta Teacher',
    'profile.beta.teacher'
  )
on conflict do nothing;

insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  seed_key
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'owner',
    'membership.alpha.owner'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'admin',
    'membership.alpha.admin'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    'teacher',
    'membership.alpha.teacher'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000011',
    'owner',
    'membership.beta.owner'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000012',
    'admin',
    'membership.beta.admin'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000013',
    'teacher',
    'membership.beta.teacher'
  )
on conflict do nothing;

insert into desmoslock_v2.tests (
  id,
  workspace_id,
  created_by_profile_id,
  title,
  seed_key,
  lifecycle,
  revision,
  created_at,
  opened_at,
  ended_at,
  creation_request_id
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    'Synthetic Alpha Algebra Test',
    'test.alpha.algebra',
    'draft',
    1,
    '2000-01-01T00:00:00.000000Z',
    null,
    null,
    null
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000013',
    'Synthetic Beta Algebra Test',
    'test.beta.algebra',
    'draft',
    1,
    '2000-01-01T00:00:00.000000Z',
    null,
    null,
    null
  )
on conflict do nothing;

insert into desmoslock_v2.student_sessions (
  id,
  workspace_id,
  test_id,
  state,
  seed_key
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'created',
    'session.alpha.algebra'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    'created',
    'session.beta.algebra'
  )
on conflict do nothing;

insert into desmoslock_v2.baseline_fixture_state (
  id,
  schema_generation,
  fixture_version,
  fixture_digest
)
values (
  1,
  4,
  'internal-baseline-v2',
  'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'
)
on conflict do nothing;

do $$
begin
  if not exists (
    select 1
    from desmoslock_v2.internal_baseline_status() as baseline
    where baseline.fixture_valid
  ) then
    raise exception using
      errcode = '55000',
      message = 'generation-4 synthetic fixture verification failed';
  end if;
end
$$;

commit;
