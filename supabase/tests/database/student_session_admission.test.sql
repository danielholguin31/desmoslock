begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

-- Transaction-local identities exercise production SQL authorization. They are
-- not provider/Ed25519 acceptance; real signatures and observed two-connection
-- lock waits belong to the separate Edge/provider integration gate.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000',
  ('a5300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'student-staff-' || i || '@staff.invalid', '', clock_timestamp(),
  '{"provider":"email","providers":["email"]}', '{}', clock_timestamp(), clock_timestamp()
from generate_series(1, 3) as fixture(i);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('b5300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000001',
  'Synthetic Student staff factor', 'totp', 'verified', clock_timestamp(), clock_timestamp());
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal, not_after)
select ('c5300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  ('a5300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, clock_timestamp(), clock_timestamp(),
  case when i = 1 then 'b5300000-0000-4000-8000-000000000001'::uuid else null end,
  case when i = 1 then 'aal2'::auth.aal_level else 'aal1'::auth.aal_level end,
  clock_timestamp() + interval '1 hour' from generate_series(1, 3) as fixture(i);
insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key) values
  ('16000000-0000-4000-8000-000000000001', 'school', 'student-runtime-alpha', 'Student Alpha', null),
  ('16000000-0000-4000-8000-000000000002', 'school', 'student-runtime-beta', 'Student Beta', null);
