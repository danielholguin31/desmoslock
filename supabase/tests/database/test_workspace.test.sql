begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select plan(255);

-- These are transaction-local SQL Auth fixtures, not actual GoTrue sessions.
-- The production authorization helpers remain intact. Native two-connection
-- lock waits and real provider/browser journeys have separate acceptance lanes.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000'::uuid,
  ('a5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'test-workspace-' || i || '@staff.invalid', '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, clock_timestamp(), clock_timestamp()
from generate_series(1, 6) as fixture(i);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
select ('b5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  ('a5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'Synthetic Test factor ' || i, 'totp', 'verified', clock_timestamp(), clock_timestamp()
from generate_series(1, 6) as fixture(i) where i not in (3, 4);
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal, not_after)
select ('c5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  ('a5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  clock_timestamp(), clock_timestamp(),
  case when i in (3, 4) then null else
    ('b5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid end,
  case when i in (3, 4) then 'aal1'::auth.aal_level else 'aal2'::auth.aal_level end,
  clock_timestamp() + interval '1 hour'
from generate_series(1, 6) as fixture(i);
insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key) values
  ('15000000-0000-4000-8000-000000000001', 'school', 'runtime-test-alpha', 'Runtime Test Alpha', null),
  ('15000000-0000-4000-8000-000000000002', 'school', 'runtime-test-beta', 'Runtime Test Beta', null),
  ('15000000-0000-4000-8000-000000000003', 'school', 'runtime-test-empty', 'Runtime Test Empty', null);
insert into desmoslock_v2.profiles (id, display_name, auth_user_id, seed_key)
select ('25000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'Test Workspace Staff ' || i,
  ('a5200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, null
from generate_series(1, 6) as fixture(i);
insert into desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key) values
  ('15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', 'owner', null),
  ('15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000002', 'admin', null),
  ('15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'teacher', null),
  ('15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000004', 'teacher', null),
  ('15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'owner', null),
  ('15000000-0000-4000-8000-000000000003', '25000000-0000-4000-8000-000000000003', 'teacher', null),
  ('10000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'teacher', null);

create function pg_temp.test_claims(actor integer, actor_aal text, extra jsonb default '{}')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', ($3 || jsonb_build_object(
    'sub', 'a5200000-0000-4000-8000-' || lpad($1::text, 12, '0'),
    'session_id', 'c5200000-0000-4000-8000-' || lpad($1::text, 12, '0'),
    'role', 'authenticated', 'aal', $2,
    'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
  ))::text, true);
end;
$$;
create temporary table test_results (label text primary key, code text, test_id uuid) on commit drop;
grant select, insert on test_results to authenticated;
create temporary table test_snapshots (label text primary key, state jsonb not null) on commit drop;
create function pg_temp.test_snapshot() returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object(
    'tests', (select jsonb_agg(to_jsonb(t) || jsonb_build_object('tuple', t.ctid::text) order by t.id)
      from desmoslock_v2.tests as t),
    'audit', (select jsonb_agg(to_jsonb(e) || jsonb_build_object('tuple', e.ctid::text) order by e.id)
      from desmoslock_v2.staff_audit_events as e)
  );
$$;

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", (select array_agg(a.attname::text collate "C" order by a.attnum) from pg_type as t join pg_attribute as a on a.attrelid = t.typrelid where t.oid = p.prorettype and a.attnum > 0 and not a.attisdropped) collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.current_school_tests(uuid,text,uuid)')$$,
  $$values (0::smallint, array['workspace_id', 'before_created_at', 'before_test_id']::text[] collate "C", array['code', 'test_id', 'school_id', 'created_by_profile_id', 'title', 'lifecycle', 'test_revision', 'created_at', 'opened_at', 'ended_at']::text[] collate "C")$$,
  'current_school_tests has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.current_school_tests(uuid,text,uuid)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.current_school_tests(uuid,text,uuid)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.current_school_tests(uuid,text,uuid)', 'EXECUTE'), 'current_school_tests has only the authenticated public grant');

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", (select array_agg(a.attname::text collate "C" order by a.attnum) from pg_type as t join pg_attribute as a on a.attrelid = t.typrelid where t.oid = p.prorettype and a.attnum > 0 and not a.attisdropped) collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.current_school_test(uuid,uuid)')$$,
  $$values (0::smallint, array['workspace_id', 'test_id']::text[] collate "C", array['code', 'test_id', 'school_id', 'created_by_profile_id', 'title', 'lifecycle', 'test_revision', 'created_at', 'opened_at', 'ended_at']::text[] collate "C")$$,
  'current_school_test has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.current_school_test(uuid,uuid)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.current_school_test(uuid,uuid)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.current_school_test(uuid,uuid)', 'EXECUTE'), 'current_school_test has only the authenticated public grant');

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", p.proargnames[p.pronargs + 1:array_length(p.proargnames, 1)] collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.create_school_test(uuid,uuid,text)')$$,
  $$values (0::smallint, array['workspace_id', 'creation_request_id', 'title']::text[] collate "C", array['code', 'test_id']::text[] collate "C")$$,
  'create_school_test has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.create_school_test(uuid,uuid,text)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.create_school_test(uuid,uuid,text)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.create_school_test(uuid,uuid,text)', 'EXECUTE'), 'create_school_test has only the authenticated public grant');

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", p.proargnames[p.pronargs + 1:array_length(p.proargnames, 1)] collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.update_test_title(uuid,uuid,text,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'test_id', 'title', 'expected_test_revision']::text[] collate "C", array['code']::text[] collate "C")$$,
  'update_test_title has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.update_test_title(uuid,uuid,text,bigint)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.update_test_title(uuid,uuid,text,bigint)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.update_test_title(uuid,uuid,text,bigint)', 'EXECUTE'), 'update_test_title has only the authenticated public grant');

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", p.proargnames[p.pronargs + 1:array_length(p.proargnames, 1)] collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.open_test(uuid,uuid,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'test_id', 'expected_test_revision']::text[] collate "C", array['code']::text[] collate "C")$$,
  'open_test has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.open_test(uuid,uuid,bigint)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.open_test(uuid,uuid,bigint)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.open_test(uuid,uuid,bigint)', 'EXECUTE'), 'open_test has only the authenticated public grant');

select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C", p.proargnames[p.pronargs + 1:array_length(p.proargnames, 1)] collate "C" from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.end_test(uuid,uuid,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'test_id', 'expected_test_revision']::text[] collate "C", array['code']::text[] collate "C")$$,
  'end_test has the exact required input/output names without defaults'
);

select ok(has_function_privilege('authenticated', 'desmoslock_v2.end_test(uuid,uuid,bigint)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.end_test(uuid,uuid,bigint)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.end_test(uuid,uuid,bigint)', 'EXECUTE'), 'end_test has only the authenticated public grant');

select results_eq(
  $$select format_type(a.atttypid, a.atttypmod)::text collate "C" from pg_proc as p join pg_type as t on t.oid = p.prorettype join pg_attribute as a on a.attrelid = t.typrelid where p.pronamespace = 'desmoslock_v2'::regnamespace and p.proname = 'current_school_tests' and p.proretset and a.attnum > 0 and not a.attisdropped order by a.attnum$$,
  $$select value collate "C" from (values (1, 'text'::text), (2, 'uuid'), (3, 'uuid'), (4, 'uuid'), (5, 'text'), (6, 'text'), (7, 'bigint'), (8, 'text'), (9, 'text'), (10, 'text')) as expected(position, value) order by position$$,
  'current_school_tests projects the exact ten SQL types including microsecond text timestamps'
);

