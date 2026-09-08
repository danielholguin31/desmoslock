-- Membership administration uses live per-School authority and explicit target
-- revisions. Published migrations and the append-only audit mechanism stay intact.

alter table desmoslock_v2.memberships
  drop constraint memberships_role_revision_check,
  add constraint memberships_role_revision_check
    check (role_revision between 1 and 9007199254740991),
  drop constraint memberships_revocation_reason_check,
  add constraint memberships_revocation_reason_check
    check (revocation_reason_code is null or revocation_reason_code in (
      'owner_action', 'administrator_action'
    ));

alter table desmoslock_v2.staff_audit_events
  add column previous_role text,
  add column new_role text,
  add column previous_role_revision bigint,
  add column new_role_revision bigint,
  drop constraint staff_audit_events_type_check,
  add constraint staff_audit_events_type_check check (event_type in (
    'initial_owner_bound', 'invitation_requested', 'invitation_delivery_ready',
    'invitation_ready', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'session_revoked', 'account_recovery', 'password_recovery_sessions_revoked',
    'password_recovery_completed', 'membership_role_changed'
  )),
  drop constraint staff_audit_events_result_check,
  add constraint staff_audit_events_result_check check (result_code in (
    'ok', 'initial_owner_bound', 'invitation_pending', 'invitation_delivery_ready',
    'invitation_usable', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'recovery_sessions_revoked', 'recovery_completed', 'membership_role_changed'
  )),
  add constraint staff_audit_events_role_change_check check (
    (
      event_type = 'membership_role_changed'
      and result_code = 'membership_role_changed'
      and previous_role is not null and new_role is not null
      and previous_role in ('admin', 'teacher') and new_role in ('admin', 'teacher')
      and previous_role <> new_role
      and previous_role_revision is not null and new_role_revision is not null
      and previous_role_revision between 1 and 9007199254740990
      and new_role_revision = previous_role_revision + 1
      and workspace_id is not null and actor_profile_id is not null
      and subject_profile_id is not null and session_id is not null
      and invitation_id is null
    )
    or (
      event_type <> 'membership_role_changed'
      and result_code <> 'membership_role_changed'
      and previous_role is null and new_role is null
      and previous_role_revision is null and new_role_revision is null
    )
  );

