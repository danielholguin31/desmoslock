begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(238);

select has_column(
  'desmoslock_v2',
  'profiles',
  'auth_user_id',
  'a staff profile can be bound to exactly one Auth identity'
);
select has_column(
  'desmoslock_v2',
  'memberships',
  'status',
  'School memberships have an explicit lifecycle state'
);
select has_column(
  'desmoslock_v2',
  'memberships',
  'role_revision',
  'School memberships carry a live role revision'
);
select has_table(
  'desmoslock_v2',
  'staff_invitations',
  'controlled staff invitations exist'
);
select has_column(
  'desmoslock_v2',
  'staff_invitations',
  'request_key',
  'invitation orchestration has a durable server-generated idempotency key'
);
select has_column(
  'desmoslock_v2',
  'staff_invitations',
  'delivery_lease_expires_at',
  'pending delivery attempts have a bounded database-owned lease'
);
select has_table(
  'desmoslock_v2',
  'application_session_revocations',
  'application session revocations exist independently of Auth sessions'
);
select has_table(
  'desmoslock_v2',
  'staff_audit_events',
  'a minimized staff authentication audit exists'
);
select has_table(
  'desmoslock_v2',
  'staff_password_recovery_operations',
  'password recovery has a durable caller-and-provider-session-bound operation'
);
select has_table(
  'desmoslock_v2',
  'application_session_revocation_cutoffs',
  'completed recovery has an account-wide session-creation cutoff'
);

select ok(
  (
    select bool_and(class.relrowsecurity)
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'desmoslock_v2'
      and class.relname in (
        'staff_invitations',
        'application_session_revocations',
        'staff_audit_events',
        'staff_password_recovery_operations',
        'application_session_revocation_cutoffs'
      )
  ),
  'every staff lifecycle table enables RLS'
);
select is(
  (
    select count(*)::bigint
    from pg_policy as policy
    join pg_class as class on class.oid = policy.polrelid
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'desmoslock_v2'
      and class.relname in (
        'staff_invitations',
        'application_session_revocations',
        'staff_audit_events',
        'staff_password_recovery_operations',
        'application_session_revocation_cutoffs'
      )
  ),
  0::bigint,
  'staff lifecycle tables have no direct allow policy'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'staff_invitations',
      'application_session_revocations',
      'staff_audit_events',
      'staff_password_recovery_operations',
      'application_session_revocation_cutoffs'
    ]) as lifecycle_table(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as checked_privilege(privilege_name)
    where has_table_privilege(
      'authenticated',
      'desmoslock_v2.' || lifecycle_table.table_name,
      checked_privilege.privilege_name
    )
  ),
  'authenticated has no direct lifecycle table privileges'
);

select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.current_staff_context()',
    'EXECUTE'
  ),
  'authenticated can request its server-derived staff context'
);
select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.current_manageable_staff()',
    'EXECUTE'
  ),
  'authenticated can request the Owner-scoped manageable staff projection'
);
select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.current_manageable_staff_invitations()',
    'EXECUTE'
  ),
  'authenticated can request the Owner-scoped manageable invitation projection'
);
select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.begin_staff_password_recovery(uuid)',
    'EXECUTE'
  ),
  'authenticated can begin only its provider-verified password recovery operation'
);
select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.finish_staff_password_recovery(uuid)',
    'EXECUTE'
  ),
  'authenticated can finish only its provider-verified password recovery operation'
);
select ok(
  has_function_privilege(
    'authenticated',
    'desmoslock_v2.begin_staff_invitation(uuid,text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated can invoke the controlled invitation seam'
);
select ok(
  to_regprocedure('desmoslock_v2.begin_staff_invitation(uuid,text,text)') is null,
  'the invitation seam cannot omit its server-generated request key'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'desmoslock_v2.internal_prepare_staff_invitation(uuid,uuid,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated cannot prepare an invitation for delivery'
);
select ok(
  has_function_privilege(
    'service_role',
    'desmoslock_v2.internal_prepare_staff_invitation(uuid,uuid,timestamp with time zone)',
    'EXECUTE'
  ),
  'only the service delivery boundary can bind an invitation recipient'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'desmoslock_v2.internal_publish_staff_invitation(uuid)',
    'EXECUTE'
  ),
  'authenticated cannot publish a prepared invitation'
);
select ok(
  has_function_privilege(
    'service_role',
    'desmoslock_v2.internal_publish_staff_invitation(uuid)',
    'EXECUTE'
  ),
  'only the service delivery boundary can acknowledge mail delivery'
);
select ok(
  to_regprocedure(
    'desmoslock_v2.internal_complete_staff_invitation(uuid,uuid,timestamp with time zone)'
  ) is null,
  'the former one-step prepare-and-publish RPC no longer exists'
);
select ok(
  has_function_privilege(
    'service_role',
    'desmoslock_v2.internal_bind_initial_owner(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'the service boundary can bind an initial seeded Owner'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'desmoslock_v2.internal_bind_initial_owner(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot bind an initial Owner'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.internal_bind_initial_owner(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot bind an initial Owner'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.current_staff_context()',
    'EXECUTE'
  ),
  'anonymous callers cannot enter the staff lifecycle'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.current_manageable_staff()',
    'EXECUTE'
  ),
  'anonymous callers cannot enumerate manageable staff'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.current_manageable_staff_invitations()',
    'EXECUTE'
  ),
  'anonymous callers cannot enumerate manageable invitations'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.begin_staff_password_recovery(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot begin a staff password recovery operation'
);
select ok(
  not has_function_privilege(
    'anon',
    'desmoslock_v2.finish_staff_password_recovery(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot finish a staff password recovery operation'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'desmoslock_v2.internal_authenticated_recovery_session()',
    'EXECUTE'
  ),
  'the authoritative provider recovery-session verifier is private'
);

select is(
  (
    select function_info.proargnames
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.current_staff_context()')
  ),
  array[
    'code',
    'profile_id',
    'display_name',
    'school_id',
    'school_slug',
    'school_name',
    'membership_role',
    'role_revision'
  ]::text[],
  'the current staff context keeps its exact canonical-profile PostgREST row keys'
);
select is(
  (
    select function_info.proargnames
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.current_manageable_staff()')
  ),
  array[
    'code',
    'school_id',
    'profile_id',
    'display_name',
    'email',
    'membership_role'
  ]::text[],
  'the manageable staff projection keeps its exact PostgREST row keys'
);
select is(
  (
    select function_info.proargnames
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.current_manageable_staff_invitations()')
  ),
  array[
    'code',
    'invitation_id',
    'school_id',
    'invited_email',
    'invited_role',
    'invitation_status',
    'expires_at'
  ]::text[],
  'the manageable invitation projection keeps its exact PostgREST row keys'
);
select is(
  (
    select function_info.proargnames
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.begin_staff_password_recovery(uuid)')
  ),
  array['requested_operation_id', 'code', 'operation_id', 'expires_at']::text[],
  'the password-recovery begin seam keeps its exact PostgREST input and row keys'
);
select is(
  (
    select function_info.proargnames
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.finish_staff_password_recovery(uuid)')
  ),
  array['operation_id', 'code']::text[],
  'the password-recovery finish seam keeps its exact PostgREST input and row key'
);
select ok(
  (
    select bool_and(
      position('recovery_now := clock_timestamp();' in function_info.prosrc) > 0
      and position('statement_timestamp()' in function_info.prosrc) = 0
    )
    from pg_proc as function_info
    where function_info.oid in (
      to_regprocedure('desmoslock_v2.begin_staff_password_recovery(uuid)'),
      to_regprocedure('desmoslock_v2.finish_staff_password_recovery(uuid)')
    )
  ),
  'serialized recovery functions use a fresh wall-clock linearization point rather than RPC-start time'
);
select ok(
  (
    select bool_and(
      function_info.prosecdef
      and function_info.provolatile = 's'
      and function_info.proconfig @> array['search_path=""']::text[]
    )
    from pg_proc as function_info
    where function_info.oid in (
      to_regprocedure('desmoslock_v2.current_manageable_staff()'),
      to_regprocedure('desmoslock_v2.current_manageable_staff_invitations()')
    )
  ),
  'management projections are stable security-definer functions with an empty search path'
);

select is(
  (
    select function_info.proargnames[1:function_info.pronargs]
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.begin_staff_invitation(uuid,text,text,uuid)')
  ),
  array['workspace_id', 'email', 'role', 'request_key']::text[],
  'the public invitation RPC keeps its exact PostgREST parameter names'
);
select is(
  (
    select function_info.proargnames[1:function_info.pronargs]
    from pg_proc as function_info
    where function_info.oid = to_regprocedure(
      'desmoslock_v2.internal_prepare_staff_invitation(uuid,uuid,timestamp with time zone)'
    )
  ),
  array['invitation_id', 'invited_user_id', 'expires_at']::text[],
  'the service preparation RPC keeps its exact PostgREST parameter names'
);
select is(
  (
    select function_info.proargnames[1:function_info.pronargs]
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.internal_publish_staff_invitation(uuid)')
  ),
  array['invitation_id']::text[],
  'the service publish RPC keeps its exact PostgREST parameter name'
);
select is(
  (
    select function_info.proargnames[1:function_info.pronargs]
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.internal_fail_staff_invitation(uuid,text)')
  ),
  array['invitation_id', 'reason_code']::text[],
  'the service cleanup RPC keeps its exact PostgREST parameter names'
);
select is(
  (
    select function_info.proargnames[1:function_info.pronargs]
    from pg_proc as function_info
    where function_info.oid =
      to_regprocedure('desmoslock_v2.internal_bind_initial_owner(uuid,uuid,uuid)')
  ),
  array['workspace_id', 'profile_id', 'auth_user_id']::text[],
  'the initial Owner binding RPC keeps its exact PostgREST parameter names'
);