select results_eq(
  $$select format_type(a.atttypid, a.atttypmod)::text collate "C" from pg_proc as p join pg_type as t on t.oid = p.prorettype join pg_attribute as a on a.attrelid = t.typrelid where p.pronamespace = 'desmoslock_v2'::regnamespace and p.proname = 'current_school_test' and p.proretset and a.attnum > 0 and not a.attisdropped order by a.attnum$$,
  $$select value collate "C" from (values (1, 'text'::text), (2, 'uuid'), (3, 'uuid'), (4, 'uuid'), (5, 'text'), (6, 'text'), (7, 'bigint'), (8, 'text'), (9, 'text'), (10, 'text')) as expected(position, value) order by position$$,
  'current_school_test projects the exact ten SQL types including microsecond text timestamps'
);

select ok(not has_table_privilege('authenticated', 'desmoslock_v2.tests', 'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('anon', 'desmoslock_v2.tests', 'SELECT,INSERT,UPDATE,DELETE') and (select relrowsecurity from pg_class where oid = 'desmoslock_v2.tests'::regclass), 'Test tables retain RLS and no direct client read or write grants');

select results_eq(
  $$select lifecycle, revision, created_at = '2000-01-01T00:00:00.000000Z'::timestamptz, opened_at is null, ended_at is null, creation_request_id is null from desmoslock_v2.tests where seed_key is not null order by id$$,
  $$values ('draft'::text, 1::bigint, true, true, true, true), ('draft'::text, 1::bigint, true, true, true, true)$$,
  'both canonical fixture Tests have exactly the selected pristine metadata'
);

select ok(not has_function_privilege('authenticated', 'desmoslock_v2.internal_authorize_test_staff(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.internal_authorize_test_staff(uuid)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.internal_authorize_test_staff(uuid)', 'EXECUTE'), 'internal_authorize_test_staff(uuid) remains a private helper without client or service-role execution');

select ok(not has_function_privilege('authenticated', 'desmoslock_v2.internal_is_canonical_test_title(text)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.internal_is_canonical_test_title(text)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.internal_is_canonical_test_title(text)', 'EXECUTE'), 'internal_is_canonical_test_title(text) remains a private helper without client or service-role execution');

select ok(not has_function_privilege('authenticated', 'desmoslock_v2.internal_parse_test_timestamp(text)', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.internal_parse_test_timestamp(text)', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.internal_parse_test_timestamp(text)', 'EXECUTE'), 'internal_parse_test_timestamp(text) remains a private helper without client or service-role execution');

select ok(not has_function_privilege('authenticated', 'desmoslock_v2.internal_guard_test_transition()', 'EXECUTE') and not has_function_privilege('anon', 'desmoslock_v2.internal_guard_test_transition()', 'EXECUTE') and not has_function_privilege('service_role', 'desmoslock_v2.internal_guard_test_transition()', 'EXECUTE'), 'internal_guard_test_transition() remains a private helper without client or service-role execution');

set local role anon;

select throws_ok(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  '42501', null, 'anonymous callers cannot invoke the Test reader'
);

reset role;
select set_config('request.jwt.claims', '{}', true);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('unauthenticated'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list denial returns exactly one null-data row'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000099')$$,
  $$values ('unauthenticated'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'detail denial returns exactly one null-data row'
);

select results_eq(
  $$select * from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', 'Denied')$$,
  $$values ('unauthenticated'::text, null::uuid)$$,
  'create denial returns exactly one code and null ID'
);

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000003', null, null)$$,
  $$select null::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text where false$$,
  'an authorized empty School returns no synthetic success row'
);

reset role;

select pg_temp.test_claims(4, 'aal1', '{}'::jsonb);
set local role authenticated;

insert into test_results select 'owner', r.* from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', 'owner colleague Test') as r;

select results_eq(
  $$select code, test_id is not null from test_results where label = 'owner'$$,
  $$values ('test_created'::text, true)$$,
  'create produces one server Test identity for the owner colleague journey'
);

insert into test_results select 'admin', r.* from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000002', 'admin colleague Test') as r;

select results_eq(
  $$select code, test_id is not null from test_results where label = 'admin'$$,
  $$values ('test_created'::text, true)$$,
  'create produces one server Test identity for the admin colleague journey'
);

insert into test_results select 'teacher', r.* from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000003', 'teacher colleague Test') as r;

select results_eq(
  $$select code, test_id is not null from test_results where label = 'teacher'$$,
  $$values ('test_created'::text, true)$$,
  'create produces one server Test identity for the teacher colleague journey'
);

reset role;

select results_eq(
  $$select count(*), count(distinct test_id) from test_results$$,
  $$values (3::bigint, 3::bigint)$$,
  'distinct creation keys create three distinct Tests'
);

select results_eq(
  $$select count(*), bool_and(t.created_by_profile_id = '25000000-0000-4000-8000-000000000004'::uuid and t.seed_key is null and t.revision = 1 and t.lifecycle = 'draft' and t.creation_request_id is not null and t.created_at >= transaction_timestamp() and t.created_at <= clock_timestamp()) from desmoslock_v2.tests as t where workspace_id = '15000000-0000-4000-8000-000000000001'$$,
  $$values (3::bigint, true)$$,
  'create derives immutable creator and fresh server metadata from genuine authority'
);

reset role;

select pg_temp.test_claims(1, 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select count(*) from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)), 3::bigint, 'owner can list all colleague Tests at its required assurance');

select results_eq(
  $$select code, test_id, school_id, lifecycle, test_revision from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'owner'))$$,
  $$select 'ok'::text, test_id, '15000000-0000-4000-8000-000000000001'::uuid, 'draft'::text, 1::bigint from test_results where label = 'owner'$$,
  'owner can read the exact other-creator Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'owner'), 'owner revised', 1)$$,
  $$values ('test_title_updated'::text)$$,
  'owner can title-edit a colleague draft'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'owner'), 2)$$,
  $$values ('test_opened'::text)$$,
  'owner can open a colleague Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'owner'), 'owner open title', 3)$$,
  $$values ('test_title_updated'::text)$$,
  'owner can title-edit an open colleague Test without closing admission'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'owner'), 4)$$,
  $$values ('test_ended'::text)$$,
  'owner can end a colleague Test'
);

reset role;

select results_eq(
  $$select t.revision, t.lifecycle, t.created_by_profile_id, t.created_at <= t.opened_at and t.opened_at <= t.ended_at, count(e.id) from desmoslock_v2.tests as t join desmoslock_v2.staff_audit_events as e on e.test_id = t.id where t.id = (select test_id from test_results where label = 'owner') group by t.id$$,
  $$values (5::bigint, 'ended'::text, '25000000-0000-4000-8000-000000000004'::uuid, true, 5::bigint)$$,
  'owner lifecycle preserves creator, ordered clocks and one event per real mutation'
);

