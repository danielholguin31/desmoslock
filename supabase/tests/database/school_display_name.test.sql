begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select plan(90);

-- Independent NULL-seed Schools and synthetic provider-schema identities are
-- local SQL fixtures, not live GoTrue sessions. Calls use the genuine production
-- authorization helpers. Fault injection below models authority changes between
-- checks; it is not actual multi-connection lock-wait coverage.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'school-settings-1@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'school-settings-2@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'school-settings-3@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'school-settings-4@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'school-settings-5@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a4200000-0000-4000-8000-000000000006',
    'authenticated', 'authenticated', 'school-settings-6@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp());

insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at
) values
  ('b4200000-0000-4000-8000-000000000001', 'a4200000-0000-4000-8000-000000000001', 'Synthetic School settings factor 1',
    'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b4200000-0000-4000-8000-000000000002', 'a4200000-0000-4000-8000-000000000002', 'Synthetic School settings factor 2',
    'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b4200000-0000-4000-8000-000000000004', 'a4200000-0000-4000-8000-000000000004', 'Synthetic School settings factor 4',
    'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b4200000-0000-4000-8000-000000000005', 'a4200000-0000-4000-8000-000000000005', 'Synthetic School settings factor 5',
    'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b4200000-0000-4000-8000-000000000006', 'a4200000-0000-4000-8000-000000000006', 'Synthetic School settings factor 6',
    'totp', 'verified', clock_timestamp(), clock_timestamp());

insert into auth.sessions (
  id, user_id, created_at, updated_at, factor_id, aal, not_after
) values
  ('c4200000-0000-4000-8000-000000000001', 'a4200000-0000-4000-8000-000000000001',
    clock_timestamp(), clock_timestamp(), 'b4200000-0000-4000-8000-000000000001', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c4200000-0000-4000-8000-000000000002', 'a4200000-0000-4000-8000-000000000002',
    clock_timestamp(), clock_timestamp(), 'b4200000-0000-4000-8000-000000000002', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c4200000-0000-4000-8000-000000000003', 'a4200000-0000-4000-8000-000000000003',
    clock_timestamp(), clock_timestamp(), null, 'aal1',
    clock_timestamp() + interval '1 hour'),
  ('c4200000-0000-4000-8000-000000000004', 'a4200000-0000-4000-8000-000000000004',
    clock_timestamp(), clock_timestamp(), 'b4200000-0000-4000-8000-000000000004', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c4200000-0000-4000-8000-000000000005', 'a4200000-0000-4000-8000-000000000005',
    clock_timestamp(), clock_timestamp(), 'b4200000-0000-4000-8000-000000000005', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c4200000-0000-4000-8000-000000000006', 'a4200000-0000-4000-8000-000000000006',
    clock_timestamp(), clock_timestamp(), 'b4200000-0000-4000-8000-000000000006', 'aal2',
    clock_timestamp() + interval '1 hour');

insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key) values
  ('14000000-0000-4000-8000-000000000001', 'school', 'runtime-settings-alpha', 'Runtime Settings Alpha', null),
  ('14000000-0000-4000-8000-000000000002', 'school', 'runtime-settings-beta', 'Runtime Settings Beta', null);

insert into desmoslock_v2.profiles (id, display_name, auth_user_id, seed_key) values
  ('24000000-0000-4000-8000-000000000001', 'School Settings Staff 1', 'a4200000-0000-4000-8000-000000000001', null),
  ('24000000-0000-4000-8000-000000000002', 'School Settings Staff 2', 'a4200000-0000-4000-8000-000000000002', null),
  ('24000000-0000-4000-8000-000000000003', 'School Settings Staff 3', 'a4200000-0000-4000-8000-000000000003', null),
  ('24000000-0000-4000-8000-000000000004', 'School Settings Staff 4', 'a4200000-0000-4000-8000-000000000004', null),
  ('24000000-0000-4000-8000-000000000006', 'School Settings Staff 6', 'a4200000-0000-4000-8000-000000000006', null);

insert into desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key) values
  ('14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'owner', null),
  ('14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000002', 'admin', null),
  ('14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000003', 'teacher', null),
  ('14000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001', 'teacher', null),
  ('14000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000004', 'owner', null);

create function pg_temp.set_school_settings_claims(
  actor_user_id uuid, actor_session_id uuid, actor_aal text, extra_claims jsonb default '{}'
) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (coalesce($4, '{}'::jsonb) || jsonb_build_object(
    'sub', $1, 'session_id', $2, 'role', 'authenticated', 'aal', $3,
    'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
  ))::text, true);
