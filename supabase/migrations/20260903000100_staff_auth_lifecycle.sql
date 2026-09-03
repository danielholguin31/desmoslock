-- Controlled staff enrollment and recovery for the generation-3 internal baseline.
-- Auth identities, sessions, MFA factors, School roles, and application revocations
-- are re-read at every protected database boundary. JWT role metadata is never an
-- authorization source.

alter table desmoslock_v2.workspaces alter column seed_key drop not null;
alter table desmoslock_v2.profiles alter column seed_key drop not null;
alter table desmoslock_v2.memberships alter column seed_key drop not null;
alter table desmoslock_v2.tests alter column seed_key drop not null;
alter table desmoslock_v2.student_sessions alter column seed_key drop not null;

alter table desmoslock_v2.profiles
  add column auth_user_id uuid,
  add constraint profiles_auth_user_id_unique unique (auth_user_id),
  add constraint profiles_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users (id) on delete restrict;

alter table desmoslock_v2.memberships
  add column status text not null default 'active',
  add column role_revision bigint not null default 1,
  add column accepted_at timestamp with time zone,
  add column revoked_at timestamp with time zone,
  add column revoked_by_profile_id uuid,
  add column revocation_reason_code text,
  add column updated_at timestamp with time zone,
  add constraint memberships_status_check
    check (status in ('active', 'revoked')),
  add constraint memberships_role_revision_check
    check (role_revision > 0),
  add constraint memberships_revoked_by_profile_id_fkey
    foreign key (revoked_by_profile_id)
    references desmoslock_v2.profiles (id) on delete restrict,
  add constraint memberships_revocation_reason_check
    check (
      revocation_reason_code is null
      or revocation_reason_code in ('owner_action')
    ),
  add constraint memberships_lifecycle_check
    check (
      (
        status = 'active'
        and revoked_at is null
        and revoked_by_profile_id is null
        and revocation_reason_code is null
      )
      or (
        status = 'revoked'
        and revoked_at is not null
        and revoked_by_profile_id is not null
        and revocation_reason_code is not null
      )
    );

create table desmoslock_v2.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  requested_by_profile_id uuid not null,
  invited_email_normalized text not null,
  invited_user_id uuid references auth.users (id) on delete restrict,
  role text not null,
  status text not null,
  revision bigint not null default 1,
  requested_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone,
  accepted_at timestamp with time zone,
  accepted_profile_id uuid unique references desmoslock_v2.profiles (id) on delete restrict,
  revoked_at timestamp with time zone,
  revoked_by_profile_id uuid references desmoslock_v2.profiles (id) on delete restrict,
  failure_reason_code text,
  constraint staff_invitations_requester_membership_fkey
    foreign key (workspace_id, requested_by_profile_id)
    references desmoslock_v2.memberships (workspace_id, profile_id)
    on delete restrict,
  constraint staff_invitations_role_check
    check (role in ('admin', 'teacher')),
  constraint staff_invitations_status_check
    check (
      status in (
        'pending_delivery',
        'delivery_ready',
        'pending_acceptance',
        'accepted',
        'revoked',
        'delivery_failed',
        'expired'
      )
    ),
  constraint staff_invitations_revision_check check (revision > 0),
  constraint staff_invitations_email_check
    check (
      invited_email_normalized = lower(btrim(invited_email_normalized))
      and octet_length(invited_email_normalized) between 3 and 320
      and invited_email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      and invited_email_normalized !~ '[[:cntrl:]]'
    ),
  constraint staff_invitations_failure_reason_check
    check (
      failure_reason_code is null
      or failure_reason_code in ('dependency_unavailable', 'invalid_request')
    ),
  constraint staff_invitations_lifecycle_check
    check (
      (
        status = 'pending_delivery'
        and invited_user_id is null
        and expires_at is null
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is null
      )
      or (
        status = 'delivery_ready'
        and invited_user_id is not null
        and expires_at is not null
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is null
      )
      or (
        status = 'pending_acceptance'
        and invited_user_id is not null
        and expires_at is not null
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is null
      )
      or (
        status = 'accepted'
        and invited_user_id is not null
        and expires_at is not null
        and accepted_at is not null
        and accepted_profile_id is not null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is null
      )
      or (
        status = 'revoked'
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is not null
        and revoked_by_profile_id is not null
        and failure_reason_code is null
      )
      or (
        status = 'delivery_failed'
        and invited_user_id is null
        and expires_at is null
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is not null
      )
      or (
        status = 'expired'
        and invited_user_id is not null
        and expires_at is not null
        and accepted_at is null
        and accepted_profile_id is null
        and revoked_at is null
        and revoked_by_profile_id is null
        and failure_reason_code is null
      )
    )
);

create unique index staff_invitations_one_open_email_per_school
  on desmoslock_v2.staff_invitations (workspace_id, invited_email_normalized)
  where status in ('pending_delivery', 'delivery_ready', 'pending_acceptance');

create unique index staff_invitations_one_open_user_per_school
  on desmoslock_v2.staff_invitations (workspace_id, invited_user_id)
  where status in ('delivery_ready', 'pending_acceptance');