select ok(
  (
    select bool_and(column_info.is_nullable = 'YES')
    from information_schema.columns as column_info
    where column_info.table_schema = 'desmoslock_v2'
      and column_info.column_name = 'seed_key'
      and column_info.table_name in (
        'workspaces', 'profiles', 'memberships', 'tests', 'student_sessions'
      )
  ),
  'runtime rows do not require synthetic fixture seed keys'
);
select is(
  (
    select column_info.is_nullable
    from information_schema.columns as column_info
    where column_info.table_schema = 'desmoslock_v2'
      and column_info.table_name = 'application_session_revocations'
      and column_info.column_name = 'workspace_id'
  ),
  'YES',
  'application-session revocations are account-wide rather than assigned to an arbitrary School'
);
select ok(
  not exists (
    select 1
    from information_schema.columns as column_info
    where column_info.table_schema = 'desmoslock_v2'
      and column_info.table_name in (
        'staff_password_recovery_operations',
        'application_session_revocation_cutoffs'
      )
      and column_info.column_name in (
        'email',
        'password',
        'token',
        'auth_code',
        'code_verifier',
        'code_challenge',
        'provider_error',
        'request_payload',
        'workspace_id'
      )
  ),
  'password-recovery operations persist no School guess, contact PII, password, PKCE material, token, or provider error'
);

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
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'owner-alpha@staff.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'invitee@staff.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'wrong-recipient@staff.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'rollback-recipient@staff.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'owner-beta@staff.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at
)
values
  (
    'b1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Synthetic alpha owner factor',
    'totp',
    'verified',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000002',
    'Synthetic invitee factor',
    'totp',
    'verified',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000003',
    'a1000000-0000-4000-8000-000000000003',
    'Synthetic wrong-recipient factor',
    'totp',
    'verified',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000004',
    'Synthetic rollback-recipient factor',
    'totp',
    'verified',
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000005',
    'Synthetic beta owner factor',
    'totp',
    'verified',
    now(),
    now()
  );

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
values
  (
    'c1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000001',
    'aal2',
    now() + interval '2 hours'
  ),
  (
    'c1000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000002',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000002',
    'aal2',
    now() + interval '2 hours'
  ),
  (
    'c1000000-0000-4000-8000-000000000003',
    'a1000000-0000-4000-8000-000000000003',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000003',
    'aal2',
    now() + interval '2 hours'
  ),
  (
    'c1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000004',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000004',
    'aal2',
    now() + interval '2 hours'
  ),
  (
    'c1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000005',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000005',
    'aal2',
    now() + interval '2 hours'
  ),
  (
    'c1000000-0000-4000-8000-000000000011',
    'a1000000-0000-4000-8000-000000000001',
    now(),
    now(),
    'b1000000-0000-4000-8000-000000000001',
    'aal2',
    now() + interval '2 hours'
  );

update auth.users
set email_confirmed_at = null
where id = 'a1000000-0000-4000-8000-000000000001';

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001'
    )
  ),
  'email_unverified',
  'an unconfirmed Auth identity cannot become the initial Owner'
);
reset role;

update auth.users
set email_confirmed_at = now()
where id = 'a1000000-0000-4000-8000-000000000001';

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001'
    )
  ),
  'initial_owner_bound',
  'the service boundary binds the confirmed Alpha Owner'
);
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001'
    )
  ),
  'initial_owner_bound',
  'exact initial Owner binding replay is idempotent'
);
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000003'
    )
  ),
  'conflict',
  'a differently bound Auth user cannot replace the initial Owner'
);
reset role;

insert into desmoslock_v2.profiles (id, display_name, seed_key)
values (
  '20000000-0000-4000-8000-000000000099',
  'Synthetic second Alpha Owner',
  'review-second-alpha-owner'
);
insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  seed_key
) values (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000099',
  'owner',
  'review-second-alpha-owner-membership'
);

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000099',
      'a1000000-0000-4000-8000-000000000003'
    )
  ),
  'conflict',
  'a School with a bound Owner cannot bind a different seeded Owner'
);
reset role;

delete from desmoslock_v2.memberships
where workspace_id = '10000000-0000-4000-8000-000000000001'
  and profile_id = '20000000-0000-4000-8000-000000000099';
delete from desmoslock_v2.profiles
where id = '20000000-0000-4000-8000-000000000099';

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'a1000000-0000-4000-8000-000000000003'
    )
  ),
  'invalid_request',
  'a seeded Administrator profile cannot be bound as the initial Owner'
);
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000011',
      'a1000000-0000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'an Auth identity already bound in another School cannot bind a second profile'
);
select is(
  (
    select code
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000011',
      'a1000000-0000-4000-8000-000000000005'
    )
  ),
  'initial_owner_bound',
  'the service boundary independently binds the confirmed Beta Owner'
);
reset role;

select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where event_type = 'initial_owner_bound'
  ),
  2::bigint,
  'initial Owner binding emits one minimal audit event per actual bind only'
);
select ok(
  not exists (
    select 1
    from desmoslock_v2.staff_audit_events
    where event_type = 'initial_owner_bound'
      and (actor_profile_id is not null or invitation_id is not null or session_id is not null)
  ),
  'initial Owner binding audit is system-attributed and carries no unrelated identity data'
);

set local role authenticated;
select throws_ok(
  $$
    select *
    from desmoslock_v2.internal_bind_initial_owner(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001'
    )
  $$,
  '42501',
  null,
  'authenticated cannot bypass the service-only initial Owner gate'
);
reset role;

create function pg_temp.set_staff_claims(
  user_id uuid,
  session_id uuid,
  aal text,
  extra_claims jsonb default '{}'::jsonb,
  expires_in interval default interval '1 hour'
)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    (
      jsonb_build_object(
        'sub', user_id::text,
        'role', 'authenticated',
        'session_id', session_id::text,
        'aal', aal,
        'exp', floor(extract(epoch from clock_timestamp() + expires_in))::bigint
      ) || extra_claims
    )::text,
    true
  );
end;
$$;

create temporary table staff_auth_test_results (
  label text primary key,
  code text not null,
  invitation_id uuid,
  request_key uuid,
  operation_id uuid,
  expires_at timestamp with time zone,
  profile_id uuid,
  school_id uuid,
  membership_role text
) on commit drop;

grant select, insert, update, delete on table staff_auth_test_results
  to authenticated, service_role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'parser-regression@staff.invalid',
      'owner',
      gen_random_uuid()
    )
  ),
  'invalid_request',
  'Postgres can execute the compiled staff-authorization record path'
);
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'missing-request-key@staff.invalid',
      'teacher',
      null
    )
  ),
  'invalid_request',
  'the public invitation seam rejects a missing server-generated request key'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'membership_inactive',
  'an uninvited verified Auth user has no staff context'
);
select is(
  (select code from desmoslock_v2.current_staff_invitations()),
  'invitation_not_found',
  'an uninvited verified Auth user has no discoverable invitation'
);
select results_eq(
  $$
    select code, school_id, profile_id, display_name, email, membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$values (
    'membership_inactive'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text
  )$$,
  'an uninvited user cannot enumerate staff through the Owner projection'
);
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$values (
    'membership_inactive'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text,
    null::timestamp with time zone
  )$$,
  'an uninvited user cannot enumerate invitations through the Owner projection'
);
select throws_ok(
  $$select * from desmoslock_v2.tests$$,
  '42501',
  null,
  'an uninvited Auth user cannot read School Tests directly'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select code, display_name, school_id::text, membership_role
    from desmoslock_v2.current_staff_context()
  $$,
  $$values (
    'ok'::text,
    'Synthetic Alpha Owner'::text,
    '10000000-0000-4000-8000-000000000001'::text,
    'owner'::text
  )$$,
  'live database identity, canonical display name, membership, and role produce Alpha context'
);
select results_eq(
  $$
    select school_id::text, school_slug, membership_role
    from desmoslock_v2.current_school_summary()
  $$,
  $$values ('10000000-0000-4000-8000-000000000001'::text, 'synthetic-alpha'::text, 'owner'::text)$$,
  'the original School summary now uses the live Auth/session/membership seam'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal1'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'aal1-recipient@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'step_up_required',
  'a signed AAL1 session cannot initiate an invitation'
);
select results_eq(
  $$
    select code, school_id, profile_id, display_name, email, membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$values (
    'step_up_required'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text
  )$$,
  'an Owner cannot enumerate staff without current AAL2 and verified TOTP'
);
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$values (
    'step_up_required'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text,
    null::timestamp with time zone
  )$$,
  'an Owner cannot enumerate invitations without current AAL2 and verified TOTP'
);
reset role;