select results_eq(
  $$select event_type, result_code, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, actor_profile_id, workspace_id = '15000000-0000-4000-8000-000000000001'::uuid and session_id::text = replace(actor_profile_id::text, '25000000', 'c5200000') and subject_profile_id is null and invitation_id is null and previous_role is null and new_role is null and previous_role_revision is null and new_role_revision is null and previous_settings_revision is null and new_settings_revision is null from desmoslock_v2.staff_audit_events where test_id = (select test_id from test_results where label = 'owner') order by new_test_revision$$,
  $$values ('test_created'::text, 'test_created'::text, null::bigint, 1::bigint, null::text, 'draft'::text, '25000000-0000-4000-8000-000000000004'::uuid, true), ('test_title_updated', 'test_title_updated', 1, 2, 'draft', 'draft', '25000000-0000-4000-8000-000000000001'::uuid, true), ('test_opened', 'test_opened', 2, 3, 'draft', 'open', '25000000-0000-4000-8000-000000000001'::uuid, true), ('test_title_updated', 'test_title_updated', 3, 4, 'open', 'open', '25000000-0000-4000-8000-000000000001'::uuid, true), ('test_ended', 'test_ended', 4, 5, 'open', 'ended', '25000000-0000-4000-8000-000000000001'::uuid, true)$$,
  'owner events carry exact typed transitions and attributable actors without unrelated data'
);

reset role;

select pg_temp.test_claims(2, 'aal2', '{}'::jsonb);
set local role authenticated;

select is((select count(*) from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)), 3::bigint, 'admin can list all colleague Tests at its required assurance');

select results_eq(
  $$select code, test_id, school_id, lifecycle, test_revision from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'admin'))$$,
  $$select 'ok'::text, test_id, '15000000-0000-4000-8000-000000000001'::uuid, 'draft'::text, 1::bigint from test_results where label = 'admin'$$,
  'admin can read the exact other-creator Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'admin'), 'admin revised', 1)$$,
  $$values ('test_title_updated'::text)$$,
  'admin can title-edit a colleague draft'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'admin'), 2)$$,
  $$values ('test_opened'::text)$$,
  'admin can open a colleague Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'admin'), 'admin open title', 3)$$,
  $$values ('test_title_updated'::text)$$,
  'admin can title-edit an open colleague Test without closing admission'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'admin'), 4)$$,
  $$values ('test_ended'::text)$$,
  'admin can end a colleague Test'
);

reset role;

select results_eq(
  $$select t.revision, t.lifecycle, t.created_by_profile_id, t.created_at <= t.opened_at and t.opened_at <= t.ended_at, count(e.id) from desmoslock_v2.tests as t join desmoslock_v2.staff_audit_events as e on e.test_id = t.id where t.id = (select test_id from test_results where label = 'admin') group by t.id$$,
  $$values (5::bigint, 'ended'::text, '25000000-0000-4000-8000-000000000004'::uuid, true, 5::bigint)$$,
  'admin lifecycle preserves creator, ordered clocks and one event per real mutation'
);

select results_eq(
  $$select event_type, result_code, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, actor_profile_id, workspace_id = '15000000-0000-4000-8000-000000000001'::uuid and session_id::text = replace(actor_profile_id::text, '25000000', 'c5200000') and subject_profile_id is null and invitation_id is null and previous_role is null and new_role is null and previous_role_revision is null and new_role_revision is null and previous_settings_revision is null and new_settings_revision is null from desmoslock_v2.staff_audit_events where test_id = (select test_id from test_results where label = 'admin') order by new_test_revision$$,
  $$values ('test_created'::text, 'test_created'::text, null::bigint, 1::bigint, null::text, 'draft'::text, '25000000-0000-4000-8000-000000000004'::uuid, true), ('test_title_updated', 'test_title_updated', 1, 2, 'draft', 'draft', '25000000-0000-4000-8000-000000000002'::uuid, true), ('test_opened', 'test_opened', 2, 3, 'draft', 'open', '25000000-0000-4000-8000-000000000002'::uuid, true), ('test_title_updated', 'test_title_updated', 3, 4, 'open', 'open', '25000000-0000-4000-8000-000000000002'::uuid, true), ('test_ended', 'test_ended', 4, 5, 'open', 'ended', '25000000-0000-4000-8000-000000000002'::uuid, true)$$,
  'admin events carry exact typed transitions and attributable actors without unrelated data'
);

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select is((select count(*) from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)), 3::bigint, 'teacher can list all colleague Tests at its required assurance');

select results_eq(
  $$select code, test_id, school_id, lifecycle, test_revision from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$select 'ok'::text, test_id, '15000000-0000-4000-8000-000000000001'::uuid, 'draft'::text, 1::bigint from test_results where label = 'teacher'$$,
  'teacher can read the exact other-creator Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'teacher revised', 1)$$,
  $$values ('test_title_updated'::text)$$,
  'teacher can title-edit a colleague draft'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 2)$$,
  $$values ('test_opened'::text)$$,
  'teacher can open a colleague Test'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'teacher open title', 3)$$,
  $$values ('test_title_updated'::text)$$,
  'teacher can title-edit an open colleague Test without closing admission'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 4)$$,
  $$values ('test_ended'::text)$$,
  'teacher can end a colleague Test'
);

reset role;

select results_eq(
  $$select t.revision, t.lifecycle, t.created_by_profile_id, t.created_at <= t.opened_at and t.opened_at <= t.ended_at, count(e.id) from desmoslock_v2.tests as t join desmoslock_v2.staff_audit_events as e on e.test_id = t.id where t.id = (select test_id from test_results where label = 'teacher') group by t.id$$,
  $$values (5::bigint, 'ended'::text, '25000000-0000-4000-8000-000000000004'::uuid, true, 5::bigint)$$,
  'teacher lifecycle preserves creator, ordered clocks and one event per real mutation'
);

select results_eq(
  $$select event_type, result_code, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, actor_profile_id, workspace_id = '15000000-0000-4000-8000-000000000001'::uuid and session_id::text = replace(actor_profile_id::text, '25000000', 'c5200000') and subject_profile_id is null and invitation_id is null and previous_role is null and new_role is null and previous_role_revision is null and new_role_revision is null and previous_settings_revision is null and new_settings_revision is null from desmoslock_v2.staff_audit_events where test_id = (select test_id from test_results where label = 'teacher') order by new_test_revision$$,
  $$values ('test_created'::text, 'test_created'::text, null::bigint, 1::bigint, null::text, 'draft'::text, '25000000-0000-4000-8000-000000000004'::uuid, true), ('test_title_updated', 'test_title_updated', 1, 2, 'draft', 'draft', '25000000-0000-4000-8000-000000000003'::uuid, true), ('test_opened', 'test_opened', 2, 3, 'draft', 'open', '25000000-0000-4000-8000-000000000003'::uuid, true), ('test_title_updated', 'test_title_updated', 3, 4, 'open', 'open', '25000000-0000-4000-8000-000000000003'::uuid, true), ('test_ended', 'test_ended', 4, 5, 'open', 'ended', '25000000-0000-4000-8000-000000000003'::uuid, true)$$,
  'teacher events carry exact typed transitions and attributable actors without unrelated data'
);

