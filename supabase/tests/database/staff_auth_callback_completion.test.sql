begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

-- Transaction-local fault injection exercises changes between acceptance's
-- initial and post-lock authorization checks. This is deterministic coverage of
-- revalidation, not evidence of a multi-connection PostgreSQL concurrency run.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'a7000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'callback-race@staff.invalid', '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
  clock_timestamp(), clock_timestamp()
);
insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
values (
  'c7000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000001',
  clock_timestamp(), clock_timestamp(), 'aal1', clock_timestamp() + interval '1 hour'
);
insert into desmoslock_v2.staff_invitations (
  id, workspace_id, requested_by_profile_id, request_key,
  invited_email_normalized, invited_user_id, role, status,
  delivery_lease_expires_at, expires_at
) values (
  'd7000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000001',
  'callback-race@staff.invalid',
  'a7000000-0000-4000-8000-000000000001',
  'teacher', 'delivery_ready',
  clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour'
);

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a7000000-0000-4000-8000-000000000001',
  'session_id', 'c7000000-0000-4000-8000-000000000001',
  'role', 'authenticated', 'aal', 'aal1',
  'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
)::text, true);

create temporary table callback_authority_probe (
  action text not null,
  calls integer not null default 0
) on commit drop;
insert into callback_authority_probe (action) values ('changed_email');

alter function desmoslock_v2.internal_authenticated_staff_session(boolean)
  rename to callback_fixture_original_staff_session;
create function desmoslock_v2.internal_authenticated_staff_session(
  require_step_up boolean
)
returns table (code text, user_id uuid, session_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  probe record;
begin
  update pg_temp.callback_authority_probe set calls = calls + 1
  returning * into probe;
  if probe.calls = 1 and probe.action = 'elapsed_invitation' then
    -- Set expiry inside the acceptance statement, after its start timestamp,
    -- so the second-check delay distinguishes wall-clock from statement time.
    update desmoslock_v2.staff_invitations
    set expires_at = clock_timestamp() + interval '0.05 seconds'
    where id = 'd7000000-0000-4000-8000-000000000001';
  end if;
  if probe.calls = 2 then
    case probe.action
      when 'changed_email' then
        update auth.users set email = 'changed@staff.invalid'
        where id = 'a7000000-0000-4000-8000-000000000001';
      when 'unverified' then
        update auth.users set email_confirmed_at = null
        where id = 'a7000000-0000-4000-8000-000000000001';
      when 'banned' then
        update auth.users set banned_until = clock_timestamp() + interval '1 hour'
        where id = 'a7000000-0000-4000-8000-000000000001';
      when 'expired_session' then
        update auth.sessions set not_after = clock_timestamp() - interval '1 second'
        where id = 'c7000000-0000-4000-8000-000000000001';
      when 'revoked_session' then
        insert into desmoslock_v2.application_session_revocations (
          user_id, session_id, workspace_id, revoked_by_profile_id, reason_code
        ) values (
          'a7000000-0000-4000-8000-000000000001',
          'c7000000-0000-4000-8000-000000000001', null,
          '20000000-0000-4000-8000-000000000001', 'current_session'
        );
      when 'elapsed_invitation' then
        perform pg_sleep(0.1);
      else
        null;
    end case;
  end if;
  return query select *
  from desmoslock_v2.callback_fixture_original_staff_session($1);
end;
$$;
revoke all on function desmoslock_v2.internal_authenticated_staff_session(boolean)
  from public, anon, authenticated, service_role;

set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'invitation_not_found',
  'acceptance rechecks the verified email after acquiring its locks'
);
reset role;
update auth.users set email = 'callback-race@staff.invalid'
where id = 'a7000000-0000-4000-8000-000000000001';
update callback_authority_probe set action = 'unverified', calls = 0;
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'email_unverified',
  'acceptance rejects loss of email verification after its initial check'
);
reset role;
update auth.users set email_confirmed_at = clock_timestamp()
where id = 'a7000000-0000-4000-8000-000000000001';
update callback_authority_probe set action = 'banned', calls = 0;
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'unauthenticated',
  'acceptance rejects a provider identity banned after its initial check'
);
reset role;
update auth.users set banned_until = null
where id = 'a7000000-0000-4000-8000-000000000001';
update callback_authority_probe set action = 'expired_session', calls = 0;
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'session_expired',
  'acceptance rejects a provider session expired after its initial check'
);
reset role;
update auth.sessions set not_after = clock_timestamp() + interval '1 hour'
where id = 'c7000000-0000-4000-8000-000000000001';
update callback_authority_probe set action = 'revoked_session', calls = 0;
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'session_revoked',
  'acceptance rejects application revocation committed between its authority checks'
);
reset role;
delete from desmoslock_v2.application_session_revocations
where user_id = 'a7000000-0000-4000-8000-000000000001';

