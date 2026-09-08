begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

-- All identities below are synthetic provider-schema fixtures, not live GoTrue
-- sessions. NULL-seed runtime rows preserve the canonical release fixture.
-- RPCs call the genuine authorization helpers. The audit rejection below is
-- deterministic fault injection, not actual multi-connection lock coverage.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'membership-admin-1@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'membership-admin-2@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'membership-admin-3@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'membership-admin-4@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'membership-admin-5@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000006',
    'authenticated', 'authenticated', 'membership-admin-6@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000007',
    'authenticated', 'authenticated', 'membership-admin-7@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000008',
    'authenticated', 'authenticated', 'membership-admin-8@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000009',
    'authenticated', 'authenticated', 'membership-admin-9@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()),
  ('00000000-0000-0000-0000-000000000000', 'a3200000-0000-4000-8000-000000000010',
    'authenticated', 'authenticated', 'membership-admin-10@staff.invalid', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp());

insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at
) values
  ('b3200000-0000-4000-8000-000000000001', 'a3200000-0000-4000-8000-000000000001',
    'Synthetic membership factor 1', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000002', 'a3200000-0000-4000-8000-000000000002',
    'Synthetic membership factor 2', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000003', 'a3200000-0000-4000-8000-000000000003',
    'Synthetic membership factor 3', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000004', 'a3200000-0000-4000-8000-000000000004',
    'Synthetic membership factor 4', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000005', 'a3200000-0000-4000-8000-000000000005',
    'Synthetic membership factor 5', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000006', 'a3200000-0000-4000-8000-000000000006',
    'Synthetic membership factor 6', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000007', 'a3200000-0000-4000-8000-000000000007',
    'Synthetic membership factor 7', 'totp', 'verified', clock_timestamp(), clock_timestamp()),
  ('b3200000-0000-4000-8000-000000000010', 'a3200000-0000-4000-8000-000000000010',
    'Synthetic membership factor 10', 'totp', 'verified', clock_timestamp(), clock_timestamp());

insert into auth.sessions (
  id, user_id, created_at, updated_at, factor_id, aal, not_after
) values
  ('c3200000-0000-4000-8000-000000000001', 'a3200000-0000-4000-8000-000000000001',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000001', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000002', 'a3200000-0000-4000-8000-000000000002',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000002', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000003', 'a3200000-0000-4000-8000-000000000003',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000003', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000004', 'a3200000-0000-4000-8000-000000000004',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000004', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000005', 'a3200000-0000-4000-8000-000000000005',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000005', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000006', 'a3200000-0000-4000-8000-000000000006',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000006', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000007', 'a3200000-0000-4000-8000-000000000007',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000007', 'aal2',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000008', 'a3200000-0000-4000-8000-000000000008',
    clock_timestamp(), clock_timestamp(), null, 'aal1',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000009', 'a3200000-0000-4000-8000-000000000009',
    clock_timestamp(), clock_timestamp(), null, 'aal1',
    clock_timestamp() + interval '1 hour'),
  ('c3200000-0000-4000-8000-000000000010', 'a3200000-0000-4000-8000-000000000010',
    clock_timestamp(), clock_timestamp(), 'b3200000-0000-4000-8000-000000000010', 'aal2',
    clock_timestamp() + interval '1 hour');

insert into desmoslock_v2.workspaces (id, kind, slug, display_name, seed_key) values
  ('13000000-0000-4000-8000-000000000001', 'school', 'runtime-membership-alpha', 'Runtime Membership Alpha', null),
  ('13000000-0000-4000-8000-000000000002', 'school', 'runtime-membership-beta', 'Runtime Membership Beta', null);