insert into desmoslock_v2.profiles (id, display_name, auth_user_id, seed_key)
select ('26000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'Student Staff ' || i,
  ('a5300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, null from generate_series(1, 3) as fixture(i);
insert into desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key) values
  ('16000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', 'owner', null),
  ('16000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000002', 'teacher', null),
  ('16000000-0000-4000-8000-000000000002', '26000000-0000-4000-8000-000000000003', 'teacher', null);
insert into desmoslock_v2.tests
  (id, workspace_id, created_by_profile_id, title, seed_key, lifecycle, revision, created_at, opened_at)
values ('36000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000002', 'Admission Algebra', null, 'open', 2,
  clock_timestamp() - interval '1 minute', clock_timestamp());

create function pg_temp.student_claims(actor integer, assurance text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'a5300000-0000-4000-8000-' || lpad($1::text, 12, '0'),
    'session_id', 'c5300000-0000-4000-8000-' || lpad($1::text, 12, '0'),
    'role', 'authenticated', 'aal', $2,
    'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint)::text, true);
end;
$$;
create temporary table student_results (label text primary key, result jsonb not null);
create function pg_temp.student_snapshot() returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object(
    'sessions', (select jsonb_agg(to_jsonb(s) || jsonb_build_object('tuple', s.ctid::text) order by s.id) from desmoslock_v2.student_sessions as s),
    'materials', (select jsonb_agg(to_jsonb(m) || jsonb_build_object('tuple', m.ctid::text) order by m.issuance_request_id) from desmoslock_v2.student_join_materials as m),
    'bindings', (select jsonb_agg(to_jsonb(b) || jsonb_build_object('tuple', b.ctid::text) order by b.test_id, b.device_session_id) from desmoslock_v2.student_device_bindings as b),
    'audit', (select jsonb_agg(to_jsonb(e) || jsonb_build_object('tuple', e.ctid::text) order by e.id) from desmoslock_v2.staff_audit_events as e)
  );
$$;
create function pg_temp.student_join(mode text, request uuid, device uuid, key text, material text, cap text, reconnect text)
returns desmoslock_v2.student_admission_row language plpgsql as $$
declare proof record; result desmoslock_v2.student_admission_row; operation text;
begin
  operation := desmoslock_v2.internal_student_operation_digest(jsonb_build_array('join', $1, $2, $3, $5, $6, $7));
  select * into proof from desmoslock_v2.create_student_bootstrap_challenge($2, $3, $4,
    desmoslock_v2.internal_student_key_thumbprint($4), operation);
  select * into result from desmoslock_v2.commit_student_session_join($1, $2, $3, $4,
    desmoslock_v2.internal_student_key_thumbprint($4), $5, $6, $7, operation, proof.challenge_id, proof.expires_at_ms);
  return result;
end;
$$;
create function pg_temp.student_read(session uuid, device uuid, admission_epoch bigint, cap text, key text, counter bigint)
returns desmoslock_v2.student_current_row language plpgsql as $$
declare request uuid := gen_random_uuid(); result desmoslock_v2.student_current_row; operation text;
begin
  operation := desmoslock_v2.internal_student_operation_digest(jsonb_build_array('read', request,
    jsonb_build_array('16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', $1, $2, $3), $4));
  select * into result from desmoslock_v2.commit_student_session_read('16000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001', $1, $2, $3, request, operation, $4, $5, $6);
  return result;
end;
$$;

select is(desmoslock_v2.internal_student_operation_digest(jsonb_build_array('join', 'initial',
  '56000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
  repeat('1', 64), repeat('2', 64), repeat('3', 64))),
  '3a11a67220c88877cf832f0905cda50c077563a884e33d9f9265420dcf3bce76', 'SQL operation digest matches independent canonical UTF-8 join vector');

select is((select count(*) from desmoslock_v2.student_sessions where seed_key is not null and state = 'created'
  and synthetic_display_name is null and created_at = '2000-01-01T00:00:00.000000Z' and epoch = 1 and revision = 1
  and device_session_id is null and device_public_key is null and last_accepted_proof_counter = 0
  and cardinality(maintenance_accepted_at) = 0 and capability_digest is null and capability_issued_at is null
  and capability_expires_at is null and reconnect_digest is null and reconnect_expires_at is null
  and join_request_id is null and join_operation_digest is null and join_admission_mode is null and join_material_digest is null
  and rotation_request_id is null and rotation_operation_digest is null and previous_reconnect_digest is null),
  2::bigint, 'both pristine Student fixtures retain every exact non-authority field');
select is((select count(*) from desmoslock_v2.student_join_materials), 0::bigint, 'join authority starts empty');
select is((select count(*) from desmoslock_v2.student_device_bindings), 0::bigint, 'permanent bindings start empty');
select is((select count(*) from desmoslock_v2.student_bootstrap_challenges), 0::bigint, 'bootstrap challenges start empty');
select is((select count(*) from desmoslock_v2.student_bootstrap_limits), 0::bigint, 'lazy bootstrap allowance starts empty');
select ok(not has_table_privilege('service_role', 'desmoslock_v2.student_sessions', 'SELECT'), 'service role cannot bypass admission RPCs');
select ok(not has_function_privilege('authenticated', 'desmoslock_v2.commit_student_session_read(uuid,uuid,uuid,uuid,bigint,uuid,text,text,text,bigint)', 'EXECUTE'), 'staff JWT cannot invoke private credential commit');
select ok(has_function_privilege('service_role', 'desmoslock_v2.commit_student_session_read(uuid,uuid,uuid,uuid,bigint,uuid,text,text,text,bigint)', 'EXECUTE'), 'only backend service role can invoke credential commit');
select ok(not has_function_privilege('service_role', 'desmoslock_v2.issue_test_join_code(uuid,uuid,bigint,uuid,text)', 'EXECUTE'), 'service role cannot impersonate live staff issuance');

select pg_temp.student_claims(3, 'aal1');
select is((select code from desmoslock_v2.issue_test_join_code('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 2, '46000000-0000-4000-8000-000000000001', repeat('1', 64))),
  'membership_inactive', 'foreign-School Teacher cannot issue material');
select pg_temp.student_claims(1, 'aal1');
select isnt((select code from desmoslock_v2.issue_test_join_code('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 2, '46000000-0000-4000-8000-000000000001', repeat('1', 64))),
  'join_code_issued', 'Owner lacks live AAL2 at lower-assurance request');
select pg_temp.student_claims(2, 'aal1');
insert into student_results select 'code', to_jsonb(r) from desmoslock_v2.issue_test_join_code(
  '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', 2,
  '46000000-0000-4000-8000-000000000001', repeat('1', 64)) as r;
select is((select result->>'code' from student_results where label = 'code'), 'join_code_issued', 'colleague Teacher AAL1 issues open-Test code');
select is((select revision from desmoslock_v2.tests where id = '36000000-0000-4000-8000-000000000001'), 3::bigint, 'code issuance advances Test revision once');
select is((select count(*) from desmoslock_v2.staff_audit_events where event_type = 'join_code_issued'), 1::bigint, 'code issue has one typed audit');
select is((select code from desmoslock_v2.update_test_title('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 'Changed title', 3)), 'test_title_updated', 'ordinary title flow remains valid');
select is((select expires_at from desmoslock_v2.issue_test_join_code('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 2, '46000000-0000-4000-8000-000000000001', repeat('1', 64))),
  (select result->>'expires_at' from student_results where label = 'code'), 'exact code retry keeps original expiry after later title edit');
select is((select revision from desmoslock_v2.tests where id = '36000000-0000-4000-8000-000000000001'), 4::bigint, 'code retry does not undo newer title revision');
select is((select code from desmoslock_v2.issue_test_join_code('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 2, '46000000-0000-4000-8000-000000000001', repeat('2', 64))),
  'test_revision_conflict', 'same issuance request with changed commitment conflicts');

insert into student_results select 'before-wrong-mode', pg_temp.student_snapshot();
select is((pg_temp.student_join('readmission', '56000000-0000-4000-8000-000000000002',
  '66000000-0000-4000-8000-000000000002', repeat('A', 43), repeat('1', 64), repeat('2', 64), repeat('3', 64))).code,
  'student_session_denied', 'targeted mode cannot claim reusable public material');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'before-wrong-mode'), 'mode denial changes no domain rows or audit');
insert into student_results select 'joined', to_jsonb(pg_temp.student_join('initial',
  '56000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', repeat('A', 43),
  repeat('1', 64), repeat('2', 64), repeat('3', 64)));
select is((select result->>'code' from student_results where label = 'joined'), 'ok', 'initial admission creates a server identity');
select is((select count(*) from desmoslock_v2.student_sessions where state = 'active'), 1::bigint, 'initial admission creates exactly one active row');
select is((select count(*) from desmoslock_v2.student_device_bindings), 1::bigint, 'initial admission permanently binds its device');
select is((select last_accepted_proof_counter from desmoslock_v2.student_sessions where state = 'active'), 0::bigint, 'bootstrap does not consume admitted counter');
select is((select cardinality(maintenance_accepted_at) from desmoslock_v2.student_sessions where state = 'active'), 0, 'bootstrap does not allocate admitted allowance');
insert into student_results select 'joined-retry', to_jsonb(pg_temp.student_join('initial',
  '56000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', repeat('A', 43),
  repeat('1', 64), repeat('2', 64), repeat('3', 64)));
select is((select result - 'server_now_ms' from student_results where label = 'joined-retry'),
  (select result - 'server_now_ms' from student_results where label = 'joined'), 'exact first-join recovery retains all issuance facts and original expiry');
select is((select count(*) from desmoslock_v2.staff_audit_events where event_type = 'student_session_admitted'), 1::bigint, 'exact join retry has no duplicate domain event');
select is((select code from desmoslock_v2.read_student_maintenance_key('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  '66000000-0000-4000-8000-000000000001', 1, 'reconnect', '76000000-0000-4000-8000-000000000009',
  repeat('a', 64), repeat('b', 64))), 'student_session_denied', 'wrong reconnect grant before first rotation is denied despite NULL receipt fields');


select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  '66000000-0000-4000-8000-000000000001', 1, repeat('2', 64), repeat('A', 43), 1)).code, 'ok', 'own read accepts first signed counter');
insert into student_results select 'after-read', pg_temp.student_snapshot();
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  '66000000-0000-4000-8000-000000000001', 1, repeat('2', 64), repeat('A', 43), 1)).code, 'student_session_denied', 'same counter replay is denied');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'after-read'), 'counter replay changes neither tuple, quota, state nor audit');
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  '66000000-0000-4000-8000-000000000001', 1, repeat('2', 64), repeat('B', 42) || 'A', 20)).code, 'student_session_denied', 'previously verified wrong key cannot advance current authority');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'after-read'), 'wrong-key commit spends no victim allowance');
select is((select revision from desmoslock_v2.student_sessions where state = 'active'), 1::bigint, 'protected reads do not advance session revision');