update auth.mfa_factors
set status = 'unverified'
where id = 'b1000000-0000-4000-8000-000000000001';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'removed-factor-recipient@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'step_up_required',
  'a removed TOTP factor invalidates an already-open AAL2 mutation path'
);
reset role;
update auth.mfa_factors
set status = 'verified'
where id = 'b1000000-0000-4000-8000-000000000001';

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2',
  '{"app_metadata":{"role":"owner","workspace_id":"10000000-0000-4000-8000-000000000002"}}'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000002',
      'cross-school-recipient@staff.invalid',
      'admin',
      gen_random_uuid()
    )
  ),
  'membership_inactive',
  'forged JWT role and School metadata cannot cross the School boundary'
);
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'owner-role-recipient@staff.invalid',
      'owner',
      gen_random_uuid()
    )
  ),
  'invalid_request',
  'the invitation API never creates another Owner'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id, request_key)
select
  'acceptance',
  result.code,
  result.invitation_id,
  'd1000000-0000-4000-8000-000000000001'::uuid
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'invitee@staff.invalid',
  'admin',
  'd1000000-0000-4000-8000-000000000001'
) as result;
reset role;

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'acceptance'),
  'invitation_pending',
  'an Owner can initiate an Administrator invitation'
);
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  ),
  'pending_delivery',
  'an initiated invitation is not usable before service-side recipient binding'
);
select is(
  (
    select delivery_lease_expires_at
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  ),
  (
    select requested_at + interval '5 minutes'
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  ),
  'the database owns an exact five-minute pending-delivery lease'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000005',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'beta-management-invitation', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000002',
  'beta-pending@staff.invalid',
  'teacher',
  'd1000000-0000-4000-8000-000000000015'
) as result;
reset role;
select is(
  (
    select code
    from pg_temp.staff_auth_test_results
    where label = 'beta-management-invitation'
  ),
  'invitation_pending',
  'the Beta Owner can create a separate same-School management-list fixture'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$
    select
      'ok'::text,
      invitation.id,
      invitation.workspace_id,
      invitation.invited_email_normalized,
      invitation.role,
      invitation.status,
      invitation.delivery_lease_expires_at
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  $$,
  'an AAL2 Owner can select the exact live pending-delivery invitation without request-key leakage'
);
reset role;

set local role authenticated;
select results_eq(
  $$
    select result.code, result.invitation_id
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      ' INVITEE@staff.invalid ',
      'admin',
      'd1000000-0000-4000-8000-000000000001'
    ) as result
  $$,
  $$
    select 'invitation_pending'::text, invitation_id
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  $$,
  'an exact serial begin replay recovers the committed invitation after a lost response'
);
select results_eq(
  $$
    select result.code, result.invitation_id
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'invitee@staff.invalid',
      'teacher',
      'd1000000-0000-4000-8000-000000000001'
    ) as result
  $$,
  $$values ('conflict'::text, null::uuid)$$,
  'a request-key replay cannot change server-owned invitation intent'
);
select results_eq(
  $$
    select result.code, result.invitation_id
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'different-recipient@staff.invalid',
      'admin',
      'd1000000-0000-4000-8000-000000000001'
    ) as result
  $$,
  $$values ('conflict'::text, null::uuid)$$,
  'a request key cannot disclose or retarget a different normalized email'
);
select results_eq(
  $$
    select result.code, result.invitation_id
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'invitee@staff.invalid',
      'admin',
      'd1000000-0000-4000-8000-000000000002'
    ) as result
  $$,
  $$values ('conflict'::text, null::uuid)$$,
  'a concurrent invocation with a different request key cannot share a pending delivery'
);
reset role;
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
      and event_type = 'invitation_requested'
  ),
  1::bigint,
  'an exact begin replay does not duplicate the invitation-requested audit event'
);

update pg_temp.staff_auth_test_results
set expires_at = statement_timestamp() + interval '1 hour'
where label = 'acceptance';

set local role service_role;
insert into pg_temp.staff_auth_test_results (label, code)
select 'acceptance-prepare', result.code
from desmoslock_v2.internal_prepare_staff_invitation(
  (
    select invitation_id
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  ),
  'a1000000-0000-4000-8000-000000000002',
  (
    select expires_at
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  )
) as result;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'a1000000-0000-4000-8000-000000000002',
      (
        select expires_at
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      )
    )
  ),
  'invitation_delivery_ready',
  'an exact preparation retry reconciles without advancing delivery state'
);
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'a1000000-0000-4000-8000-000000000002',
      (
        select expires_at + interval '1 second'
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      )
    )
  ),
  'conflict',
  'a preparation retry with different immutable delivery data fails closed'
);
reset role;

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'acceptance-prepare'),
  'invitation_delivery_ready',
  'preparation binds the intended recipient without making the invitation consumable'
);
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  ),
  'delivery_ready',
  'recipient binding persists in a non-consumable delivery-ready state'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$
    select
      'ok'::text,
      invitation.id,
      invitation.workspace_id,
      invitation.invited_email_normalized,
      invitation.role,
      invitation.status,
      invitation.expires_at
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  $$,
  'the Owner projection exposes a live delivery-ready invitation without making it consumable'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'invitee@staff.invalid',
      'admin',
      'd1000000-0000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'the original request key cannot restart delivery after recipient preparation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_invitations()),
  'invitation_not_found',
  'a prepared recipient cannot discover an invitation before delivery acknowledgment'
);
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Premature Recipient'
    )
  ),
  'invitation_not_found',
  'a prepared recipient cannot consume an invitation before delivery acknowledgment'
);
reset role;

select is(
  (
    select count(*)
    from desmoslock_v2.profiles
    where auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'premature acceptance creates no profile'
);
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  ),
  'delivery_ready',
  'premature acceptance leaves the delivery-ready state unchanged'
);

set local role service_role;
insert into pg_temp.staff_auth_test_results (label, code)
select 'acceptance-publish', result.code
from desmoslock_v2.internal_publish_staff_invitation(
  (
    select invitation_id
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  )
) as result;
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      )
    )
  ),
  'invitation_usable',
  'an exact publish retry reconciles without another delivery side effect'
);
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_consumed',
  'a failure race cannot retract an already published invitation'
);
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      )
    )
  ),
  'invitation_usable',
  'publish reconciliation remains usable after the losing failure race'
);
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'a1000000-0000-4000-8000-000000000002',
      (
        select expires_at
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      )
    )
  ),
  'invitation_consumed',
  'preparation cannot be replayed after delivery publication'
);
reset role;

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'acceptance-publish'),
  'invitation_usable',
  'delivery acknowledgment is the only transition that makes an invitation usable'
);
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
      and event_type = 'invitation_delivery_ready'
  ),
  1::bigint,
  'exact preparation retries emit one delivery-ready audit event'
);
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
      and event_type = 'invitation_ready'
  ),
  1::bigint,
  'exact publish retries emit one usable audit event'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$
    select
      'ok'::text,
      invitation.id,
      invitation.workspace_id,
      invitation.invited_email_normalized,
      invitation.role,
      invitation.status,
      invitation.expires_at
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
  $$,
  'the Owner projection exposes the exact published invitation needed for revocation selection'
);
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'invitee@staff.invalid',
      'admin',
      gen_random_uuid()
    )
  ),
  'conflict',
  'a repeated begin cannot redeliver while publish reconciliation is ambiguous'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select code, invitation_id
    from desmoslock_v2.current_staff_invitations()
  $$,
  $$
    select
      'ok'::text,
      invitation_id
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  $$,
  'only the bound and delivery-acknowledged recipient can discover the usable invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Wrong Recipient'
    )
  ),
  'invitation_not_found',
  'a different Auth user gets the non-enumerating invitation result'
);
reset role;

update auth.users
set email = 'changed-recipient@staff.invalid'
where id = 'a1000000-0000-4000-8000-000000000002';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Changed Recipient'
    )
  ),
  'invitation_not_found',
  'a changed email identity gets the same non-enumerating invitation result'
);
reset role;
update auth.users
set email = 'invitee@staff.invalid', email_confirmed_at = null
where id = 'a1000000-0000-4000-8000-000000000002';

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Unconfirmed Recipient'
    )
  ),
  'email_unverified',
  'an unconfirmed email identity cannot accept an invitation'
);
reset role;
update auth.users
set email_confirmed_at = now()
where id = 'a1000000-0000-4000-8000-000000000002';

update auth.sessions
set aal = 'aal1', factor_id = null
where id = 'c1000000-0000-4000-8000-000000000002';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal1'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (
  label,
  code
)
select
  'accepted',
  result.code
from desmoslock_v2.accept_staff_invitation(
  (
    select invitation_id
    from pg_temp.staff_auth_test_results
    where label = 'acceptance'
  ),
  'Synthetic Accepted Administrator'
) as result;
select is(
  (
    select code
    from desmoslock_v2.revoke_membership(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000003'
    )
  ),
  'step_up_required',
  'AAL1 invitation acceptance does not weaken privileged Administrator mutations'
);
reset role;