reset role;
savepoint owner_create;
select pg_temp.test_claims(1, 'aal2');
set local role authenticated;
select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000031', 'Owner creation')$$,
  $$values ('test_created'::text, true)$$,
  'Owner can create at genuine AAL2'
);
reset role;
select results_eq(
  $$select created_by_profile_id from desmoslock_v2.tests where creation_request_id = '45000000-0000-4000-8000-000000000031'$$,
  $$values ('25000000-0000-4000-8000-000000000001'::uuid)$$,
  'Owner creation derives its actual actor profile'
);
rollback to savepoint owner_create;
release savepoint owner_create;

reset role;
savepoint administrator_create;
select pg_temp.test_claims(2, 'aal2');
set local role authenticated;
select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000031', 'Administrator creation')$$,
  $$values ('test_created'::text, true)$$,
  'Administrator can create at genuine AAL2'
);
reset role;
select results_eq(
  $$select created_by_profile_id from desmoslock_v2.tests where creation_request_id = '45000000-0000-4000-8000-000000000031'$$,
  $$values ('25000000-0000-4000-8000-000000000002'::uuid)$$,
  'Administrator creation derives its actual actor profile'
);
rollback to savepoint administrator_create;
release savepoint administrator_create;

reset role;

insert into test_snapshots values ('completed', pg_temp.test_snapshot());

reset role;
savepoint owner_aal1;
update auth.sessions set aal = 'aal1', factor_id = null where id = 'c5200000-0000-4000-8000-000000000001';

reset role;

select pg_temp.test_claims(1, 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'owner_aal1 cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'owner_aal1 cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('step_up_required'::text), ('step_up_required'), ('step_up_required'), ('step_up_required')$$,
  'owner_aal1 denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'owner_aal1 leaves all Test tuples and audits unchanged');

rollback to savepoint owner_aal1;
release savepoint owner_aal1;

reset role;
savepoint admin_aal1;
update auth.sessions set aal = 'aal1', factor_id = null where id = 'c5200000-0000-4000-8000-000000000002';

reset role;

select pg_temp.test_claims(2, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'admin_aal1 cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'admin_aal1 cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('step_up_required'::text), ('step_up_required'), ('step_up_required'), ('step_up_required')$$,
  'admin_aal1 denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'admin_aal1 leaves all Test tuples and audits unchanged');

rollback to savepoint admin_aal1;
release savepoint admin_aal1;

reset role;
savepoint unverified_factor;
update auth.mfa_factors set status = 'unverified' where id = 'b5200000-0000-4000-8000-000000000001';

reset role;

select pg_temp.test_claims(1, 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unverified_factor cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('step_up_required'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unverified_factor cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('step_up_required'::text), ('step_up_required'), ('step_up_required'), ('step_up_required')$$,
  'unverified_factor denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'unverified_factor leaves all Test tuples and audits unchanged');

rollback to savepoint unverified_factor;
release savepoint unverified_factor;

reset role;
savepoint expired_session;
update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = 'c5200000-0000-4000-8000-000000000003';

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('session_expired'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'expired_session cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('session_expired'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'expired_session cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('session_expired'::text), ('session_expired'), ('session_expired'), ('session_expired')$$,
  'expired_session denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'expired_session leaves all Test tuples and audits unchanged');

rollback to savepoint expired_session;
release savepoint expired_session;

reset role;
savepoint unverified_email;
update auth.users set email_confirmed_at = null where id = 'a5200000-0000-4000-8000-000000000003';

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('email_unverified'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unverified_email cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('email_unverified'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unverified_email cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('email_unverified'::text), ('email_unverified'), ('email_unverified'), ('email_unverified')$$,
  'unverified_email denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'unverified_email leaves all Test tuples and audits unchanged');

rollback to savepoint unverified_email;
release savepoint unverified_email;

reset role;
savepoint recovery_session;
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values ('e5200000-0000-4000-8000-000000000003', 'c5200000-0000-4000-8000-000000000003', clock_timestamp(), clock_timestamp(), 'recovery');

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('forbidden'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'recovery_session cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('forbidden'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'recovery_session cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('forbidden'::text), ('forbidden'), ('forbidden'), ('forbidden')$$,
  'recovery_session denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'recovery_session leaves all Test tuples and audits unchanged');

rollback to savepoint recovery_session;
release savepoint recovery_session;

reset role;
savepoint revoked_session;
insert into desmoslock_v2.application_session_revocations (user_id, session_id, workspace_id, revoked_by_profile_id, reason_code) values ('a5200000-0000-4000-8000-000000000003', 'c5200000-0000-4000-8000-000000000003', null, '25000000-0000-4000-8000-000000000003', 'current_session');

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('session_revoked'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'revoked_session cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('session_revoked'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'revoked_session cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('session_revoked'::text), ('session_revoked'), ('session_revoked'), ('session_revoked')$$,
  'revoked_session denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'revoked_session leaves all Test tuples and audits unchanged');

rollback to savepoint revoked_session;
release savepoint revoked_session;

reset role;
savepoint inactive_member;
update desmoslock_v2.memberships set status = 'revoked', role_revision = 2, revoked_at = clock_timestamp(), revoked_by_profile_id = '25000000-0000-4000-8000-000000000001', revocation_reason_code = 'owner_action' where workspace_id = '15000000-0000-4000-8000-000000000001' and profile_id = '25000000-0000-4000-8000-000000000003';

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('membership_inactive'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'inactive_member cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('membership_inactive'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'inactive_member cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('membership_inactive'::text), ('membership_inactive'), ('membership_inactive'), ('membership_inactive')$$,
  'inactive_member denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'inactive_member leaves all Test tuples and audits unchanged');

rollback to savepoint inactive_member;
release savepoint inactive_member;

reset role;
savepoint unaffiliated_identity;

reset role;

select pg_temp.test_claims(6, 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, null)$$,
  $$values ('membership_inactive'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unaffiliated_identity cannot list or disclose Test data'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('membership_inactive'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'unaffiliated_identity cannot disclose a targeted Test'
);

select results_eq(
  $$select code from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'Denied') union all select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Denied', 5) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('membership_inactive'::text), ('membership_inactive'), ('membership_inactive'), ('membership_inactive')$$,
  'unaffiliated_identity denies all four write RPCs before target transitions'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'unaffiliated_identity leaves all Test tuples and audits unchanged');

rollback to savepoint unaffiliated_identity;
release savepoint unaffiliated_identity;

reset role;

select pg_temp.test_claims(4, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000003', 'A later unrelated title')$$,
  $$select 'test_creation_already_recorded'::text, test_id from test_results where label = 'teacher'$$,
  'same create key returns original identity after title/lifecycle changes without rewriting them'
);

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('test_already_ended'::text)$$,
  'matching ended revision returns the no-op acknowledgment'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 4)$$,
  $$values ('test_revision_conflict'::text)$$,
  'stale end replay conflicts before already-ended detection'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 5)$$,
  $$values ('test_transition_rejected'::text)$$,
  'ended Test cannot reopen'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'teacher open title', 5)$$,
  $$values ('test_transition_rejected'::text)$$,
  'even an unchanged ended title is read-only'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Changed', 4)$$,
  $$values ('test_revision_conflict'::text)$$,
  'stale expected revision precedes ended lifecycle rejection'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'create replay, no-op, stale and ended-state rejections preserve exact Test/audit tuples');

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', null::text)$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects null before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), null::text, 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects null'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', '')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects empty before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), '', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects empty'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', '   ')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects blank before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), '   ', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects blank'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', ' padded ')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects ASCII edge spaces before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), ' padded ', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects ASCII edge spaces'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', chr(160) || 'title')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects Unicode edge whitespace before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), chr(160) || 'title', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects Unicode edge whitespace'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'title' || chr(65279))$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects BOM edge whitespace before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'title' || chr(65279), 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects BOM edge whitespace'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'a' || chr(9) || 'b')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects raw tab before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'a' || chr(9) || 'b', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects raw tab'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'a' || chr(10) || 'b')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects raw newline before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'a' || chr(10) || 'b', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects raw newline'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'a' || chr(127) || 'b')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects DEL before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'a' || chr(127) || 'b', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects DEL'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', 'a' || chr(133) || 'b')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects C1 control before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'a' || chr(133) || 'b', 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects C1 control'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', repeat('a', 161))$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects 161 ASCII bytes before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), repeat('a', 161), 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects 161 ASCII bytes'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', repeat('é', 81))$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects 162 UTF-8 bytes before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), repeat('é', 81), 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects 162 UTF-8 bytes'
);

select results_eq(
  $$select code, test_id from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000099', repeat('🧪', 41))$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'SQL create rejects 164 UTF-8 bytes before canonical title normalization'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), repeat('🧪', 41), 5)$$,
  $$values ('invalid_request'::text)$$,
  'SQL title mutation independently rejects 164 UTF-8 bytes'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Valid title', null::bigint) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), null::bigint) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), null::bigint)$$,
  $$values ('invalid_request'::text), ('invalid_request'), ('invalid_request')$$,
  'all revision mutations reject invalid expected revision null::bigint'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Valid title', 0) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 0) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 0)$$,
  $$values ('invalid_request'::text), ('invalid_request'), ('invalid_request')$$,
  'all revision mutations reject invalid expected revision 0'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Valid title', -1) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), -1) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), -1)$$,
  $$values ('invalid_request'::text), ('invalid_request'), ('invalid_request')$$,
  'all revision mutations reject invalid expected revision -1'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 'Valid title', 9007199254740992) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 9007199254740992) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'teacher'), 9007199254740992)$$,
  $$values ('invalid_request'::text), ('invalid_request'), ('invalid_request')$$,
  'all revision mutations reject invalid expected revision 9007199254740992'
);