end;
$$;
create temporary table school_settings_snapshots (
  label text primary key, state jsonb not null
) on commit drop;
create temporary table school_settings_clocks (
  label text primary key, observed_at timestamp with time zone not null
) on commit drop;

-- Test-owner-only snapshots include tuple locations as well as logical values.
-- Actor authority may change in fault fixtures; no School or audit write may hide.
create function pg_temp.school_settings_snapshot(target_school_id uuid)
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object(
    'workspace', (select to_jsonb(w) || jsonb_build_object('tuple', w.ctid::text)
      from desmoslock_v2.workspaces as w where w.id = $1),
    'audit', (select jsonb_agg(to_jsonb(e) || jsonb_build_object('tuple', e.ctid::text) order by e.id)
      from desmoslock_v2.staff_audit_events as e where e.workspace_id = $1)
  );
$$;

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C",
      p.proargnames[p.pronargs + 1:array_length(p.proargnames, 1)] collate "C"
    from pg_proc as p where p.oid =
      to_regprocedure('desmoslock_v2.update_school_display_name(uuid,text,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'display_name', 'expected_settings_revision']::text[] collate "C",
    array['code']::text[] collate "C")$$,
  'School rename requires exact PostgREST input keys and returns only a code row'
);
select is(
  (select proargnames from pg_proc where oid = to_regprocedure('desmoslock_v2.current_staff_context()')),
  array['code', 'profile_id', 'display_name', 'school_id', 'school_slug', 'school_name',
    'school_settings_revision', 'membership_role', 'role_revision']::text[],
  'staff context exposes the exact nine-field shape with School settings revision beside its name'
);
select results_eq(
  $$select column_name::text collate "C", data_type::text collate "C", is_nullable::text collate "C"
    from information_schema.columns where table_schema = 'desmoslock_v2' and table_name = 'workspaces'
      and column_name = 'settings_revision'$$,
  $$values ('settings_revision'::text collate "C", 'bigint'::text collate "C", 'NO'::text collate "C")$$,
  'School settings revision is a required bigint'
);
select results_eq(
  $$select column_name::text collate "C", data_type::text collate "C", is_nullable::text collate "C"
    from information_schema.columns where table_schema = 'desmoslock_v2' and table_name = 'staff_audit_events'
      and column_name in ('previous_settings_revision', 'new_settings_revision') order by 1$$,
  $$values ('new_settings_revision'::text collate "C", 'bigint'::text collate "C", 'YES'::text collate "C"),
    ('previous_settings_revision'::text collate "C", 'bigint'::text collate "C", 'YES'::text collate "C")$$,
  'School audit revisions have exact nullable bigint types'
);
select results_eq(
  $$select column_name::text collate "C" from information_schema.columns
    where table_schema = 'desmoslock_v2' and table_name = 'staff_audit_events' order by 1$$,
  $$select column_name collate "C" from (values
    ('id'::text), ('occurred_at'), ('event_type'), ('result_code'), ('workspace_id'),
    ('actor_profile_id'), ('subject_profile_id'), ('invitation_id'), ('session_id'),
    ('previous_role'), ('new_role'), ('previous_role_revision'), ('new_role_revision'),
    ('previous_settings_revision'), ('new_settings_revision'),
    ('test_id'), ('previous_test_revision'), ('new_test_revision'),
    ('previous_test_lifecycle'), ('new_test_lifecycle'),
    ('student_session_id'), ('actor_device_session_id'),
    ('previous_student_revision'), ('new_student_revision'),
    ('previous_student_epoch'), ('new_student_epoch'),
    ('previous_student_state'), ('new_student_state')
  ) as expected(column_name) order by 1$$,
  'the exact audit schema contains no old or new School names or arbitrary payload'
);
select ok(
  has_function_privilege('authenticated', 'desmoslock_v2.update_school_display_name(uuid,text,bigint)', 'EXECUTE')
  and not has_function_privilege('anon', 'desmoslock_v2.update_school_display_name(uuid,text,bigint)', 'EXECUTE')
  and not has_function_privilege('service_role', 'desmoslock_v2.update_school_display_name(uuid,text,bigint)', 'EXECUTE'),
  'School rename is exposed only to authenticated staff through live authorization'
);
select ok(
  has_function_privilege('authenticated', 'desmoslock_v2.current_staff_context()', 'EXECUTE')
  and not has_function_privilege('anon', 'desmoslock_v2.current_staff_context()', 'EXECUTE')
  and not has_function_privilege('service_role', 'desmoslock_v2.current_staff_context()', 'EXECUTE'),
  'recreated staff context retains its restricted grants'
);
select ok(
  not has_table_privilege('authenticated', 'desmoslock_v2.workspaces', 'SELECT')
  and not has_table_privilege('authenticated', 'desmoslock_v2.workspaces', 'UPDATE'),
  'product clients retain no direct School table read or update privilege'
);

