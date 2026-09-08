-- Target Membership locks can wait while the caller's authority changes.
-- Revalidate the real Owner and AAL2 session after that wait before returning
-- target state or making any revocation write. Published migrations stay intact.

create or replace function desmoslock_v2.revoke_membership(
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
  target_membership_found boolean;
  mutation_at timestamp with time zone;
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
  target_membership_found := found;

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

  if not target_membership_found or target_membership.status <> 'active' then
    return query select 'membership_inactive'::text;
    return;
  end if;

  if target_membership.role = 'owner' then
    return query select 'forbidden'::text;
    return;
  end if;

  mutation_at := clock_timestamp();
  update desmoslock_v2.memberships
  set
    status = 'revoked',
    role_revision = role_revision + 1,
    revoked_at = mutation_at,
    revoked_by_profile_id = authorization_result.profile_id,
    revocation_reason_code = 'owner_action',
    updated_at = mutation_at
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

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'e1a9a879948a685a263f24fad98e7fc9a30817fe6ce9461e32fc121080d00a4a'::text;
$$;
-- desmoslock-migration-set-sha256:end

revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;

update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