select results_eq(
  $$select * from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', null, 'Valid')$$,
  $$values ('invalid_request'::text, null::uuid)$$,
  'create requires a duplicate-guard UUID'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', null)$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'detail requires a Test identity'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests(null, null, null)$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list requires a School identity'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', null, '35000000-0000-4000-8000-000000000001')$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects ID-only cursor without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56.000001Z', null)$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects timestamp-only cursor without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-02-29T12:34:56.000001Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects invalid leap date without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2024-02-30T12:34:56.000001Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects invalid day without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '0000-01-01T00:00:00.000000Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects year zero without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '10000-01-01T00:00:00.000000Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects five-digit year without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T24:00:00.000000Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects hour 24 without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:60:00.000000Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects minute 60 without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:60.000000Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects leap second without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56.001Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects millisecond truncation without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56.0000001Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects excess fractional digits without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects missing fractional digits without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56.000001+00:00', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects offset spelling without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08 12:34:56.000001Z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects space date separator without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', '2026-09-08T12:34:56.000001z', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects lowercase UTC suffix without data disclosure'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000001', 'infinity', (select test_id from test_results where label = 'teacher'))$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'list rejects infinity without data disclosure'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'completed'), 'all rejected payloads preserve complete Test and audit tuples');

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000011', repeat('é', 80))$$,
  $$values ('test_created'::text, true)$$,
  'canonical valid UTF-8 title 11 is accepted at the byte boundary or with interior whitespace'
);

select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000012', repeat('🧪', 40))$$,
  $$values ('test_created'::text, true)$$,
  'canonical valid UTF-8 title 12 is accepted at the byte boundary or with interior whitespace'
);

select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000013', 'Interior ' || chr(160) || ' space')$$,
  $$values ('test_created'::text, true)$$,
  'canonical valid UTF-8 title 13 is accepted at the byte boundary or with interior whitespace'
);

select results_eq(
  $$select code, test_id <> (select test_id from test_results where label = 'teacher') from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000003', 'Different creator key')$$,
  $$values ('test_created'::text, true)$$,
  'the same request UUID for a different creator represents an independent creation'
);

select results_eq(
  $$select code, test_id is not null from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000003', '45000000-0000-4000-8000-000000000003', 'Different School key')$$,
  $$values ('test_created'::text, true)$$,
  'the same request UUID in another authorized School is independent'
);

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

insert into test_results select 'beta', r.* from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000002', '45000000-0000-4000-8000-000000000001', 'Beta private title') as r;

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002', null, null)$$,
  $$values ('membership_inactive'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'Alpha Teacher cannot list a foreign School'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'beta'))$$,
  $$values ('test_unavailable'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'detail hides foreign Test in an authorized School'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'beta'), 'Hidden target', 1) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'beta'), 1) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'beta'), 1)$$,
  $$values ('test_unavailable'::text), ('test_unavailable'), ('test_unavailable')$$,
  'all target mutations hide foreign Test in an authorized School'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000099')$$,
  $$values ('test_unavailable'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'detail hides missing Test'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000099', 'Hidden target', 1) union all select code from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000099', 1) union all select code from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000099', 1)$$,
  $$values ('test_unavailable'::text), ('test_unavailable'), ('test_unavailable')$$,
  'all target mutations hide missing Test'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_test('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')$$,
  $$values ('test_unavailable'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'detail hides pinned fixture Test with an actual same-School Membership'
);

select results_eq(
  $$select code from desmoslock_v2.update_test_title('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Hidden target', 1) union all select code from desmoslock_v2.open_test('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1) union all select code from desmoslock_v2.end_test('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1)$$,
  $$values ('test_unavailable'::text), ('test_unavailable'), ('test_unavailable')$$,
  'all target mutations hide pinned fixture Test with an actual same-School Membership'
);

reset role;

select pg_temp.test_claims(4, 'aal1', '{}'::jsonb);
set local role authenticated;

insert into test_results select 'orphan', r.* from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000020', 'Creator may leave') as r;

reset role;
update desmoslock_v2.memberships set status = 'revoked', role_revision = 2, revoked_at = clock_timestamp(), revoked_by_profile_id = '25000000-0000-4000-8000-000000000001', revocation_reason_code = 'owner_action' where workspace_id = '15000000-0000-4000-8000-000000000001' and profile_id = '25000000-0000-4000-8000-000000000004';

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 1)$$,
  $$values ('test_transition_rejected'::text)$$,
  'a draft cannot end even after creator departure'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 'Colleague continues', 1)$$,
  $$values ('test_title_updated'::text)$$,
  'creator revocation does not strand the draft title'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 'Colleague continues', 2)$$,
  $$values ('test_title_unchanged'::text)$$,
  'matching draft title is a no-op'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 'Colleague continues', 1)$$,
  $$values ('test_revision_conflict'::text)$$,
  'stale title conflicts before unchanged detection'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 2)$$,
  $$values ('test_opened'::text)$$,
  'a colleague can open after creator revocation'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 3)$$,
  $$values ('test_already_open'::text)$$,
  'matching open revision is a no-op'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 2)$$,
  $$values ('test_revision_conflict'::text)$$,
  'stale open replay conflicts before already-open detection'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', (select test_id from test_results where label = 'orphan'), 3)$$,
  $$values ('test_ended'::text)$$,
  'a colleague can end after creator revocation'
);