insert into school_settings_snapshots values ('alpha-initial', pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'));

insert into school_settings_snapshots values ('beta-initial', pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000002'));

set local role anon;

select throws_ok($$select * from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Anonymous rename', 1)$$,
  '42501', null, 'anonymous callers cannot invoke the School rename RPC');

reset role;

select set_config('request.jwt.claims', '{}'::jsonb::text, true);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Unauthenticated rename', 1)),
  'unauthenticated', 'an authenticated database role without an Auth identity cannot rename'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', null::text, 1)),
  'invalid_request', 'name shape validation precedes missing-identity authorization'
);

select is((select code from desmoslock_v2.update_school_display_name(null, 'Missing School', 1)),
  'invalid_request', 'School identifier shape validation precedes authorization');

select results_eq(
  $$select * from desmoslock_v2.current_staff_context()$$,
  $$values ('unauthenticated'::text, null::uuid, null::text, null::uuid, null::text, null::text, null::bigint, null::text, null::bigint)$$,
  'failed context reveals no School name or settings revision'
);

reset role;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000005', 'c4200000-0000-4000-8000-000000000005', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Uninvited rename', 1)),
  'membership_inactive', 'a confirmed uninvited identity cannot rename a School'
);

select results_eq(
  $$select * from desmoslock_v2.current_staff_context()$$,
  $$values ('membership_inactive'::text, null::uuid, null::text, null::uuid, null::text, null::text, null::bigint, null::text, null::bigint)$$,
  'an uninvited identity receives no School name or settings revision'
);

reset role;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000006', 'c4200000-0000-4000-8000-000000000006', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Unaffiliated rename', 1)),
  'membership_inactive', 'a bound profile without active Membership cannot rename'
);

select results_eq(
  $$select * from desmoslock_v2.current_staff_context()$$,
  $$values ('membership_inactive'::text, '24000000-0000-4000-8000-000000000006'::uuid, null::text, null::uuid, null::text, null::text, null::bigint, null::text, null::bigint)$$,
  'inactive-profile context retains only its canonical profile ID'
);

reset role;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_staff_context() order by school_id$$,
  $$values
    ('ok'::text, '24000000-0000-4000-8000-000000000001'::uuid, 'School Settings Staff 1'::text,
      '14000000-0000-4000-8000-000000000001'::uuid, 'runtime-settings-alpha'::text, 'Runtime Settings Alpha'::text, 1::bigint, 'owner'::text, 1::bigint),
    ('ok'::text, '24000000-0000-4000-8000-000000000001'::uuid, 'School Settings Staff 1'::text,
      '14000000-0000-4000-8000-000000000002'::uuid, 'runtime-settings-beta'::text, 'Runtime Settings Beta'::text, 1::bigint, 'teacher'::text, 1::bigint)$$,
  'context exposes each active School name and revision with that School-specific Membership role'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000002', 'Foreign Owner authority', 1)),
  'forbidden', 'Owner authority in Alpha does not elevate its Teacher membership in Beta'
);

select throws_ok($$select * from desmoslock_v2.workspaces where id = '14000000-0000-4000-8000-000000000002'$$,
  '42501', null, 'School settings do not introduce a direct foreign-School read');
select throws_ok($$update desmoslock_v2.workspaces set display_name = 'Bypass' where id = '14000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'direct table mutation cannot bypass revision and live authority checks');

reset role;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, school_name, school_settings_revision, membership_role
    from desmoslock_v2.current_staff_context()$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid, 'Runtime Settings Alpha'::text,
    1::bigint, 'admin'::text)$$,
  'Administrator context exposes only its own School name and settings revision'
);
select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000002', 'Foreign Admin authority', 1)),
  'membership_inactive', 'Administrator without a Beta Membership cannot rename Beta'
);

reset role;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000003', 'c4200000-0000-4000-8000-000000000003', 'aal1', '{"app_metadata":{"role":"owner"},"user_metadata":{"role":"admin"}}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, school_name, school_settings_revision, membership_role from desmoslock_v2.current_staff_context()$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid, 'Runtime Settings Alpha'::text, 1::bigint, 'teacher'::text)$$,
  'a Teacher at ordinary AAL1 receives only its own verified School name and settings revision'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Teacher AAL1 rename', 1)),
  'step_up_required', 'AAL1 assurance cannot authorize School editing'
);