-- Reconnect and receipt recovery both use fresh counters; only rotation emits audit.
create function pg_temp.student_reconnect(counter bigint, cap text default repeat('4', 64))
returns desmoslock_v2.student_admission_row language plpgsql as $$
declare id uuid; operation text; result desmoslock_v2.student_admission_row;
begin
  select (r.result->>'student_session_id')::uuid into id from student_results as r where label = 'joined';
  operation := desmoslock_v2.internal_student_operation_digest(jsonb_build_array('reconnect',
    '76000000-0000-4000-8000-000000000001', jsonb_build_array('16000000-0000-4000-8000-000000000001',
      '36000000-0000-4000-8000-000000000001', id, '66000000-0000-4000-8000-000000000001', 1), 1, repeat('3', 64), $2, repeat('5', 64)));
  select * into result from desmoslock_v2.commit_student_session_reconnect('16000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001', id, '66000000-0000-4000-8000-000000000001', 1,
    '76000000-0000-4000-8000-000000000001', operation, 1, repeat('3', 64), $2, repeat('5', 64), repeat('A', 43), $1);
  return result;
end;
$$;
insert into student_results select 'rotated', to_jsonb(pg_temp.student_reconnect(3));
select is((select result->>'code' from student_results where label = 'rotated'), 'ok', 'reconnect accepts a counter gap and rotates candidates');
insert into student_results select 'rotation-retry', to_jsonb(pg_temp.student_reconnect(4));
select is((select result - 'server_now_ms' - 'accepted_proof_counter' from student_results where label = 'rotation-retry'),
  (select result - 'server_now_ms' - 'accepted_proof_counter' from student_results where label = 'rotated'), 'exact consumed-grant retry returns original revision and expiry');