insert into desmoslock_v2.profiles (id, display_name, auth_user_id, seed_key) values
  ('23000000-0000-4000-8000-000000000001', 'Runtime Membership Staff 1', 'a3200000-0000-4000-8000-000000000001', null),
  ('23000000-0000-4000-8000-000000000002', 'Runtime Membership Staff 2', 'a3200000-0000-4000-8000-000000000002', null),
  ('23000000-0000-4000-8000-000000000003', 'Runtime Membership Staff 3', 'a3200000-0000-4000-8000-000000000003', null),
  ('23000000-0000-4000-8000-000000000004', 'Runtime Membership Staff 4', 'a3200000-0000-4000-8000-000000000004', null),
  ('23000000-0000-4000-8000-000000000005', 'Runtime Membership Staff 5', 'a3200000-0000-4000-8000-000000000005', null),
  ('23000000-0000-4000-8000-000000000006', 'Runtime Membership Staff 6', 'a3200000-0000-4000-8000-000000000006', null),
  ('23000000-0000-4000-8000-000000000010', 'Runtime Membership Staff 10', 'a3200000-0000-4000-8000-000000000010', null);

insert into desmoslock_v2.memberships (workspace_id, profile_id, role, seed_key) values
  ('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 'owner', null),
  ('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000002', 'admin', null),
  ('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'teacher', null),
  ('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000005', 'admin', null),
  ('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000010', 'teacher', null),
  ('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000001', 'teacher', null),
  ('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000002', 'teacher', null),
  ('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000004', 'owner', null),
  ('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000006', 'teacher', null);

create function pg_temp.set_membership_admin_claims(
  actor_user_id uuid, actor_session_id uuid, actor_aal text, extra_claims jsonb default '{}'
) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (coalesce($4, '{}'::jsonb) || jsonb_build_object(
    'sub', $1, 'session_id', $2, 'role', 'authenticated', 'aal', $3,
    'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
  ))::text, true);
end;
$$;

create temporary table membership_admin_results (
  label text primary key, code text not null, invitation_id uuid
) on commit drop;
grant select, insert on pg_temp.membership_admin_results to authenticated, service_role;
create temporary table membership_admin_snapshots (
  label text primary key, state jsonb not null
) on commit drop;
create temporary table membership_admin_clocks (
  label text primary key, observed_at timestamp with time zone not null
) on commit drop;

-- Only the test owner invokes snapshots. Include physical tuple locations to
-- detect writes that leave the logical values unchanged, plus all scoped audits.
create function pg_temp.membership_admin_snapshot()
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object(
    'memberships', (select jsonb_agg(to_jsonb(m) || jsonb_build_object('tuple', m.ctid::text)
      order by m.workspace_id, m.profile_id) from desmoslock_v2.memberships as m
      where m.workspace_id in ('13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002')),
    'profiles', (select jsonb_agg(to_jsonb(p) || jsonb_build_object('tuple', p.ctid::text)
      order by p.id) from desmoslock_v2.profiles as p
      where p.auth_user_id::text like 'a3200000-%'),
    'invitations', (select jsonb_agg(to_jsonb(i) || jsonb_build_object('tuple', i.ctid::text)
      order by i.id) from desmoslock_v2.staff_invitations as i
      where i.workspace_id in ('13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002')),
    'audits', (select jsonb_agg(to_jsonb(e) order by e.id)
      from desmoslock_v2.staff_audit_events as e
      where e.workspace_id in ('13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002'))
  );
$$;

select ok(to_regprocedure('desmoslock_v2.revoke_membership(uuid,uuid)') is null,
  'the revision-free revocation overload is absent');
select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C"
    from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.revoke_membership(uuid,uuid,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'profile_id', 'expected_role_revision']::text[] collate "C")$$,
  'revocation exposes the exact required revision parameter without a default'
);
select results_eq(
  $$select p.pronargdefaults, p.proargnames[1:p.pronargs] collate "C"
    from pg_proc as p where p.oid = to_regprocedure('desmoslock_v2.change_membership_role(uuid,uuid,text,bigint)')$$,
  $$values (0::smallint, array['workspace_id', 'profile_id', 'role', 'expected_role_revision']::text[] collate "C")$$,
  'role change exposes exact required PostgREST parameters without defaults'
);
select ok(
  has_function_privilege('authenticated', 'desmoslock_v2.change_membership_role(uuid,uuid,text,bigint)', 'EXECUTE')
  and not has_function_privilege('anon', 'desmoslock_v2.change_membership_role(uuid,uuid,text,bigint)', 'EXECUTE')
  and not has_function_privilege('service_role', 'desmoslock_v2.change_membership_role(uuid,uuid,text,bigint)', 'EXECUTE'),
  'role changes are exposed only through authenticated staff authorization'
);