reset role;

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('b4200000-0000-4000-8000-000000000003', 'a4200000-0000-4000-8000-000000000003', 'Synthetic Teacher step-up factor',
  'totp', 'verified', clock_timestamp(), clock_timestamp());
update auth.sessions set aal = 'aal2', factor_id = 'b4200000-0000-4000-8000-000000000003' where id = 'c4200000-0000-4000-8000-000000000003';

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000003', 'c4200000-0000-4000-8000-000000000003', 'aal2', '{"app_metadata":{"role":"owner"}}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Teacher AAL2 rename', 1)),
  'forbidden', 'genuine Teacher AAL2 and forged metadata still cannot authorize School editing'
);

reset role;

update auth.sessions set aal = 'aal1', factor_id = null where id = 'c4200000-0000-4000-8000-000000000001';

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'AAL1 rename', 1)),
  'step_up_required', 'Owner editing requires genuine provider-session AAL2 even when the JWT claims AAL2'
);

reset role;

update auth.sessions set aal = 'aal2', factor_id = 'b4200000-0000-4000-8000-000000000001' where id = 'c4200000-0000-4000-8000-000000000001';

update auth.sessions set aal = 'aal1', factor_id = null where id = 'c4200000-0000-4000-8000-000000000002';

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'AAL1 rename', 1)),
  'step_up_required', 'Administrator editing requires genuine provider-session AAL2 even when the JWT claims AAL2'
);

reset role;

update auth.sessions set aal = 'aal2', factor_id = 'b4200000-0000-4000-8000-000000000002' where id = 'c4200000-0000-4000-8000-000000000002';

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-initial'),
  'all permission, assurance and direct-table denials preserve the Alpha tuple and audit'
);

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000002'),
  (select state from school_settings_snapshots where label = 'beta-initial'),
  'foreign-School denials preserve the Beta tuple and audit'
);

-- A seeded target is forbidden even when the actor has genuine same-School authority.
savepoint school_seeded_target;

update desmoslock_v2.workspaces set seed_key = 'settings.test.seeded-target' where id = '14000000-0000-4000-8000-000000000001';

insert into school_settings_snapshots values ('seeded-target', pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'));

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Seeded target rename', 1)),
  'forbidden', 'an authorized Owner cannot mutate a non-runtime School target'
);

reset role;

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'seeded-target'),
  'target rejection writes neither the seeded School tuple nor an audit'
);

rollback to savepoint school_seeded_target;
release savepoint school_seeded_target;

-- Validate raw controls before trimming, then bound the canonical UTF-8 bytes.

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select input.ordinal, result.code
    from (values (1, null::text), (2, ''::text), (3, '   '::text),
      (4, repeat('a', 161)), (5, repeat('é', 81)), (6, repeat('🏫', 41))) as input(ordinal, name)
    cross join lateral desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', input.name, 1) as result order by input.ordinal$$,
  $$values (1, 'invalid_request'::text), (2, 'invalid_request'::text), (3, 'invalid_request'::text),
    (4, 'invalid_request'::text), (5, 'invalid_request'::text), (6, 'invalid_request'::text)$$,
  'null, blank and names exceeding 160 UTF-8 bytes fail closed'
);
select results_eq(
  $$select control.codepoint, result.code from (
      select generate_series(1, 31) as codepoint union all select generate_series(127, 159)
    ) as control cross join lateral desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Raw' || chr(control.codepoint) || 'School', 1) as result
    order by control.codepoint$$,
  $$select control.codepoint, 'invalid_request'::text from (
      select generate_series(1, 31) as codepoint union all select generate_series(127, 159)
    ) as control order by control.codepoint$$,
  'every representable C0, DEL and C1 control is rejected inside otherwise canonical text'
);
select results_eq(
  $$select input.codepoint, result.code from (
      values (32), (160), (5760), (8192), (8193), (8194), (8195), (8196), (8197),
        (8198), (8199), (8200), (8201), (8202), (8232), (8233), (8239), (8287), (12288), (65279)
    ) as input(codepoint) cross join lateral desmoslock_v2.update_school_display_name(
      '14000000-0000-4000-8000-000000000001', chr(input.codepoint) || 'School' || chr(input.codepoint), 1
    ) as result order by input.codepoint$$,
  $$select input.codepoint, 'invalid_request'::text from (
      values (32), (160), (5760), (8192), (8193), (8194), (8195), (8196), (8197),
        (8198), (8199), (8200), (8201), (8202), (8232), (8233), (8239), (8287), (12288), (65279)
    ) as input(codepoint) order by input.codepoint$$,
  'noncanonical ASCII, NBSP, FEFF and all selected Unicode trim padding are rejected independently by SQL'
);
select results_eq(
  $$select input.ordinal, result.code from (
      values (1, null::bigint), (2, 0::bigint), (3, -1::bigint), (4, 9007199254740992::bigint)
    ) as input(ordinal, revision) cross join lateral desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Valid Shape', input.revision) as result
    order by input.ordinal$$,
  $$values (1, 'invalid_request'::text), (2, 'invalid_request'::text),
    (3, 'invalid_request'::text), (4, 'invalid_request'::text)$$,
  'settings expectations must be present positive safe integers'
);