update callback_authority_probe set action = 'elapsed_invitation', calls = 0;
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000001', 'Callback recipient'
  )),
  'invitation_expired',
  'acceptance uses the wall clock after serialized checks, not statement start'
);
reset role;
select is(
  (select count(*) from desmoslock_v2.profiles
    where auth_user_id = 'a7000000-0000-4000-8000-000000000001'),
  0::bigint,
  'every failed post-lock revalidation leaves the recipient unbound'
);
select is(
  (select count(*) from desmoslock_v2.staff_audit_events
    where invitation_id = 'd7000000-0000-4000-8000-000000000001'
      and event_type = 'invitation_accepted'),
  0::bigint,
  'failed revalidation never emits an acceptance audit event'
);

drop function desmoslock_v2.internal_authenticated_staff_session(boolean);
alter function desmoslock_v2.callback_fixture_original_staff_session(boolean)
  rename to internal_authenticated_staff_session;

-- A separate prepared attempt exercises the real, restored helper and provider
-- rejection metadata. The diagnostic is never an authority or callback secret.
insert into desmoslock_v2.staff_invitations (
  id, workspace_id, requested_by_profile_id, request_key,
  invited_email_normalized, invited_user_id, role, status,
  delivery_lease_expires_at, expires_at
) values (
  'd7000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000002',
  'callback-race@staff.invalid',
  'a7000000-0000-4000-8000-000000000001',
  'teacher', 'delivery_ready',
  clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour'
);
set local role service_role;
select is(
  (select code from desmoslock_v2.internal_fail_staff_invitation(
    'd7000000-0000-4000-8000-000000000002', 'delivery_rejected'
  )),
  'invitation_delivery_ready',
  'a provider rejection retains prepared binding and expiry'
);
select is(
  (select code from desmoslock_v2.internal_fail_staff_invitation(
    'd7000000-0000-4000-8000-000000000002', 'arbitrary provider response'
  )),
  'invalid_request',
  'delivery diagnostics reject arbitrary provider text'
);
reset role;
select results_eq(
  $$select status, failure_reason_code from desmoslock_v2.staff_invitations
    where id = 'd7000000-0000-4000-8000-000000000002'$$,
  $$values ('delivery_ready'::text, 'delivery_rejected'::text)$$,
  'prepared delivery diagnostics are bounded and persisted'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.accept_staff_invitation(
    'd7000000-0000-4000-8000-000000000002', 'Callback recipient'
  )),
  'invitation_accepted',
  'a verified exact recipient can accept a live prepared invitation'
);
reset role;
select results_eq(
  $$select status, failure_reason_code from desmoslock_v2.staff_invitations
    where id = 'd7000000-0000-4000-8000-000000000002'$$,
  $$values ('accepted'::text, null::text)$$,
  'acceptance clears delivery diagnostics atomically'
);

-- Model a pre-begin provider-session transaction that becomes visible only
-- after the concrete sweep. The account cutoff must reject it independently.
insert into auth.mfa_amr_claims (
  id, session_id, created_at, updated_at, authentication_method
) values (
  'e7000000-0000-4000-8000-000000000001',
  'c7000000-0000-4000-8000-000000000001',
  clock_timestamp(), clock_timestamp(), 'recovery'
);
set local role authenticated;
select is(
  (select code from desmoslock_v2.begin_staff_password_recovery(
    'f7000000-0000-4000-8000-000000000003'
  )),
  'recovery_sessions_revoked',
  'recovery begins for the exact provider recovery session'
);
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
select
  'c7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000001',
  operation.started_at - interval '1 second', clock_timestamp(), 'aal1',
  clock_timestamp() + interval '1 hour'