insert into membership_admin_snapshots values ('initial', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, profile_id, membership_role, role_revision
    from desmoslock_v2.current_manageable_staff() order by profile_id$$,
  $$values
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000002'::uuid, 'admin'::text, 1::bigint),
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000003'::uuid, 'teacher'::text, 1::bigint),
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000005'::uuid, 'admin'::text, 1::bigint),
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000010'::uuid, 'teacher'::text, 1::bigint)$$,
  'Owner in Alpha and Teacher in Beta sees only Alpha manageable staff with explicit revisions'
);
select throws_ok(
  $$select * from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003')$$,
  '42883', null, 'the old two-argument revocation cannot bypass target revision checking'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 'admin', 1)),
  'forbidden',
  'Owner cannot change its own role'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 1)),
  'forbidden',
  'Owner cannot revoke itself'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000004', 'admin', 1)),
  'forbidden',
  'a foreign Owner profile is not a manageable Alpha target'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000006', 1)),
  'forbidden',
  'a foreign Teacher profile is not a manageable Alpha target'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000006', 'admin', 1)),
  'forbidden',
  'Owner authority in Alpha does not authorize role changes in Beta'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000006', 1)),
  'forbidden',
  'Owner authority in Alpha does not authorize revocation in Beta'
);

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000002', 'cross-school-owner@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000090')),
  'forbidden',
  'Owner authority in Alpha does not authorize invitations in Beta'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, profile_id, membership_role, role_revision
    from desmoslock_v2.current_manageable_staff() order by profile_id$$,
  $$values
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000003'::uuid, 'teacher'::text, 1::bigint),
    ('13000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000010'::uuid, 'teacher'::text, 1::bigint)$$,
  'Administrator in Alpha and Teacher in Beta sees only Alpha Teachers with explicit revisions'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', 1)),
  'forbidden',
  'Administrator cannot change a Teacher role'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000005', 1)),
  'forbidden',
  'Administrator cannot revoke another Administrator'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000002', 1)),
  'forbidden',
  'Administrator cannot revoke itself'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 1)),
  'forbidden',
  'Administrator cannot revoke an Owner'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000006', 1)),
  'forbidden',
  'Administrator authority in Alpha does not authorize revocation in Beta'
);

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'admin-forbidden@staff.invalid', 'admin', 'd3200000-0000-4000-8000-000000000091')),
  'forbidden',
  'Administrator cannot issue Administrator invitations'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{"app_metadata":{"role":"owner","workspace_id":"13000000-0000-4000-8000-000000000002"},"user_metadata":{"role":"owner"}}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000006', 'admin', 1)),
  'forbidden',
  'forged Owner metadata does not elevate a real Beta Teacher membership'
);

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000002', 'cross-school-admin@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000092')),
  'forbidden',
  'forged Owner metadata does not grant a cross-School invitation'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000003', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000005', 'teacher', 1)),
  'forbidden',
  'a Teacher cannot change another staff role'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000005', 1)),
  'forbidden',
  'a Teacher cannot revoke staff'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000007', 'c3200000-0000-4000-8000-000000000007', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', 1)),
  'membership_inactive',
  'a confirmed uninvited identity cannot change staff roles'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 1)),
  'membership_inactive',
  'a confirmed uninvited identity cannot revoke staff'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'initial'),
  'authorization denials and the removed overload write no staff tuple, invitation, or audit'
);

-- Genuine AAL1 sessions stay insufficient even when JWT metadata claims AAL2.