select is((select count(*) from desmoslock_v2.staff_audit_events where event_type = 'student_session_reconnected'), 1::bigint, 'reconnect receipt creates no duplicate event');
insert into student_results select 'after-rotation', pg_temp.student_snapshot();
select is((pg_temp.student_reconnect(5, repeat('6', 64))).code, 'student_session_denied', 'receipt cannot substitute successor candidate');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'after-rotation'), 'receipt mismatch preserves full state');
select is((pg_temp.student_join('initial', '56000000-0000-4000-8000-000000000001',
  '66000000-0000-4000-8000-000000000001', repeat('A', 43), repeat('1', 64), repeat('2', 64), repeat('3', 64))).code,
  'student_session_denied', 'rotation defeats old join receipt recovery');

select is((select code from desmoslock_v2.prepare_student_readmission('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  2, '86000000-0000-4000-8000-000000000001', repeat('6', 64))), 'student_session_transition_rejected', 'active live reconnect authority requires explicit removal before prepare');
select is((select code from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'), 2)),
  'student_session_removed', 'staff removes admitted session');
select is((select epoch from desmoslock_v2.student_sessions where state = 'removed'), 2::bigint, 'removal advances epoch exactly once');
select is((select code from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'), 2)),
  'student_session_revision_conflict', 'stale removal is rejected before already-removed no-op');
select is((select code from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'), 3)),
  'student_session_already_removed', 'matching-revision removal is a no-op');
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  '66000000-0000-4000-8000-000000000001', 1, repeat('4', 64), repeat('A', 43), 99)).code, 'student_session_denied', 'removed epoch rejects an unseen high counter');
insert into student_results select 'prepared', to_jsonb(r) from desmoslock_v2.prepare_student_readmission(
  '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001',
  (select (result->>'student_session_id')::uuid from student_results where label = 'joined'), 3,
  '86000000-0000-4000-8000-000000000001', repeat('6', 64)) as r;
select is((select result->>'code' from student_results where label = 'prepared'), 'student_readmission_prepared', 'removed identity receives targeted material');
select is((select expires_at from desmoslock_v2.prepare_student_readmission('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'joined'),
  3, '86000000-0000-4000-8000-000000000001', repeat('6', 64))),
  (select result->>'expires_at' from student_results where label = 'prepared'), 'exact prepare retry retains original targeted expiry');
insert into student_results select 'claimed', to_jsonb(pg_temp.student_join('readmission',
  '56000000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000003', repeat('C', 42) || 'A',
  repeat('6', 64), repeat('7', 64), repeat('8', 64)));
select is((select result->>'code' from student_results where label = 'claimed'), 'ok', 'new device claims targeted material');
select is((select result->>'student_session_id' from student_results where label = 'claimed'),
  (select result->>'student_session_id' from student_results where label = 'joined'), 'targeted claim preserves canonical Student identity');
select is((select result->>'synthetic_display_name' from student_results where label = 'claimed'),
  (select result->>'synthetic_display_name' from student_results where label = 'joined'), 'targeted claim preserves synthetic display');
select is((select epoch from desmoslock_v2.student_sessions where state = 'active'), 3::bigint, 'claim preserves prepared epoch');
select is((select revision from desmoslock_v2.student_sessions where state = 'active'), 5::bigint, 'remove, prepare, claim each advance revision once');
select is((select count(*) from desmoslock_v2.student_device_bindings), 2::bigint, 'old device mapping survives rebind');
select is((pg_temp.student_join('initial', '56000000-0000-4000-8000-000000000004',
  '66000000-0000-4000-8000-000000000001', repeat('A', 43), repeat('1', 64), repeat('9', 64), repeat('a', 64))).code,
  'student_session_denied', 'permanent old binding cannot bootstrap a second identity');

-- An audit dependency error must escape as unavailable and roll back every
-- session/epoch/authority/proof effect; it is not an intentional public denial.
create function pg_temp.fail_student_audit() returns trigger language plpgsql as $$
begin
  if new.event_type = 'student_session_removed' then raise exception 'synthetic student audit failure'; end if;
  return new;
end;
$$;
create trigger synthetic_student_audit_failure before insert on desmoslock_v2.staff_audit_events
  for each row execute function pg_temp.fail_student_audit();
insert into student_results select 'before-audit-failure', pg_temp.student_snapshot();
select throws_ok($$select * from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', (select (result->>'student_session_id')::uuid from student_results where label = 'claimed'), 5)$$,
  'P0001', 'synthetic student audit failure', 'audit failure propagates instead of becoming a denial');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'before-audit-failure'),
  'audit failure rolls back full session, binding, material, proof and audit tuples');
drop trigger synthetic_student_audit_failure on desmoslock_v2.staff_audit_events;

-- A synthetic inactive maximum fixture has no authority and no binding.
insert into desmoslock_v2.student_sessions
  (id, workspace_id, test_id, state, seed_key, synthetic_display_name, created_at, epoch, revision)
values ('96000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 'removed', null, 'Student MAXIMUM', clock_timestamp(),
  9007199254740991, 9007199254740991);
insert into student_results select 'before-max', pg_temp.student_snapshot();
select is((select code from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001', 9007199254740991)),
  'student_session_already_removed', 'matching no-op remains possible at maximum revision/epoch');
select is((select code from desmoslock_v2.remove_student_session('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001', 9007199254740990)),
  'student_session_revision_conflict', 'stale maximum no-op is rejected');
select is((select code from desmoslock_v2.prepare_student_readmission('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001', 9007199254740991,
  '86000000-0000-4000-8000-000000000009', repeat('d', 64))), 'invalid_request', 'prepare cannot overflow safe revision or epoch');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'before-max'), 'maximum no-op/stale/overflow commands leave every tuple unchanged');