from desmoslock_v2.staff_password_recovery_operations as operation
where operation.id = 'f7000000-0000-4000-8000-000000000003';
select is(
  (select count(*) from desmoslock_v2.application_session_revocations
    where session_id = 'c7000000-0000-4000-8000-000000000002'),
  0::bigint,
  'the late-visible provider session was absent from the concrete begin sweep'
);
select set_config('request.jwt.claims', (
  current_setting('request.jwt.claims')::jsonb || jsonb_build_object(
    'session_id', 'c7000000-0000-4000-8000-000000000002'
  )
)::text, true);
set local role authenticated;
select is(
  (select code from desmoslock_v2.current_staff_context()),
  'session_revoked',
  'the begin cutoff rejects a late-visible old session before cleanup completion'
);
reset role;

-- Invitation begin uses the same deterministic fault-injection approach for
-- waits on request rows, open attempts, and insertion uniqueness. These probes
-- verify fresh authority/clock decisions; they are not concurrent connections.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'a7000000-0000-4000-8000-000000000009',
  'authenticated', 'authenticated', 'callback-owner@staff.invalid', '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
  clock_timestamp(), clock_timestamp()
);
insert into auth.mfa_factors (
  id, user_id, friendly_name, factor_type, status, created_at, updated_at
) values (
  'b7000000-0000-4000-8000-000000000009',
  'a7000000-0000-4000-8000-000000000009',
  'Synthetic callback Owner factor', 'totp', 'verified',
  clock_timestamp(), clock_timestamp()
);
insert into auth.sessions (
  id, user_id, created_at, updated_at, factor_id, aal, not_after
) values (
  'c7000000-0000-4000-8000-000000000009',
  'a7000000-0000-4000-8000-000000000009',
  clock_timestamp(), clock_timestamp(),
  'b7000000-0000-4000-8000-000000000009', 'aal2',
  clock_timestamp() + interval '1 hour'
);
-- Bind only this transaction's seeded Owner fixture.
update desmoslock_v2.profiles
set auth_user_id = 'a7000000-0000-4000-8000-000000000009'
where id = '20000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'a7000000-0000-4000-8000-000000000009',
  'session_id', 'c7000000-0000-4000-8000-000000000009',
  'role', 'authenticated', 'aal', 'aal2',
  'exp', floor(extract(epoch from clock_timestamp() + interval '1 hour'))::bigint
)::text, true);

create temporary table callback_invitation_begin_probe (
  action text not null,
  calls integer not null default 0,
  mutation_call integer not null,
  target_invitation_id uuid,
  observed_at timestamp with time zone,
  winner_state jsonb
) on commit drop;
insert into callback_invitation_begin_probe (action, mutation_call)
values ('revoked_membership', 2);
create temporary table callback_invitation_begin_snapshots (
  label text primary key,
  state jsonb not null
) on commit drop;

