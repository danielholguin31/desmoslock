-- Callback completion keeps the existing RPC/state surface. A prepared invitation
-- remains redeemable when delivery acknowledgment is lost. Recovery operation IDs
-- identify cleanup attempts; neither they nor completion prove a password change.

alter table desmoslock_v2.staff_invitations
  drop constraint staff_invitations_failure_reason_check,
  drop constraint staff_invitations_lifecycle_check;

alter table desmoslock_v2.staff_invitations
  add constraint staff_invitations_failure_reason_check check (
    failure_reason_code is null
    or failure_reason_code in (
      'dependency_unavailable', 'invalid_request', 'delivery_lease_expired',
      'delivery_unconfirmed', 'delivery_rejected'
    )
  ),
  add constraint staff_invitations_lifecycle_check
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
        and (
          failure_reason_code is null
          or failure_reason_code in ('delivery_unconfirmed', 'delivery_rejected')
        )
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
    );


-- A previously begun recovery may have missed a concurrently inserted provider
-- session in its concrete sweep. Install its creation cutoff before removing
-- the old unfinished-operation guard. Never move a completion cutoff backward.
insert into desmoslock_v2.application_session_revocation_cutoffs as cutoff (
  user_id, invalid_before, last_recovery_operation_id, updated_at
)
select distinct on (operation.auth_user_id)
  operation.auth_user_id,
  coalesce(operation.completed_at, operation.started_at),
  operation.id,
  clock_timestamp()
from desmoslock_v2.staff_password_recovery_operations as operation
order by operation.auth_user_id,
  coalesce(operation.completed_at, operation.started_at) desc, operation.id
on conflict (user_id) do update set
  invalid_before = greatest(cutoff.invalid_before, excluded.invalid_before),
  last_recovery_operation_id = case
    when excluded.invalid_before >= cutoff.invalid_before
      then excluded.last_recovery_operation_id
    else cutoff.last_recovery_operation_id
  end,
  updated_at = greatest(cutoff.updated_at, excluded.updated_at);

create or replace function desmoslock_v2.internal_authenticated_staff_session(
  require_step_up boolean
)
returns table (
  code text,
  user_id uuid,
  session_id uuid
)
language plpgsql
volatile
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
  current_session_created_at timestamp with time zone;
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
      and current_user_banned_until > clock_timestamp()
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
    or jwt_expiration::numeric <= extract(epoch from clock_timestamp())
  then
    return query select 'session_expired'::text, current_user_id, null::uuid;
    return;
  end if;

  select
    auth_session.created_at,
    auth_session.aal::text,
    auth_session.factor_id
  into
    current_session_created_at,
    current_session_aal,
    current_session_factor_id
  from auth.sessions as auth_session
  where auth_session.id = current_session_id
    and auth_session.user_id = current_user_id
    and (
      auth_session.not_after is null
      or auth_session.not_after > clock_timestamp()
    );

  if not found then
    return query
      select 'session_expired'::text, current_user_id, current_session_id;
    return;
  end if;

  if exists (
    select 1
    from auth.mfa_amr_claims as amr_claim
    where amr_claim.session_id = current_session_id
      and amr_claim.authentication_method = 'recovery'
  ) then
    return query
      select 'forbidden'::text, current_user_id, current_session_id;
    return;
  end if;

  if exists (
      select 1
      from desmoslock_v2.application_session_revocations as revocation
      where revocation.user_id = current_user_id
        and revocation.session_id = current_session_id
    )
    or exists (
      select 1
      from desmoslock_v2.application_session_revocation_cutoffs as cutoff
      where cutoff.user_id = current_user_id
        and (
          current_session_created_at is null
          or current_session_created_at <= cutoff.invalid_before
        )
    )
  then
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