update auth.sessions set aal = 'aal1', factor_id = null where id = 'c3200000-0000-4000-8000-000000000001';

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', 1)),
  'step_up_required',
  'Owner role changes require real provider-session AAL2'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 1)),
  'step_up_required',
  'Owner revocation requires real provider-session AAL2'
);

reset role;

update auth.sessions set aal = 'aal2', factor_id = 'b3200000-0000-4000-8000-000000000001' where id = 'c3200000-0000-4000-8000-000000000001';

update auth.sessions set aal = 'aal1', factor_id = null where id = 'c3200000-0000-4000-8000-000000000002';

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'aal1-admin@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000093')),
  'step_up_required',
  'Administrator invitations require real provider-session AAL2'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 1)),
  'step_up_required',
  'Administrator revocation requires real provider-session AAL2'
);

reset role;

update auth.sessions set aal = 'aal2', factor_id = 'b3200000-0000-4000-8000-000000000002' where id = 'c3200000-0000-4000-8000-000000000002';

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'initial'),
  'AAL1 attempts leave every domain tuple and audit unchanged'
);

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'teacher', 1)),
  'invalid_request',
  'same current role with the current revision is invalid'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'owner', 1)),
  'invalid_request',
  'an Owner role cannot be assigned through staff role change'
);

select results_eq(
  $$select revision.ordinal, result.code
    from (values (1, null::bigint), (2, 0::bigint), (3, -1::bigint),
      (4, 9007199254740992::bigint)) as revision(ordinal, expected)
    cross join lateral desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', revision.expected) as result order by revision.ordinal$$,
  $$values (1, 'invalid_request'::text), (2, 'invalid_request'::text),
    (3, 'invalid_request'::text), (4, 'invalid_request'::text)$$,
  'role change rejects absent, nonpositive, and unsafe-integer expected revisions'
);

select results_eq(
  $$select revision.ordinal, result.code
    from (values (1, null::bigint), (2, 0::bigint), (3, -1::bigint),
      (4, 9007199254740992::bigint)) as revision(ordinal, expected)
    cross join lateral desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', revision.expected) as result order by revision.ordinal$$,
  $$values (1, 'invalid_request'::text), (2, 'invalid_request'::text),
    (3, 'invalid_request'::text), (4, 'invalid_request'::text)$$,
  'revocation rejects absent, nonpositive, and unsafe-integer expected revisions'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'initial'),
  'invalid roles and revisions write no staff tuple or audit'
);

-- A matching expected revision at the safe-integer ceiling cannot be incremented.
savepoint membership_revision_ceiling;
update desmoslock_v2.memberships set role_revision = 9007199254740991
where workspace_id = '13000000-0000-4000-8000-000000000001'
  and profile_id = '23000000-0000-4000-8000-000000000003';
insert into membership_admin_snapshots values ('revision-ceiling', pg_temp.membership_admin_snapshot());
select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2');
set local role authenticated;
select is(
  (select code from desmoslock_v2.change_membership_role(
    '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003',
    'admin', 9007199254740991
  )), 'invalid_request', 'role change cannot increment a matching revision beyond the safe-integer ceiling'
);
select is(
  (select code from desmoslock_v2.revoke_membership(
    '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003',
    9007199254740991
  )), 'invalid_request', 'revocation cannot increment a matching revision beyond the safe-integer ceiling'
);
reset role;
select throws_ok(
  $$update desmoslock_v2.memberships set role_revision = 9007199254740992
    where workspace_id = '13000000-0000-4000-8000-000000000001'
      and profile_id = '23000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'the table also rejects an unsafe-integer role revision'
);
select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'revision-ceiling'),
  'overflow denials and the rejected direct write preserve the exact tuple and audit'
);
rollback to savepoint membership_revision_ceiling;
release savepoint membership_revision_ceiling;

-- Revocation records which live School role actually authorized the action.

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000010', 1)),
  'membership_revoked',
  'an AAL2 Administrator can revoke an Alpha Teacher at the expected revision'
);