alter function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  rename to callback_fixture_original_authorize_staff;
create function desmoslock_v2.internal_authorize_staff(
  workspace_id uuid,
  allowed_roles text[],
  require_step_up boolean
)
returns table (
  code text, user_id uuid, session_id uuid, profile_id uuid,
  membership_role text, role_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  probe record;
begin
  update pg_temp.callback_invitation_begin_probe set calls = calls + 1
  returning * into probe;
  if probe.action = 'elapsed_replay' and probe.calls = 1 then
    -- The exact request row is copied after this check and before the delay.
    update desmoslock_v2.staff_invitations
    set delivery_lease_expires_at = clock_timestamp() + interval '0.05 seconds'
    where id = probe.target_invitation_id;
  end if;
  if probe.calls = probe.mutation_call then
    case probe.action
      when 'revoked_membership' then
        update desmoslock_v2.memberships
        set status = 'revoked', role_revision = memberships.role_revision + 1,
          revoked_at = clock_timestamp(),
          revoked_by_profile_id = '20000000-0000-4000-8000-000000000001',
          revocation_reason_code = 'owner_action'
        where memberships.workspace_id = '10000000-0000-4000-8000-000000000001'
          and memberships.profile_id = '20000000-0000-4000-8000-000000000001';
      when 'expired_session' then
        update auth.sessions set not_after = clock_timestamp() - interval '1 second'
        where id = 'c7000000-0000-4000-8000-000000000009';
      when 'unverified_factor' then
        update auth.mfa_factors set status = 'unverified'
        where id = 'b7000000-0000-4000-8000-000000000009';
      when 'elapsed_replay' then
        perform pg_sleep(0.1);
      when 'delayed_mint' then
        perform pg_sleep(0.1);
        update pg_temp.callback_invitation_begin_probe
        set observed_at = clock_timestamp();
      when 'unique_competitor' then
        -- Call 3 precedes the contained INSERT, so this fixture survives the
        -- unique-violation rollback and is seen by exact-request reconciliation.
        insert into desmoslock_v2.staff_invitations (
          id, workspace_id, requested_by_profile_id, request_key,
          invited_email_normalized, role, status,
          requested_at, updated_at, delivery_lease_expires_at
        ) values (
          'd7000000-0000-4000-8000-000000000094',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'f7000000-0000-4000-8000-000000000094',
          'begin-unique@staff.invalid', 'teacher', 'pending_delivery',
          clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '5 minutes'
        );
        update pg_temp.callback_invitation_begin_probe
        set winner_state = (
          select to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
          from desmoslock_v2.staff_invitations as invitation
          where invitation.id = 'd7000000-0000-4000-8000-000000000094'
        );
      else
        null;
    end case;
  end if;
  if probe.action = 'unique_competitor' and probe.calls = 4 then
    update auth.sessions set not_after = clock_timestamp() - interval '1 second'
    where id = 'c7000000-0000-4000-8000-000000000009';
  end if;
  return query select *
  from desmoslock_v2.callback_fixture_original_authorize_staff($1, $2, $3);
end;
$$;
revoke all on function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  from public, anon, authenticated, service_role;

set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-denied@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000090'
  )$$,
  $$values ('membership_inactive'::text, null::uuid)$$,
  'new invitation mint rejects Owner membership loss after the exact-request lookup'
);
reset role;
select results_eq(
  $$select
    (select count(*) from desmoslock_v2.staff_invitations
      where request_key = 'f7000000-0000-4000-8000-000000000090'),
    (select count(*) from desmoslock_v2.staff_audit_events
      where event_type = 'invitation_requested'
        and actor_profile_id = '20000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 0::bigint)$$,
  'post-lookup membership denial creates no invitation or request audit'
);
update desmoslock_v2.memberships
set status = 'active', revoked_at = null, revoked_by_profile_id = null,
  revocation_reason_code = null
where workspace_id = '10000000-0000-4000-8000-000000000001'
  and profile_id = '20000000-0000-4000-8000-000000000001';

insert into desmoslock_v2.staff_invitations (
  id, workspace_id, requested_by_profile_id, request_key,
  invited_email_normalized, role, status,
  requested_at, updated_at, delivery_lease_expires_at
) values (
  'd7000000-0000-4000-8000-000000000091',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000091',
  'begin-replay@staff.invalid', 'teacher', 'pending_delivery',
  clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '5 minutes'
);
insert into callback_invitation_begin_snapshots (label, state)
select 'replay', to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
from desmoslock_v2.staff_invitations as invitation
where invitation.id = 'd7000000-0000-4000-8000-000000000091';
update callback_invitation_begin_probe
set action = 'expired_session', calls = 0, mutation_call = 2;
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-replay@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000091'
  )$$,
  $$values ('session_expired'::text, null::uuid)$$,
  'exact-request replay rejects a provider session that expires after lookup'
);
reset role;
update auth.sessions set not_after = clock_timestamp() + interval '1 hour'
where id = 'c7000000-0000-4000-8000-000000000009';
update callback_invitation_begin_probe
set action = 'unverified_factor', calls = 0, mutation_call = 2;
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-replay@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000091'
  )$$,
  $$values ('step_up_required'::text, null::uuid)$$,
  'exact-request replay rejects TOTP verification lost after lookup'
);
reset role;
select is(
  (select to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = 'd7000000-0000-4000-8000-000000000091'),
  (select state from callback_invitation_begin_snapshots where label = 'replay'),
  'denied session and MFA replays leave the exact pending invitation unchanged'
);
select is(
  (select count(*) from desmoslock_v2.staff_audit_events
    where invitation_id = 'd7000000-0000-4000-8000-000000000091'),
  0::bigint,
  'denied exact-request replays emit no audit event'
);
update auth.mfa_factors set status = 'verified'
where id = 'b7000000-0000-4000-8000-000000000009';