create or replace function desmoslock_v2.internal_authenticated_recovery_session()
returns table (
  code text,
  user_id uuid,
  session_id uuid,
  jwt_expires_at timestamp with time zone
)
language plpgsql
volatile
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
  current_session_not_after timestamp with time zone;
  jwt_expiration text;
  parsed_jwt_expires_at timestamp with time zone;
begin
  request_jwt := auth.jwt();
  current_user_id := auth.uid();
  current_session_id := desmoslock_v2.internal_request_session_id();

  if current_user_id is null then
    return query
      select 'unauthenticated'::text, null::uuid, null::uuid,
        null::timestamp with time zone;
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
      and current_user_banned_until > clock_timestamp()
    )
  then
    return query
      select 'unauthenticated'::text, null::uuid, null::uuid,
        null::timestamp with time zone;
    return;
  end if;

  if current_email_confirmed_at is null then
    return query
      select 'email_unverified'::text, current_user_id, null::uuid,
        null::timestamp with time zone;
    return;
  end if;

  jwt_expiration := request_jwt ->> 'exp';
  if current_session_id is null
    or jwt_expiration is null
    or jwt_expiration !~ '^[0-9]{1,20}$'
    or jwt_expiration::numeric <= extract(epoch from clock_timestamp())
  then
    return query
      select 'session_expired'::text, current_user_id, null::uuid,
        null::timestamp with time zone;
    return;
  end if;

  begin
    parsed_jwt_expires_at := to_timestamp(jwt_expiration::double precision);
  exception
    when datetime_field_overflow or numeric_value_out_of_range then
      return query
        select 'session_expired'::text, current_user_id, null::uuid,
          null::timestamp with time zone;
      return;
  end;

  select auth_session.not_after
  into current_session_not_after
  from auth.sessions as auth_session
  where auth_session.id = current_session_id
    and auth_session.user_id = current_user_id
    and (
      auth_session.not_after is null
      or auth_session.not_after > clock_timestamp()
    );

  if not found then
    return query
      select 'session_expired'::text, current_user_id, current_session_id,
        null::timestamp with time zone;
    return;
  end if;

  if not exists (
    select 1
    from auth.mfa_amr_claims as amr_claim
    where amr_claim.session_id = current_session_id
      and amr_claim.authentication_method = 'recovery'
  ) then
    return query
      select 'forbidden'::text, current_user_id, current_session_id,
        null::timestamp with time zone;
    return;
  end if;

  if current_session_not_after is not null then
    parsed_jwt_expires_at := least(
      parsed_jwt_expires_at,
      current_session_not_after
    );
  end if;

  return query
    select 'ok'::text, current_user_id, current_session_id,
      parsed_jwt_expires_at;
end;
$$;