reset role;

select results_eq(
  $$select m.status, m.role_revision, m.revocation_reason_code, m.revoked_by_profile_id,
      m.revoked_at = m.updated_at, e.event_type, e.result_code, e.actor_profile_id,
      e.subject_profile_id, e.session_id, e.invitation_id, e.previous_role, e.new_role,
      e.previous_role_revision, e.new_role_revision
    from desmoslock_v2.memberships as m join desmoslock_v2.staff_audit_events as e
      on e.workspace_id = m.workspace_id and e.subject_profile_id = m.profile_id
    where m.workspace_id = '13000000-0000-4000-8000-000000000001' and m.profile_id = '23000000-0000-4000-8000-000000000010'$$,
  $$values ('revoked'::text, 2::bigint, 'administrator_action'::text, '23000000-0000-4000-8000-000000000002'::uuid,
    true, 'membership_revoked'::text, 'membership_revoked'::text, '23000000-0000-4000-8000-000000000002'::uuid,
    '23000000-0000-4000-8000-000000000010'::uuid, 'c3200000-0000-4000-8000-000000000002'::uuid, null::uuid, null::text, null::text,
    null::bigint, null::bigint)$$,
  'Administrator revocation advances once with truthful attribution and no role-change payload'
);

insert into membership_admin_snapshots values ('revoked-teacher', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000010', 'admin', 2)),
  'forbidden',
  'role change does not resurrect a revoked Teacher'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000010', 2)),
  'forbidden',
  'an already revoked Teacher gets the same generic target denial'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'revoked-teacher'),
  'revoked-target denials preserve the target tuple and audit exactly'
);

insert into membership_admin_clocks values ('role-change-start', clock_timestamp());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', 1)),
  'membership_role_changed',
  'Owner promotes an active Teacher with the exact expected revision'
);

reset role;

select results_eq(
  $$select m.role, m.status, m.role_revision, m.revoked_at, m.revocation_reason_code,
      e.event_type, e.result_code, e.workspace_id, e.actor_profile_id, e.subject_profile_id,
      e.session_id, e.invitation_id, e.previous_role, e.new_role,
      e.previous_role_revision, e.new_role_revision, e.occurred_at = m.updated_at,
      m.updated_at >= (select observed_at from membership_admin_clocks where label = 'role-change-start')
    from desmoslock_v2.memberships as m join desmoslock_v2.staff_audit_events as e
      on e.workspace_id = m.workspace_id and e.subject_profile_id = m.profile_id
    where m.workspace_id = '13000000-0000-4000-8000-000000000001' and m.profile_id = '23000000-0000-4000-8000-000000000003'$$,
  $$values ('admin'::text, 'active'::text, 2::bigint, null::timestamptz, null::text,
    'membership_role_changed'::text, 'membership_role_changed'::text, '13000000-0000-4000-8000-000000000001'::uuid,
    '23000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-000000000003'::uuid, 'c3200000-0000-4000-8000-000000000001'::uuid, null::uuid,
    'teacher'::text, 'admin'::text, 1::bigint, 2::bigint, true, true)$$,
  'role change advances exactly once and writes one fully attributed typed audit at the mutation clock'
);

insert into membership_admin_snapshots values ('promoted-teacher', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'teacher', 1)),
  'membership_revision_conflict',
  'a role change with the pre-promotion revision fails closed'
);

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 1)),
  'membership_revision_conflict',
  'revocation with the pre-promotion revision fails closed'
);

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'admin', 2)),
  'invalid_request',
  'same-role retry at the fresh revision is invalid'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 2)),
  'forbidden',
  'Administrator cannot revoke a Teacher who has since become Administrator'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'promoted-teacher'),
  'stale and newly forbidden actions leave all tuples and audits byte-for-byte unchanged'
);

create function pg_temp.reject_membership_role_audit()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'membership_role_changed' then
    raise exception using errcode = '55000', message = 'synthetic role audit sink failure';
  end if;
  return new;