create table desmoslock_v2.application_session_revocations (
  user_id uuid not null references auth.users (id) on delete restrict,
  session_id uuid not null,
  workspace_id uuid not null references desmoslock_v2.workspaces (id) on delete restrict,
  revoked_by_profile_id uuid not null references desmoslock_v2.profiles (id) on delete restrict,
  reason_code text not null,
  revoked_at timestamp with time zone not null default now(),
  primary key (user_id, session_id),
  constraint application_session_revocations_reason_check
    check (reason_code in ('current_session', 'account_recovery'))
);

create index application_session_revocations_session_lookup
  on desmoslock_v2.application_session_revocations (session_id, user_id);

create table desmoslock_v2.staff_audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamp with time zone not null default now(),
  event_type text not null,
  result_code text not null,
  workspace_id uuid references desmoslock_v2.workspaces (id) on delete restrict,
  actor_profile_id uuid references desmoslock_v2.profiles (id) on delete restrict,
  subject_profile_id uuid references desmoslock_v2.profiles (id) on delete restrict,
  invitation_id uuid references desmoslock_v2.staff_invitations (id) on delete restrict,
  session_id uuid,
  constraint staff_audit_events_type_check
    check (
      event_type in (
        'initial_owner_bound',
        'invitation_requested',
        'invitation_delivery_ready',
        'invitation_ready',
        'invitation_delivery_failed',
        'invitation_accepted',
        'invitation_expired',
        'invitation_revoked',
        'membership_revoked',
        'session_revoked',
        'account_recovery'
      )
    ),
  constraint staff_audit_events_result_check
    check (
      result_code in (
        'ok',
        'initial_owner_bound',
        'invitation_pending',
        'invitation_delivery_ready',
        'invitation_usable',
        'invitation_delivery_failed',
        'invitation_accepted',
        'invitation_expired',
        'invitation_revoked',
        'membership_revoked'
      )
    )
);

alter table desmoslock_v2.staff_invitations enable row level security;
alter table desmoslock_v2.application_session_revocations enable row level security;
alter table desmoslock_v2.staff_audit_events enable row level security;

revoke all on table desmoslock_v2.staff_invitations
  from public, anon, authenticated, service_role;
revoke all on table desmoslock_v2.application_session_revocations
  from public, anon, authenticated, service_role;
revoke all on table desmoslock_v2.staff_audit_events
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_reject_staff_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'staff audit events are append-only';
end;
$$;

revoke all on function desmoslock_v2.internal_reject_staff_audit_mutation()
  from public, anon, authenticated, service_role;

create trigger staff_audit_events_append_only
before update or delete on desmoslock_v2.staff_audit_events
for each row execute function desmoslock_v2.internal_reject_staff_audit_mutation();

create trigger staff_audit_events_no_truncate
before truncate on desmoslock_v2.staff_audit_events
for each statement execute function desmoslock_v2.internal_reject_staff_audit_mutation();

