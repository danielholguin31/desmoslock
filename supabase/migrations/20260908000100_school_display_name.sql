-- Runtime School presentation changes use live same-School authority and an
-- explicit settings revision. Published migrations and canonical seeds remain intact.

alter table desmoslock_v2.workspaces
  add column settings_revision bigint not null default 1,
  add constraint workspaces_settings_revision_check
    check (settings_revision between 1 and 9007199254740991);

alter table desmoslock_v2.staff_audit_events
  add column previous_settings_revision bigint,
  add column new_settings_revision bigint,
  drop constraint staff_audit_events_type_check,
  add constraint staff_audit_events_type_check check (event_type in (
    'initial_owner_bound', 'invitation_requested', 'invitation_delivery_ready',
    'invitation_ready', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'session_revoked', 'account_recovery', 'password_recovery_sessions_revoked',
    'password_recovery_completed', 'membership_role_changed', 'school_display_name_updated'
  )),
  drop constraint staff_audit_events_result_check,
  add constraint staff_audit_events_result_check check (result_code in (
    'ok', 'initial_owner_bound', 'invitation_pending', 'invitation_delivery_ready',
    'invitation_usable', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'recovery_sessions_revoked', 'recovery_completed', 'membership_role_changed',
    'school_display_name_updated'
  )),
  add constraint staff_audit_events_school_settings_check check (
    (
      event_type = 'school_display_name_updated'
      and result_code = 'school_display_name_updated'
      and previous_settings_revision is not null and new_settings_revision is not null
      and previous_settings_revision between 1 and 9007199254740990
      and new_settings_revision = previous_settings_revision + 1
      and workspace_id is not null and actor_profile_id is not null
      and session_id is not null and subject_profile_id is null and invitation_id is null
      and previous_role is null and new_role is null
      and previous_role_revision is null and new_role_revision is null
    )
    or (
      event_type <> 'school_display_name_updated'
      and result_code <> 'school_display_name_updated'
      and previous_settings_revision is null and new_settings_revision is null
    )
  );

-- Return-type changes require recreation. Unexpected dependencies fail safely;
-- there is no CASCADE and all grants are explicitly restored below.
drop function desmoslock_v2.current_staff_context();
create function desmoslock_v2.current_staff_context()
returns table (
  code text,
  profile_id uuid,
  display_name text,
  school_id uuid,
  school_slug text,
  school_name text,
  school_settings_revision bigint,
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
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::bigint,
      null::text,
      null::bigint;
    return;
  end if;

  current_profile_id := desmoslock_v2.internal_current_profile();
  if current_profile_id is null then
    return query select
      'membership_inactive'::text,
      null::uuid,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::bigint,
      null::text,
      null::bigint;
    return;
  end if;

  return query
  select
    'ok'::text,
    current_profile_id,
    profile.display_name,
    workspace.id,
    workspace.slug,
    workspace.display_name,
    workspace.settings_revision,
    membership.role,
    membership.role_revision
  from desmoslock_v2.memberships as membership
  join desmoslock_v2.profiles as profile
    on profile.id = membership.profile_id
  join desmoslock_v2.workspaces as workspace
    on workspace.id = membership.workspace_id
  where membership.profile_id = current_profile_id
    and membership.status = 'active'
  order by workspace.slug;

  if not found then
    return query select
      'membership_inactive'::text,
      current_profile_id,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::bigint,
      null::text,
      null::bigint;
  end if;
end;
$$;

revoke all on function desmoslock_v2.current_staff_context()
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_staff_context() to authenticated;

create function desmoslock_v2.update_school_display_name(
  workspace_id uuid,
  display_name text,
  expected_settings_revision bigint
)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_school desmoslock_v2.workspaces%rowtype;
  target_school_found boolean;
  mutation_at timestamp with time zone;
begin
  -- Match ECMAScript trim after rejecting all representable C0/C1 controls.
  -- PostgreSQL text cannot contain NUL. Wire names must already be canonical.
  if $1 is null or $2 is null or octet_length($2) not between 1 and 160
    or $2 ~ U&'[\0001-\001F\007F-\009F]'
    or $2 <> btrim($2, U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    or $3 is null or $3 < 1 or $3 > 9007199254740991
  then
    return query select 'invalid_request'::text;
    return;
  end if;

  select * into authorization_result
  from desmoslock_v2.internal_authorize_staff($1, array['owner', 'admin']::text[], true);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;

  select * into target_school
  from desmoslock_v2.workspaces as workspace
  where workspace.id = $1 and workspace.kind = 'school' and workspace.seed_key is null
  for update;
  target_school_found := found;

  select * into authorization_result
  from desmoslock_v2.internal_authorize_staff($1, array['owner', 'admin']::text[], true);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if not target_school_found then
    return query select 'forbidden'::text;
    return;
  end if;
  if target_school.settings_revision <> $3 then
    return query select 'school_settings_revision_conflict'::text;
    return;
  end if;
  if target_school.display_name = $2 then
    return query select 'school_display_name_unchanged'::text;
    return;
  end if;
  if target_school.settings_revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;

  mutation_at := clock_timestamp();
  update desmoslock_v2.workspaces as workspace
  set display_name = $2, settings_revision = workspace.settings_revision + 1
  where workspace.id = $1 and workspace.seed_key is null and workspace.settings_revision = $3;
  if not found then
    return query select 'school_settings_revision_conflict'::text;
    return;
  end if;

  -- No names are logged. Failure of this constrained, append-only audit insert
  -- aborts the rename in the same transaction; no exception masks that failure.
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    session_id, previous_settings_revision, new_settings_revision
  ) values (
    mutation_at, 'school_display_name_updated', 'school_display_name_updated', $1,
    authorization_result.profile_id, authorization_result.session_id,
    target_school.settings_revision, target_school.settings_revision + 1
  );
  return query select 'school_display_name_updated'::text;
end;
$$;

revoke all on function desmoslock_v2.update_school_display_name(uuid, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.update_school_display_name(uuid, text, bigint) to authenticated;

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