create or replace function desmoslock_v2.current_staff_invitations()
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
    and invitation.status in ('delivery_ready', 'pending_acceptance')
    and invitation.expires_at > clock_timestamp()
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

  -- A row-lock wait may outlive the original Owner/session/MFA authority.
  select *
  into authorization_result
  from desmoslock_v2.internal_authorize_staff(
    $1, array['owner']::text[], true
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
      and invitation.status in (
        'pending_delivery', 'delivery_ready', 'pending_acceptance'
      )
    order by invitation.id
    for update
  loop
    select *
    into authorization_result
    from desmoslock_v2.internal_authorize_staff(
      $1, array['owner']::text[], true
    );
    if authorization_result.code <> 'ok' then
      return query select authorization_result.code, null::uuid;
      return;
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
    $1, array['owner']::text[], true
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
      $1, array['owner']::text[], true
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
        $1, array['owner']::text[], true
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

create or replace function desmoslock_v2.internal_prepare_staff_invitation(
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

  if invitation_row.status = 'pending_delivery'
    and invitation_row.delivery_lease_expires_at <= clock_timestamp()
  then
    update desmoslock_v2.staff_invitations as invitation
    set
      status = 'delivery_failed',
      failure_reason_code = 'delivery_lease_expired',
      revision = invitation.revision + 1,
      updated_at = clock_timestamp()
    where invitation.id = invitation_row.id
      and invitation.revision = invitation_row.revision
      and invitation.status = 'pending_delivery';

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
      invitation_row.id,
      null
    );

    return query select 'invitation_delivery_failed'::text;
    return;
  end if;

  if invitation_row.status = 'delivery_ready'
    and invitation_row.expires_at <= clock_timestamp()
  then
    update desmoslock_v2.staff_invitations as invitation
    set
      status = 'expired',
      failure_reason_code = null,
      revision = invitation.revision + 1,
      updated_at = clock_timestamp()
    where invitation.id = invitation_row.id
      and invitation.revision = invitation_row.revision
      and invitation.status = 'delivery_ready';

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

  if invitation_row.status = 'expired' then
    return query select 'invitation_expired'::text;
    return;
  end if;

  if $3 <= clock_timestamp() then
    return query select 'invalid_request'::text;
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
      updated_at = clock_timestamp()
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

create or replace function desmoslock_v2.internal_publish_staff_invitation(
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

  if invitation_row.status = 'expired' then
    return query select 'invitation_expired'::text;
    return;
  end if;

  if invitation_row.status in ('delivery_ready', 'pending_acceptance')
    and invitation_row.expires_at <= clock_timestamp()
  then
    update desmoslock_v2.staff_invitations as invitation
    set
      status = 'expired',
      failure_reason_code = null,
      revision = invitation.revision + 1,
      updated_at = clock_timestamp()
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
    failure_reason_code = null,
    revision = invitation.revision + 1,
    updated_at = clock_timestamp()
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

create or replace function desmoslock_v2.internal_fail_staff_invitation(
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
    or $2 not in (
      'dependency_unavailable', 'invalid_request',
      'delivery_unconfirmed', 'delivery_rejected'
    )
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

  if invitation_row.status = 'delivery_ready' then
    -- Preparation is the durable point after which the provider may have sent
    -- an email. Never erase its verified binding based on a network outcome.
    if invitation_row.failure_reason_code is distinct from (case
      when $2 = 'delivery_rejected' then 'delivery_rejected'
      else 'delivery_unconfirmed'
    end) then
      update desmoslock_v2.staff_invitations as invitation
      set
        failure_reason_code = case
          when $2 = 'delivery_rejected' then 'delivery_rejected'
          else 'delivery_unconfirmed'
        end,
        revision = invitation.revision + 1,
        updated_at = clock_timestamp()
      where invitation.id = invitation_row.id;
    end if;
    return query select 'invitation_delivery_ready'::text;
    return;
  end if;

  if invitation_row.status <> 'pending_delivery' then
    return query select 'invitation_consumed'::text;
    return;
  end if;

  update desmoslock_v2.staff_invitations
  set
    status = 'delivery_failed',
    invited_user_id = null,
    expires_at = null,
    failure_reason_code = case
      when $2 = 'invalid_request' then 'invalid_request'
      else 'dependency_unavailable'
    end,
    revision = revision + 1,
    updated_at = clock_timestamp()
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

create or replace function desmoslock_v2.accept_staff_invitation(
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
  acceptance_now timestamp with time zone;
begin
  select *
  into session_result
  from desmoslock_v2.internal_authenticated_staff_session(false);

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

  select *
  into invitation_row
  from desmoslock_v2.staff_invitations as invitation
  where invitation.id = $1
    and invitation.invited_user_id = session_result.user_id
  for update;

  if not found then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  -- Serialize with provider identity/session changes, then re-read authority
  -- with a fresh snapshot and wall clock after every potentially waiting lock.
  perform 1 from auth.users as auth_user
  where auth_user.id = session_result.user_id
  for share;
  perform 1 from auth.sessions as auth_session
  where auth_session.id = session_result.session_id
    and auth_session.user_id = session_result.user_id
  for share;

  select * into session_result
  from desmoslock_v2.internal_authenticated_staff_session(false);
  if session_result.code <> 'ok' then
    return query select session_result.code;
    return;
  end if;

  select desmoslock_v2.internal_normalize_staff_email(auth_user.email)
  into current_email_normalized
  from auth.users as auth_user
  where auth_user.id = session_result.user_id;

  if current_email_normalized is null
    or invitation_row.invited_user_id <> session_result.user_id
    or invitation_row.invited_email_normalized <> current_email_normalized
  then
    return query select 'invitation_not_found'::text;
    return;
  end if;

  acceptance_now := clock_timestamp();

  if invitation_row.status = 'accepted' then
    if exists (
      select 1 from desmoslock_v2.profiles as profile
      where profile.id = invitation_row.accepted_profile_id
        and profile.auth_user_id = session_result.user_id
    ) then
      -- This confirms an earlier acceptance, never current School authority.
      -- In particular, do not write or restore a subsequently revoked Membership.
      return query select 'invitation_accepted'::text;
    else
      return query select 'conflict'::text;
    end if;
    return;
  end if;

  if invitation_row.status not in ('delivery_ready', 'pending_acceptance') then
    return query select
      case
        when invitation_row.status = 'expired' then 'invitation_expired'::text
        else 'invitation_consumed'::text
      end;
    return;
  end if;

  if invitation_row.expires_at <= acceptance_now then
    update desmoslock_v2.staff_invitations
    set
      status = 'expired',
      failure_reason_code = null,
      revision = revision + 1,
      updated_at = acceptance_now
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
      acceptance_now,
      acceptance_now
    );

    update desmoslock_v2.staff_invitations
    set
      status = 'accepted',
      failure_reason_code = null,
      accepted_at = acceptance_now,
      accepted_profile_id = new_profile_id,
      revision = revision + 1,
      updated_at = acceptance_now
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

create or replace function desmoslock_v2.begin_staff_password_recovery(
  requested_operation_id uuid
)
returns table (
  code text,
  operation_id uuid,
  expires_at timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovery_session record;
  current_profile_id uuid;
  existing_operation desmoslock_v2.staff_password_recovery_operations%rowtype;
  operation_found boolean;
  recovery_now timestamp with time zone;
  operation_expires_at timestamp with time zone;
begin
  select *
  into recovery_session
  from desmoslock_v2.internal_authenticated_recovery_session();

  if recovery_session.code <> 'ok' then
    return query select
      recovery_session.code,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  if $1 is null then
    return query select
      'invalid_request'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  select profile.id
  into current_profile_id
  from desmoslock_v2.profiles as profile
  where profile.auth_user_id = recovery_session.user_id
  for update;

  if not found then
    return query select
      'membership_inactive'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  select *
  into existing_operation
  from desmoslock_v2.staff_password_recovery_operations as operation
  where operation.auth_user_id = recovery_session.user_id
    and operation.auth_session_id = recovery_session.session_id
  for update;
  operation_found := found;

  -- Re-read provider authority after the per-profile serialization lock and
  -- any exact operation-row lock. This prevents a waiting recovery request
  -- from acting on pre-lock session state.
  select *
  into recovery_session
  from desmoslock_v2.internal_authenticated_recovery_session();

  if recovery_session.code <> 'ok' then
    return query select
      recovery_session.code,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  -- The profile row is the per-account recovery serialization lock. Capture
  -- one fresh wall-clock linearization point after that lock (and any exact
  -- operation-row lock) rather than reusing the outer RPC statement start.
  recovery_now := clock_timestamp();

  if recovery_session.jwt_expires_at <= recovery_now then
    return query select
      'session_expired'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  if operation_found then
    if existing_operation.auth_user_id <> recovery_session.user_id
      or existing_operation.auth_session_id <> recovery_session.session_id
      or existing_operation.profile_id <> current_profile_id
    then
      return query select
        'conflict'::text,
        null::uuid,
        null::timestamp with time zone;
      return;
    end if;

    if existing_operation.status = 'completed' then
      return query select
        'recovery_completed'::text,
        existing_operation.id,
        existing_operation.expires_at;
      return;
    end if;

    if existing_operation.expires_at <= recovery_now then
      return query select
        'recovery_expired'::text,
        null::uuid,
        null::timestamp with time zone;
      return;
    end if;

    return query select
      'recovery_sessions_revoked'::text,
      existing_operation.id,
      existing_operation.expires_at;
    return;
  end if;

  if exists (
    select 1 from desmoslock_v2.staff_password_recovery_operations as operation
    where operation.id = $1
  ) then
    return query select 'conflict'::text, null::uuid, null::timestamp with time zone;
    return;
  end if;

  if not exists (
    select 1
    from auth.sessions as auth_session
    where auth_session.id = recovery_session.session_id
      and auth_session.user_id = recovery_session.user_id
      and (
        auth_session.not_after is null
        or auth_session.not_after > recovery_now
      )
      and exists (
        select 1
        from auth.mfa_amr_claims as amr_claim
        where amr_claim.session_id = auth_session.id
          and amr_claim.authentication_method = 'recovery'
      )
      and not exists (
        select 1
        from desmoslock_v2.application_session_revocations as revocation
        where revocation.user_id = recovery_session.user_id
          and revocation.session_id = recovery_session.session_id
      )
      and not exists (
        select 1
        from desmoslock_v2.application_session_revocation_cutoffs as cutoff
        where cutoff.user_id = recovery_session.user_id
          and (
            auth_session.created_at is null
            or auth_session.created_at <= cutoff.invalid_before
          )
      )
  ) then
    return query select
      'conflict'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.staff_password_recovery_operations as operation
    where operation.auth_user_id = recovery_session.user_id
      and operation.auth_session_id <> recovery_session.session_id
      and operation.status = 'sessions_revoked'
      and operation.expires_at > recovery_now
  ) then
    return query select
      'conflict'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  if exists (
    select 1
    from desmoslock_v2.staff_password_recovery_operations as operation
    where operation.auth_session_id = recovery_session.session_id
  ) then
    return query select
      'conflict'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  operation_expires_at := least(
    recovery_now + interval '15 minutes',
    recovery_session.jwt_expires_at
  );
  if operation_expires_at <= recovery_now then
    return query select
      'session_expired'::text,
      null::uuid,
      null::timestamp with time zone;
    return;
  end if;

  begin
    insert into desmoslock_v2.staff_password_recovery_operations (
      id,
      auth_user_id,
      auth_session_id,
      profile_id,
      status,
      started_at,
      expires_at
    ) values (
      $1,
      recovery_session.user_id,
      recovery_session.session_id,
      current_profile_id,
      'sessions_revoked',
      recovery_now,
      operation_expires_at
    );
  exception
    when unique_violation then
      select *
      into existing_operation
      from desmoslock_v2.staff_password_recovery_operations as operation
      where operation.id = $1
      for update;
      operation_found := found;

      -- A uniqueness wait may outlive the first post-lock clock sample.
      -- Re-read provider authority and refresh the clock before authorizing
      -- an exact reconciliation result.
      select *
      into recovery_session
      from desmoslock_v2.internal_authenticated_recovery_session();

      if recovery_session.code <> 'ok' then
        return query select
          recovery_session.code,
          null::uuid,
          null::timestamp with time zone;
        return;
      end if;

      recovery_now := clock_timestamp();

      if recovery_session.jwt_expires_at <= recovery_now then
        return query select
          'session_expired'::text,
          null::uuid,
          null::timestamp with time zone;
        return;
      end if;

      if operation_found
        and existing_operation.auth_user_id = recovery_session.user_id
        and existing_operation.auth_session_id = recovery_session.session_id
        and existing_operation.profile_id = current_profile_id
      then
        if existing_operation.status = 'completed' then
          return query select
            'recovery_completed'::text,
            existing_operation.id,
            existing_operation.expires_at;
          return;
        end if;

        if existing_operation.expires_at > recovery_now then
          return query select
            'recovery_sessions_revoked'::text,
            existing_operation.id,
            existing_operation.expires_at;
          return;
        end if;

        return query select
          'recovery_expired'::text,
          null::uuid,
          null::timestamp with time zone;
        return;
      end if;

      return query select
        'conflict'::text,
        null::uuid,
        null::timestamp with time zone;
      return;
  end;

  insert into desmoslock_v2.application_session_revocations (
    user_id,
    session_id,
    workspace_id,
    revoked_by_profile_id,
    reason_code
  )
  select
    recovery_session.user_id,
    auth_session.id,
    null,
    current_profile_id,
    'account_recovery'
  from auth.sessions as auth_session
  where auth_session.user_id = recovery_session.user_id
  on conflict (user_id, session_id) do nothing;

  -- Install the revocation boundary now, so abandoning cleanup cannot leave
  -- old sessions live or blockade a later ordinary password sign-in.
  insert into desmoslock_v2.application_session_revocation_cutoffs as cutoff (
    user_id, invalid_before, last_recovery_operation_id, updated_at
  ) values (
    recovery_session.user_id, recovery_now, $1, recovery_now
  )
  on conflict (user_id) do update set
    invalid_before = greatest(cutoff.invalid_before, excluded.invalid_before),
    last_recovery_operation_id = case
      when excluded.invalid_before >= cutoff.invalid_before
        then excluded.last_recovery_operation_id
      else cutoff.last_recovery_operation_id
    end,
    updated_at = greatest(cutoff.updated_at, excluded.updated_at);

  perform desmoslock_v2.internal_append_auth_event(
    'password_recovery_sessions_revoked',
    'recovery_sessions_revoked',
    null,
    current_profile_id,
    current_profile_id,
    null,
    recovery_session.session_id
  );

  return query select
    'recovery_sessions_revoked'::text,
    $1,
    operation_expires_at;
end;
$$;

comment on function desmoslock_v2.internal_prepare_staff_invitation(
  uuid, uuid, timestamp with time zone
) is
  'Service-only exact recipient binding into redeemable delivery_ready. Preparation precedes mail transport and preserves immutable recipient/expiry data across ambiguous acknowledgments.';
comment on function desmoslock_v2.internal_fail_staff_invitation(uuid, text) is
  'Service-only bounded delivery diagnostic. Pending delivery may fail terminally; a prepared invitation keeps its binding and expiry with delivery_unconfirmed or delivery_rejected and returns invitation_delivery_ready.';
comment on function desmoslock_v2.accept_staff_invitation(uuid, text) is
  'Atomic acceptance of a live prepared or acknowledged invitation after post-lock verified identity, session, email, revocation, and expiry checks. Same-identity accepted replay returns success without writes and never restores revoked Membership authority; refresh current_staff_context afterward.';

comment on function desmoslock_v2.begin_staff_password_recovery(uuid) is
  'Begins cleanup and returns the canonical nonsecret operation for the exact verified recovery identity/session; the input UUID is a creation hint, not authorization.';
comment on function desmoslock_v2.finish_staff_password_recovery(uuid) is
  'Confirms completion of account session cleanup for the exact verified recovery identity/session. This RPC neither sets nor proves a password change; Auth owns the password update.';
comment on table desmoslock_v2.application_session_revocation_cutoffs is
  'Default-deny account recovery cutoff installed at begin and advanced at cleanup completion; ordinary sessions created after the current cutoff are not blocked by unfinished operations.';

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '1b499b73aca1ff812cbc244f9eb9908e8dad839ecc6befbcb1a496865a2d5f52'::text;
$$;
-- desmoslock-migration-set-sha256:end

revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;

update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