reset role;

select results_eq(
  $$select revision, created_by_profile_id, (select count(*) from desmoslock_v2.staff_audit_events where test_id = t.id) from desmoslock_v2.tests as t where id = (select test_id from test_results where label = 'orphan')$$,
  $$values (4::bigint, '25000000-0000-4000-8000-000000000004'::uuid, 4::bigint)$$,
  'creator attribution remains intact and stale/no-op operations add no event'
);

insert into desmoslock_v2.tests (
  id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision,
  created_at, opened_at, ended_at, creation_request_id
) select ('35000000-0000-4000-8000-' || lpad((80 + ordinal)::text, 12, '0'))::uuid,
  '15000000-0000-4000-8000-000000000001'::uuid, '25000000-0000-4000-8000-000000000003', 'Ceiling Test', null,
  lifecycle, 9007199254740991, '2026-01-01T00:00:00.000001Z'::timestamptz,
  case when lifecycle <> 'draft' then '2026-01-01T00:00:00.000002Z'::timestamptz end,
  case when lifecycle = 'ended' then '2026-01-01T00:00:00.000003Z'::timestamptz end,
  ('45000000-0000-4000-8000-' || lpad((80 + ordinal)::text, 12, '0'))::uuid
from (values (1, 'draft'::text), (2, 'open'), (3, 'ended')) as fixture(ordinal, lifecycle);

reset role;

insert into test_snapshots values ('ceiling', pg_temp.test_snapshot());

reset role;

select pg_temp.test_claims(3, 'aal1', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000081', 'Ceiling Test', 9007199254740991)$$,
  $$values ('test_title_unchanged'::text)$$,
  'maximum draft revision still permits title no-op'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000081', 'Changed ceiling', 9007199254740991)$$,
  $$values ('invalid_request'::text)$$,
  'maximum draft revision rejects a real title increment'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000081', 9007199254740991)$$,
  $$values ('invalid_request'::text)$$,
  'maximum draft revision cannot overflow on open'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000082', 'Ceiling Test', 9007199254740991)$$,
  $$values ('test_title_unchanged'::text)$$,
  'maximum open revision still permits title no-op'
);

select results_eq(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000082', 'Changed ceiling', 9007199254740991)$$,
  $$values ('invalid_request'::text)$$,
  'maximum open revision rejects a real title increment'
);

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000082', 9007199254740991)$$,
  $$values ('test_already_open'::text)$$,
  'maximum open revision retains its valid no-op'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000082', 9007199254740991)$$,
  $$values ('invalid_request'::text)$$,
  'maximum open revision cannot overflow on end'
);

select results_eq(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000083', 9007199254740991)$$,
  $$values ('test_already_ended'::text)$$,
  'maximum ended revision retains its valid no-op'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'ceiling'), 'ceiling no-ops and rejected increments preserve physical rows and audits');

insert into desmoslock_v2.tests (
  id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision,
  created_at, opened_at, ended_at, creation_request_id
) select ('36000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '15000000-0000-4000-8000-000000000002'::uuid, '25000000-0000-4000-8000-000000000005', 'Page Test ' || i,
  null, 'draft', 1,
  '2099-09-08T12:34:56.000000Z'::timestamptz +
    case when i >= 6 then (i - 4) * interval '1 microsecond'
      when i in (4, 5) then interval '1 microsecond' else interval '0 microseconds' end,
  null, null, ('46000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1, 54) as fixture(i);
create temporary table page_rows (
  ordinal bigint, code text, test_id uuid, school_id uuid, created_by_profile_id uuid,
  title text, lifecycle text, test_revision bigint, created_at text, opened_at text, ended_at text
) on commit drop;
grant select, insert on page_rows to authenticated;

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

insert into page_rows select r.ordinality, r.code, r.test_id, r.school_id, r.created_by_profile_id, r.title, r.lifecycle, r.test_revision, r.created_at, r.opened_at, r.ended_at from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002', null, null) with ordinality as r;

select is((select count(*) from page_rows), 51::bigint, 'first SQL page returns exactly 51 raw rows as bounded lookahead');

select results_eq(
  $$select ordinal, test_id, created_at from page_rows where ordinal >= 49 order by ordinal$$,
  $$values (49::bigint, '36000000-0000-4000-8000-000000000006'::uuid, '2099-09-08T12:34:56.000002Z'::text), (50, '36000000-0000-4000-8000-000000000005'::uuid, '2099-09-08T12:34:56.000001Z'), (51, '36000000-0000-4000-8000-000000000004'::uuid, '2099-09-08T12:34:56.000001Z')$$,
  'microseconds inside one millisecond and UUID ties survive the visible-page boundary'
);

create temporary table second_page on commit drop as
select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002',
  (select created_at from page_rows where ordinal = 50),
  (select test_id from page_rows where ordinal = 50));

select is((select count(*) from second_page), 5::bigint, 'visible-row cursor includes the lookahead tie plus all older rows including the original Beta Test');

reset role;

select results_eq(
  $$select test_id from (select test_id, created_at from page_rows where ordinal <= 50 union all select test_id, created_at from second_page) as actual order by created_at desc, test_id desc$$,
  $$select id from desmoslock_v2.tests where workspace_id = '15000000-0000-4000-8000-000000000002' and seed_key is null order by created_at desc, id desc$$,
  'two native pages have no gap, duplicate, rounded timestamp or dropped lookahead'
);

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select created_at from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000002', '36000000-0000-4000-8000-000000000001')$$,
  $$values ('2099-09-08T12:34:56.000000Z'::text)$$,
  'detail retains all six fractional digits including trailing zeros'
);

set local timezone = 'Pacific/Honolulu';

select results_eq(
  $$select created_at from desmoslock_v2.current_school_test('15000000-0000-4000-8000-000000000002', '36000000-0000-4000-8000-000000000005')$$,
  $$values ('2099-09-08T12:34:56.000001Z'::text)$$,
  'SQL projections retain canonical UTC text independently of session timezone'
);

select results_eq(
  $$select * from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002', '2099-02-29T12:34:56.000001Z', '36000000-0000-4000-8000-000000000005')$$,
  $$values ('invalid_request'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::text, null::text, null::text)$$,
  'invalid calendar remains rejected under a non-UTC session timezone'
);