update auth.sessions
set
  aal = 'aal2',
  factor_id = 'b1000000-0000-4000-8000-000000000002'
where id = 'c1000000-0000-4000-8000-000000000002';

update pg_temp.staff_auth_test_results
set
  profile_id = (
    select profile.id
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  ),
  school_id = '10000000-0000-4000-8000-000000000001',
  membership_role = 'admin'
where label = 'accepted';

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'accepted'),
  'invitation_accepted',
  'the intended provider-verified AAL1 recipient accepts exactly once'
);
select results_eq(
  $$
    select
      profile.auth_user_id::text,
      membership.workspace_id::text,
      membership.role,
      membership.status,
      invitation.status
    from desmoslock_v2.profiles as profile
    join desmoslock_v2.memberships as membership
      on membership.profile_id = profile.id
    join desmoslock_v2.staff_invitations as invitation
      on invitation.accepted_profile_id = profile.id
    where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  $$,
  $$values (
    'a1000000-0000-4000-8000-000000000002'::text,
    '10000000-0000-4000-8000-000000000001'::text,
    'admin'::text,
    'active'::text,
    'accepted'::text
  )$$,
  'acceptance atomically creates one profile, one live membership, and a terminal invitation'
);
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'acceptance'
    )
      and event_type = 'invitation_accepted'
  ),
  1::bigint,
  'the accepted invitation has exactly one acceptance audit event'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select
      code,
      school_id::text,
      profile_id,
      display_name,
      email,
      membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$
    select
      'ok'::text,
      '10000000-0000-4000-8000-000000000001'::text,
      profile.id,
      'Synthetic Accepted Administrator'::text,
      'invitee@staff.invalid'::text,
      'admin'::text
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  $$,
  'an AAL2 Owner receives only the bounded human-readable active staff row for its School'
);
select is_empty(
  $$select * from desmoslock_v2.current_manageable_staff_invitations()$$,
  'accepted invitations disappear from the Owner revocation selector'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select code, school_id, profile_id, display_name, email, membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$values (
    'forbidden'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text
  )$$,
  'an Administrator cannot enumerate manageable staff'
);
select results_eq(
  $$
    select
      code,
      invitation_id,
      school_id,
      invited_email,
      invited_role,
      invitation_status,
      expires_at
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$values (
    'forbidden'::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text,
    null::timestamp with time zone
  )$$,
  'an Administrator cannot enumerate manageable invitations'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Wrong Accepted Recipient'
    )
  ),
  'invitation_not_found',
  'a non-recipient cannot distinguish an accepted invitation from an absent one'
);
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      'd1000000-0000-4000-8000-000000000098',
      'Missing Invitation'
    )
  ),
  'invitation_not_found',
  'an absent invitation uses the same non-enumerating result'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'acceptance'
      ),
      'Replay Attempt'
    )
  ),
  'invitation_consumed',
  'a terminal row-lock/CAS invitation rejects replay and concurrent losers'
);
reset role;

select is(
  (
    select count(*)
    from desmoslock_v2.profiles
    where auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'replay never creates a second profile'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'admin-cannot-invite@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'forbidden',
  'a live Administrator cannot initiate another staff invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'rollback', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'rollback-recipient@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;
set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      ),
      'a1000000-0000-4000-8000-000000000004',
      now() + interval '1 hour'
    )
  ),
  'invitation_delivery_ready',
  'the rollback fixture is prepared without becoming usable'
);
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      )
    )
  ),
  'invitation_usable',
  'the rollback fixture becomes usable only after delivery acknowledgment'
);
reset role;

create function pg_temp.reject_staff_audit_insert()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = '55000', message = 'synthetic audit sink failure';
end;
$$;
create trigger reject_staff_audit_insert
before insert on desmoslock_v2.staff_audit_events
for each row execute function pg_temp.reject_staff_audit_insert();

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000004',
  'aal2'
);
set local role authenticated;
select throws_ok(
  format(
    'select * from desmoslock_v2.accept_staff_invitation(%L::uuid, %L::text)',
    (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    ),
    'Rollback Recipient'
  ),
  '55000',
  'synthetic audit sink failure',
  'an audit failure aborts the entire acceptance mutation'
);
reset role;
drop trigger reject_staff_audit_insert on desmoslock_v2.staff_audit_events;

select is(
  (
    select count(*)
    from desmoslock_v2.profiles
    where auth_user_id = 'a1000000-0000-4000-8000-000000000004'
  ),
  0::bigint,
  'a failed acceptance leaves no profile behind'
);
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    )
  ),
  'pending_acceptance',
  'a failed acceptance rolls the invitation back to its usable state'
);

update desmoslock_v2.staff_invitations
set expires_at = now() - interval '1 minute'
where id = (
  select invitation_id
  from pg_temp.staff_auth_test_results
  where label = 'rollback'
);
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      ),
      'Wrong Expired Recipient'
    )
  ),
  'invitation_not_found',
  'a non-recipient cannot discover that an invitation has elapsed'
);
reset role;
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    )
  ),
  'pending_acceptance',
  'a non-recipient cannot terminalize another user invitation'
);
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    )
      and event_type = 'invitation_expired'
  ),
  0::bigint,
  'a non-recipient expiration probe creates no audit event'
);

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      )
    )
  ),
  'invitation_expired',
  'a publish replay terminalizes an elapsed published invitation instead of reporting it usable'
);
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      )
    )
  ),
  'invitation_expired',
  'repeated publish reconciliation preserves the exact terminal expiry result'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000004',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      ),
      'Expired Recipient'
    )
  ),
  'invitation_expired',
  'the intended recipient observes the terminal expiry created by publish reconciliation'
);
reset role;
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    )
  ),
  'expired',
  'expiry is a terminal audited invitation transition'
);
select results_eq(
  $$
    select actor_profile_id, session_id
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'rollback'
    )
      and event_type = 'invitation_expired'
  $$,
  $$values (
    null::uuid,
    null::uuid
  )$$,
  'service publish reconciliation audits expiry once without impersonating any staff actor or session'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'rollback'
      ),
      'Wrong Terminal Recipient'
    )
  ),
  'invitation_not_found',
  'a non-recipient gets the same result after expiration is persisted'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'elapsed', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'wrong-recipient@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'elapsed'
      ),
      'a1000000-0000-4000-8000-000000000003',
      now() + interval '1 hour'
    )
  ),
  'invitation_delivery_ready',
  'the reissue fixture first becomes recipient-bound but non-consumable'
);
reset role;

update desmoslock_v2.staff_invitations
set expires_at = now() - interval '1 minute'
where id = (
  select invitation_id
  from pg_temp.staff_auth_test_results
  where label = 'elapsed'
);

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'elapsed'
      ),
      'a1000000-0000-4000-8000-000000000003',
      (
        select invitation.expires_at
        from desmoslock_v2.staff_invitations as invitation
        where invitation.id = (
          select invitation_id
          from pg_temp.staff_auth_test_results
          where label = 'elapsed'
        )
      )
    )
  ),
  'invitation_expired',
  'prepare reconciliation terminalizes an elapsed delivery-ready invitation before SMTP'
);
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'elapsed'
      ),
      'a1000000-0000-4000-8000-000000000003',
      now() - interval '1 minute'
    )
  ),
  'invitation_expired',
  'expired prepare reconciliation is idempotent and cannot authorize a dead-link send'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'reissued', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  ' WRONG-RECIPIENT@staff.invalid ',
  'admin',
  gen_random_uuid()
) as result;
reset role;

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'reissued'),
  'invitation_pending',
  'an elapsed open invitation no longer blocks a normalized-email reissue'
);
select ok(
  (
    select prior.invitation_id <> replacement.invitation_id
    from pg_temp.staff_auth_test_results as prior
    cross join pg_temp.staff_auth_test_results as replacement
    where prior.label = 'elapsed'
      and replacement.label = 'reissued'
  ),
  'reissue creates a new invitation identity'
);
select results_eq(
  $$
    select result.label, invitation.status
    from pg_temp.staff_auth_test_results as result
    join desmoslock_v2.staff_invitations as invitation
      on invitation.id = result.invitation_id
    where result.label in ('elapsed', 'reissued')
    order by result.label
  $$,
  $$values
    ('elapsed'::text, 'expired'::text),
    ('reissued'::text, 'pending_delivery'::text)
  $$,
  'reissue terminalizes only the elapsed row and leaves the replacement pending delivery'
);
select results_eq(
  $$
    select actor_profile_id, session_id
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'elapsed'
    )
      and event_type = 'invitation_expired'
  $$,
  $$values (
    null::uuid,
    null::uuid
  )$$,
  'prepare-side expiry is audited once as a minimized system transition'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'wrong-recipient@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'conflict',
  'a second reissue attempt conflicts while its replacement remains open'
);
reset role;
select results_eq(
  $$
    select result.label, invitation.status
    from pg_temp.staff_auth_test_results as result
    join desmoslock_v2.staff_invitations as invitation
      on invitation.id = result.invitation_id
    where result.label in ('elapsed', 'reissued')
    order by result.label
  $$,
  $$values
    ('elapsed'::text, 'expired'::text),
    ('reissued'::text, 'pending_delivery'::text)
  $$,
  'repeat conflict leaves the terminal original and open replacement unchanged'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000004',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'elapsed'
      ),
      'Wrong Reissue Recipient'
    )
  ),
  'invitation_not_found',
  'a non-recipient cannot distinguish the reissue-terminalized invitation'
);
reset role;

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'reissued'
      )
    )
  ),
  'invitation_consumed',
  'publish cannot skip recipient preparation from pending delivery'
);
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'reissued'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_delivery_failed',
  'service cleanup closes a pending-delivery replacement before later lifecycle cases'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'revoke', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'wrong-recipient@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'revoke'
      ),
      'a1000000-0000-4000-8000-000000000003',
      now() + interval '1 hour'
    )
  ),
  'invitation_delivery_ready',
  'the revocation fixture is bound without being published'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000005',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.revoke_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'revoke'
      )
    )
  ),
  'invitation_not_found',
  'a cross-School Owner cannot revoke or discover another School invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.revoke_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'revoke'
      )
    )
  ),
  'invitation_revoked',
  'the same-School Owner can revoke a pending invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000004',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'revoke'
      ),
      'Wrong Revoked Recipient'
    )
  ),
  'invitation_not_found',
  'a non-recipient cannot distinguish a revoked invitation from an absent one'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'revoke'
      ),
      'Intended Revoked Recipient'
    )
  ),
  'invitation_consumed',
  'only the bound recipient may observe that its invitation is terminal'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'delivery-failure', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'wrong-recipient@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;