reset role;

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-initial'),
  'invalid name and revision shapes cause no physical School write or audit'
);

insert into school_settings_clocks values ('owner-start', clock_timestamp());

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Owner Renamed Alpha', 1)),
  'school_display_name_updated', 'an AAL2 Owner can rename its runtime School at the expected revision'
);

reset role;

select results_eq(
  $$select w.id, w.kind, w.slug, w.seed_key, w.display_name, w.settings_revision,
      e.event_type, e.result_code, e.workspace_id, e.actor_profile_id, e.session_id,
      e.previous_settings_revision, e.new_settings_revision,
      e.subject_profile_id, e.invitation_id, e.previous_role, e.new_role,
      e.previous_role_revision, e.new_role_revision,
      e.occurred_at >= (select observed_at from school_settings_clocks where label = 'owner-start')
    from desmoslock_v2.workspaces as w join desmoslock_v2.staff_audit_events as e on e.workspace_id = w.id
    where w.id = '14000000-0000-4000-8000-000000000001'$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid, 'school'::text, 'runtime-settings-alpha'::text, null::text,
    'Owner Renamed Alpha'::text, 2::bigint, 'school_display_name_updated'::text, 'school_display_name_updated'::text,
    '14000000-0000-4000-8000-000000000001'::uuid, '24000000-0000-4000-8000-000000000001'::uuid, 'c4200000-0000-4000-8000-000000000001'::uuid, 1::bigint, 2::bigint,
    null::uuid, null::uuid, null::text, null::text, null::bigint, null::bigint, true)$$,
  'rename changes only presentation and revision and emits one attributable typed audit at a fresh clock'
);

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Administrator Alpha', 2)),
  'school_display_name_updated', 'an AAL2 Administrator can rename using a canonical School name'
);

reset role;

select results_eq(
  $$select w.display_name, w.settings_revision, e.actor_profile_id, e.session_id,
      e.previous_settings_revision, e.new_settings_revision
    from desmoslock_v2.workspaces as w join desmoslock_v2.staff_audit_events as e on e.workspace_id = w.id
    where w.id = '14000000-0000-4000-8000-000000000001' and e.new_settings_revision = 3$$,
  $$values ('Administrator Alpha'::text, 3::bigint, '24000000-0000-4000-8000-000000000002'::uuid,
    'c4200000-0000-4000-8000-000000000002'::uuid, 2::bigint, 3::bigint)$$,
  'Administrator rename stores the canonical name and advances exactly one settings revision'
);

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000003', 'c4200000-0000-4000-8000-000000000003', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, school_name, school_settings_revision from desmoslock_v2.current_staff_context()$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid, 'Administrator Alpha'::text, 3::bigint)$$,
  'the Teacher context refresh observes the new School presentation and revision'
);

reset role;

insert into school_settings_snapshots values ('alpha-renamed', pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'));

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Administrator Alpha', 3)),
  'school_display_name_unchanged', 'canonical matching-revision no-op succeeds without mutation'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Administrator Alpha', 2)),
  'school_settings_revision_conflict', 'a stale expectation conflicts even when the current name coincidentally matches'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Stale different name', 2)),
  'school_settings_revision_conflict', 'a stale changed name conflicts instead of overwriting newer settings'
);

reset role;

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-renamed'),
  'no-op and stale requests preserve the exact School tuple and complete audit'
);

savepoint school_name_ascii;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', repeat('a', 160), 3)),
  'school_display_name_updated', 'exactly 160 canonical UTF-8 bytes are accepted for the ascii boundary'
);

reset role;