create function desmoslock_v2.internal_normalize_staff_email(candidate text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when octet_length(btrim(candidate)) between 3 and 320
      and lower(btrim(candidate)) ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      and lower(btrim(candidate)) !~ '[[:cntrl:]]'
    then lower(btrim(candidate))
    else null
  end;
$$;

revoke all on function desmoslock_v2.internal_normalize_staff_email(text)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_request_session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(auth.jwt() ->> 'session_id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid
    else null
  end;
$$;

revoke all on function desmoslock_v2.internal_request_session_id()
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_current_profile()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select profile.id
  from desmoslock_v2.profiles as profile
  where profile.auth_user_id = (select auth.uid());
$$;

revoke all on function desmoslock_v2.internal_current_profile()
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_active_membership(workspace_id uuid)
returns table (
  profile_id uuid,
  membership_role text,
  role_revision bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select membership.profile_id, membership.role, membership.role_revision
  from desmoslock_v2.memberships as membership
  join desmoslock_v2.profiles as profile on profile.id = membership.profile_id
  where profile.auth_user_id = (select auth.uid())
    and membership.workspace_id = $1
    and membership.status = 'active';
$$;

revoke all on function desmoslock_v2.internal_active_membership(uuid)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_authenticated_staff_session(
  require_step_up boolean
)
returns table (
  code text,
  user_id uuid,
  session_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  request_jwt jsonb;
  current_user_id uuid;
  current_session_id uuid;
  current_email_confirmed_at timestamp with time zone;
  current_user_deleted_at timestamp with time zone;
  current_user_banned_until timestamp with time zone;
  current_session_aal text;
  current_session_factor_id uuid;
  jwt_expiration text;
begin
  request_jwt := auth.jwt();
  current_user_id := auth.uid();
  current_session_id := desmoslock_v2.internal_request_session_id();

  if current_user_id is null then
    return query select 'unauthenticated'::text, null::uuid, null::uuid;
    return;
  end if;

  select
    auth_user.email_confirmed_at,
    auth_user.deleted_at,
    auth_user.banned_until
  into
    current_email_confirmed_at,
    current_user_deleted_at,
    current_user_banned_until
  from auth.users as auth_user
  where auth_user.id = current_user_id;

  if not found or current_user_deleted_at is not null
    or (
      current_user_banned_until is not null
      and current_user_banned_until > statement_timestamp()
    )
  then
    return query select 'unauthenticated'::text, null::uuid, null::uuid;
    return;
  end if;

  if current_email_confirmed_at is null then
    return query select 'email_unverified'::text, current_user_id, null::uuid;
    return;
  end if;

  jwt_expiration := request_jwt ->> 'exp';
  if current_session_id is null
    or jwt_expiration is null
    or jwt_expiration !~ '^[0-9]{1,20}$'
    or jwt_expiration::numeric <= extract(epoch from statement_timestamp())
  then
    return query select 'session_expired'::text, current_user_id, null::uuid;
    return;
  end if;

  select auth_session.aal::text, auth_session.factor_id
  into current_session_aal, current_session_factor_id
  from auth.sessions as auth_session
  where auth_session.id = current_session_id
    and auth_session.user_id = current_user_id
    and (
      auth_session.not_after is null
      or auth_session.not_after > statement_timestamp()
    );

  if not found then
    return query
      select 'session_expired'::text, current_user_id, current_session_id;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.application_session_revocations as revocation
    where revocation.user_id = current_user_id
      and revocation.session_id = current_session_id
  ) then
    return query
      select 'session_revoked'::text, current_user_id, current_session_id;
    return;
  end if;

  if require_step_up and (
    coalesce(request_jwt ->> 'aal', '') <> 'aal2'
    or coalesce(current_session_aal, '') <> 'aal2'
    or current_session_factor_id is null
    or not exists (
      select 1
      from auth.mfa_factors as factor
      where factor.id = current_session_factor_id
        and factor.user_id = current_user_id
        and factor.factor_type::text = 'totp'
        and factor.status::text = 'verified'
    )
  ) then
    return query
      select 'step_up_required'::text, current_user_id, current_session_id;
    return;
  end if;

  return query select 'ok'::text, current_user_id, current_session_id;
end;
$$;

revoke all on function desmoslock_v2.internal_authenticated_staff_session(boolean)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_authorize_staff(
  workspace_id uuid,
  allowed_roles text[],
  require_step_up boolean
)
returns table (
  code text,
  user_id uuid,
  session_id uuid,
  profile_id uuid,
  membership_role text,
  role_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_result record;
  membership_result record;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session($3);

  if session_result.code <> 'ok' then
    return query select
      session_result.code,
      session_result.user_id,
      session_result.session_id,
      null::uuid,
      null::text,
      null::bigint;
    return;
  end if;

  select *
  into membership_result
  from desmoslock_v2.internal_active_membership($1);

  if not found then
    return query select
      'membership_inactive'::text,
      session_result.user_id,
      session_result.session_id,
      desmoslock_v2.internal_current_profile(),
      null::text,
      null::bigint;
    return;
  end if;

  if $2 is null
    or cardinality($2) = 0
    or not (membership_result.membership_role = any($2))
  then
    return query select
      'forbidden'::text,
      session_result.user_id,
      session_result.session_id,
      membership_result.profile_id,
      membership_result.membership_role,
      membership_result.role_revision;
    return;
  end if;

  return query select
    'ok'::text,
    session_result.user_id,
    session_result.session_id,
    membership_result.profile_id,
    membership_result.membership_role,
    membership_result.role_revision;
end;
$$;

revoke all on function desmoslock_v2.internal_authorize_staff(uuid, text[], boolean)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_append_auth_event(
  event_name text,
  outcome_code text,
  event_workspace_id uuid,
  event_actor_profile_id uuid,
  event_subject_profile_id uuid,
  event_invitation_id uuid,
  event_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_event_id uuid;
begin
  insert into desmoslock_v2.staff_audit_events (
    event_type,
    result_code,
    workspace_id,
    actor_profile_id,
    subject_profile_id,
    invitation_id,
    session_id
  ) values (
    event_name,
    outcome_code,
    event_workspace_id,
    event_actor_profile_id,
    event_subject_profile_id,
    event_invitation_id,
    event_session_id
  )
  returning id into inserted_event_id;

  return inserted_event_id;
end;
$$;

revoke all on function desmoslock_v2.internal_append_auth_event(
  text, text, uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_bind_initial_owner(
  workspace_id uuid,
  profile_id uuid,
  auth_user_id uuid
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_auth_user_id uuid;
  auth_user_email_confirmed_at timestamp with time zone;
  auth_user_deleted_at timestamp with time zone;
  auth_user_banned_until timestamp with time zone;
begin
  if $1 is null or $2 is null or $3 is null then
    return query select 'invalid_request'::text;
    return;
  end if;

  perform 1
  from desmoslock_v2.workspaces as workspace
  where workspace.id = $1
    and workspace.seed_key is not null
  for update;

  if not found then
    return query select 'invalid_request'::text;
    return;
  end if;

  select profile.auth_user_id
  into target_auth_user_id
  from desmoslock_v2.profiles as profile
  join desmoslock_v2.memberships as membership
    on membership.profile_id = profile.id
  where profile.id = $2
    and membership.workspace_id = $1
    and profile.seed_key is not null
    and membership.seed_key is not null
    and membership.role = 'owner'
    and membership.status = 'active'
  for update of profile, membership;

  if not found then
    return query select 'invalid_request'::text;
    return;
  end if;

  select
    auth_user.email_confirmed_at,
    auth_user.deleted_at,
    auth_user.banned_until
  into
    auth_user_email_confirmed_at,
    auth_user_deleted_at,
    auth_user_banned_until
  from auth.users as auth_user
  where auth_user.id = $3
  for update;

  if not found
    or auth_user_deleted_at is not null
    or (
      auth_user_banned_until is not null
      and auth_user_banned_until > statement_timestamp()
    )
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  if auth_user_email_confirmed_at is null then
    return query select 'email_unverified'::text;
    return;
  end if;

  if target_auth_user_id is not null and target_auth_user_id <> $3 then
    return query select 'conflict'::text;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = $3
      and profile.id <> $2
  ) then
    return query select 'conflict'::text;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.memberships as membership
    join desmoslock_v2.profiles as profile
      on profile.id = membership.profile_id
    where membership.workspace_id = $1
      and membership.role = 'owner'
      and membership.status = 'active'
      and profile.auth_user_id is not null
      and profile.id <> $2
  ) then
    return query select 'conflict'::text;
    return;
  end if;

  if target_auth_user_id = $3 then
    return query select 'initial_owner_bound'::text;
    return;
  end if;

  begin
    update desmoslock_v2.profiles as profile
    set auth_user_id = $3
    where profile.id = $2
      and profile.auth_user_id is null;
  exception
    when unique_violation then
      return query select 'conflict'::text;
      return;
  end;

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'initial_owner_bound',
    'initial_owner_bound',
    $1,
    null,
    $2,
    null,
    null
  );

  return query select 'initial_owner_bound'::text;
end;
$$;

revoke all on function desmoslock_v2.internal_bind_initial_owner(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.internal_bind_initial_owner(uuid, uuid, uuid)
  to service_role;

create function desmoslock_v2.current_staff_context()
returns table (
  code text,
  profile_id uuid,
  school_id uuid,
  school_slug text,
  school_name text,
  membership_role text,
  role_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_result record;
  current_profile_id uuid;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(false);

  if session_result.code <> 'ok' then
    return query select
      session_result.code,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::bigint;
    return;
  end if;

  current_profile_id := desmoslock_v2.internal_current_profile();
  if current_profile_id is null then
    return query select
      'membership_inactive'::text,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::bigint;
    return;
  end if;

  return query
  select
    'ok'::text,
    current_profile_id,
    workspace.id,
    workspace.slug,
    workspace.display_name,
    membership.role,
    membership.role_revision
  from desmoslock_v2.memberships as membership
  join desmoslock_v2.workspaces as workspace
    on workspace.id = membership.workspace_id
  where membership.profile_id = current_profile_id
    and membership.status = 'active'
  order by workspace.slug;

  if not found then
    return query select
      'membership_inactive'::text,
      current_profile_id,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::bigint;
  end if;
end;
$$;

revoke all on function desmoslock_v2.current_staff_context()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_staff_context() to authenticated;

create function desmoslock_v2.current_staff_invitations()
returns table (
  code text,
  invitation_id uuid,
  school_id uuid,
  school_name text,
  invited_role text,
  expires_at timestamp with time zone
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_result record;
  current_email_normalized text;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(false);

  if session_result.code <> 'ok' then
    return query select
      session_result.code,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::timestamp with time zone;
    return;
  end if;

  select desmoslock_v2.internal_normalize_staff_email(auth_user.email)
  into current_email_normalized
  from auth.users as auth_user
  where auth_user.id = session_result.user_id;

  return query
  select
    'ok'::text,
    invitation.id,
    workspace.id,
    workspace.display_name,
    invitation.role,
    invitation.expires_at
  from desmoslock_v2.staff_invitations as invitation
  join desmoslock_v2.workspaces as workspace
    on workspace.id = invitation.workspace_id
  where invitation.invited_user_id = session_result.user_id
    and invitation.invited_email_normalized = current_email_normalized
    and invitation.status = 'pending_acceptance'
    and invitation.expires_at > statement_timestamp()
  order by invitation.requested_at, invitation.id;

  if not found then
    return query select
      'invitation_not_found'::text,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::timestamp with time zone;
  end if;
end;
$$;

revoke all on function desmoslock_v2.current_staff_invitations()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_staff_invitations() to authenticated;

create function desmoslock_v2.begin_staff_invitation(
  workspace_id uuid,
  email text,
  role text
)
returns table (
  code text,
  invitation_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  normalized_email text;
  new_invitation_id uuid;
  expired_invitation desmoslock_v2.staff_invitations%rowtype;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1,
    array['owner']::text[],
    true
  );

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid;
    return;
  end if;

  normalized_email := desmoslock_v2.internal_normalize_staff_email($2);
  if normalized_email is null
    or $3 is null
    or $3 not in ('admin', 'teacher')
  then
    return query select 'invalid_request'::text, null::uuid;
    return;
  end if;

  for expired_invitation in
    select invitation.*
    from desmoslock_v2.staff_invitations as invitation
    where invitation.workspace_id = $1
      and invitation.invited_email_normalized = normalized_email
      and invitation.status in ('delivery_ready', 'pending_acceptance')
      and invitation.expires_at <= statement_timestamp()
    order by invitation.id
    for update
  loop
    update desmoslock_v2.staff_invitations as invitation
    set
      status = 'expired',
      revision = invitation.revision + 1,
      updated_at = statement_timestamp()
    where invitation.id = expired_invitation.id
      and invitation.revision = expired_invitation.revision
      and invitation.status = expired_invitation.status;

    if found then
      perform desmoslock_v2.internal_append_auth_event(
        'invitation_expired',
        'invitation_expired',
        expired_invitation.workspace_id,
        authorization_result.profile_id,
        null,
        expired_invitation.id,
        authorization_result.session_id
      );
    end if;
  end loop;

  begin
    insert into desmoslock_v2.staff_invitations (
      workspace_id,
      requested_by_profile_id,
      invited_email_normalized,
      role,
      status
    ) values (
      $1,
      authorization_result.profile_id,
      normalized_email,
      $3,
      'pending_delivery'
    )
    returning id into new_invitation_id;
  exception
    when unique_violation then
      return query select 'conflict'::text, null::uuid;
      return;
  end;

  perform desmoslock_v2.internal_append_auth_event(
    'invitation_requested',
    'invitation_pending',
    $1,
    authorization_result.profile_id,
    null,
    new_invitation_id,
    authorization_result.session_id
  );

  return query select 'invitation_pending'::text, new_invitation_id;
end;
$$;

revoke all on function desmoslock_v2.begin_staff_invitation(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.begin_staff_invitation(uuid, text, text)
  to authenticated;

create function desmoslock_v2.internal_prepare_staff_invitation(
  invitation_id uuid,
  invited_user_id uuid,
  expires_at timestamp with time zone
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row desmoslock_v2.staff_invitations%rowtype;
  target_email_normalized text;
begin
  if $1 is null
    or $2 is null
    or $3 is null
    or $3 <= statement_timestamp()
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  select desmoslock_v2.internal_normalize_staff_email(auth_user.email)
  into target_email_normalized
  from auth.users as auth_user
  where auth_user.id = $2
    and auth_user.deleted_at is null;

  if not found or target_email_normalized is null then
    return query select 'invalid_request'::text;
    return;
  end if;

  if target_email_normalized <> invitation_row.invited_email_normalized then
    return query select 'invalid_request'::text;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = $2
  ) then
    return query select 'conflict'::text;
    return;
  end if;

  if invitation_row.status = 'delivery_ready' then
    if invitation_row.invited_user_id = $2
      and invitation_row.expires_at = $3
    then
      return query select 'invitation_delivery_ready'::text;
    else
      return query select 'conflict'::text;
    end if;
    return;
  end if;

  if invitation_row.status <> 'pending_delivery' then
    return query select 'invitation_consumed'::text;
    return;
  end if;

  begin
    update desmoslock_v2.staff_invitations
    set
      invited_user_id = $2,
      expires_at = $3,
      status = 'delivery_ready',
      revision = revision + 1,
      updated_at = statement_timestamp()
    where id = $1
      and revision = invitation_row.revision;
  exception
    when unique_violation then
      return query select 'conflict'::text;
      return;
  end;

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'invitation_delivery_ready',
    'invitation_delivery_ready',
    invitation_row.workspace_id,
    null,
    null,
    $1,
    null
  );

  return query select 'invitation_delivery_ready'::text;
end;
$$;

revoke all on function desmoslock_v2.internal_prepare_staff_invitation(
  uuid, uuid, timestamp with time zone
) from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.internal_prepare_staff_invitation(
  uuid, uuid, timestamp with time zone
) to service_role;

create function desmoslock_v2.internal_publish_staff_invitation(
  invitation_id uuid
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row desmoslock_v2.staff_invitations%rowtype;
begin
  if $1 is null then
    return query select 'invalid_request'::text;
    return;
  end if;

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  if invitation_row.status in ('delivery_ready', 'pending_acceptance')
    and invitation_row.expires_at <= statement_timestamp()
  then
    update desmoslock_v2.staff_invitations as invitation
    set
      status = 'expired',
      revision = invitation.revision + 1,
      updated_at = statement_timestamp()
    where invitation.id = invitation_row.id
      and invitation.revision = invitation_row.revision
      and invitation.status = invitation_row.status;

    if not found then
      return query select 'conflict'::text;
      return;
    end if;

    perform desmoslock_v2.internal_append_auth_event(
      'invitation_expired',
      'invitation_expired',
      invitation_row.workspace_id,
      null,
      null,
      invitation_row.id,
      null
    );

    return query select 'invitation_expired'::text;
    return;
  end if;

  if invitation_row.status = 'pending_acceptance' then
    return query select 'invitation_usable'::text;
    return;
  end if;

  if invitation_row.status <> 'delivery_ready' then
    return query select 'invitation_consumed'::text;
    return;
  end if;

  update desmoslock_v2.staff_invitations as invitation
  set
    status = 'pending_acceptance',
    revision = invitation.revision + 1,
    updated_at = statement_timestamp()
  where invitation.id = invitation_row.id
    and invitation.revision = invitation_row.revision
    and invitation.status = 'delivery_ready';

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'invitation_ready',
    'invitation_usable',
    invitation_row.workspace_id,
    null,
    null,
    invitation_row.id,
    null
  );

  return query select 'invitation_usable'::text;
end;
$$;

revoke all on function desmoslock_v2.internal_publish_staff_invitation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.internal_publish_staff_invitation(uuid)
  to service_role;

create function desmoslock_v2.internal_fail_staff_invitation(
  invitation_id uuid,
  reason_code text
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row desmoslock_v2.staff_invitations%rowtype;
begin
  if $1 is null
    or $2 is null
    or $2 not in ('dependency_unavailable', 'invalid_request')
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  if invitation_row.status = 'delivery_failed' then
    return query select 'invitation_delivery_failed'::text;
    return;
  end if;

  if invitation_row.status not in ('pending_delivery', 'delivery_ready') then
    return query select 'invitation_consumed'::text;
    return;
  end if;

  update desmoslock_v2.staff_invitations
  set
    status = 'delivery_failed',
    invited_user_id = null,
    expires_at = null,
    failure_reason_code = $2,
    revision = revision + 1,
    updated_at = statement_timestamp()
  where id = $1
    and revision = invitation_row.revision;

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'invitation_delivery_failed',
    'invitation_delivery_failed',
    invitation_row.workspace_id,
    null,
    null,
    $1,
    null
  );

  return query select 'invitation_delivery_failed'::text;
end;
$$;

revoke all on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.internal_fail_staff_invitation(uuid, text)
  to service_role;

create function desmoslock_v2.accept_staff_invitation(
  invitation_id uuid,
  display_name text
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_result record;
  invitation_row desmoslock_v2.staff_invitations%rowtype;
  current_email_normalized text;
  new_profile_id uuid;
  normalized_display_name text;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(true);

  if session_result.code <> 'ok' then
    return query select session_result.code;
    return;
  end if;

  normalized_display_name := btrim($2);
  if $1 is null
    or $2 is null
    or octet_length(normalized_display_name) not between 1 and 160
    or normalized_display_name ~ '[[:cntrl:]]'
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  select desmoslock_v2.internal_normalize_staff_email(auth_user.email)
  into current_email_normalized
  from auth.users as auth_user
  where auth_user.id = session_result.user_id;

  if not found or current_email_normalized is null then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
    and invitation.invited_user_id = session_result.user_id
    and invitation.invited_email_normalized = current_email_normalized
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  if invitation_row.status <> 'pending_acceptance' then
    return query select
      case
        when invitation_row.status = 'expired' then 'invitation_expired'::text
        when invitation_row.status = 'delivery_ready' then 'invitation_not_found'::text
        else 'invitation_consumed'::text
      end;
    return;
  end if;

  if invitation_row.expires_at <= statement_timestamp() then
    update desmoslock_v2.staff_invitations
    set
      status = 'expired',
      revision = revision + 1,
      updated_at = statement_timestamp()
    where id = invitation_row.id
      and revision = invitation_row.revision;

    if not found then
      return query select 'conflict'::text;
      return;
    end if;

    perform desmoslock_v2.internal_append_auth_event(
      'invitation_expired',
      'invitation_expired',
      invitation_row.workspace_id,
      null,
      null,
      invitation_row.id,
      session_result.session_id
    );

    return query select 'invitation_expired'::text;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.profiles as profile
    where profile.auth_user_id = session_result.user_id
  ) then
    return query select 'conflict'::text;
    return;
  end if;

  new_profile_id := gen_random_uuid();

  begin
    insert into desmoslock_v2.profiles (
      id,
      display_name,
      seed_key,
      auth_user_id
    ) values (
      new_profile_id,
      normalized_display_name,
      null,
      session_result.user_id
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
      invitation_row.workspace_id,
      new_profile_id,
      invitation_row.role,
      null,
      'active',
      1,
      statement_timestamp(),
      statement_timestamp()
    );

    update desmoslock_v2.staff_invitations
    set
      status = 'accepted',
      accepted_at = statement_timestamp(),
      accepted_profile_id = new_profile_id,
      revision = revision + 1,
      updated_at = statement_timestamp()
    where id = invitation_row.id
      and revision = invitation_row.revision;

    if not found then
      raise exception using errcode = '40001', message = 'invitation state changed';
    end if;

    perform desmoslock_v2.internal_append_auth_event(
      'invitation_accepted',
      'invitation_accepted',
      invitation_row.workspace_id,
      new_profile_id,
      new_profile_id,
      invitation_row.id,
      session_result.session_id
    );
  exception
    when unique_violation then
      return query select 'conflict'::text;
      return;
  end;

  return query select 'invitation_accepted'::text;
end;
$$;

revoke all on function desmoslock_v2.accept_staff_invitation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.accept_staff_invitation(uuid, text)
  to authenticated;

create function desmoslock_v2.revoke_staff_invitation(
  invitation_id uuid
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_result record;
  authorization_result record;
  invitation_row desmoslock_v2.staff_invitations%rowtype;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(true);

  if session_result.code <> 'ok' then
    return query select session_result.code;
    return;
  end if;

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    invitation_row.workspace_id,
    array['owner']::text[],
    true
  );

  if authorization_result.code <> 'ok' then
    return query select
      case
        when authorization_result.code in ('membership_inactive', 'forbidden')
          then 'invitation_not_found'::text
        else authorization_result.code
      end;
    return;
  end if;

  if invitation_row.status not in (
    'pending_delivery',
    'delivery_ready',
    'pending_acceptance'
  ) then
    return query select 'invitation_consumed'::text;
    return;
  end if;

  if invitation_row.status in ('delivery_ready', 'pending_acceptance')
    and invitation_row.expires_at <= statement_timestamp()
  then
    update desmoslock_v2.staff_invitations
    set
      status = 'expired',
      revision = revision + 1,
      updated_at = statement_timestamp()
    where id = invitation_row.id
      and revision = invitation_row.revision;

    perform desmoslock_v2.internal_append_auth_event(
      'invitation_expired',
      'invitation_expired',
      invitation_row.workspace_id,
      authorization_result.profile_id,
      null,
      invitation_row.id,
      authorization_result.session_id
    );

    return query select 'invitation_expired'::text;
    return;
  end if;

  update desmoslock_v2.staff_invitations
  set
    status = 'revoked',
    revoked_at = statement_timestamp(),
    revoked_by_profile_id = authorization_result.profile_id,
    revision = revision + 1,
    updated_at = statement_timestamp()
  where id = invitation_row.id
    and revision = invitation_row.revision;

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'invitation_revoked',
    'invitation_revoked',
    invitation_row.workspace_id,
    authorization_result.profile_id,
    null,
    invitation_row.id,
    authorization_result.session_id
  );

  return query select 'invitation_revoked'::text;
end;
$$;

revoke all on function desmoslock_v2.revoke_staff_invitation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.revoke_staff_invitation(uuid)
  to authenticated;

create function desmoslock_v2.revoke_membership(
  workspace_id uuid,
  profile_id uuid
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_membership desmoslock_v2.memberships%rowtype;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1,
    array['owner']::text[],
    true
  );

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  select *
  into target_membership
  from desmoslock_v2.memberships as membership
  where membership.workspace_id = $1
    and membership.profile_id = $2
  for update;

  if not found or target_membership.status <> 'active' then
    return query select 'membership_inactive'::text;
    return;
  end if;

  if target_membership.role = 'owner' then
    return query select 'forbidden'::text;
    return;
  end if;

  update desmoslock_v2.memberships
  set
    status = 'revoked',
    role_revision = role_revision + 1,
    revoked_at = statement_timestamp(),
    revoked_by_profile_id = authorization_result.profile_id,
    revocation_reason_code = 'owner_action',
    updated_at = statement_timestamp()
  where memberships.workspace_id = $1
    and memberships.profile_id = $2
    and role_revision = target_membership.role_revision
    and status = 'active';

  if not found then
    return query select 'conflict'::text;
    return;
  end if;

  perform desmoslock_v2.internal_append_auth_event(
    'membership_revoked',
    'membership_revoked',
    $1,
    authorization_result.profile_id,
    $2,
    null,
    authorization_result.session_id
  );

  return query select 'membership_revoked'::text;
end;
$$;

revoke all on function desmoslock_v2.revoke_membership(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.revoke_membership(uuid, uuid)
  to authenticated;

create function desmoslock_v2.internal_authorize_any_staff(
  require_step_up boolean
)
returns table (
  code text,
  user_id uuid,
  session_id uuid,
  profile_id uuid,
  workspace_id uuid,
  membership_role text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_result record;
  current_profile_id uuid;
  membership_result record;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(require_step_up);

  if session_result.code <> 'ok' then
    return query select
      session_result.code,
      session_result.user_id,
      session_result.session_id,
      null::uuid,
      null::uuid,
      null::text;
    return;
  end if;

  current_profile_id := desmoslock_v2.internal_current_profile();
  if current_profile_id is null then
    return query select
      'membership_inactive'::text,
      session_result.user_id,
      session_result.session_id,
      null::uuid,
      null::uuid,
      null::text;
    return;
  end if;

  select membership.workspace_id, membership.role
  into membership_result
  from desmoslock_v2.memberships as membership
  where membership.profile_id = current_profile_id
    and membership.status = 'active'
  order by membership.workspace_id
  limit 1;

  if not found then
    return query select
      'membership_inactive'::text,
      session_result.user_id,
      session_result.session_id,
      current_profile_id,
      null::uuid,
      null::text;
    return;
  end if;

  return query select
    'ok'::text,
    session_result.user_id,
    session_result.session_id,
    current_profile_id,
    membership_result.workspace_id,
    membership_result.role;
end;
$$;

revoke all on function desmoslock_v2.internal_authorize_any_staff(boolean)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.revoke_current_staff_session()
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_any_staff(true);

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  insert into desmoslock_v2.application_session_revocations (
    user_id,
    session_id,
    workspace_id,
    revoked_by_profile_id,
    reason_code
  ) values (
    authorization_result.user_id,
    authorization_result.session_id,
    authorization_result.workspace_id,
    authorization_result.profile_id,
    'current_session'
  );

  perform desmoslock_v2.internal_append_auth_event(
    'session_revoked',
    'ok',
    authorization_result.workspace_id,
    authorization_result.profile_id,
    authorization_result.profile_id,
    null,
    authorization_result.session_id
  );

  return query select 'ok'::text;
end;
$$;

revoke all on function desmoslock_v2.revoke_current_staff_session()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.revoke_current_staff_session()
  to authenticated;

create function desmoslock_v2.revoke_all_current_user_staff_sessions()
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_any_staff(true);

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  insert into desmoslock_v2.application_session_revocations (
    user_id,
    session_id,
    workspace_id,
    revoked_by_profile_id,
    reason_code
  )
  select
    authorization_result.user_id,
    auth_session.id,
    authorization_result.workspace_id,
    authorization_result.profile_id,
    'account_recovery'
  from auth.sessions as auth_session
  where auth_session.user_id = authorization_result.user_id
  on conflict (user_id, session_id) do nothing;

  perform desmoslock_v2.internal_append_auth_event(
    'account_recovery',
    'ok',
    authorization_result.workspace_id,
    authorization_result.profile_id,
    authorization_result.profile_id,
    null,
    authorization_result.session_id
  );

  return query select 'ok'::text;
end;
$$;

revoke all on function desmoslock_v2.revoke_all_current_user_staff_sessions()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.revoke_all_current_user_staff_sessions()
  to authenticated;

create or replace function desmoslock_v2.current_school_summary()
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
    staff_context.school_id,
    staff_context.school_slug,
    staff_context.school_name,
    staff_context.membership_role,
    (
      select count(*)
      from desmoslock_v2.tests as school_test
      where school_test.workspace_id = staff_context.school_id
    ),
    (
      select count(*)
      from desmoslock_v2.student_sessions as school_session
      where school_session.workspace_id = staff_context.school_id
    )
  from desmoslock_v2.current_staff_context() as staff_context
  where staff_context.code = 'ok'
  order by staff_context.school_slug;
$$;

revoke all on function desmoslock_v2.current_school_summary()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_school_summary() to authenticated;

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
        'internal-baseline-v1',
        '3',
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
        profile.display_name
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
        membership.role
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

comment on column desmoslock_v2.profiles.auth_user_id is
  'Nullable for deterministic fixtures; runtime staff profiles bind one Auth user exactly once.';
comment on column desmoslock_v2.memberships.status is
  'Live backend authorization state. JWT membership or role metadata is ignored.';
comment on table desmoslock_v2.staff_invitations is
  'Default-deny, server-owned invitation lifecycle; normalized target email is never audited.';
comment on table desmoslock_v2.application_session_revocations is
  'Application-layer session tombstones checked in addition to live Auth session state.';
comment on table desmoslock_v2.staff_audit_events is
  'Append-only minimized auth audit with typed codes and no PII, secrets, payloads, or provider errors.';
comment on function desmoslock_v2.current_staff_context() is
  'Caller-scoped rows: code, profile_id, school_id, school_slug, school_name, membership_role, role_revision; failures are one code row with null context.';
comment on function desmoslock_v2.current_staff_invitations() is
  'Recipient-scoped rows: code, invitation_id, school_id, school_name, invited_role, expires_at; target email is never returned.';
comment on function desmoslock_v2.internal_baseline_status() is
  'Service-only deterministic verification of synthetic rows; runtime rows have null seed keys and are excluded.';
comment on function desmoslock_v2.internal_bind_initial_owner(uuid, uuid, uuid) is
  'Service-only, idempotent binding of one confirmed Auth user to an active seeded initial Owner; returns code only.';
comment on function desmoslock_v2.begin_staff_invitation(uuid, text, text) is
  'Owner-only AAL2/TOTP seam. Expired matching invitations are terminalized before reissue; invitation_pending requires service preparation and explicit delivery acknowledgment.';
comment on function desmoslock_v2.internal_prepare_staff_invitation(
  uuid, uuid, timestamp with time zone
) is
  'Service-only recipient binding into non-consumable delivery_ready. Exact replay returns invitation_delivery_ready and exposes no recipient data.';
comment on function desmoslock_v2.internal_publish_staff_invitation(uuid) is
  'Service-only exact delivery_ready-to-pending_acceptance acknowledgment. Exact replay returns invitation_usable without another mail side effect.';
comment on function desmoslock_v2.internal_fail_staff_invitation(uuid, text) is
  'Service-only terminal failure for pending_delivery or delivery_ready. Success code invitation_delivery_failed records only a stable code.';
comment on function desmoslock_v2.accept_staff_invitation(uuid, text) is
  'Recipient-bound identity and normalized email are matched before state reads; AAL2/TOTP mutation returns code only. Refresh current_staff_context after invitation_accepted.';
comment on function desmoslock_v2.revoke_staff_invitation(uuid) is
  'Owner-only AAL2/TOTP mutation returning one stable code row.';
comment on function desmoslock_v2.revoke_membership(uuid, uuid) is
  'Owner-only AAL2/TOTP School-scoped revocation returning one stable code row.';
comment on function desmoslock_v2.revoke_current_staff_session() is
  'AAL2/TOTP application-session revocation returning one stable code row.';
comment on function desmoslock_v2.revoke_all_current_user_staff_sessions() is
  'AAL2/TOTP account-recovery seam revoking all known Auth sessions at the application boundary.';