set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'delivery-failure'
      ),
      'a1000000-0000-4000-8000-000000000003',
      now() + interval '1 hour'
    )
  ),
  'invitation_delivery_ready',
  'the ambiguous-response fixture remains non-consumable after preparation'
);
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'delivery-failure'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_delivery_failed',
  'failure cleanup closes an invitation even if preparation already committed'
);
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'delivery-failure'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_delivery_failed',
  'delivery failure cleanup is idempotent and reveals no prior completion state'
);
select is(
  (
    select code
    from desmoslock_v2.internal_publish_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'delivery-failure'
      )
    )
  ),
  'invitation_consumed',
  'a publish race cannot revive an invitation after delivery failure wins'
);
reset role;

select results_eq(
  $$
    select status, invited_user_id, expires_at, failure_reason_code
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'delivery-failure'
    )
  $$,
  $$values (
    'delivery_failed'::text,
    null::uuid,
    null::timestamp with time zone,
    'dependency_unavailable'::text
  )$$,
  'ambiguous preparation cleanup removes the non-consumable recipient binding'
);
select ok(
  not exists (
    select 1
    from desmoslock_v2.staff_audit_events
    where event_type in (
      'invitation_delivery_ready',
      'invitation_ready',
      'invitation_delivery_failed'
    )
      and actor_profile_id is not null
  ),
  'service preparation, publication, and cleanup never impersonate the requesting Owner'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'failure-unavailable', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'rollback-recipient@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'failure-unavailable'
      ),
      'a1000000-0000-4000-8000-000000000004',
      now() + interval '1 hour'
    )
  ),
  'invitation_delivery_ready',
  'the unavailable-failure fixture is prepared but remains non-consumable'
);
reset role;

revoke execute on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  from service_role;
set local role service_role;
select throws_ok(
  format(
    'select * from desmoslock_v2.internal_fail_staff_invitation(%L::uuid, %L::text)',
    (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'failure-unavailable'
    ),
    'dependency_unavailable'
  ),
  '42501',
  null,
  'an unavailable failure RPC cannot mutate the prepared invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000004',
  'aal2'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.accept_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'failure-unavailable'
      ),
      'Unavailable Failure Recipient'
    )
  ),
  'invitation_not_found',
  'failure-path unavailability never makes a prepared invitation consumable'
);
reset role;
select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'failure-unavailable'
    )
  ),
  'delivery_ready',
  'failure-path unavailability leaves the durable non-consumable state intact'
);

grant execute on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  to service_role;
set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'failure-unavailable'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_delivery_failed',
  'restored cleanup can terminalize the same delivery-ready invitation'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (
  label,
  code,
  invitation_id,
  request_key
)
select
  'lease-lost',
  result.code,
  result.invitation_id,
  'd1000000-0000-4000-8000-000000000010'::uuid
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'wrong-recipient@staff.invalid',
  'teacher',
  'd1000000-0000-4000-8000-000000000010'
) as result;
reset role;

revoke execute on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  from service_role;
set local role service_role;
select throws_ok(
  format(
    'select * from desmoslock_v2.internal_fail_staff_invitation(%L::uuid, %L::text)',
    (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'lease-lost'
    ),
    'dependency_unavailable'
  ),
  '42501',
  null,
  'an unavailable failure RPC can leave only a bounded pending-delivery lease'
);
reset role;
grant execute on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  to service_role;

select is(
  (
    select status
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'lease-lost'
    )
  ),
  'pending_delivery',
  'cleanup unavailability initially preserves the non-consumable pending row'
);
update desmoslock_v2.staff_invitations
set
  requested_at = statement_timestamp() - interval '6 minutes',
  delivery_lease_expires_at = statement_timestamp() - interval '1 minute'
where id = (
  select invitation_id
  from pg_temp.staff_auth_test_results
  where label = 'lease-lost'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (
  label,
  code,
  invitation_id,
  request_key
)
select
  'lease-replacement',
  result.code,
  result.invitation_id,
  'd1000000-0000-4000-8000-000000000011'::uuid
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'wrong-recipient@staff.invalid',
  'teacher',
  'd1000000-0000-4000-8000-000000000011'
) as result;
select results_eq(
  $$
    select result.code, result.invitation_id
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'wrong-recipient@staff.invalid',
      'teacher',
      'd1000000-0000-4000-8000-000000000010'
    ) as result
  $$,
  $$values ('conflict'::text, null::uuid)$$,
  'a terminalized lease key cannot replay into a new delivery attempt'
);
reset role;

select is(
  (select code from pg_temp.staff_auth_test_results where label = 'lease-replacement'),
  'invitation_pending',
  'a new request key atomically recovers after the stale pending lease'
);
select results_eq(
  $$
    select result.label, invitation.status, invitation.failure_reason_code
    from pg_temp.staff_auth_test_results as result
    join desmoslock_v2.staff_invitations as invitation
      on invitation.id = result.invitation_id
    where result.label in ('lease-lost', 'lease-replacement')
    order by result.label
  $$,
  $$values
    ('lease-lost'::text, 'delivery_failed'::text, 'delivery_lease_expired'::text),
    ('lease-replacement'::text, 'pending_delivery'::text, null::text)
  $$,
  'lease recovery terminalizes only the stale attempt and preserves one live replacement'
);
select results_eq(
  $$
    select actor_profile_id, session_id
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'lease-lost'
    )
      and event_type = 'invitation_delivery_failed'
  $$,
  $$values (null::uuid, null::uuid)$$,
  'automatic lease recovery records one minimized system audit without impersonating staff'
);

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_fail_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'lease-replacement'
      ),
      'dependency_unavailable'
    )
  ),
  'invitation_delivery_failed',
  'the recovery replacement can still be closed through ordinary idempotent cleanup'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (
  label,
  code,
  invitation_id,
  request_key
)
select
  'lease-prepare',
  result.code,
  result.invitation_id,
  'd1000000-0000-4000-8000-000000000012'::uuid
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'rollback-recipient@staff.invalid',
  'teacher',
  'd1000000-0000-4000-8000-000000000012'
) as result;
reset role;
update desmoslock_v2.staff_invitations
set
  requested_at = statement_timestamp() - interval '6 minutes',
  delivery_lease_expires_at = statement_timestamp() - interval '1 minute'
where id = (
  select invitation_id
  from pg_temp.staff_auth_test_results
  where label = 'lease-prepare'
);

set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'lease-prepare'
      ),
      'a1000000-0000-4000-8000-000000000004',
      statement_timestamp() + interval '1 hour'
    )
  ),
  'invitation_delivery_failed',
  'recipient preparation cannot revive an elapsed pending-delivery lease'
);
reset role;
select results_eq(
  $$
    select status, invited_user_id, expires_at, failure_reason_code
    from desmoslock_v2.staff_invitations
    where id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'lease-prepare'
    )
  $$,
  $$values (
    'delivery_failed'::text,
    null::uuid,
    null::timestamp with time zone,
    'delivery_lease_expired'::text
  )$$,
  'elapsed preparation stays non-consumable and never binds its Auth recipient'
);
select results_eq(
  $$
    select actor_profile_id, session_id
    from desmoslock_v2.staff_audit_events
    where invitation_id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'lease-prepare'
    )
      and event_type = 'invitation_delivery_failed'
  $$,
  $$values (null::uuid, null::uuid)$$,
  'prepare-side lease expiry produces one minimized system audit'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (label, code, invitation_id)