insert into desmoslock_v2.staff_invitations (
  id, workspace_id, requested_by_profile_id, request_key,
  invited_email_normalized, role, status,
  requested_at, updated_at, delivery_lease_expires_at
) values (
  'd7000000-0000-4000-8000-000000000092',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000092',
  'begin-open@staff.invalid', 'teacher', 'pending_delivery',
  clock_timestamp() - interval '6 minutes', clock_timestamp() - interval '6 minutes',
  clock_timestamp() - interval '1 minute'
);
insert into callback_invitation_begin_snapshots (label, state)
select 'expired-open', to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
from desmoslock_v2.staff_invitations as invitation
where invitation.id = 'd7000000-0000-4000-8000-000000000092';
update callback_invitation_begin_probe
set action = 'revoked_membership', calls = 0, mutation_call = 3;
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-open@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000192'
  )$$,
  $$values ('membership_inactive'::text, null::uuid)$$,
  'open-attempt reconciliation rejects Owner authority lost after its candidate lock'
);
reset role;
select is(
  (select to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = 'd7000000-0000-4000-8000-000000000092'),
  (select state from callback_invitation_begin_snapshots where label = 'expired-open'),
  'post-candidate denial does not terminalize the elapsed open attempt'
);
select results_eq(
  $$select
    (select count(*) from desmoslock_v2.staff_invitations
      where request_key = 'f7000000-0000-4000-8000-000000000192'),
    (select count(*) from desmoslock_v2.staff_audit_events
      where invitation_id = 'd7000000-0000-4000-8000-000000000092')$$,
  $$values (0::bigint, 0::bigint)$$,
  'post-candidate denial creates neither a replacement nor an expiry audit'
);
update desmoslock_v2.memberships
set status = 'active', revoked_at = null, revoked_by_profile_id = null,
  revocation_reason_code = null
where workspace_id = '10000000-0000-4000-8000-000000000001'
  and profile_id = '20000000-0000-4000-8000-000000000001';

update callback_invitation_begin_probe
set action = 'expired_session', calls = 0, mutation_call = 4;
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-insert-denied@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000095'
  )$$,
  $$values ('session_expired'::text, null::uuid)$$,
  'successful INSERT still denies authority lost during its wait'
);
reset role;
-- The contained denial also rolls back the synthetic session/probe mutation;
-- only the returned denial and missing product effects establish this contract.
select results_eq(
  $$select
    (select count(*) from desmoslock_v2.staff_invitations
      where request_key = 'f7000000-0000-4000-8000-000000000095'),
    (select count(*) from desmoslock_v2.staff_audit_events
      where event_type = 'invitation_requested'
        and actor_profile_id = '20000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 0::bigint)$$,
  'post-insert authority denial rolls back the invitation and emits no request audit'
);

update callback_invitation_begin_probe
set action = 'unique_competitor', calls = 0, mutation_call = 3;
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-unique@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000094'
  )$$,
  $$values ('session_expired'::text, null::uuid)$$,
  'uniqueness reconciliation rechecks the session after locking the injected winner'
);
reset role;
select is(
  (select to_jsonb(invitation) || jsonb_build_object('tuple', invitation.ctid::text)
    from desmoslock_v2.staff_invitations as invitation
    where invitation.id = 'd7000000-0000-4000-8000-000000000094'),
  (select winner_state from callback_invitation_begin_probe),
  'denied uniqueness reconciliation preserves the exact competing pending row'
);
select is(
  (select count(*) from desmoslock_v2.staff_audit_events
    where invitation_id = 'd7000000-0000-4000-8000-000000000094'),
  0::bigint,
  'denied uniqueness reconciliation adds no request audit for the injected winner'
);
update auth.sessions set not_after = clock_timestamp() + interval '1 hour'
where id = 'c7000000-0000-4000-8000-000000000009';