select is((select count(*) from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002', '0001-01-01T00:00:00.000000Z', '36000000-0000-4000-8000-000000000005')), 0::bigint, 'canonical year 0001 is valid and yields an empty older page');

select is((select count(*) from desmoslock_v2.current_school_tests('15000000-0000-4000-8000-000000000002', '9999-12-31T23:59:59.999999Z', '36000000-0000-4000-8000-000000000005')), 51::bigint, 'canonical year 9999 remains a bounded valid native cursor');

reset role;
set local timezone = 'UTC';

create function pg_temp.reject_test_audit() returns trigger language plpgsql as $$
begin
  if new.test_id is not null then
    raise exception using errcode = 'PTW01', message = 'synthetic Test audit rejection';
  end if;
  return new;
end;
$$;
create trigger reject_test_audit before insert on desmoslock_v2.staff_audit_events
for each row execute function pg_temp.reject_test_audit();

reset role;

insert into test_snapshots values ('audit-failure', pg_temp.test_snapshot());

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

select throws_ok(
  $$select * from desmoslock_v2.create_school_test('15000000-0000-4000-8000-000000000002', '45000000-0000-4000-8000-000000000098', 'Audit must roll back')$$,
  'PTW01', 'synthetic Test audit rejection', 'create propagates the unique audit failure'
);

select throws_ok(
  $$select * from desmoslock_v2.update_test_title('15000000-0000-4000-8000-000000000002', (select test_id from test_results where label = 'beta'), 'Audit must roll back', 1)$$,
  'PTW01', 'synthetic Test audit rejection', 'title propagates the unique audit failure'
);

select throws_ok(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000002', (select test_id from test_results where label = 'beta'), 1)$$,
  'PTW01', 'synthetic Test audit rejection', 'open propagates the unique audit failure'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'audit-failure'), 'failed create/title/open audit rolls back all logical data and physical tuples');

drop trigger reject_test_audit on desmoslock_v2.staff_audit_events;

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select * from desmoslock_v2.open_test('15000000-0000-4000-8000-000000000002', (select test_id from test_results where label = 'beta'), 1)$$,
  $$values ('test_opened'::text)$$,
  'prepare a genuine open Test for atomic end audit check'
);

reset role;
create trigger reject_test_audit before insert on desmoslock_v2.staff_audit_events for each row execute function pg_temp.reject_test_audit();

reset role;

insert into test_snapshots values ('end-audit-failure', pg_temp.test_snapshot());

reset role;

select pg_temp.test_claims(5, 'aal2', '{}'::jsonb);
set local role authenticated;

select throws_ok(
  $$select * from desmoslock_v2.end_test('15000000-0000-4000-8000-000000000002', (select test_id from test_results where label = 'beta'), 2)$$,
  'PTW01', 'synthetic Test audit rejection', 'end propagates the unique audit failure'
);

reset role;

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'end-audit-failure'), 'failed end audit rolls back lifecycle, revision, timestamps and event');

drop trigger reject_test_audit on desmoslock_v2.staff_audit_events;

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', null, 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects missing actor'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', null, (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects missing session'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', null, 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects missing Test'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', null, '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects missing School'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), null, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects missing previous revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 4, 'open', 'open')$$,
  '23514', null, 'typed audit rejects revision gap'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 9007199254740991, 9007199254740992, 'open', 'open')$$,
  '23514', null, 'typed audit rejects unsafe revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_opened', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects mismatched result'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'ended')$$,
  '23514', null, 'typed audit rejects title lifecycle change'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'ended', 'ended')$$,
  '23514', null, 'typed audit rejects title after end'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_opened', 'test_opened', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects invalid open transition'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_ended', 'test_ended', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'draft', 'ended')$$,
  '23514', null, 'typed audit rejects invalid end transition'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_created', 'test_created', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), null, 2, null, 'draft')$$,
  '23514', null, 'typed audit rejects invalid create revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, subject_profile_id) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open', '25000000-0000-4000-8000-000000000003')$$,
  '23514', null, 'typed audit rejects staff subject'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, previous_role, new_role, previous_role_revision, new_role_revision) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open', 'teacher', 'admin', 1, 2)$$,
  '23514', null, 'typed audit rejects Membership fields'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle, previous_settings_revision, new_settings_revision) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open', 1, 2)$$,
  '23514', null, 'typed audit rejects School revision fields'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('session_revoked', 'ok', '15000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23514', null, 'typed audit rejects Test payload on other event'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision, previous_test_lifecycle, new_test_lifecycle) values ('test_title_updated', 'test_title_updated', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000005', 'c5200000-0000-4000-8000-000000000005', (select test_id from test_results where label = 'beta'), 2, 3, 'open', 'open')$$,
  '23503', null, 'audit Test foreign key is bound to the exact School'
);

select throws_ok(
  $$update desmoslock_v2.tests set id = '35000000-0000-4000-8000-000000000090' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing Test ID'
);

select throws_ok(
  $$update desmoslock_v2.tests set workspace_id = '15000000-0000-4000-8000-000000000001' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing School identity'
);

select throws_ok(
  $$update desmoslock_v2.tests set created_by_profile_id = '25000000-0000-4000-8000-000000000003' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing creator attribution'
);

select throws_ok(
  $$update desmoslock_v2.tests set creation_request_id = '45000000-0000-4000-8000-000000000090' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing create key'
);

select throws_ok(
  $$update desmoslock_v2.tests set seed_key = 'test.illegal.runtime' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing seed identity'
);

select throws_ok(
  $$update desmoslock_v2.tests set created_at = created_at + interval '1 microsecond' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing creation timestamp'
);

select throws_ok(
  $$update desmoslock_v2.tests set opened_at = opened_at + interval '1 microsecond' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing opened timestamp'
);

select throws_ok(
  $$update desmoslock_v2.tests set lifecycle = 'draft', opened_at = null where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing backward lifecycle'
);

select throws_ok(
  $$update desmoslock_v2.tests set revision = revision + 1 where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing revision-only increment'
);

select throws_ok(
  $$update desmoslock_v2.tests set title = 'Unversioned title' where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing unversioned title'
);

select throws_ok(
  $$update desmoslock_v2.tests set revision = 0 where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing nonpositive revision'
);

select throws_ok(
  $$update desmoslock_v2.tests set revision = 9007199254740992 where id = (select test_id from test_results where label = 'beta')$$,
  null, null, 'storage guard rejects changing unsafe revision'
);

select throws_ok(
  $$update desmoslock_v2.tests set lifecycle = 'open', opened_at = '2000-01-01T00:00:00.000000Z', revision = 2 where id = '30000000-0000-4000-8000-000000000001'$$,
  null, null, 'pinned synthetic metadata cannot change lifecycle'
);

select throws_ok(
  $$update desmoslock_v2.tests set revision = 2 where id = '30000000-0000-4000-8000-000000000001'$$,
  null, null, 'pinned synthetic metadata cannot change revision'
);

select throws_ok(
  $$update desmoslock_v2.tests set created_at = '2000-01-01T00:00:00.000001Z' where id = '30000000-0000-4000-8000-000000000001'$$,
  null, null, 'pinned synthetic metadata cannot change creation timestamp'
);

select throws_ok(
  $$update desmoslock_v2.tests set creation_request_id = '45000000-0000-4000-8000-000000000090' where id = '30000000-0000-4000-8000-000000000001'$$,
  null, null, 'pinned synthetic metadata cannot change creation key'
);

select throws_ok(
  $$update desmoslock_v2.staff_audit_events set new_test_revision = 99 where test_id = (select test_id from test_results where label = 'beta')$$,
  '55000', 'staff audit events are append-only', 'Test audit keeps append-only update protection'
);

select throws_ok(
  $$delete from desmoslock_v2.staff_audit_events where test_id = (select test_id from test_results where label = 'beta')$$,
  '55000', 'staff audit events are append-only', 'Test audit keeps append-only delete protection'
);