select 'existing-user', result.code, result.invitation_id
from desmoslock_v2.begin_staff_invitation(
  '10000000-0000-4000-8000-000000000001',
  'owner-alpha@staff.invalid',
  'teacher',
  gen_random_uuid()
) as result;
reset role;
set local role service_role;
select is(
  (
    select code
    from desmoslock_v2.internal_prepare_staff_invitation(
      (
        select invitation_id
        from pg_temp.staff_auth_test_results
        where label = 'existing-user'
      ),
      'a1000000-0000-4000-8000-000000000001',
      now() + interval '1 hour'
    )
  ),
  'conflict',
  'delivery cannot repurpose an already-linked Auth identity'
);
reset role;

insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  seed_key,
  status,
  role_revision,
  accepted_at
)
select
  '10000000-0000-4000-8000-000000000002',
  profile.id,
  'teacher',
  null,
  'active',
  1,
  now()
from desmoslock_v2.profiles as profile
where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002';

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select school_id::text, profile_id, email, membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$
    select
      '10000000-0000-4000-8000-000000000001'::text,
      profile.id,
      'invitee@staff.invalid'::text,
      'admin'::text
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  $$,
  'an Alpha Owner cannot see the same profile membership that belongs to Beta'
);
select is(
  (
    select code
    from desmoslock_v2.revoke_membership(
      '10000000-0000-4000-8000-000000000001',
      (
        select profile_id
        from pg_temp.staff_auth_test_results
        where label = 'accepted'
      )
    )
  ),
  'membership_revoked',
  'an Owner can revoke an Administrator membership at the backend boundary'
);
reset role;

select results_eq(
  $$
    select workspace_id::text, status
    from desmoslock_v2.memberships
    where profile_id = (
      select profile_id
      from pg_temp.staff_auth_test_results
      where label = 'accepted'
    )
    order by workspace_id
  $$,
  $$values
    ('10000000-0000-4000-8000-000000000001'::text, 'revoked'::text),
    ('10000000-0000-4000-8000-000000000002'::text, 'active'::text)
  $$,
  'membership revocation affects only the selected School'
);
select is(
  (
    select count(*)
    from desmoslock_v2.application_session_revocations
    where user_id = 'a1000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'School membership revocation does not globally revoke Auth application sessions'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is_empty(
  $$select * from desmoslock_v2.current_manageable_staff()$$,
  'revoked and fixture-only memberships do not appear in the Alpha management projection'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000005',
  'aal2'
);
set local role authenticated;
select results_eq(
  $$
    select school_id::text, profile_id, email, membership_role
    from desmoslock_v2.current_manageable_staff()
  $$,
  $$
    select
      '10000000-0000-4000-8000-000000000002'::text,
      profile.id,
      'invitee@staff.invalid'::text,
      'teacher'::text
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = 'a1000000-0000-4000-8000-000000000002'
  $$,
  'the Beta Owner sees only the remaining live Beta Teacher membership'
);
select results_eq(
  $$
    select
      invitation_id,
      school_id::text,
      invited_email,
      invited_role,
      invitation_status
    from desmoslock_v2.current_manageable_staff_invitations()
  $$,
  $$
    select
      invitation.id,
      invitation.workspace_id::text,
      invitation.invited_email_normalized,
      invitation.role,
      invitation.status
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = (
      select invitation_id
      from pg_temp.staff_auth_test_results
      where label = 'beta-management-invitation'
    )
  $$,
  'the Beta Owner sees its pending invitation without any Alpha invitation leakage'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  'aal2',
  '{"app_metadata":{"role":"owner","workspace_id":"10000000-0000-4000-8000-000000000002"}}'
);
set local role authenticated;
select results_eq(
  $$
    select code, school_id::text, membership_role
    from desmoslock_v2.current_staff_context()
  $$,
  $$values ('ok'::text, '10000000-0000-4000-8000-000000000002'::text, 'teacher'::text)$$,
  'an already-open Teacher session observes only its remaining live School role'
);
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000002',
      'forged-role-recipient@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'forbidden',
  'forged stale Owner metadata cannot elevate a live Teacher role'
);
reset role;

create temporary table management_staff_overflow_fixture (
  ordinal integer primary key,
  auth_user_id uuid not null,
  profile_id uuid not null
) on commit drop;
insert into management_staff_overflow_fixture (ordinal, auth_user_id, profile_id)
select series.ordinal, gen_random_uuid(), gen_random_uuid()
from generate_series(1, 502) as series(ordinal);
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
)
select
  '00000000-0000-0000-0000-000000000000',
  fixture.auth_user_id,
  'authenticated',
  'authenticated',
  format('management-overflow-%s@staff.invalid', fixture.ordinal),
  '',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
from management_staff_overflow_fixture as fixture;
insert into desmoslock_v2.profiles (id, display_name, auth_user_id)
select
  fixture.profile_id,
  format('Overflow Staff %s', lpad(fixture.ordinal::text, 3, '0')),
  fixture.auth_user_id
from management_staff_overflow_fixture as fixture;
insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  status,
  accepted_at,
  updated_at
)
select
  '10000000-0000-4000-8000-000000000001',
  fixture.profile_id,
  'teacher',
  'active',
  now(),
  now()
from management_staff_overflow_fixture as fixture;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal2'
);
set local role authenticated;
select is(
  (select count(*) from desmoslock_v2.current_manageable_staff()),
  501::bigint,
  'manageable staff returns one deterministic overflow sentinel row beyond the 500-item product cap'
);
reset role;

delete from desmoslock_v2.memberships as membership
using management_staff_overflow_fixture as fixture
where membership.workspace_id = '10000000-0000-4000-8000-000000000001'
  and membership.profile_id = fixture.profile_id;
delete from desmoslock_v2.profiles as profile
using management_staff_overflow_fixture as fixture
where profile.id = fixture.profile_id;
delete from auth.users as auth_user
using management_staff_overflow_fixture as fixture
where auth_user.id = fixture.auth_user_id;

create temporary table management_invitation_overflow_fixture (
  id uuid primary key
) on commit drop;
insert into management_invitation_overflow_fixture (id)
select gen_random_uuid()
from generate_series(1, 502);
insert into desmoslock_v2.staff_invitations (
  id,
  workspace_id,
  requested_by_profile_id,
  request_key,
  invited_email_normalized,
  role,
  status,
  delivery_lease_expires_at
)
select
  fixture.id,
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  gen_random_uuid(),
  format('invitation-overflow-%s@staff.invalid', row_number() over (order by fixture.id)),
  'teacher',
  'pending_delivery',
  statement_timestamp() + interval '5 minutes'
from management_invitation_overflow_fixture as fixture;

set local role authenticated;
select is(
  (select count(*) from desmoslock_v2.current_manageable_staff_invitations()),
  501::bigint,
  'manageable invitations return one deterministic overflow sentinel row beyond the 500-item product cap'
);
reset role;

delete from desmoslock_v2.staff_invitations as invitation
using management_invitation_overflow_fixture as fixture
where invitation.id = fixture.id;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000099',
  'aal2'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_expired',
  'a signed claim for a missing Auth session fails closed'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000005',
  'aal1'
);
update auth.sessions
set aal = 'aal1', factor_id = null
where id = 'c1000000-0000-4000-8000-000000000005';
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_current_staff_session()),
  'ok',
  'provider-authenticated AAL1 staff can revoke the current application session'
);
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_revoked',
  'current-session revocation takes effect at the next backend boundary'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal1',
  '{"user_metadata":{"target_user_id":"a1000000-0000-4000-8000-000000000002"}}'
);
update auth.sessions
set aal = 'aal1', factor_id = null
where id = 'c1000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(
  (select code from desmoslock_v2.revoke_all_current_user_staff_sessions()),
  'ok',
  'provider-authenticated AAL1 staff can revoke every current-user application session'
);
reset role;
select is(
  (
    select count(*)
    from desmoslock_v2.application_session_revocations
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'recovery records both current and other application sessions'
);
select is(
  (
    select count(*)
    from desmoslock_v2.application_session_revocations
    where user_id = 'a1000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'forged recovery target metadata cannot revoke another user application session'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000011',
  'aal2'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_revoked',
  'a second already-open session is invalid immediately after recovery'
);
reset role;

insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  status,
  accepted_at,
  updated_at
)
values (
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  'teacher',
  'active',
  now(),
  now()
);

insert into auth.mfa_amr_claims (
  id,
  session_id,
  created_at,
  updated_at,
  authentication_method
)
values
  (
    'e1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    now(),
    now(),
    'otp'
  ),
  (
    'e1000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000011',
    now(),
    now(),
    'password'
  );

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'aal1',
  '{"amr":[{"method":"recovery","timestamp":1}],"user_metadata":{"recovery":true}}'
);
set local role authenticated;
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000001'
    )
  $$,
  $$values ('forbidden'::text, null::uuid, null::timestamp with time zone)$$,
  'generic OTP plus forged JWT AMR and metadata cannot become provider-verified recovery'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000011',
  'aal2',
  '{"amr":[{"method":"recovery","timestamp":1}]}'
);
set local role authenticated;
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000002'
    )
  $$,
  $$values ('forbidden'::text, null::uuid, null::timestamp with time zone)$$,
  'a password session cannot become recovery through a forged signed-request payload claim'
);
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000002'
    )
  ),
  'forbidden',
  'a generic password session cannot finish a password-recovery operation'
);
reset role;

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
values (
  'c1000000-0000-4000-8000-000000000012',
  'a1000000-0000-4000-8000-000000000001',
  now(),
  now(),
  null,
  'aal1',
  now() + interval '2 hours'
);
insert into auth.mfa_amr_claims (
  id,
  session_id,
  created_at,
  updated_at,
  authentication_method
)
values (
  'e1000000-0000-4000-8000-000000000012',
  'c1000000-0000-4000-8000-000000000012',
  now(),
  now(),
  'recovery'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000012',
  'aal1'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'forbidden',
  'a provider recovery session cannot enter protected staff reads'
);
select is(
  (
    select code
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001',
      'recovery-cannot-invite@staff.invalid',
      'teacher',
      gen_random_uuid()
    )
  ),
  'forbidden',
  'a provider recovery session cannot enter protected staff mutations'
);
select is(
  (select code from desmoslock_v2.revoke_current_staff_session()),
  'forbidden',
  'ordinary self-session revocation does not admit the privileged recovery session exception'
);
insert into pg_temp.staff_auth_test_results (
  label,
  code,
  operation_id,
  expires_at
)
select
  'password-recovery',
  result.code,
  result.operation_id,
  result.expires_at