-- A separate disposable device exercises forfeit without spending the main
-- readmission fixture's maintenance allowance.
insert into student_results select 'forfeit-fixture', to_jsonb(pg_temp.student_join('initial',
  '56000000-0000-4000-8000-000000000008', '66000000-0000-4000-8000-000000000008', repeat('G', 42) || 'A',
  repeat('1', 64), repeat('b', 64), repeat('c', 64)));
select is((select result->>'code' from student_results where label = 'forfeit-fixture'), 'ok', 'forfeit fixture is admitted through the real join RPC');
create function pg_temp.student_forfeit() returns desmoslock_v2.student_forfeit_row language plpgsql as $$
declare id uuid; operation text; result desmoslock_v2.student_forfeit_row;
begin
  select (r.result->>'student_session_id')::uuid into id from student_results as r where label = 'forfeit-fixture';
  operation := desmoslock_v2.internal_student_operation_digest(jsonb_build_array('forfeit',
    '76000000-0000-4000-8000-000000000008', jsonb_build_array('16000000-0000-4000-8000-000000000001',
      '36000000-0000-4000-8000-000000000001', id, '66000000-0000-4000-8000-000000000008', 1), 1, repeat('b', 64)));
  select * into result from desmoslock_v2.commit_student_session_forfeit('16000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001', id, '66000000-0000-4000-8000-000000000008', 1,
    '76000000-0000-4000-8000-000000000008', operation, 1, repeat('b', 64), repeat('G', 42) || 'A', 1);
  return result;
end;
$$;
select is((pg_temp.student_forfeit()).code, 'ok', 'forfeit acknowledges the atomic backend transition');
select results_eq($$select state, revision, epoch, last_accepted_proof_counter, cardinality(maintenance_accepted_at),
  capability_digest, reconnect_digest, device_session_id from desmoslock_v2.student_sessions
  where id = (select (result->>'student_session_id')::uuid from student_results where label = 'forfeit-fixture')$$,
  $$values ('forfeited'::text, 2::bigint, 2::bigint, 0::bigint, 0, null::text, null::text, null::uuid)$$,
  'forfeit advances revision/epoch once and clears all current maintenance authority');
