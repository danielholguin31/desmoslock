-- Operational Owner bootstrap must not bind or add to the immutable synthetic
-- fixture. Runtime Schools, profiles, and memberships carry null seed keys;
-- all provider identity, active-owner, locking, and audit rules stay intact.
-- Previously altered canonical fixtures are intentionally not repaired here.

create or replace function desmoslock_v2.internal_bind_initial_owner(
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
    and workspace.seed_key is null
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
    and profile.seed_key is null
    and membership.seed_key is null
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

comment on function desmoslock_v2.internal_bind_initial_owner(uuid, uuid, uuid) is
  'Service-only, idempotent binding of one confirmed Auth user to an active runtime Owner. School, profile, and Membership must all have null seed keys; pinned or mixed synthetic fixture targets are rejected without mutation.';

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '8d5fd99304ce8bbf9524dfb788080f890ab84565c096a8e6d4faf437a9b734dc'::text;
$$;
-- desmoslock-migration-set-sha256:end

revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;

update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