from desmoslock_v2.begin_staff_password_recovery(
  'f1000000-0000-4000-8000-000000000012'
) as result;
reset role;

select is(
  (
    select code
    from pg_temp.staff_auth_test_results
    where label = 'password-recovery'
  ),
  'recovery_sessions_revoked',
  'provider-verified recovery revokes application sessions before permitting password update'
);
select ok(
  (
    select operation_id = 'f1000000-0000-4000-8000-000000000012'
      and expires_at > statement_timestamp()
      and expires_at <= statement_timestamp() + interval '15 minutes'
    from pg_temp.staff_auth_test_results
    where label = 'password-recovery'
  ),
  'the recovery operation returns the caller key with a bounded fifteen-minute completion window'
);
select results_eq(
  $$
    select
      operation.auth_user_id::text,
      operation.auth_session_id::text,
      operation.profile_id::text,
      operation.status
    from desmoslock_v2.staff_password_recovery_operations as operation
    where operation.id = 'f1000000-0000-4000-8000-000000000012'
  $$,
  $$values (
    'a1000000-0000-4000-8000-000000000001'::text,
    'c1000000-0000-4000-8000-000000000012'::text,
    '20000000-0000-4000-8000-000000000001'::text,
    'sessions_revoked'::text
  )$$,
  'recovery state is bound only to the exact caller, provider session, and staff profile'
);
select results_eq(
  $$
    select count(*), bool_and(workspace_id is null)
    from desmoslock_v2.application_session_revocations
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  $$,
  $$values (3::bigint, true)$$,
  'recovery covers every Auth session exactly once without assigning an arbitrary School'
);
select results_eq(
  $$
    select count(*), bool_and(workspace_id is null)
    from desmoslock_v2.staff_audit_events
    where event_type = 'password_recovery_sessions_revoked'
      and session_id = 'c1000000-0000-4000-8000-000000000012'
  $$,
  $$values (1::bigint, true)$$,
  'recovery begin emits one minimized account-wide audit event'
);
select results_eq(
  $$
    select workspace_id::text, role, status
    from desmoslock_v2.memberships
    where profile_id = '20000000-0000-4000-8000-000000000001'
    order by workspace_id
  $$,
  $$values
    ('10000000-0000-4000-8000-000000000001'::text, 'owner'::text, 'active'::text),
    ('10000000-0000-4000-8000-000000000002'::text, 'teacher'::text, 'active'::text)
  $$,
  'account-wide recovery revokes sessions without changing either active School membership'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000012',
  'aal1'
);
set local role authenticated;
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000012'
    )
  $$,
  $$
    select code, operation_id, expires_at
    from pg_temp.staff_auth_test_results
    where label = 'password-recovery'
  $$,
  'exact recovery-begin retry returns the same durable operation result'
);
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000099'
    )
  $$,
  $$values ('conflict'::text, null::uuid, null::timestamp with time zone)$$,
  'one provider recovery session cannot own two operation identities'
);
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000099'
    )
  ),
  'conflict',
  'the post-lock recovery verifier cannot turn a missing finish operation into a successful lookup'
);
reset role;
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where event_type = 'password_recovery_sessions_revoked'
      and session_id = 'c1000000-0000-4000-8000-000000000012'
  ),
  1::bigint,
  'recovery-begin retry does not duplicate its audit event'
);

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
values (
  'c1000000-0000-4000-8000-000000000013',
  'a1000000-0000-4000-8000-000000000001',
  now(),
  now(),
  null,
  'aal1',
  now() + interval '2 hours'
);
insert into auth.mfa_amr_claims (
  id,
  session_id,
  created_at,
  updated_at,
  authentication_method
)
values (
  'e1000000-0000-4000-8000-000000000013',
  'c1000000-0000-4000-8000-000000000013',
  now(),
  now(),
  'recovery'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000013',
  'aal1'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000012'
    )
  ),
  'conflict',
  'another recovery session for the same user cannot finish the bound operation'
);
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000013'
    )
  $$,
  $$values ('conflict'::text, null::uuid, null::timestamp with time zone)$$,
  'a second recovery session cannot supersede the live operation winner'
);
reset role;
select is(
  (
    select count(*)
    from desmoslock_v2.staff_password_recovery_operations
    where id = 'f1000000-0000-4000-8000-000000000013'
  ),
  0::bigint,
  'the losing recovery session creates no competing operation state'
);

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
values (
  'c1000000-0000-4000-8000-000000000014',
  'a1000000-0000-4000-8000-000000000001',
  clock_timestamp(),
  clock_timestamp(),
  null,
  'aal1',
  clock_timestamp() + interval '2 hours'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000014',
  'aal1'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_revoked',
  'an ordinary session created during active recovery is blacked out before completion'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000012',
  'aal1'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000012'
    )
  ),
  'recovery_completed',
  'the exact recovery session can mark its operation complete after user-scoped password update'
);
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000012'
    )
  ),
  'recovery_completed',
  'recovery completion retry is idempotent'
);
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000012'
    )
  $$,
  $$
    select
      'recovery_completed'::text,
      operation_id,
      expires_at
    from pg_temp.staff_auth_test_results
    where label = 'password-recovery'
  $$,
  'begin replay reconciles an already-completed recovery operation'
);
reset role;
select is(
  (
    select count(*)
    from desmoslock_v2.staff_audit_events
    where event_type = 'password_recovery_completed'
      and session_id = 'c1000000-0000-4000-8000-000000000012'
  ),
  1::bigint,
  'recovery completion and its retry emit exactly one minimized audit event'
);

select results_eq(
  $$
    select count(*), bool_and(workspace_id is null)
    from desmoslock_v2.application_session_revocations
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  $$,
  $$values (5::bigint, true)$$,
  'finish re-sweeps both recovery and ordinary sessions created after begin'
);
select results_eq(
  $$
    select
      last_recovery_operation_id::text,
      invalid_before >= (
        select max(auth_session.created_at)
        from auth.sessions as auth_session
        where auth_session.id in (
          'c1000000-0000-4000-8000-000000000013',
          'c1000000-0000-4000-8000-000000000014'
        )
      )
    from desmoslock_v2.application_session_revocation_cutoffs
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  $$,
  $$values ('f1000000-0000-4000-8000-000000000012'::text, true)$$,
  'finish records one account cutoff at or after every pre-completion session'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000014',
  'aal1'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_revoked',
  'the late ordinary session remains unusable after recovery completion'
);
reset role;

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000013',
  'aal1'
);
set local role authenticated;
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000013'
    )
  $$,
  $$values ('conflict'::text, null::uuid, null::timestamp with time zone)$$,
  'a recovery session invalidated by the winning completion cannot retry later'
);
reset role;

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
select
  'c1000000-0000-4000-8000-000000000015',
  'a1000000-0000-4000-8000-000000000001',
  clock_timestamp(),
  clock_timestamp(),
  null,
  'aal1',
  clock_timestamp() + interval '2 hours'
from desmoslock_v2.application_session_revocation_cutoffs as cutoff
where cutoff.user_id = 'a1000000-0000-4000-8000-000000000001';
insert into auth.mfa_amr_claims (
  id,
  session_id,
  created_at,
  updated_at,
  authentication_method
)
values (
  'e1000000-0000-4000-8000-000000000015',
  'c1000000-0000-4000-8000-000000000015',
  clock_timestamp(),
  clock_timestamp(),
  'recovery'
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000015',
  'aal1'
);
set local role authenticated;
insert into pg_temp.staff_auth_test_results (
  label,
  code,
  operation_id,
  expires_at
)
select
  'expired-password-recovery',
  result.code,
  result.operation_id,
  result.expires_at