select results_eq(
  $$select display_name, octet_length(display_name), settings_revision from desmoslock_v2.workspaces where id = '14000000-0000-4000-8000-000000000001'$$,
  $$values (repeat('a', 160), 160, 4::bigint)$$,
  'the ascii boundary stores exactly the canonical 160-byte name and advances once'
);
rollback to savepoint school_name_ascii;
release savepoint school_name_ascii;

savepoint school_name_unicode;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', repeat('é', 80), 3)),
  'school_display_name_updated', 'exactly 160 canonical UTF-8 bytes are accepted for the unicode boundary'
);

reset role;

select results_eq(
  $$select display_name, octet_length(display_name), settings_revision from desmoslock_v2.workspaces where id = '14000000-0000-4000-8000-000000000001'$$,
  $$values (repeat('é', 80), 160, 4::bigint)$$,
  'the unicode boundary stores exactly the canonical 160-byte name and advances once'
);
rollback to savepoint school_name_unicode;
release savepoint school_name_unicode;

savepoint school_name_emoji;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', repeat('🏫', 40), 3)),
  'school_display_name_updated', 'exactly 160 canonical UTF-8 bytes are accepted for the emoji boundary'
);

reset role;

select results_eq(
  $$select display_name, octet_length(display_name), settings_revision from desmoslock_v2.workspaces where id = '14000000-0000-4000-8000-000000000001'$$,
  $$values (repeat('🏫', 40), 160, 4::bigint)$$,
  'the emoji boundary stores exactly the canonical 160-byte name and advances once'
);
rollback to savepoint school_name_emoji;
release savepoint school_name_emoji;

savepoint school_revision_ceiling;

update desmoslock_v2.workspaces set settings_revision = 9007199254740991 where id = '14000000-0000-4000-8000-000000000001';

insert into school_settings_snapshots values ('revision-ceiling', pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'));

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Administrator Alpha', 9007199254740991)),
  'school_display_name_unchanged', 'matching no-op still succeeds at the maximum safe settings revision'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Changed at ceiling', 9007199254740991)),
  'invalid_request', 'a changed name cannot increment beyond the safe settings revision ceiling'
);

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Administrator Alpha', 9007199254740990)),
  'school_settings_revision_conflict', 'stale same-name request still conflicts at the maximum settings revision'
);

reset role;

select throws_ok($$update desmoslock_v2.workspaces set settings_revision = 9007199254740992 where id = '14000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the School table rejects an unsafe settings revision');
select throws_ok($$update desmoslock_v2.workspaces set settings_revision = 0 where id = '14000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the School table rejects a nonpositive settings revision');

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'revision-ceiling'),
  'ceiling no-op, conflicts and rejected increments leave the School tuple and audit unchanged'
);

rollback to savepoint school_revision_ceiling;
release savepoint school_revision_ceiling;

create function pg_temp.reject_school_settings_audit()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'school_display_name_updated' then
    raise exception using errcode = 'PSS01', message = 'synthetic School settings audit rejection';
  end if;
  return new;
end;
$$;
create trigger reject_school_settings_audit before insert on desmoslock_v2.staff_audit_events
for each row execute function pg_temp.reject_school_settings_audit();

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select throws_ok($$select * from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Audit must roll back', 3)$$,
  'PSS01', 'synthetic School settings audit rejection',
  'a uniquely identified audit sink failure aborts the School rename');

reset role;

drop trigger reject_school_settings_audit on desmoslock_v2.staff_audit_events;

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-renamed'),
  'audit failure rolls back the School name, revision, physical tuple and every event'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision)
    values ('school_display_name_updated', 'school_display_name_updated', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 3, 5)$$,
  '23514', null, 'settings audit cannot skip a revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision)
    values ('school_display_name_updated', 'school_display_name_updated', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', null, 4)$$,
  '23514', null, 'settings audit requires the prior revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision)
    values ('school_display_name_updated', 'school_display_name_updated', '14000000-0000-4000-8000-000000000001', null, 'c4200000-0000-4000-8000-000000000001', 3, 4)$$,
  '23514', null, 'settings audit requires its actor'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision, subject_profile_id)
    values ('school_display_name_updated', 'school_display_name_updated', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 3, 4, '24000000-0000-4000-8000-000000000002')$$,
  '23514', null, 'settings audit cannot carry a staff subject'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('school_display_name_updated', 'school_display_name_updated', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 3, 4, 'teacher', 'admin', 1, 2)$$,
  '23514', null, 'settings audit cannot carry Membership role fields'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision)
    values ('membership_revoked', 'membership_revoked', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 3, 4)$$,
  '23514', null, 'other event types cannot carry settings revisions'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, previous_settings_revision, new_settings_revision)
    values ('school_display_name_updated', 'membership_revoked', '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 3, 4)$$,
  '23514', null, 'settings audit requires its matching result code'
);