select is((pg_temp.student_forfeit()).code, 'student_session_denied', 'lost forfeit acknowledgment cannot be fabricated from a retry denial');
select is((select count(*) from desmoslock_v2.staff_audit_events where event_type = 'student_session_forfeited'),
  1::bigint, 'forfeit retry has no duplicate domain event');

-- Twelve accepted invocations per rolling minute; replay and rate denial do not mutate.
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'claimed'),
  '66000000-0000-4000-8000-000000000003', 3, repeat('7', 64), repeat('C', 42) || 'A', i)).code,
  'ok', 'fresh counter within twelve accepted calls: ' || i)
from generate_series(1, 12) as counter(i);
insert into student_results select 'at-limit', pg_temp.student_snapshot();
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'claimed'),
  '66000000-0000-4000-8000-000000000003', 3, repeat('7', 64), repeat('C', 42) || 'A', 13)).code,
  'student_session_denied', 'thirteenth invocation cannot advance counter');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'at-limit'), 'rate denial preserves full domain/proof state');
select is(desmoslock_v2.internal_student_next_allowance(array['2026-09-08T00:00:00Z'::timestamptz],
  '2026-09-08T00:01:00Z'::timestamptz), array['2026-09-08T00:01:00Z'::timestamptz], 'rolling allowance prunes exactly sixty-second-old entries');

-- Bootstrap key churn has its own committed allocator and cannot touch
-- the already-full admitted-device counter/window.
select is((select code from desmoslock_v2.create_student_bootstrap_challenge(('aa600000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, gen_random_uuid(),
  repeat('H', 42) || 'A', desmoslock_v2.internal_student_key_thumbprint(repeat('H', 42) || 'A'), repeat('e', 64))),
  'ok', 'bounded bootstrap challenge slot ' || i) from generate_series(1, 4) as slot(i);
select is((select code from desmoslock_v2.create_student_bootstrap_challenge(gen_random_uuid(), gen_random_uuid(),
  repeat('H', 42) || 'A', desmoslock_v2.internal_student_key_thumbprint(repeat('H', 42) || 'A'), repeat('e', 64))),
  'student_session_denied', 'fifth live challenge for a key is denied');
select is((select count(*) from desmoslock_v2.student_bootstrap_challenges
  where key_thumbprint = desmoslock_v2.internal_student_key_thumbprint(repeat('H', 42) || 'A')),
  4::bigint, 'challenge denial does not allocate a fifth record');
select is(charged.code, 'ok', 'separate key bootstrap debit ' || i)
from generate_series(1, 12) as debit(i) cross join lateral
  desmoslock_v2.charge_student_join_attempt(repeat('J', 42) || 'A' || left(i::text, 0)) as charged;
select is((select code from desmoslock_v2.charge_student_join_attempt(repeat('J', 42) || 'A')),
  'student_session_denied', 'thirteenth bootstrap attempt for one key is denied');
select is(pg_temp.student_snapshot(), (select result from student_results where label = 'at-limit'),
  'bootstrap challenge/debit traffic leaves admitted quota and domain state unchanged');

select is((select code from desmoslock_v2.end_test('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', 4)), 'test_ended', 'parent end remains a Test-only transition');
select is((select state from desmoslock_v2.current_test_student_sessions('16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001', null, null) where session_id = (select (result->>'student_session_id')::uuid from student_results where label = 'claimed')), 'active', 'staff Student projection retains persisted state; parent projection supplies ended label');
select is((select state from desmoslock_v2.student_sessions where id = (select (result->>'student_session_id')::uuid from student_results where label = 'claimed')), 'active', 'end does not rewrite child state or epochs');
select is((pg_temp.student_read((select (result->>'student_session_id')::uuid from student_results where label = 'claimed'),
  '66000000-0000-4000-8000-000000000003', 3, repeat('7', 64), repeat('C', 42) || 'A', 100)).code,
  'student_session_denied', 'closed parent defeats otherwise current device authority');
select is((select count(*) from desmoslock_v2.student_sessions where state <> 'created' and id <> '96000000-0000-4000-8000-000000000001'), 2::bigint, 'all retries preserve one recovered identity plus the separate forfeited fixture');

select * from finish();
rollback;