from desmoslock_v2.begin_staff_password_recovery(
  'f1000000-0000-4000-8000-000000000015'
) as result;
reset role;
select is(
  (
    select code
    from pg_temp.staff_auth_test_results
    where label = 'expired-password-recovery'
  ),
  'recovery_sessions_revoked',
  'a genuinely new provider recovery session may begin after the prior completion cutoff'
);

update desmoslock_v2.staff_password_recovery_operations
set
  started_at = statement_timestamp() - interval '20 minutes',
  expires_at = statement_timestamp() - interval '5 minutes'
where id = 'f1000000-0000-4000-8000-000000000015';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000015',
  'aal1'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.finish_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000015'
    )
  ),
  'recovery_expired',
  'an elapsed recovery operation cannot be completed'
);
select results_eq(
  $$
    select code, operation_id, expires_at
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000015'
    )
  $$,
  $$values ('recovery_expired'::text, null::uuid, null::timestamp with time zone)$$,
  'begin replay returns a null-data failure after the operation window elapses'
);
reset role;
select results_eq(
  $$
    select status, completed_at
    from desmoslock_v2.staff_password_recovery_operations
    where id = 'f1000000-0000-4000-8000-000000000015'
  $$,
  $$values ('sessions_revoked'::text, null::timestamp with time zone)$$,
  'expiry leaves prior session revocation intact and never fabricates completion'
);

update desmoslock_v2.staff_password_recovery_operations
set
  started_at = clock_timestamp(),
  expires_at = clock_timestamp() + interval '15 minutes'
where id = 'f1000000-0000-4000-8000-000000000015';
update auth.sessions
set not_after = clock_timestamp() + interval '5 seconds'
where id = 'c1000000-0000-4000-8000-000000000015';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000015',
  'aal1'
);
set local role authenticated;
select results_eq(
  $$
    with delayed_call as materialized (
      select
        pg_sleep(5.25),
        'f1000000-0000-4000-8000-000000000015'::uuid as operation_id
    )
    select begin_result.code, finish_result.code
    from delayed_call
    cross join lateral desmoslock_v2.begin_staff_password_recovery(
      delayed_call.operation_id
    ) as begin_result
    cross join lateral desmoslock_v2.finish_staff_password_recovery(
      delayed_call.operation_id
    ) as finish_result
  $$,
  $$values ('session_expired'::text, 'session_expired'::text)$$,
  'begin and finish reject a provider session that expires after RPC start but before serialized recovery work'
);
reset role;

update auth.sessions
set not_after = clock_timestamp() + interval '2 hours'
where id = 'c1000000-0000-4000-8000-000000000015';
update desmoslock_v2.staff_password_recovery_operations
set
  started_at = clock_timestamp(),
  expires_at = clock_timestamp() + interval '5 seconds'
where id = 'f1000000-0000-4000-8000-000000000015';
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000015',
  'aal1'
);
set local role authenticated;
select results_eq(
  $$
    with delayed_call as materialized (
      select
        pg_sleep(5.25),
        'f1000000-0000-4000-8000-000000000015'::uuid as operation_id
    )
    select begin_result.code, finish_result.code
    from delayed_call
    cross join lateral desmoslock_v2.begin_staff_password_recovery(
      delayed_call.operation_id
    ) as begin_result
    cross join lateral desmoslock_v2.finish_staff_password_recovery(
      delayed_call.operation_id
    ) as finish_result
  $$,
  $$values ('recovery_expired'::text, 'recovery_expired'::text)$$,
  'begin and finish reject an operation that expires after RPC start but before serialized recovery work'
);
reset role;
select results_eq(
  $$
    select status, completed_at
    from desmoslock_v2.staff_password_recovery_operations
    where id = 'f1000000-0000-4000-8000-000000000015'
  $$,
  $$values ('sessions_revoked'::text, null::timestamp with time zone)$$,
  'wait-past-expiry rejection preserves the already-revoked terminal safety boundary without audit mutation'
);

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
)
values (
  '00000000-0000-0000-0000-000000000000',
  'a1000000-0000-4000-8000-000000000006',
  'authenticated',
  'authenticated',
  'removed-recovery@staff.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
);
insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  factor_id,
  aal,
  not_after
)
values (
  'c1000000-0000-4000-8000-000000000006',
  'a1000000-0000-4000-8000-000000000006',
  now(),
  now(),
  null,
  'aal1',
  now() + interval '2 hours'
);
insert into auth.mfa_amr_claims (
  id,
  session_id,
  created_at,
  updated_at,
  authentication_method
)
values (
  'e1000000-0000-4000-8000-000000000006',
  'c1000000-0000-4000-8000-000000000006',
  now(),
  now(),
  'recovery'
);
insert into desmoslock_v2.profiles (id, display_name, auth_user_id)
values (
  '20000000-0000-4000-8000-000000000006',
  'Removed Recovery Staff',
  'a1000000-0000-4000-8000-000000000006'
);
insert into desmoslock_v2.memberships (
  workspace_id,
  profile_id,
  role,
  status,
  role_revision,
  accepted_at,
  revoked_at,
  revoked_by_profile_id,
  revocation_reason_code,
  updated_at
)
values (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000006',
  'teacher',
  'revoked',
  2,
  now() - interval '1 day',
  now(),
  '20000000-0000-4000-8000-000000000001',
  'owner_action',
  now()
);

select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000006',
  'c1000000-0000-4000-8000-000000000006',
  'aal1'
);
set local role authenticated;
select is(
  (
    select code
    from desmoslock_v2.begin_staff_password_recovery(
      'f1000000-0000-4000-8000-000000000006'
    )
  ),
  'recovery_sessions_revoked',
  'a bound staff profile with no active membership may still recover credentials'
);
reset role;
select results_eq(
  $$
    select membership.status, revocation.workspace_id
    from desmoslock_v2.memberships as membership
    join desmoslock_v2.application_session_revocations as revocation
      on revocation.user_id = 'a1000000-0000-4000-8000-000000000006'
    where membership.workspace_id = '10000000-0000-4000-8000-000000000001'
      and membership.profile_id = '20000000-0000-4000-8000-000000000006'
  $$,
  $$values ('revoked'::text, null::uuid)$$,
  'credential recovery remains account-wide and never reactivates removed School authority'
);

set local role anon;
select throws_ok(
  $$select * from desmoslock_v2.current_staff_context()$$,
  '42501',
  null,
  'anonymous staff-context access is denied at the function grant boundary'
);
reset role;

grant select, insert, update, delete on table
  desmoslock_v2.staff_invitations,
  desmoslock_v2.application_session_revocations,
  desmoslock_v2.staff_audit_events,
  desmoslock_v2.staff_password_recovery_operations,
  desmoslock_v2.application_session_revocation_cutoffs
to authenticated;
select pg_temp.set_staff_claims(
  'a1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000003',
  'aal2'
);
set local role authenticated;
select throws_ok(
  $$
    insert into desmoslock_v2.staff_invitations (
      id,
      workspace_id,
      requested_by_profile_id,
      role,
      status
    ) values (
      'd1000000-0000-4000-8000-000000000099',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'teacher',
      'pending_delivery'
    )
  $$,
  '42501',
  null,
  'even an accidental table grant cannot create an invitation through RLS'
);
select is_empty(
  $$select * from desmoslock_v2.staff_audit_events$$,
  'even an accidental table grant cannot read the staff audit through RLS'
);
select is_empty(
  $$select * from desmoslock_v2.staff_password_recovery_operations$$,
  'even an accidental table grant cannot read password-recovery operations through RLS'
);
select is_empty(
  $$select * from desmoslock_v2.application_session_revocation_cutoffs$$,
  'even an accidental table grant cannot read account recovery cutoffs through RLS'
);
reset role;

select throws_ok(
  $$
    update desmoslock_v2.staff_audit_events
    set result_code = 'ok'
    where true
  $$,
  '55000',
  'staff audit events are append-only',
  'the audit rejects mutation even for its owning maintenance role'
);
select throws_ok(
  $$delete from desmoslock_v2.staff_audit_events where true$$,
  '55000',
  'staff audit events are append-only',
  'the audit rejects deletion even for its owning maintenance role'
);

select ok(
  not exists (
    select 1
    from information_schema.columns as column_info
    where column_info.table_schema = 'desmoslock_v2'
      and column_info.table_name = 'staff_audit_events'
      and column_info.column_name in (
        'email',
        'ip',
        'user_agent',
        'metadata',
        'payload',
        'provider_error',
        'request_key',
        'secret',
        'token'
      )
  ),
  'the append-only audit has no PII, request key, token, arbitrary payload, secret, or provider-error column'
);

select results_eq(
  $$
    select fixture_digest, fixture_valid
    from desmoslock_v2.internal_baseline_status()
  $$,
  $$values (
    'f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201'::text,
    true
  )$$,
  'runtime staff rows never invalidate the pinned synthetic health fixture'
);

select * from finish();
rollback;