select throws_ok($$update desmoslock_v2.staff_audit_events set new_settings_revision = 9 where workspace_id = '14000000-0000-4000-8000-000000000001'$$,
  '55000', 'staff audit events are append-only', 'settings events retain the existing append-only update protection');
select throws_ok($$delete from desmoslock_v2.staff_audit_events where workspace_id = '14000000-0000-4000-8000-000000000001'$$,
  '55000', 'staff audit events are append-only', 'settings events retain the existing append-only delete protection');

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-renamed'),
  'invalid payloads and append-only attempts leave the complete audit unchanged'
);

-- Transaction-local real-helper interception changes actual actor facts only
-- after saving the genuine initial result. Reauthorization must see those facts.
create temporary table school_settings_probe (
  action text not null, calls integer not null default 0, first_code text,
  observed_at timestamp with time zone
) on commit drop;
insert into school_settings_probe (action) values ('none');
create temporary table school_settings_original_helper on commit drop as
select p.oid as function_oid, p.proacl as function_acl from pg_proc as p
where p.oid = to_regprocedure('desmoslock_v2.internal_authorize_staff(uuid,text[],boolean)');
alter function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  rename to school_fixture_original_authorize_staff;
create function desmoslock_v2.internal_authorize_staff(
  workspace_id uuid, allowed_roles text[], require_step_up boolean
) returns table (
  code text, user_id uuid, session_id uuid, profile_id uuid,
  membership_role text, role_revision bigint
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  genuine_result record;
  probe record;
begin
  select * into genuine_result
  from desmoslock_v2.school_fixture_original_authorize_staff($1, $2, $3);
  update pg_temp.school_settings_probe set calls = calls + 1 returning * into probe;
  if probe.calls = 1 then
    update pg_temp.school_settings_probe set first_code = genuine_result.code;
    case probe.action
      when 'expired_session' then
        update auth.sessions set not_after = clock_timestamp() - interval '1 second'
        where id = genuine_result.session_id;
      when 'revoked_session' then
        insert into desmoslock_v2.application_session_revocations (
          user_id, session_id, workspace_id, revoked_by_profile_id, reason_code
        ) values (genuine_result.user_id, genuine_result.session_id, null,
          genuine_result.profile_id, 'current_session');
      when 'unverified_factor' then
        update auth.mfa_factors set status = 'unverified'
        where id = (select factor_id from auth.sessions where id = genuine_result.session_id);
      when 'downgraded_actor' then
        update desmoslock_v2.memberships as m
        set role = 'teacher', role_revision = m.role_revision + 1
        where m.workspace_id = $1 and m.profile_id = genuine_result.profile_id;
      when 'revoked_actor' then
        update desmoslock_v2.memberships as m
        set status = 'revoked', role_revision = m.role_revision + 1,
          revoked_at = clock_timestamp(), revoked_by_profile_id = genuine_result.profile_id,
          revocation_reason_code = 'owner_action'
        where m.workspace_id = $1 and m.profile_id = genuine_result.profile_id;
      when 'delayed_success' then
        perform pg_sleep(0.1);
        update pg_temp.school_settings_probe set observed_at = clock_timestamp();
      else null;
    end case;
  end if;
  return query select genuine_result.code, genuine_result.user_id, genuine_result.session_id,
    genuine_result.profile_id, genuine_result.membership_role, genuine_result.role_revision;
end;
$$;
revoke all on function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  from public, anon, authenticated, service_role;

savepoint school_authority_expired_session;
update school_settings_probe set action = 'expired_session', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'session_expired', 'School rename rejects provider session expiry after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after provider session expiry leaves the School tuple and all audits unchanged'
);

rollback to savepoint school_authority_expired_session;
release savepoint school_authority_expired_session;

savepoint school_authority_revoked_session;
update school_settings_probe set action = 'revoked_session', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'session_revoked', 'School rename rejects concrete application-session revocation after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after concrete application-session revocation leaves the School tuple and all audits unchanged'
);

rollback to savepoint school_authority_revoked_session;
release savepoint school_authority_revoked_session;

savepoint school_authority_unverified_factor;
update school_settings_probe set action = 'unverified_factor', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'step_up_required', 'School rename rejects loss of verified TOTP after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after loss of verified TOTP leaves the School tuple and all audits unchanged'
);