end;
$$;
create trigger reject_membership_role_audit
before insert on desmoslock_v2.staff_audit_events
for each row execute function pg_temp.reject_membership_role_audit();

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select throws_ok(
  $$select * from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'teacher', 2)$$,
  '55000', 'synthetic role audit sink failure',
  'an audit insertion failure aborts the entire role mutation'
);

reset role;

drop trigger reject_membership_role_audit on desmoslock_v2.staff_audit_events;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'promoted-teacher'),
  'a rejected audit rolls back the Membership tuple and all event writes'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, subject_profile_id, session_id, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('membership_role_changed', 'membership_role_changed', '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000001', 'admin', 'admin', 2, 3)$$,
  '23514', null, 'typed role audit rejects a same-role transition'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, subject_profile_id, session_id, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('membership_role_changed', 'membership_role_changed', '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000001', 'admin', 'teacher', 2, 4)$$,
  '23514', null, 'typed role audit rejects a skipped revision'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, subject_profile_id, session_id, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('membership_role_changed', 'membership_role_changed', '13000000-0000-4000-8000-000000000001', null, '23000000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000001', 'admin', 'teacher', 2, 3)$$,
  '23514', null, 'typed role audit requires an attributable actor'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, subject_profile_id, session_id, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('membership_role_changed', 'membership_revoked', '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000001', 'admin', 'teacher', 2, 3)$$,
  '23514', null, 'typed role audit requires the matching result code'
);

select throws_ok(
  $$insert into desmoslock_v2.staff_audit_events (event_type, result_code, workspace_id, actor_profile_id, subject_profile_id, session_id, previous_role, new_role, previous_role_revision, new_role_revision)
    values ('membership_revoked', 'membership_revoked', '13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000003', 'c3200000-0000-4000-8000-000000000001', 'admin', 'teacher', 2, 3)$$,
  '23514', null, 'other events cannot carry a role-change payload'
);

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'promoted-teacher'),
  'invalid typed audit payloads add no event or staff write'
);

-- Administrators must not discover or clean up hidden Administrator grants.

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

insert into pg_temp.membership_admin_results (label, code, invitation_id)
select 'hidden-admin', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'hidden-admin@staff.invalid', 'admin', 'd3200000-0000-4000-8000-000000000001') as result;

reset role;

select is((select code from membership_admin_results where label = 'hidden-admin'),
  'invitation_pending', 'Owner may create a durable Administrator grant');

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is_empty($$select * from desmoslock_v2.current_manageable_staff_invitations()$$,
  'Administrator projection hides a live Administrator invitation');

select is(
  (select code from desmoslock_v2.revoke_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'hidden-admin'))),
  'invitation_not_found',
  'Administrator cannot revoke a hidden Administrator grant'
);

reset role;

update desmoslock_v2.staff_invitations
set requested_at = clock_timestamp() - interval '6 minutes',
  delivery_lease_expires_at = clock_timestamp() - interval '1 minute'
where id = (select invitation_id from pg_temp.membership_admin_results where label = 'hidden-admin');

insert into membership_admin_snapshots values ('hidden-admin-expired', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'hidden-admin@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000002')),
  'conflict',
  'Administrator Teacher invitation conflicts with an expired hidden Administrator grant'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'hidden-admin-expired'),
  'conflict does not terminalize or audit the hidden expired Administrator grant'
);

-- Teacher grants are also revocable by the live School Administrator.
select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2');
set local role authenticated;
insert into pg_temp.membership_admin_results (label, code, invitation_id)
select 'admin-revocable', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '13000000-0000-4000-8000-000000000001', 'admin-revocable@staff.invalid',
  'teacher', 'd3200000-0000-4000-8000-000000000003'
) as result;
select is((select code from pg_temp.membership_admin_results where label = 'admin-revocable'),
  'invitation_pending', 'Administrator may begin a Teacher grant that remains revocable');