-- Keep the private helper identity; row projections below apply each School role.
create or replace function desmoslock_v2.internal_authorize_owner_management()
returns table (
  code text,
  user_id uuid,
  session_id uuid,
  profile_id uuid
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
  from desmoslock_v2.internal_authenticated_staff_session(true);

  if session_result.code <> 'ok' then
    return query select
      session_result.code,
      session_result.user_id,
      session_result.session_id,
      null::uuid;
    return;
  end if;

  current_profile_id := desmoslock_v2.internal_current_profile();
  if current_profile_id is null
    or not exists (
      select 1
      from desmoslock_v2.memberships as membership
      where membership.profile_id = current_profile_id
        and membership.status = 'active'
    )
  then
    return query select
      'membership_inactive'::text,
      session_result.user_id,
      session_result.session_id,
      current_profile_id;
    return;
  end if;

  if not exists (
    select 1
    from desmoslock_v2.memberships as membership
    where membership.profile_id = current_profile_id
      and membership.role in ('owner', 'admin')
      and membership.status = 'active'
  ) then
    return query select
      'forbidden'::text,
      session_result.user_id,
      session_result.session_id,
      current_profile_id;
    return;
  end if;

  return query select
    'ok'::text,
    session_result.user_id,
    session_result.session_id,
    current_profile_id;
end;
$$;
revoke all on function desmoslock_v2.internal_authorize_owner_management()
  from public, anon, authenticated, service_role;

drop function desmoslock_v2.current_manageable_staff();
create function desmoslock_v2.current_manageable_staff()
returns table (
  code text,
  school_id uuid,
  profile_id uuid,
  display_name text,
  email text,
  membership_role text,
  role_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  authorization_result record;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_owner_management();

  if authorization_result.code <> 'ok' then
    return query select
      authorization_result.code,
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
    target_membership.workspace_id,
    target_profile.id,
    target_profile.display_name,
    desmoslock_v2.internal_normalize_staff_email(auth_user.email),
    target_membership.role,
    target_membership.role_revision
  from desmoslock_v2.memberships as actor_membership
  join desmoslock_v2.memberships as target_membership
    on target_membership.workspace_id = actor_membership.workspace_id
  join desmoslock_v2.profiles as target_profile
    on target_profile.id = target_membership.profile_id
  join auth.users as auth_user
    on auth_user.id = target_profile.auth_user_id
  where actor_membership.profile_id = authorization_result.profile_id
    and actor_membership.role in ('owner', 'admin')
    and actor_membership.status = 'active'
    and target_membership.status = 'active'
    and target_profile.id <> authorization_result.profile_id
    and (
      (actor_membership.role = 'owner' and target_membership.role in ('admin', 'teacher'))
      or (actor_membership.role = 'admin' and target_membership.role = 'teacher')
    )
    and desmoslock_v2.internal_normalize_staff_email(auth_user.email) is not null
  order by
    target_membership.workspace_id,
    lower(target_profile.display_name),
    target_profile.id
  limit 501;
end;
$$;
revoke all on function desmoslock_v2.current_manageable_staff()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_manageable_staff() to authenticated;

create or replace function desmoslock_v2.current_manageable_staff_invitations()
returns table (
  code text,
  invitation_id uuid,
  school_id uuid,
  invited_email text,
  invited_role text,
  invitation_status text,
  expires_at timestamp with time zone
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  authorization_result record;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_owner_management();

  if authorization_result.code <> 'ok' then
    return query select
      authorization_result.code,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::timestamp with time zone;
    return;
  end if;

  return query
  select
    'ok'::text,
    invitation.id,
    invitation.workspace_id,
    invitation.invited_email_normalized,
    invitation.role,
    invitation.status,
    case
      when invitation.status = 'pending_delivery'
        then invitation.delivery_lease_expires_at
      else invitation.expires_at
    end
  from desmoslock_v2.memberships as actor_membership
  join desmoslock_v2.staff_invitations as invitation
    on invitation.workspace_id = actor_membership.workspace_id
  where actor_membership.profile_id = authorization_result.profile_id
    and actor_membership.role in ('owner', 'admin')
    and actor_membership.status = 'active'
    and (actor_membership.role = 'owner' or invitation.role = 'teacher')
    and (
      (
        invitation.status = 'pending_delivery'
        and invitation.delivery_lease_expires_at > statement_timestamp()
      )
      or (
        invitation.status in ('delivery_ready', 'pending_acceptance')
        and invitation.expires_at > statement_timestamp()
      )
    )
  order by
    invitation.workspace_id,
    invitation.invited_email_normalized,
    invitation.id
  limit 501;
end;
$$;
revoke all on function desmoslock_v2.current_manageable_staff_invitations()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_manageable_staff_invitations() to authenticated;

create or replace function desmoslock_v2.begin_staff_invitation(
  workspace_id uuid,
  email text,
  role text,
  request_key uuid
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
  request_invitation desmoslock_v2.staff_invitations%rowtype;
  expired_invitation desmoslock_v2.staff_invitations%rowtype;
  request_now timestamp with time zone;
  request_found boolean;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1,
    case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end,
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
    or $4 is null
  then
    return query select 'invalid_request'::text, null::uuid;
    return;
  end if;

  select invitation.*
  into request_invitation
  from desmoslock_v2.staff_invitations as invitation
  where invitation.workspace_id = $1
    and invitation.request_key = $4
  for update;
  request_found := found;

  -- A row-lock wait may outlive the original staff/session/MFA authority.
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1, case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end, true
  );
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid;
    return;
  end if;
  request_now := clock_timestamp();

  if request_found then
    if request_invitation.requested_by_profile_id = authorization_result.profile_id
      and request_invitation.invited_email_normalized = normalized_email
      and request_invitation.role = $3
      and request_invitation.status = 'pending_delivery'
      and request_invitation.delivery_lease_expires_at > request_now
    then
      return query select
        'invitation_pending'::text,
        request_invitation.id;
      return;
    end if;

    if request_invitation.requested_by_profile_id = authorization_result.profile_id
      and request_invitation.invited_email_normalized = normalized_email
      and request_invitation.role = $3
      and request_invitation.status = 'pending_delivery'
      and request_invitation.delivery_lease_expires_at <= request_now
    then
      update desmoslock_v2.staff_invitations as invitation
      set
        status = 'delivery_failed',
        failure_reason_code = 'delivery_lease_expired',
        revision = invitation.revision + 1,
        updated_at = request_now
      where invitation.id = request_invitation.id
        and invitation.revision = request_invitation.revision
        and invitation.status = 'pending_delivery';

      if found then
        perform desmoslock_v2.internal_append_auth_event(
          'invitation_delivery_failed',
          'invitation_delivery_failed',
          request_invitation.workspace_id,
          null,
          null,
          request_invitation.id,
          null
        );
      end if;
    end if;

    return query select 'conflict'::text, null::uuid;
    return;
  end if;

  -- Lock the currently open attempt before deciding whether its lease or
  -- acceptance window elapsed. A candidate can expire while this lock waits.
  for expired_invitation in
    select invitation.*
    from desmoslock_v2.staff_invitations as invitation
    where invitation.workspace_id = $1
      and invitation.invited_email_normalized = normalized_email
      and (authorization_result.membership_role = 'owner' or invitation.role = 'teacher')
      and invitation.status in (
        'pending_delivery', 'delivery_ready', 'pending_acceptance'
      )
    order by invitation.id
    for update
  loop
    select *
    into authorization_result
    from desmoslock_v2.internal_authorize_staff(
      $1, case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end, true
    );
    if authorization_result.code <> 'ok' then
      return query select authorization_result.code, null::uuid;
      return;
    end if;
    -- An Owner may have become an Administrator while this candidate lock waited.
    if authorization_result.membership_role = 'admin' and expired_invitation.role <> 'teacher' then
      continue;
    end if;
    request_now := clock_timestamp();

    if expired_invitation.status = 'pending_delivery'
      and expired_invitation.delivery_lease_expires_at <= request_now
    then
      update desmoslock_v2.staff_invitations as invitation
      set
        status = 'delivery_failed',
        failure_reason_code = 'delivery_lease_expired',
        revision = invitation.revision + 1,
        updated_at = request_now
      where invitation.id = expired_invitation.id
        and invitation.revision = expired_invitation.revision
        and invitation.status = 'pending_delivery';

      if found then
        perform desmoslock_v2.internal_append_auth_event(
          'invitation_delivery_failed', 'invitation_delivery_failed',
          expired_invitation.workspace_id, null, null,
          expired_invitation.id, null
        );
      end if;
    elsif expired_invitation.status in ('delivery_ready', 'pending_acceptance')
      and expired_invitation.expires_at <= request_now
    then
      update desmoslock_v2.staff_invitations as invitation
      set
        status = 'expired',
        failure_reason_code = null,
        revision = invitation.revision + 1,
        updated_at = request_now
      where invitation.id = expired_invitation.id
        and invitation.revision = expired_invitation.revision
        and invitation.status = expired_invitation.status;

      if found then
        perform desmoslock_v2.internal_append_auth_event(
          'invitation_expired', 'invitation_expired',
          expired_invitation.workspace_id, authorization_result.profile_id,
          null, expired_invitation.id, authorization_result.session_id
        );
      end if;
    end if;
  end loop;

  -- Recheck after every candidate lock and before attempting a new row.
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1, case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end, true
  );
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid;
    return;
  end if;
  request_now := clock_timestamp();

  begin
    insert into desmoslock_v2.staff_invitations (
      workspace_id,
      requested_by_profile_id,
      request_key,
      invited_email_normalized,
      role,
      status,
      requested_at,
      updated_at,
      delivery_lease_expires_at
    ) values (
      $1,
      authorization_result.profile_id,
      $4,
      normalized_email,
      $3,
      'pending_delivery',
      request_now,
      request_now,
      request_now + interval '5 minutes'
    )
    returning id into new_invitation_id;

    -- INSERT can also wait on a unique contender that eventually rolls back.
    -- Revalidate even when insertion succeeds, then mint the five-minute lease
    -- from the fresh completion clock. On authority loss, the contained
    -- exception rolls this insertion back before returning its denial code.
    select *
    into authorization_result
    from desmoslock_v2.internal_authorize_staff(
      $1, case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end, true
    );
    if authorization_result.code <> 'ok' then
      raise exception using
        errcode = 'PST01', message = 'staff invitation authority changed';
    end if;
    request_now := clock_timestamp();

    update desmoslock_v2.staff_invitations as invitation
    set
      requested_at = request_now,
      updated_at = request_now,
      delivery_lease_expires_at = request_now + interval '5 minutes'
    where invitation.id = new_invitation_id;
  exception
    when sqlstate 'PST01' then
      return query select authorization_result.code, null::uuid;
      return;
    when unique_violation then
      select invitation.*
      into request_invitation
      from desmoslock_v2.staff_invitations as invitation
      where invitation.workspace_id = $1
        and invitation.request_key = $4
      for update;
      request_found := found;

      -- Both uniqueness reconciliation and this exact-row lookup may wait.
      select *
      into authorization_result
      from desmoslock_v2.internal_authorize_staff(
        $1, case when $3 = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end, true
      );
      if authorization_result.code <> 'ok' then
        return query select authorization_result.code, null::uuid;
        return;
      end if;
      request_now := clock_timestamp();

      if request_found
        and request_invitation.requested_by_profile_id = authorization_result.profile_id
        and request_invitation.invited_email_normalized = normalized_email
        and request_invitation.role = $3
        and request_invitation.status = 'pending_delivery'
        and request_invitation.delivery_lease_expires_at > request_now
      then
        return query select
          'invitation_pending'::text,
          request_invitation.id;
        return;
      end if;

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
revoke all on function desmoslock_v2.begin_staff_invitation(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.begin_staff_invitation(uuid, text, text, uuid) to authenticated;

create or replace function desmoslock_v2.revoke_staff_invitation(
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
    case when invitation_row.role = 'teacher' then array['owner', 'admin']::text[]
      else array['owner']::text[] end,
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
    and invitation_row.expires_at <= clock_timestamp()
  then
    update desmoslock_v2.staff_invitations
    set
      status = 'expired',
      failure_reason_code = null,
      revision = revision + 1,
      updated_at = clock_timestamp()
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
    failure_reason_code = null,
    revoked_at = clock_timestamp(),
    revoked_by_profile_id = authorization_result.profile_id,
    revision = revision + 1,
    updated_at = clock_timestamp()
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
grant execute on function desmoslock_v2.revoke_staff_invitation(uuid) to authenticated;

-- Fail safely on any unexpected dependency; no revision-free overload survives.
drop function desmoslock_v2.revoke_membership(uuid, uuid);
create function desmoslock_v2.revoke_membership(
  workspace_id uuid,
  profile_id uuid,
  expected_role_revision bigint
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_membership desmoslock_v2.memberships%rowtype;
  target_membership_found boolean;
  mutation_at timestamp with time zone;
begin
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1,
    array['owner', 'admin']::text[],
    true
  );

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  if $3 is null or $3 < 1 or $3 > 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;

  select *
  into target_membership
  from desmoslock_v2.memberships as membership
  where membership.workspace_id = $1
    and membership.profile_id = $2
  for update;
  target_membership_found := found;

  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1,
    array['owner', 'admin']::text[],
    true
  );

  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  if not target_membership_found or target_membership.status <> 'active'
    or target_membership.profile_id = authorization_result.profile_id
    or target_membership.role = 'owner'
    or (authorization_result.membership_role = 'admin' and target_membership.role <> 'teacher')
  then
    return query select 'forbidden'::text;
    return;
  end if;

  if target_membership.role_revision <> $3 then
    return query select 'membership_revision_conflict'::text;
    return;
  end if;
  if target_membership.role_revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;

  mutation_at := clock_timestamp();
  update desmoslock_v2.memberships
  set
    status = 'revoked',
    role_revision = role_revision + 1,
    revoked_at = mutation_at,
    revoked_by_profile_id = authorization_result.profile_id,
    revocation_reason_code = case when authorization_result.membership_role = 'admin'
      then 'administrator_action' else 'owner_action' end,
    updated_at = mutation_at
  where memberships.workspace_id = $1
    and memberships.profile_id = $2
    and role_revision = target_membership.role_revision
    and status = 'active';

  if not found then
    return query select 'membership_revision_conflict'::text;
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
revoke all on function desmoslock_v2.revoke_membership(uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.revoke_membership(uuid, uuid, bigint) to authenticated;

create function desmoslock_v2.change_membership_role(
  workspace_id uuid,
  profile_id uuid,
  role text,
  expected_role_revision bigint
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_membership desmoslock_v2.memberships%rowtype;
  target_membership_found boolean;
  mutation_at timestamp with time zone;
begin
  select * into authorization_result
  from desmoslock_v2.internal_authorize_staff($1, array['owner']::text[], true);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if $3 is null or $3 not in ('admin', 'teacher')
    or $4 is null or $4 < 1 or $4 > 9007199254740991
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  select * into target_membership
  from desmoslock_v2.memberships as membership
  where membership.workspace_id = $1 and membership.profile_id = $2
  for update;
  target_membership_found := found;

  select * into authorization_result
  from desmoslock_v2.internal_authorize_staff($1, array['owner']::text[], true);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if not target_membership_found or target_membership.status <> 'active'
    or target_membership.profile_id = authorization_result.profile_id
    or target_membership.role not in ('admin', 'teacher')
  then
    return query select 'forbidden'::text;
    return;
  end if;
  if target_membership.role_revision <> $4 then
    return query select 'membership_revision_conflict'::text;
    return;
  end if;
  if target_membership.role = $3 or target_membership.role_revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;

  mutation_at := clock_timestamp();
  update desmoslock_v2.memberships as membership
  set role = $3, role_revision = membership.role_revision + 1, updated_at = mutation_at
  where membership.workspace_id = $1 and membership.profile_id = $2
    and membership.role_revision = $4 and membership.status = 'active';
  if not found then
    return query select 'membership_revision_conflict'::text;
    return;
  end if;

  -- The typed audit insert shares this mutation's transaction and fresh clock.
  -- Any audit failure aborts the role write; the existing append-only helper and
  -- triggers are unchanged, and no catch converts a failed audit into success.
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    subject_profile_id, session_id, previous_role, new_role,
    previous_role_revision, new_role_revision
  ) values (
    mutation_at, 'membership_role_changed', 'membership_role_changed', $1,
    authorization_result.profile_id, $2, authorization_result.session_id,
    target_membership.role, $3, target_membership.role_revision,
    target_membership.role_revision + 1
  );
  return query select 'membership_role_changed'::text;
end;
$$;

revoke all on function desmoslock_v2.change_membership_role(uuid, uuid, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.change_membership_role(uuid, uuid, text, bigint) to authenticated;

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