rollback to savepoint school_authority_unverified_factor;
release savepoint school_authority_unverified_factor;

savepoint school_authority_owner_downgraded;
update school_settings_probe set action = 'downgraded_actor', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'forbidden', 'School rename rejects Owner downgrade to Teacher after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after Owner downgrade to Teacher leaves the School tuple and all audits unchanged'
);

rollback to savepoint school_authority_owner_downgraded;
release savepoint school_authority_owner_downgraded;

savepoint school_authority_admin_downgraded;
update school_settings_probe set action = 'downgraded_actor', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'forbidden', 'School rename rejects Administrator downgrade to Teacher after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after Administrator downgrade to Teacher leaves the School tuple and all audits unchanged'
);

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, school_name, school_settings_revision, membership_role, role_revision
    from desmoslock_v2.current_staff_context()$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid, 'Administrator Alpha'::text, 3::bigint, 'teacher'::text, 2::bigint)$$,
  'the same session retains ordinary Teacher School presentation after Administrator downgrade'
);

reset role;

rollback to savepoint school_authority_admin_downgraded;
release savepoint school_authority_admin_downgraded;

savepoint school_authority_admin_revoked;
update school_settings_probe set action = 'revoked_actor', calls = 0, first_code = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'Post-wait rename', 3)),
  'membership_inactive', 'School rename rejects Administrator Membership revocation after genuine initial authorization'
);

reset role;

select results_eq(
  $$select first_code, calls, pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001') =
      (select state from school_settings_snapshots where label = 'alpha-renamed')
    from school_settings_probe$$,
  $$values ('ok'::text, 2, true)$$,
  'post-lock revalidation after Administrator Membership revocation leaves the School tuple and all audits unchanged'
);

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000002', 'c4200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_staff_context()$$,
  $$values ('membership_inactive'::text, '24000000-0000-4000-8000-000000000002'::uuid, null::text, null::uuid, null::text, null::text, null::bigint, null::text, null::bigint)$$,
  'the same revoked Administrator session receives no School presentation or settings revision'
);

reset role;

rollback to savepoint school_authority_admin_revoked;
release savepoint school_authority_admin_revoked;

savepoint school_delayed_success;
update school_settings_probe set action = 'delayed_success', calls = 0, first_code = null, observed_at = null;

select pg_temp.set_school_settings_claims('a4200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select code from desmoslock_v2.update_school_display_name('14000000-0000-4000-8000-000000000001', 'After the authority wait', 3)),
  'school_display_name_updated', 'School rename succeeds after the delay when genuine Owner authority remains valid'
);

reset role;

select results_eq(
  $$select probe.first_code, probe.calls, w.display_name, w.settings_revision,
      e.previous_settings_revision, e.new_settings_revision, e.occurred_at >= probe.observed_at
    from desmoslock_v2.workspaces as w cross join school_settings_probe as probe
    join desmoslock_v2.staff_audit_events as e on e.workspace_id = '14000000-0000-4000-8000-000000000001' and e.new_settings_revision = 4
    where w.id = '14000000-0000-4000-8000-000000000001'$$,
  $$values ('ok'::text, 2, 'After the authority wait'::text, 4::bigint, 3::bigint, 4::bigint, true)$$,
  'the successful rename captures its sole audit clock after the delayed authorization boundary'
);
rollback to savepoint school_delayed_success;
release savepoint school_delayed_success;

-- Restore the genuine function object and its original restricted privileges.
drop function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean);
alter function desmoslock_v2.school_fixture_original_authorize_staff(uuid, text[], boolean)
  rename to internal_authorize_staff;
select ok(
  (select p.oid = original.function_oid and p.proacl is not distinct from original.function_acl
    from pg_proc as p cross join school_settings_original_helper as original
    where p.oid = to_regprocedure('desmoslock_v2.internal_authorize_staff(uuid,text[],boolean)')),
  'the original authorization helper object and exact grants are restored'
);

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000001'),
  (select state from school_settings_snapshots where label = 'alpha-renamed'),
  'isolated authorization fixtures leave the successful Alpha name, revision and audit intact'
);

select is(pg_temp.school_settings_snapshot('14000000-0000-4000-8000-000000000002'),
  (select state from school_settings_snapshots where label = 'beta-initial'),
  'all Alpha settings operations leave the second School tuple and audit untouched'
);

select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values ('f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text, true)$$,
  'runtime School settings preserve the canonical pinned fixture and health'
);

select * from finish();
rollback;