select is(
  (select code from desmoslock_v2.revoke_staff_invitation(
    (select invitation_id from pg_temp.membership_admin_results where label = 'admin-revocable')
  )),
  'invitation_revoked', 'Administrator may revoke a Teacher grant in its own School'
);
reset role;
select results_eq(
  $$select i.status, i.revision, i.revoked_by_profile_id, e.actor_profile_id, e.session_id
    from desmoslock_v2.staff_invitations as i join desmoslock_v2.staff_audit_events as e
      on e.invitation_id = i.id and e.event_type = 'invitation_revoked'
    where i.id = (select invitation_id from membership_admin_results where label = 'admin-revocable')$$,
  $$values ('revoked'::text, 2::bigint, '23000000-0000-4000-8000-000000000002'::uuid,
    '23000000-0000-4000-8000-000000000002'::uuid, 'c3200000-0000-4000-8000-000000000002'::uuid)$$,
  'Teacher invitation revocation advances once and records the actual Administrator actor'
);

-- The issuance decision is durable: later issuer authority loss blocks new
-- requests and authenticated replay while service delivery and acceptance finish.

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

insert into pg_temp.membership_admin_results (label, code, invitation_id)
select 'issuer-downgraded', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'membership-admin-8@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000008') as result;

insert into pg_temp.membership_admin_results (label, code, invitation_id)
select 'issuer-revoked', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'membership-admin-9@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000009') as result;

reset role;

select results_eq(
  $$select label, code from membership_admin_results
    where label in ('issuer-downgraded', 'issuer-revoked') order by label$$,
  $$values ('issuer-downgraded'::text, 'invitation_pending'::text),
    ('issuer-revoked'::text, 'invitation_pending'::text)$$,
  'an AAL2 Administrator may issue Teacher grants in its School'
);

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select results_eq(
  $$select school_id, invited_email, invited_role, invitation_status
    from desmoslock_v2.current_manageable_staff_invitations() order by invited_email$$,
  $$values ('13000000-0000-4000-8000-000000000001'::uuid, 'membership-admin-8@staff.invalid'::text, 'teacher'::text, 'pending_delivery'::text),
    ('13000000-0000-4000-8000-000000000001'::uuid, 'membership-admin-9@staff.invalid'::text, 'teacher'::text, 'pending_delivery'::text)$$,
  'Administrator invitation projection contains only live Teacher grants from its School'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.change_membership_role('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000002', 'teacher', 1)),
  'membership_role_changed',
  'Owner may downgrade an Administrator after its Teacher grants begin'
);

reset role;

insert into membership_admin_snapshots values ('issuer-downgraded', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'downgraded-new@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000094')),
  'forbidden',
  'downgraded issuer cannot mint a new invitation'
);

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'membership-admin-8@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000008')),
  'forbidden',
  'downgraded issuer cannot replay a previously authorized begin request'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'issuer-downgraded'),
  'downgraded issuer new and replay attempts do not alter durable grants'
);

set local role service_role;

select is(
  (select code from desmoslock_v2.internal_prepare_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-downgraded'), 'a3200000-0000-4000-8000-000000000008', clock_timestamp() + interval '1 hour')),
  'invitation_delivery_ready',
  'service can prepare the durable Teacher grant after issuer downgrade'
);

select is(
  (select code from desmoslock_v2.internal_publish_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-downgraded'))),
  'invitation_usable',
  'service can acknowledge delivery after issuer downgrade'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000008', 'c3200000-0000-4000-8000-000000000008', 'aal1', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.accept_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-downgraded'), 'Durable Downgrade Recipient')),
  'invitation_accepted',
  'the verified recipient can accept the grant after issuer downgrade'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000001', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.revoke_membership('13000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000002', 2)),
  'membership_revoked',
  'Owner can revoke the former Administrator at its new Teacher revision'
);

reset role;

select results_eq(
  $$select role, status, role_revision, revocation_reason_code
    from desmoslock_v2.memberships where workspace_id = '13000000-0000-4000-8000-000000000001' and profile_id = '23000000-0000-4000-8000-000000000002'$$,
  $$values ('teacher'::text, 'revoked'::text, 3::bigint, 'owner_action'::text)$$,
  'Owner revocation records its actual authority after the Administrator downgrade'
);