insert into desmoslock_v2.staff_invitations (
  id, workspace_id, requested_by_profile_id, request_key,
  invited_email_normalized, role, status,
  requested_at, updated_at, delivery_lease_expires_at
) values (
  'd7000000-0000-4000-8000-000000000093',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000093',
  'begin-lease@staff.invalid', 'teacher', 'pending_delivery',
  clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '5 minutes'
);
update callback_invitation_begin_probe
set action = 'elapsed_replay', calls = 0, mutation_call = 2,
  target_invitation_id = 'd7000000-0000-4000-8000-000000000093';
set local role authenticated;
select results_eq(
  $$select code, invitation_id from desmoslock_v2.begin_staff_invitation(
    '10000000-0000-4000-8000-000000000001', 'begin-lease@staff.invalid',
    'teacher', 'f7000000-0000-4000-8000-000000000093'
  )$$,
  $$values ('conflict'::text, null::uuid)$$,
  'exact lease replay uses the post-wait clock instead of returning stale delivery authority'
);
reset role;
select results_eq(
  $$select status, failure_reason_code from desmoslock_v2.staff_invitations
    where id = 'd7000000-0000-4000-8000-000000000093'$$,
  $$values ('delivery_failed'::text, 'delivery_lease_expired'::text)$$,
  'a lease that expires during lookup is terminalized after the wait'
);
select is(
  (select count(*) from desmoslock_v2.staff_audit_events
    where invitation_id = 'd7000000-0000-4000-8000-000000000093'
      and event_type = 'invitation_delivery_failed'),
  1::bigint,
  'elapsed replay emits exactly one bounded delivery-failure audit'
);

update callback_invitation_begin_probe
set action = 'delayed_mint', calls = 0, mutation_call = 4, observed_at = null;
set local role authenticated;
select results_eq(
  $$select code, invitation_id is not null
    from desmoslock_v2.begin_staff_invitation(
      '10000000-0000-4000-8000-000000000001', 'begin-delayed-mint@staff.invalid',
      'teacher', 'f7000000-0000-4000-8000-000000000096'
    )$$,
  $$values ('invitation_pending'::text, true)$$,
  'a successful delayed INSERT mints a pending invitation after fresh authorization'
);
reset role;
select results_eq(
  $$select invitation.requested_at >= probe.observed_at,
      invitation.updated_at = invitation.requested_at,
      invitation.delivery_lease_expires_at = invitation.requested_at + interval '5 minutes'
    from desmoslock_v2.staff_invitations as invitation
    cross join callback_invitation_begin_probe as probe
    where invitation.request_key = 'f7000000-0000-4000-8000-000000000096'$$,
  $$values (true, true, true)$$,
  'successful mint starts its exact five-minute lease after the final insertion delay'
);
select is(
  (select count(*) from desmoslock_v2.staff_audit_events as event
    join desmoslock_v2.staff_invitations as invitation
      on invitation.id = event.invitation_id
    where invitation.request_key = 'f7000000-0000-4000-8000-000000000096'
      and event.event_type = 'invitation_requested'),
  1::bigint,
  'successful delayed mint emits one request audit'
);

drop function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean);
alter function desmoslock_v2.callback_fixture_original_authorize_staff(uuid, text[], boolean)
  rename to internal_authorize_staff;

select * from finish();
rollback;