reset role;

-- Insert-path CHECK tests bypass no guard and isolate the stored invariants.

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', ' noncanonical ', null, 'draft', 1, '2026-01-01T00:00:00.000002Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects noncanonical title'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'draft', 9007199254740992, '2026-01-01T00:00:00.000002Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects unsafe revision'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'draft', 0, '2026-01-01T00:00:00.000002Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects zero revision'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'draft', 1, 'infinity', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects infinite creation time'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'draft', 1, '10000-01-01T00:00:00Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects creation year above 9999'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'active', 1, '2026-01-01T00:00:00.000002Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects unknown lifecycle'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'draft', 1, '2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000003Z', null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects draft with opened timestamp'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'open', 1, '2026-01-01T00:00:00.000002Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects open without opened timestamp'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'ended', 1, '2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000003Z', null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects ended without ended timestamp'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'open', 1, '2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000001Z', null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects opening one microsecond before creation'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', null, 'ended', 1, '2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000003Z', '2026-01-01T00:00:00.000002Z', '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Test insertion rejects ending one microsecond before opening'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', 'test.invalid.pristine', 'draft', 2, '2000-01-01T00:00:00.000000Z', null, null, null)$$,
  '23514', null, 'Synthetic-only CHECK independently rejects non-pristine revision'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', 'test.invalid.pristine', 'draft', 1, '2000-01-01T00:00:00.000001Z', null, null, null)$$,
  '23514', null, 'Synthetic-only CHECK independently rejects non-pristine creation time'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', 'test.invalid.pristine', 'draft', 1, '2000-01-01T00:00:00.000000Z', null, null, '45000000-0000-4000-8000-000000000097')$$,
  '23514', null, 'Synthetic-only CHECK independently rejects non-pristine request key'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', 'test.invalid.pristine', 'open', 1, '2000-01-01T00:00:00.000000Z', '2000-01-01T00:00:00.000001Z', null, null)$$,
  '23514', null, 'Synthetic-only CHECK independently rejects non-pristine open lifecycle'
);

select throws_ok(
  $$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at, ended_at, creation_request_id) values ('35000000-0000-4000-8000-000000000097', '15000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000003', 'Invalid storage fixture', 'test.invalid.pristine', 'ended', 1, '2000-01-01T00:00:00.000000Z', '2000-01-01T00:00:00.000001Z', '2000-01-01T00:00:00.000002Z', null)$$,
  '23514', null, 'Synthetic-only CHECK independently rejects non-pristine ended lifecycle'
);

select throws_ok($$insert into desmoslock_v2.tests (id, workspace_id, created_by_profile_id, title, seed_key, creation_request_id)
  select '35000000-0000-4000-8000-000000000096', workspace_id, created_by_profile_id,
    'Duplicate create key', null, creation_request_id
  from desmoslock_v2.tests where id = (select test_id from test_results where label = 'beta')$$,
  '23505', null, 'storage independently enforces the exact School/creator/create-key duplicate guard');

select is((select pg_temp.test_snapshot()), (select state from test_snapshots where label = 'end-audit-failure'), 'all invalid audit and storage writes preserve every Test tuple and audit event');

-- Infrastructure probes for the selected parent-before-child lock predicate.
-- These do not implement or exercise future StudentSession admission handlers;
-- native open/ended lock-wait ordering lives in revoke-membership-lock.test.mjs.
insert into desmoslock_v2.tests (
  id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision,
  created_at, opened_at, ended_at, creation_request_id
) values
  ('35000000-0000-4000-8000-000000000098', '15000000-0000-4000-8000-000000000001',
    '25000000-0000-4000-8000-000000000003', 'Draft parent probe', null, 'draft', 1,
    '2026-01-01T00:00:00.000002Z', null, null, null),
  ('35000000-0000-4000-8000-000000000099', '15000000-0000-4000-8000-000000000002',
    '25000000-0000-4000-8000-000000000005', 'Open foreign parent probe', null, 'open', 1,
    '2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000003Z', null, null);
insert into desmoslock_v2.student_sessions (id, workspace_id, test_id, state, seed_key) values
  ('55000000-0000-4000-8000-000000000098', '15000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000098', 'created', null),
  ('55000000-0000-4000-8000-000000000099', '15000000-0000-4000-8000-000000000002',
    '35000000-0000-4000-8000-000000000099', 'created', null);
insert into test_snapshots values ('parent-predicates', jsonb_build_object(
  'tests_and_audit', pg_temp.test_snapshot(),
  'children', (select jsonb_agg(to_jsonb(s) || jsonb_build_object('tuple', s.ctid::text) order by s.id)
    from desmoslock_v2.student_sessions as s)
));
create temporary table test_parent_gate_results (
  label text primary key, parent_found boolean not null, parent_open boolean not null,
  child_inspected boolean not null, child_found boolean not null
) on commit drop;
do $probe$
declare
  probe record;
  parent_found boolean;
  parent_open boolean;
  child_inspected boolean;
  child_found boolean;
begin
  for probe in select * from (values
    ('draft', '15000000-0000-4000-8000-000000000001'::uuid, '35000000-0000-4000-8000-000000000098'::uuid),
    ('foreign', '15000000-0000-4000-8000-000000000001'::uuid, '35000000-0000-4000-8000-000000000099'::uuid),
    ('owned-open', '15000000-0000-4000-8000-000000000002'::uuid, '35000000-0000-4000-8000-000000000099'::uuid)
  ) as cases(label, workspace_id, test_id) loop
    select t.lifecycle = 'open' into parent_open from desmoslock_v2.tests as t
      where t.workspace_id = probe.workspace_id and t.id = probe.test_id for share;
    parent_found := found;
    child_inspected := false;
    child_found := false;
    if parent_found and parent_open then
      child_inspected := true;
      perform 1 from desmoslock_v2.student_sessions as s
        where s.workspace_id = probe.workspace_id and s.test_id = probe.test_id for update;
      child_found := found;
    end if;
    insert into test_parent_gate_results values (
      probe.label, parent_found, coalesce(parent_open, false), child_inspected, child_found
    );
  end loop;
end;
$probe$;
select results_eq(
  $$select label, parent_found, parent_open, child_inspected, child_found
    from test_parent_gate_results where label in ('draft', 'foreign') order by label$$,
  $$values ('draft'::text, true, false, false, false), ('foreign'::text, false, false, false, false)$$,
  'parent SHARE probes reject draft and wrong-School Tests before inspecting any child'
);
select results_eq(
  $$select parent_found, parent_open, child_inspected, child_found
    from test_parent_gate_results where label = 'owned-open'$$,
  $$values (true, true, true, true)$$,
  'the owned open parent control permits child inspection after its SHARE lock'
);
select is(jsonb_build_object(
  'tests_and_audit', pg_temp.test_snapshot(),
  'children', (select jsonb_agg(to_jsonb(s) || jsonb_build_object('tuple', s.ctid::text) order by s.id)
    from desmoslock_v2.student_sessions as s)
), (select state from test_snapshots where label = 'parent-predicates'),
  'parent predicate probes preserve every Test, audit event and placeholder child tuple');

select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values ('f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text, true)$$,
  'runtime Test lifecycle and pagination leave the canonical pinned fixture and health valid'
);

select * from finish();
rollback;
