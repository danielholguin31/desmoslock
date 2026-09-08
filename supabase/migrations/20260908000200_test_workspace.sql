-- Staff Test workspace: immutable attribution, exact microsecond pages, and
-- revision-bound draft/open/ended mutations. Published predecessors stay intact.
-- Placeholder StudentSessions are unchanged; a live open Test is the admission
-- predicate for the later parent-before-child session implementation.

create function desmoslock_v2.internal_is_canonical_test_title(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select $1 is not null and octet_length($1) between 1 and 160
    and $1 !~ U&'[\0001-\001F\007F-\009F]'
    and $1 = btrim($1, U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
revoke all on function desmoslock_v2.internal_is_canonical_test_title(text)
  from public, anon, authenticated, service_role;

alter table desmoslock_v2.tests
  add column lifecycle text not null default 'draft',
  add column revision bigint not null default 1,
  add column created_at timestamp with time zone not null default clock_timestamp(),
  add column opened_at timestamp with time zone,
  add column ended_at timestamp with time zone,
  add column creation_request_id uuid;

-- This time is fixed synthetic metadata only. Existing nonseed rows retain the
-- migration-recorded default above; no historical creation time is invented.
update desmoslock_v2.tests
set created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
where (id, seed_key) in (
  ('30000000-0000-4000-8000-000000000001'::uuid, 'test.alpha.algebra'),
  ('30000000-0000-4000-8000-000000000002'::uuid, 'test.beta.algebra')
);

alter table desmoslock_v2.tests
  add constraint tests_title_check check (desmoslock_v2.internal_is_canonical_test_title(title)),
  add constraint tests_revision_check check (revision between 1 and 9007199254740991),
  add constraint tests_created_at_check check (
    created_at >= '0001-01-01T00:00:00Z'::timestamptz
    and created_at < '10000-01-01T00:00:00Z'::timestamptz
  ),
  add constraint tests_lifecycle_check check (
    (lifecycle = 'draft' and opened_at is null and ended_at is null)
    or (lifecycle = 'open' and opened_at is not null and ended_at is null
      and opened_at >= created_at and opened_at < '10000-01-01T00:00:00Z'::timestamptz)
    or (lifecycle = 'ended' and opened_at is not null and ended_at is not null
      and opened_at >= created_at and ended_at >= opened_at
      and ended_at < '10000-01-01T00:00:00Z'::timestamptz)
  ),
  add constraint tests_synthetic_metadata_check check (
    seed_key is null or (
      lifecycle = 'draft' and revision = 1
      and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
      and opened_at is null and ended_at is null and creation_request_id is null
    )
  );

create unique index tests_creation_request_unique
  on desmoslock_v2.tests (workspace_id, created_by_profile_id, creation_request_id)
  where creation_request_id is not null;
create index tests_runtime_page_order
  on desmoslock_v2.tests (workspace_id, created_at desc, id desc)
  where seed_key is null;

create function desmoslock_v2.internal_guard_test_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.seed_key is not null
    or new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.created_by_profile_id is distinct from old.created_by_profile_id
    or new.creation_request_id is distinct from old.creation_request_id
    or new.created_at is distinct from old.created_at
    or new.seed_key is distinct from old.seed_key
  then
    raise exception using errcode = '55000', message = 'Test attribution is immutable';
  end if;
  if new is not distinct from old then return new; end if;
  if new.revision <> old.revision + 1 then
    raise exception using errcode = '55000', message = 'Test revision must advance exactly once';
  end if;
  if (
    old.lifecycle in ('draft', 'open') and new.lifecycle = old.lifecycle
    and new.title is distinct from old.title
    and new.opened_at is not distinct from old.opened_at
    and new.ended_at is not distinct from old.ended_at
  ) or (
    old.lifecycle = 'draft' and new.lifecycle = 'open'
    and new.title is not distinct from old.title
    and old.opened_at is null and new.opened_at is not null
    and new.ended_at is null
  ) or (
    old.lifecycle = 'open' and new.lifecycle = 'ended'
    and new.title is not distinct from old.title
    and new.opened_at is not distinct from old.opened_at
    and old.ended_at is null and new.ended_at is not null
  ) then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'Test transition is invalid';
end;
$$;
revoke all on function desmoslock_v2.internal_guard_test_transition()
  from public, anon, authenticated, service_role;
create trigger tests_immutable_transition
before update on desmoslock_v2.tests
for each row execute function desmoslock_v2.internal_guard_test_transition();

alter table desmoslock_v2.staff_audit_events
  add column test_id uuid,
  add column previous_test_revision bigint,
  add column new_test_revision bigint,
  add column previous_test_lifecycle text,
  add column new_test_lifecycle text,
  add constraint staff_audit_events_test_school_fkey
    foreign key (workspace_id, test_id) references desmoslock_v2.tests (workspace_id, id),
  drop constraint staff_audit_events_type_check,
  add constraint staff_audit_events_type_check check (event_type in (
    'initial_owner_bound', 'invitation_requested', 'invitation_delivery_ready',
    'invitation_ready', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'session_revoked', 'account_recovery', 'password_recovery_sessions_revoked',
    'password_recovery_completed', 'membership_role_changed', 'school_display_name_updated',
    'test_created', 'test_title_updated', 'test_opened', 'test_ended'
  )),
  drop constraint staff_audit_events_result_check,
  add constraint staff_audit_events_result_check check (result_code in (
    'ok', 'initial_owner_bound', 'invitation_pending', 'invitation_delivery_ready',
    'invitation_usable', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'recovery_sessions_revoked', 'recovery_completed', 'membership_role_changed',
    'school_display_name_updated', 'test_created', 'test_title_updated', 'test_opened', 'test_ended'
  )),
  add constraint staff_audit_events_test_transition_check check (
    (
      event_type in ('test_created', 'test_title_updated', 'test_opened', 'test_ended')
      and result_code = event_type
      and workspace_id is not null and test_id is not null
      and actor_profile_id is not null and session_id is not null
      and subject_profile_id is null and invitation_id is null
      and previous_role is null and new_role is null
      and previous_role_revision is null and new_role_revision is null
      and previous_settings_revision is null and new_settings_revision is null
      and new_test_revision is not null and new_test_lifecycle is not null
      and (
        (event_type = 'test_created'
          and previous_test_revision is null and previous_test_lifecycle is null
          and new_test_revision = 1 and new_test_lifecycle = 'draft')
        or (
          event_type <> 'test_created'
          and previous_test_revision is not null and previous_test_lifecycle is not null
          and previous_test_revision between 1 and 9007199254740990
          and new_test_revision = previous_test_revision + 1
          and (
            (event_type = 'test_title_updated'
              and previous_test_lifecycle in ('draft', 'open')
              and new_test_lifecycle = previous_test_lifecycle)
            or (event_type = 'test_opened'
              and previous_test_lifecycle = 'draft' and new_test_lifecycle = 'open')
            or (event_type = 'test_ended'
              and previous_test_lifecycle = 'open' and new_test_lifecycle = 'ended')
          )
        )
      )
    )
    or (
      event_type not in ('test_created', 'test_title_updated', 'test_opened', 'test_ended')
      and result_code not in ('test_created', 'test_title_updated', 'test_opened', 'test_ended')
      and test_id is null and previous_test_revision is null and new_test_revision is null
      and previous_test_lifecycle is null and new_test_lifecycle is null
    )
  );

create function desmoslock_v2.internal_authorize_test_staff(workspace_id uuid)
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
  authorization_result record;
begin
  select * into authorization_result
  from desmoslock_v2.internal_authorize_staff($1, array['owner', 'admin', 'teacher']::text[], false);
  if authorization_result.code = 'ok'
    and authorization_result.membership_role in ('owner', 'admin')
  then
    select * into authorization_result
    from desmoslock_v2.internal_authorize_staff($1, array['owner', 'admin', 'teacher']::text[], true);
  end if;
  return query select authorization_result.code, authorization_result.user_id,
    authorization_result.session_id, authorization_result.profile_id,
    authorization_result.membership_role, authorization_result.role_revision;
end;
$$;
revoke all on function desmoslock_v2.internal_authorize_test_staff(uuid)
  from public, anon, authenticated, service_role;

create function desmoslock_v2.internal_parse_test_timestamp(value text)
returns timestamp with time zone
language plpgsql
immutable
set search_path = ''
as $$
declare
  parsed timestamp with time zone;
begin
  if $1 is null or $1 !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$'
    or left($1, 4) = '0000'
  then return null; end if;
  begin
    parsed := $1::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return null;
  end;
  if to_char(parsed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> $1 then
    return null;
  end if;
  return parsed;
end;
$$;
revoke all on function desmoslock_v2.internal_parse_test_timestamp(text)
  from public, anon, authenticated, service_role;

-- A named composite preserves the exact input test_id and output test_id names;
-- PostgreSQL cannot reuse that name for an IN and TABLE/OUT parameter.
create type desmoslock_v2.staff_test_row as (
  code text, test_id uuid, school_id uuid, created_by_profile_id uuid,
  title text, lifecycle text, test_revision bigint,
  created_at text, opened_at text, ended_at text
);
revoke all on type desmoslock_v2.staff_test_row
  from public, anon, authenticated, service_role;

create function desmoslock_v2.current_school_tests(
  workspace_id uuid, before_created_at text, before_test_id uuid
)
returns setof desmoslock_v2.staff_test_row
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  cursor_timestamp timestamp with time zone;
begin
  if $1 is null or (($2 is null) <> ($3 is null)) then
    return query select 'invalid_request'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
    return;
  end if;
  if $2 is not null then
    cursor_timestamp := desmoslock_v2.internal_parse_test_timestamp($2);
    if cursor_timestamp is null then
      return query select 'invalid_request'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::bigint, null::text, null::text, null::text;
      return;
    end if;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
    return;
  end if;
  if not exists (select 1 from desmoslock_v2.workspaces as workspace
    where workspace.id = $1 and workspace.kind = 'school' and workspace.seed_key is null)
  then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
    return;
  end if;
  return query select 'ok'::text, test.id, test.workspace_id, test.created_by_profile_id,
    test.title, test.lifecycle, test.revision,
    to_char(test.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(test.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(test.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from desmoslock_v2.tests as test
  where test.workspace_id = $1 and test.seed_key is null
    and ($2 is null or (test.created_at, test.id) < (cursor_timestamp, $3))
  order by test.created_at desc, test.id desc
  limit 51;
end;
$$;

create function desmoslock_v2.current_school_test(workspace_id uuid, test_id uuid)
returns setof desmoslock_v2.staff_test_row
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  authorization_result record;
begin
  if $1 is null or $2 is null then
    return query select 'invalid_request'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
    return;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
    return;
  end if;
  return query select 'ok'::text, test.id, test.workspace_id, test.created_by_profile_id,
    test.title, test.lifecycle, test.revision,
    to_char(test.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(test.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(test.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from desmoslock_v2.tests as test
  join desmoslock_v2.workspaces as workspace on workspace.id = test.workspace_id
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and workspace.kind = 'school' and workspace.seed_key is null;
  if not found then
    return query select 'test_unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::bigint, null::text, null::text, null::text;
  end if;
end;
$$;

create function desmoslock_v2.create_school_test(
  workspace_id uuid, creation_request_id uuid, title text
)
returns table (code text, test_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  school_found boolean;
  created_test_id uuid;
  mutation_at timestamp with time zone;
begin
  if $1 is null or $2 is null or not desmoslock_v2.internal_is_canonical_test_title($3) then
    return query select 'invalid_request'::text, null::uuid;
    return;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid;
    return;
  end if;
  perform 1 from desmoslock_v2.workspaces as workspace
  where workspace.id = $1 and workspace.kind = 'school' and workspace.seed_key is null
  for update;
  school_found := found;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code, null::uuid;
    return;
  end if;
  if not school_found then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;
  select test.id into created_test_id from desmoslock_v2.tests as test
  where test.workspace_id = $1
    and test.created_by_profile_id = authorization_result.profile_id
    and test.creation_request_id = $2 and test.seed_key is null;
  if found then
    return query select 'test_creation_already_recorded'::text, created_test_id;
    return;
  end if;
  mutation_at := clock_timestamp();
  created_test_id := gen_random_uuid();
  insert into desmoslock_v2.tests (
    id, workspace_id, created_by_profile_id, title, seed_key,
    lifecycle, revision, created_at, opened_at, ended_at, creation_request_id
  ) values (
    created_test_id, $1, authorization_result.profile_id, $3, null,
    'draft', 1, mutation_at, null, null, $2
  );
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    session_id, test_id, new_test_revision, new_test_lifecycle
  ) values (
    mutation_at, 'test_created', 'test_created', $1, authorization_result.profile_id,
    authorization_result.session_id, created_test_id, 1, 'draft'
  );
  return query select 'test_created'::text, created_test_id;
end;
$$;

create function desmoslock_v2.update_test_title(workspace_id uuid, test_id uuid, title text, expected_test_revision bigint)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  test_found boolean;
  mutation_at timestamp with time zone;
begin
  if $1 is null or $2 is null or $4 is null
    or $4 < 1 or $4 > 9007199254740991 or not desmoslock_v2.internal_is_canonical_test_title($3)
  then
    return query select 'invalid_request'::text;
    return;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  -- The Test parent is locked before any later StudentSession child operation.
  -- This tranche never locks or changes the placeholder StudentSession rows.
  select test.* into target_test
  from desmoslock_v2.tests as test
  join desmoslock_v2.workspaces as workspace on workspace.id = test.workspace_id
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and workspace.kind = 'school' and workspace.seed_key is null
  for update of test;
  test_found := found;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if not test_found then
    return query select 'test_unavailable'::text;
    return;
  end if;
  if target_test.revision <> $4 then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  if target_test.lifecycle = 'ended' then
    return query select 'test_transition_rejected'::text;
    return;
  end if;
  if target_test.title = $3 then
    return query select 'test_title_unchanged'::text;
    return;
  end if;
  if target_test.revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;
  mutation_at := clock_timestamp();
  update desmoslock_v2.tests as test
  set title = $3, revision = test.revision + 1
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and test.revision = $4;
  if not found then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    session_id, test_id, previous_test_revision, new_test_revision,
    previous_test_lifecycle, new_test_lifecycle
  ) values (
    mutation_at, 'test_title_updated', 'test_title_updated', $1,
    authorization_result.profile_id, authorization_result.session_id, $2,
    target_test.revision, target_test.revision + 1,
    target_test.lifecycle, target_test.lifecycle
  );
  return query select 'test_title_updated'::text;
end;
$$;

create function desmoslock_v2.open_test(workspace_id uuid, test_id uuid, expected_test_revision bigint)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  test_found boolean;
  mutation_at timestamp with time zone;
begin
  if $1 is null or $2 is null or $3 is null
    or $3 < 1 or $3 > 9007199254740991
  then
    return query select 'invalid_request'::text;
    return;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  -- The Test parent is locked before any later StudentSession child operation.
  -- This tranche never locks or changes the placeholder StudentSession rows.
  select test.* into target_test
  from desmoslock_v2.tests as test
  join desmoslock_v2.workspaces as workspace on workspace.id = test.workspace_id
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and workspace.kind = 'school' and workspace.seed_key is null
  for update of test;
  test_found := found;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if not test_found then
    return query select 'test_unavailable'::text;
    return;
  end if;
  if target_test.revision <> $3 then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  if target_test.lifecycle = 'ended' then
    return query select 'test_transition_rejected'::text;
    return;
  end if;
  if target_test.lifecycle = 'open' then
    return query select 'test_already_open'::text;
    return;
  end if;
  if target_test.revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;
  mutation_at := clock_timestamp();
  update desmoslock_v2.tests as test
  set lifecycle = 'open', revision = test.revision + 1, opened_at = mutation_at
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and test.revision = $3;
  if not found then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    session_id, test_id, previous_test_revision, new_test_revision,
    previous_test_lifecycle, new_test_lifecycle
  ) values (
    mutation_at, 'test_opened', 'test_opened', $1,
    authorization_result.profile_id, authorization_result.session_id, $2,
    target_test.revision, target_test.revision + 1,
    target_test.lifecycle, 'open'
  );
  return query select 'test_opened'::text;
end;
$$;

create function desmoslock_v2.end_test(workspace_id uuid, test_id uuid, expected_test_revision bigint)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  test_found boolean;
  mutation_at timestamp with time zone;
begin
  if $1 is null or $2 is null or $3 is null
    or $3 < 1 or $3 > 9007199254740991
  then
    return query select 'invalid_request'::text;
    return;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  -- The Test parent is locked before any later StudentSession child operation.
  -- This tranche never locks or changes the placeholder StudentSession rows.
  select test.* into target_test
  from desmoslock_v2.tests as test
  join desmoslock_v2.workspaces as workspace on workspace.id = test.workspace_id
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and workspace.kind = 'school' and workspace.seed_key is null
  for update of test;
  test_found := found;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code;
    return;
  end if;
  if not test_found then
    return query select 'test_unavailable'::text;
    return;
  end if;
  if target_test.revision <> $3 then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  if target_test.lifecycle = 'draft' then
    return query select 'test_transition_rejected'::text;
    return;
  end if;
  if target_test.lifecycle = 'ended' then
    return query select 'test_already_ended'::text;
    return;
  end if;
  if target_test.revision >= 9007199254740991 then
    return query select 'invalid_request'::text;
    return;
  end if;
  mutation_at := clock_timestamp();
  update desmoslock_v2.tests as test
  set lifecycle = 'ended', revision = test.revision + 1, ended_at = mutation_at
  where test.workspace_id = $1 and test.id = $2 and test.seed_key is null
    and test.revision = $3;
  if not found then
    return query select 'test_revision_conflict'::text;
    return;
  end if;
  insert into desmoslock_v2.staff_audit_events (
    occurred_at, event_type, result_code, workspace_id, actor_profile_id,
    session_id, test_id, previous_test_revision, new_test_revision,
    previous_test_lifecycle, new_test_lifecycle
  ) values (
    mutation_at, 'test_ended', 'test_ended', $1,
    authorization_result.profile_id, authorization_result.session_id, $2,
    target_test.revision, target_test.revision + 1,
    target_test.lifecycle, 'ended'
  );
  return query select 'test_ended'::text;
end;
$$;

revoke all on function desmoslock_v2.current_school_tests(uuid, text, uuid),
  desmoslock_v2.current_school_test(uuid, uuid),
  desmoslock_v2.create_school_test(uuid, uuid, text),
  desmoslock_v2.update_test_title(uuid, uuid, text, bigint),
  desmoslock_v2.open_test(uuid, uuid, bigint),
  desmoslock_v2.end_test(uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function desmoslock_v2.current_school_tests(uuid, text, uuid),
  desmoslock_v2.current_school_test(uuid, uuid),
  desmoslock_v2.create_school_test(uuid, uuid, text),
  desmoslock_v2.update_test_title(uuid, uuid, text, bigint),
  desmoslock_v2.open_test(uuid, uuid, bigint),
  desmoslock_v2.end_test(uuid, uuid, bigint)
  to authenticated;

-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text
language sql
immutable
set search_path = ''
as $$
  select '5cf17174bf44e491a6bd78fe540326d8bdee169518d75c8082e5bd9b833f3f62'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256()
  from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256()
where id = 1;