insert into membership_admin_snapshots values ('issuer-revoked', pg_temp.membership_admin_snapshot());

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'aal2', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'revoked-new@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000095')),
  'membership_inactive',
  'revoked issuer cannot mint a new invitation in that School'
);

select is(
  (select code from desmoslock_v2.begin_staff_invitation('13000000-0000-4000-8000-000000000001', 'membership-admin-9@staff.invalid', 'teacher', 'd3200000-0000-4000-8000-000000000009')),
  'membership_inactive',
  'revoked issuer cannot replay its old authenticated begin request'
);

reset role;

select is(pg_temp.membership_admin_snapshot(),
  (select state from membership_admin_snapshots where label = 'issuer-revoked'),
  'revoked issuer new and replay attempts leave the remaining durable grant unchanged'
);

set local role service_role;

select is(
  (select code from desmoslock_v2.internal_prepare_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-revoked'), 'a3200000-0000-4000-8000-000000000009', clock_timestamp() + interval '1 hour')),
  'invitation_delivery_ready',
  'service can prepare the durable Teacher grant after issuer revocation'
);

select is(
  (select code from desmoslock_v2.internal_publish_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-revoked'))),
  'invitation_usable',
  'service can acknowledge delivery after issuer revocation'
);

reset role;

select pg_temp.set_membership_admin_claims('a3200000-0000-4000-8000-000000000009', 'c3200000-0000-4000-8000-000000000009', 'aal1', '{}'::jsonb);
set local role authenticated;

select is(
  (select code from desmoslock_v2.accept_staff_invitation((select invitation_id from pg_temp.membership_admin_results where label = 'issuer-revoked'), 'Durable Revocation Recipient')),
  'invitation_accepted',
  'the verified recipient can accept the grant after issuer revocation'
);

reset role;

select results_eq(
  $$select p.auth_user_id, m.workspace_id, m.role, m.status, m.role_revision,
      i.status, i.requested_by_profile_id
    from desmoslock_v2.profiles as p join desmoslock_v2.memberships as m on m.profile_id = p.id
    join desmoslock_v2.staff_invitations as i on i.accepted_profile_id = p.id
    where p.auth_user_id in ('a3200000-0000-4000-8000-000000000008', 'a3200000-0000-4000-8000-000000000009') order by p.auth_user_id$$,
  $$values
    ('a3200000-0000-4000-8000-000000000008'::uuid, '13000000-0000-4000-8000-000000000001'::uuid, 'teacher'::text, 'active'::text, 1::bigint, 'accepted'::text, '23000000-0000-4000-8000-000000000002'::uuid),
    ('a3200000-0000-4000-8000-000000000009'::uuid, '13000000-0000-4000-8000-000000000001'::uuid, 'teacher'::text, 'active'::text, 1::bigint, 'accepted'::text, '23000000-0000-4000-8000-000000000002'::uuid)$$,
  'both durable grants produce only their original Teacher memberships despite later issuer authority loss'
);
select results_eq(
  $$select profile_id, role, status, role_revision from desmoslock_v2.memberships
    where workspace_id = '13000000-0000-4000-8000-000000000002' and profile_id in ('23000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000002') order by profile_id$$,
  $$values ('23000000-0000-4000-8000-000000000001'::uuid, 'teacher'::text, 'active'::text, 1::bigint),
    ('23000000-0000-4000-8000-000000000002'::uuid, 'teacher'::text, 'active'::text, 1::bigint)$$,
  'Alpha role and revocation mutations leave both same-identity Beta memberships unchanged'
);
select results_eq(
  $$select fixture_digest, fixture_valid from desmoslock_v2.internal_baseline_status()$$,
  $$values ('f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text, true)$$,
  'membership administration preserves the pinned canonical seed fixture'
);

select * from finish();
rollback;
