-- Accountless admission. Secrets and signature verification stay in trusted
-- main/Edge; only commitments and the verified public key cross this SQL seam.
-- Published predecessors and the generation-four pristine fixtures are intact.

alter table desmoslock_v2.student_sessions
  drop constraint student_sessions_created_only,
  add column synthetic_display_name text,
  add column created_at timestamptz not null default '2000-01-01T00:00:00.000000Z',
  add column epoch bigint not null default 1,
  add column revision bigint not null default 1,
  add column device_session_id uuid,
  add column device_public_key text,
  add column last_accepted_proof_counter bigint not null default 0,
  add column maintenance_accepted_at timestamptz[] not null default '{}',
  add column capability_digest text,
  add column capability_issued_at timestamptz,
  add column capability_expires_at timestamptz,
  add column reconnect_digest text,
  add column reconnect_expires_at timestamptz,
  add column join_request_id uuid,
  add column join_operation_digest text,
  add column join_admission_mode text,
  add column join_material_digest text,
  add column rotation_request_id uuid,
  add column rotation_operation_digest text,
  add column previous_reconnect_digest text,
  add constraint student_sessions_school_test_id_unique unique (workspace_id, test_id, id),
  add constraint student_sessions_bounds_check check (
    epoch between 1 and 9007199254740991 and revision between 1 and 9007199254740991
    and last_accepted_proof_counter between 0 and 9007199254740991
    and cardinality(maintenance_accepted_at) <= 12
    and array_position(maintenance_accepted_at, null) is null
    and created_at >= '0001-01-01T00:00:00Z'::timestamptz and created_at < '10000-01-01T00:00:00Z'::timestamptz
  ),
  add constraint student_sessions_authority_check check (
    (state = 'created' and synthetic_display_name is null
      and created_at = '2000-01-01T00:00:00.000000Z'::timestamptz
      and epoch = 1 and revision = 1 and device_session_id is null and device_public_key is null
      and last_accepted_proof_counter = 0 and cardinality(maintenance_accepted_at) = 0
      and capability_digest is null and capability_issued_at is null and capability_expires_at is null
      and reconnect_digest is null and reconnect_expires_at is null
      and join_request_id is null and join_operation_digest is null and join_admission_mode is null
      and join_material_digest is null and rotation_request_id is null
      and rotation_operation_digest is null and previous_reconnect_digest is null)
    or (state in ('active', 'removed', 'readmitted', 'forfeited') and seed_key is null
      and synthetic_display_name is not null
      and synthetic_display_name ~ '^Student [A-Z0-9][A-Z0-9-]{1,23}$'
      and ((state = 'active'
        and device_session_id is not null and device_public_key is not null
        and device_public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
        and capability_digest is not null and capability_digest ~ '^[0-9a-f]{64}$'
        and reconnect_digest is not null and reconnect_digest ~ '^[0-9a-f]{64}$'
        and capability_issued_at is not null and capability_expires_at is not null
        and reconnect_expires_at is not null
        and capability_expires_at > capability_issued_at
        and capability_expires_at <= capability_issued_at + interval '300 seconds'
        and reconnect_expires_at > capability_expires_at
        and reconnect_expires_at <= capability_issued_at + interval '900 seconds'
        and join_request_id is not null and join_operation_digest is not null
        and join_operation_digest ~ '^[0-9a-f]{64}$'
        and join_admission_mode is not null and join_admission_mode in ('initial', 'readmission')
        and join_material_digest is not null and join_material_digest ~ '^[0-9a-f]{64}$'
        and ((rotation_request_id is null and rotation_operation_digest is null and previous_reconnect_digest is null)
          or (rotation_request_id is not null and rotation_operation_digest is not null
            and rotation_operation_digest ~ '^[0-9a-f]{64}$'
            and previous_reconnect_digest is not null and previous_reconnect_digest ~ '^[0-9a-f]{64}$')))
      or (state <> 'active' and device_session_id is null and device_public_key is null
        and last_accepted_proof_counter = 0 and cardinality(maintenance_accepted_at) = 0
        and capability_digest is null and capability_issued_at is null and capability_expires_at is null
        and reconnect_digest is null and reconnect_expires_at is null
        and join_request_id is null and join_operation_digest is null and join_admission_mode is null
        and join_material_digest is null and rotation_request_id is null
        and rotation_operation_digest is null and previous_reconnect_digest is null)))
  );
create unique index student_sessions_capability_unique on desmoslock_v2.student_sessions (capability_digest);
create unique index student_sessions_reconnect_unique on desmoslock_v2.student_sessions (reconnect_digest);
create unique index student_sessions_join_request_unique on desmoslock_v2.student_sessions (join_request_id);
create unique index student_sessions_rotation_request_unique on desmoslock_v2.student_sessions (rotation_request_id);
create index student_sessions_page_order on desmoslock_v2.student_sessions
  (workspace_id, test_id, created_at desc, id desc) where seed_key is null and state <> 'created';

create table desmoslock_v2.student_join_materials (
  issuance_request_id uuid primary key,
  workspace_id uuid not null,
  test_id uuid not null,
  join_material_digest text not null unique check (join_material_digest ~ '^[0-9a-f]{64}$'),
  material_kind text not null check (material_kind in ('initial', 'readmission')),
  student_session_id uuid,
  prepared_session_revision bigint,
  prepared_epoch bigint,
  issued_test_revision bigint,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (workspace_id, test_id) references desmoslock_v2.tests (workspace_id, id),
  foreign key (workspace_id, test_id, student_session_id)
    references desmoslock_v2.student_sessions (workspace_id, test_id, id),
  check ((material_kind = 'initial' and student_session_id is null
      and prepared_session_revision is null and prepared_epoch is null and consumed_at is null
      and issued_test_revision is not null and issued_test_revision between 2 and 9007199254740991)
    or (material_kind = 'readmission' and student_session_id is not null and issued_test_revision is null
      and prepared_session_revision is not null and prepared_session_revision between 2 and 9007199254740991
      and prepared_epoch is not null and prepared_epoch between 2 and 9007199254740991))
);
create unique index student_join_materials_public_unique on desmoslock_v2.student_join_materials (test_id)
  where material_kind = 'initial';
create unique index student_join_materials_target_unique on desmoslock_v2.student_join_materials (student_session_id)
  where material_kind = 'readmission';

create table desmoslock_v2.student_device_bindings (
  workspace_id uuid not null,
  test_id uuid not null,
  device_session_id uuid not null,
  student_session_id uuid not null,
  key_thumbprint text not null check (key_thumbprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  first_epoch bigint not null check (first_epoch between 1 and 9007199254740991),
  primary key (test_id, device_session_id),
  foreign key (workspace_id, test_id, student_session_id)
    references desmoslock_v2.student_sessions (workspace_id, test_id, id)
);
create trigger student_device_bindings_immutable before update or delete
  on desmoslock_v2.student_device_bindings for each row
  execute function desmoslock_v2.internal_reject_staff_audit_mutation();
create trigger student_device_bindings_no_truncate before truncate
  on desmoslock_v2.student_device_bindings for each statement
  execute function desmoslock_v2.internal_reject_staff_audit_mutation();

create table desmoslock_v2.student_bootstrap_challenges (
  id uuid primary key,
  request_id uuid not null,
  device_session_id uuid not null,
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  key_thumbprint text not null check (key_thumbprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  logical_operation_digest text not null check (logical_operation_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create table desmoslock_v2.student_bootstrap_limits (
  id smallint primary key check (id = 1),
  accepted_at timestamptz[] not null default '{}',
  key_thumbprints text[] not null default '{}',
  check (cardinality(accepted_at) = cardinality(key_thumbprints)
    and cardinality(accepted_at) <= 120 and array_position(accepted_at, null) is null
    and array_position(key_thumbprints, null) is null)
);
alter table desmoslock_v2.student_join_materials enable row level security;
alter table desmoslock_v2.student_device_bindings enable row level security;
alter table desmoslock_v2.student_bootstrap_challenges enable row level security;
alter table desmoslock_v2.student_bootstrap_limits enable row level security;
revoke all on table desmoslock_v2.student_join_materials, desmoslock_v2.student_device_bindings,
  desmoslock_v2.student_bootstrap_challenges, desmoslock_v2.student_bootstrap_limits,
  desmoslock_v2.student_sessions from public, anon, authenticated, service_role;

create type desmoslock_v2.staff_student_session_row as (
  code text, session_id uuid, school_id uuid, test_id uuid, synthetic_display_name text,
  state text, epoch bigint, session_revision bigint, created_at text
);
create type desmoslock_v2.staff_student_mutation_row as (
  code text, test_id uuid, session_id uuid, session_revision bigint,
  test_revision bigint, epoch bigint, expires_at text
);
create type desmoslock_v2.student_admission_row as (
  code text, request_id uuid, logical_operation_digest text, school_id uuid, test_id uuid,
  student_session_id uuid, device_session_id uuid, epoch bigint, session_revision bigint,
  synthetic_display_name text, server_now_ms bigint, capability_issued_at_ms bigint,
  capability_expires_at_ms bigint, reconnect_expires_at_ms bigint, accepted_proof_counter bigint
);
create type desmoslock_v2.student_current_row as (
  code text, request_id uuid, accepted_proof_counter bigint, school_id uuid, test_id uuid,
  student_session_id uuid, device_session_id uuid, epoch bigint, session_revision bigint,
  synthetic_display_name text, server_now_ms bigint, capability_expires_at_ms bigint
);

create function desmoslock_v2.internal_student_milliseconds(value timestamptz)
returns bigint language sql immutable set search_path = '' as $$
  select floor(extract(epoch from $1) * 1000)::bigint;
$$;
create function desmoslock_v2.internal_student_timestamp(value timestamptz)
returns text language sql immutable set search_path = '' as $$
  select to_char($1 at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;
create function desmoslock_v2.internal_student_key_thumbprint(value text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if $1 is null or $1 !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then return null; end if;
  return rtrim(translate(encode(sha256(decode(translate($1, '-_', '+/') || '=', 'base64')), 'base64'), '+/', '-_'), '=');
end;
$$;

-- Values are canonical ASCII UUID/digest/mode/operation strings and safe
-- integers only; compacting jsonb's separators cannot alter string contents.
create function desmoslock_v2.internal_student_operation_digest(value jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to('desmoslock/student-logical-operation-digest/v1', 'UTF8')
    || decode('00', 'hex') || convert_to(replace($1::text, ', ', ','), 'UTF8')), 'hex');
$$;

-- All accepted times are sampled after row-lock waits. Expiry is strict.
create function desmoslock_v2.charge_student_join_attempt(key_thumbprint text)
returns table (code text) language plpgsql security definer set search_path = '' as $$
declare
  window_row desmoslock_v2.student_bootstrap_limits%rowtype;
  accepted_times timestamptz[];
  accepted_keys text[];
  checked_at timestamptz;
begin
  if $1 is null or $1 !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then
    return query select 'student_session_denied'::text; return;
  end if;
  insert into desmoslock_v2.student_bootstrap_limits (id) values (1) on conflict do nothing;
  select * into window_row from desmoslock_v2.student_bootstrap_limits where id = 1 for update;
  checked_at := clock_timestamp();
  select coalesce(array_agg(entry.at order by entry.ordinality), '{}'::timestamptz[]),
    coalesce(array_agg(entry.key order by entry.ordinality), '{}'::text[])
    into accepted_times, accepted_keys
  from unnest(window_row.accepted_at, window_row.key_thumbprints) with ordinality as entry(at, key, ordinality)
  where entry.at > checked_at - interval '60 seconds';
  if cardinality(accepted_times) >= 120 or
    (select count(*) from unnest(accepted_keys) as entry(key) where entry.key = $1) >= 12 then
    return query select 'student_session_denied'::text; return;
  end if;
  update desmoslock_v2.student_bootstrap_limits set accepted_at = array_append(accepted_times, checked_at),
    key_thumbprints = array_append(accepted_keys, $1) where id = 1;
  return query select 'ok'::text;
end;
$$;

create function desmoslock_v2.create_student_bootstrap_challenge(
  request_id uuid, device_session_id uuid, public_key text, key_thumbprint text, logical_operation_digest text
)
returns table (code text, challenge_id uuid, expires_at_ms bigint)
language plpgsql security definer set search_path = '' as $$
declare
  charged text;
  checked_at timestamptz;
  challenge uuid;
  expiry timestamptz;
begin
  -- The caller invokes this as its own committed HTTP-attempt transaction.
  select debit.code into charged from desmoslock_v2.charge_student_join_attempt($4) as debit;
  if charged <> 'ok' or $1 is null or $2 is null or $3 is null
    or desmoslock_v2.internal_student_key_thumbprint($3) is distinct from $4
    or $5 is null or $5 !~ '^[0-9a-f]{64}$' then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  -- charge holds the bootstrap singleton lock until commit; maintenance never takes it.
  checked_at := clock_timestamp();
  delete from desmoslock_v2.student_bootstrap_challenges where expires_at <= checked_at;
  if (select count(*) from desmoslock_v2.student_bootstrap_challenges) >= 256
    or (select count(*) from desmoslock_v2.student_bootstrap_challenges as c
      where c.key_thumbprint = $4 and c.consumed_at is null) >= 4 then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  challenge := gen_random_uuid();
  expiry := date_trunc('milliseconds', checked_at) + interval '15 seconds';
  insert into desmoslock_v2.student_bootstrap_challenges
    (id, request_id, device_session_id, public_key, key_thumbprint, logical_operation_digest, expires_at)
  values (challenge, $1, $2, $3, $4, $5, expiry);
  return query select 'ok'::text, challenge, desmoslock_v2.internal_student_milliseconds(expiry);
end;
$$;

-- Code issuance is a revision-only open-Test mutation with a material witness.
create or replace function desmoslock_v2.internal_guard_test_transition()
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
  if old.lifecycle = 'open' and new.lifecycle = 'open'
    and new.title is not distinct from old.title
    and new.opened_at is not distinct from old.opened_at
    and new.ended_at is not distinct from old.ended_at
    and exists (select 1 from desmoslock_v2.student_join_materials as material
      where material.test_id = new.id and material.material_kind = 'initial'
        and material.issued_test_revision = new.revision)
  then return new; end if;
  raise exception using errcode = '55000', message = 'Test transition is invalid';
end;
$$;

alter table desmoslock_v2.staff_audit_events
  drop constraint staff_audit_events_test_transition_check,
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
      and ((event_type in ('join_code_issued', 'student_session_admitted', 'student_session_claimed',
        'student_session_reconnected', 'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited')
        and test_id is not null)
        or (event_type not in ('join_code_issued', 'student_session_admitted', 'student_session_claimed',
          'student_session_reconnected', 'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited')
          and test_id is null))
      and (event_type = 'join_code_issued' or (previous_test_revision is null and new_test_revision is null))
      and (event_type = 'join_code_issued' or (previous_test_lifecycle is null and new_test_lifecycle is null))
    )
  );

alter table desmoslock_v2.staff_audit_events
  add column student_session_id uuid,
  add column actor_device_session_id uuid,
  add column previous_student_revision bigint,
  add column new_student_revision bigint,
  add column previous_student_epoch bigint,
  add column new_student_epoch bigint,
  add column previous_student_state text,
  add column new_student_state text,
  add constraint staff_audit_events_student_fkey foreign key (workspace_id, test_id, student_session_id)
    references desmoslock_v2.student_sessions (workspace_id, test_id, id),
  drop constraint staff_audit_events_type_check,
  add constraint staff_audit_events_type_check check (event_type in (
    'initial_owner_bound', 'invitation_requested', 'invitation_delivery_ready',
    'invitation_ready', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'session_revoked', 'account_recovery', 'password_recovery_sessions_revoked',
    'password_recovery_completed', 'membership_role_changed', 'school_display_name_updated',
    'test_created', 'test_title_updated', 'test_opened', 'test_ended', 'join_code_issued',
    'student_session_admitted', 'student_session_claimed', 'student_session_reconnected',
    'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited'
  )),
  drop constraint staff_audit_events_result_check,
  add constraint staff_audit_events_result_check check (result_code in (
    'ok', 'initial_owner_bound', 'invitation_pending', 'invitation_delivery_ready',
    'invitation_usable', 'invitation_delivery_failed', 'invitation_accepted',
    'invitation_expired', 'invitation_revoked', 'membership_revoked',
    'recovery_sessions_revoked', 'recovery_completed', 'membership_role_changed',
    'school_display_name_updated', 'test_created', 'test_title_updated', 'test_opened', 'test_ended',
    'join_code_issued', 'student_session_admitted', 'student_session_claimed',
    'student_session_reconnected', 'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited'
  )),
  add constraint staff_audit_events_student_transition_check check (
    (event_type in ('student_session_admitted', 'student_session_claimed', 'student_session_reconnected',
      'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited')
      and result_code = event_type and workspace_id is not null and test_id is not null
      and student_session_id is not null and subject_profile_id is null and invitation_id is null
      and ((event_type in ('student_session_removed', 'student_readmission_prepared')
        and actor_profile_id is not null and session_id is not null and actor_device_session_id is null)
        or (event_type not in ('student_session_removed', 'student_readmission_prepared')
          and actor_profile_id is null and session_id is null and actor_device_session_id is not null))
      and new_student_revision is not null and new_student_epoch is not null and new_student_state is not null
      and new_student_revision between 1 and 9007199254740991
      and new_student_epoch between 1 and 9007199254740991
      and ((event_type = 'student_session_admitted' and previous_student_revision is null
        and previous_student_epoch is null and previous_student_state is null
        and new_student_revision = 1 and new_student_epoch = 1 and new_student_state = 'active')
        or (event_type <> 'student_session_admitted' and previous_student_revision is not null
          and previous_student_epoch is not null and previous_student_state is not null
          and previous_student_revision between 1 and 9007199254740990
          and new_student_revision = previous_student_revision + 1
          and ((event_type = 'student_session_claimed' and previous_student_state = 'readmitted'
              and new_student_state = 'active' and new_student_epoch = previous_student_epoch)
            or (event_type = 'student_session_reconnected' and previous_student_state = 'active'
              and new_student_state = 'active' and new_student_epoch = previous_student_epoch)
            or (previous_student_epoch between 1 and 9007199254740990
              and new_student_epoch = previous_student_epoch + 1
              and ((event_type = 'student_session_removed' and previous_student_state in ('active', 'readmitted', 'forfeited')
                  and new_student_state = 'removed')
                or (event_type = 'student_readmission_prepared' and previous_student_state in ('active', 'removed', 'readmitted', 'forfeited')
                  and new_student_state = 'readmitted')
                or (event_type = 'student_session_forfeited' and previous_student_state = 'active'
                  and new_student_state = 'forfeited')))))))
    or (event_type not in ('student_session_admitted', 'student_session_claimed', 'student_session_reconnected',
        'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited')
      and result_code not in ('student_session_admitted', 'student_session_claimed', 'student_session_reconnected',
        'student_session_removed', 'student_readmission_prepared', 'student_session_forfeited')
      and student_session_id is null and actor_device_session_id is null
      and previous_student_revision is null and new_student_revision is null
      and previous_student_epoch is null and new_student_epoch is null
      and previous_student_state is null and new_student_state is null)
  ),
  add constraint staff_audit_events_join_code_check check (
    (event_type = 'join_code_issued' and result_code = event_type
      and workspace_id is not null and test_id is not null and actor_profile_id is not null and session_id is not null
      and subject_profile_id is null and invitation_id is null
      and previous_test_revision is not null and new_test_revision is not null
      and previous_test_revision between 1 and 9007199254740990 and new_test_revision = previous_test_revision + 1
      and previous_test_lifecycle is not null and new_test_lifecycle is not null
      and previous_test_lifecycle = 'open' and new_test_lifecycle = 'open')
    or (event_type <> 'join_code_issued' and result_code <> 'join_code_issued')
  );

create function desmoslock_v2.internal_student_audit(
  event text, old_session desmoslock_v2.student_sessions, new_session desmoslock_v2.student_sessions,
  actor_profile uuid, actor_session uuid, actor_device uuid, occurred_at timestamptz, event_id uuid
) returns void language sql set search_path = '' as $$
  insert into desmoslock_v2.staff_audit_events (
    id, occurred_at, event_type, result_code, workspace_id, test_id, student_session_id,
    actor_profile_id, session_id, actor_device_session_id,
    previous_student_revision, new_student_revision, previous_student_epoch, new_student_epoch,
    previous_student_state, new_student_state
  ) values (coalesce($8, gen_random_uuid()), $7, $1, $1, ($3).workspace_id, ($3).test_id, ($3).id, $4, $5, $6,
    ($2).revision, ($3).revision, ($2).epoch, ($3).epoch, ($2).state, ($3).state);
$$;

create function desmoslock_v2.current_test_student_sessions(
  workspace_id uuid, test_id uuid, before_created_at text, before_session_id uuid
) returns setof desmoslock_v2.staff_student_session_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  cursor_time timestamptz;
  result desmoslock_v2.staff_student_session_row;
begin
  result.code := 'invalid_request';
  if $1 is null or $2 is null or (($3 is null) <> ($4 is null)) then return next result; return; end if;
  if $3 is not null then
    cursor_time := desmoslock_v2.internal_parse_test_timestamp($3);
    if cursor_time is null then return next result; return; end if;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  select t.* into target_test from desmoslock_v2.tests as t
    join desmoslock_v2.workspaces as w on w.id = t.workspace_id
    where t.workspace_id = $1 and t.id = $2 and t.seed_key is null and w.seed_key is null and w.kind = 'school'
    for share of t;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  if target_test.id is null then result.code := 'test_unavailable'; return next result; return; end if;
  return query select 'ok'::text, s.id, s.workspace_id, s.test_id, s.synthetic_display_name,
    s.state, s.epoch, s.revision,
    desmoslock_v2.internal_student_timestamp(s.created_at)
  from desmoslock_v2.student_sessions as s
  where s.workspace_id = $1 and s.test_id = $2 and s.seed_key is null and s.state <> 'created'
    and ($3 is null or (s.created_at, s.id) < (cursor_time, $4))
  order by s.created_at desc, s.id desc limit 51;
end;
$$;

create function desmoslock_v2.issue_test_join_code(
  workspace_id uuid, test_id uuid, expected_test_revision bigint, issuance_request_id uuid, join_material_digest text
) returns setof desmoslock_v2.staff_student_mutation_row
language plpgsql security definer set search_path = '' as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  material desmoslock_v2.student_join_materials%rowtype;
  result desmoslock_v2.staff_student_mutation_row;
  changed_at timestamptz;
begin
  result.code := 'invalid_request';
  if $1 is null or $2 is null or $3 is null or $3 not between 1 and 9007199254740991
    or $4 is null or $5 is null or $5 !~ '^[0-9a-f]{64}$' then return next result; return; end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  select t.* into target_test from desmoslock_v2.tests as t
    join desmoslock_v2.workspaces as w on w.id = t.workspace_id
    where t.workspace_id = $1 and t.id = $2 and t.seed_key is null and w.seed_key is null and w.kind = 'school'
    for update of t;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  if target_test.id is null then result.code := 'test_unavailable'; return next result; return; end if;
  changed_at := clock_timestamp();
  select m.* into material from desmoslock_v2.student_join_materials as m where m.issuance_request_id = $4;
  if found then
    if material.test_id <> $2 or material.material_kind <> 'initial' or material.join_material_digest <> $5
      or material.issued_test_revision <> $3 + 1 or material.expires_at <= changed_at then
      result.code := 'test_revision_conflict'; return next result; return;
    end if;
    if target_test.lifecycle <> 'open' then result.code := 'test_transition_rejected'; return next result; return; end if;
    result := row('join_code_already_issued', $2, null, null, material.issued_test_revision, null,
      desmoslock_v2.internal_student_timestamp(material.expires_at));
    return next result; return;
  end if;
  -- An old issuance ID remains in the typed immutable audit, not a command journal.
  if exists (select 1 from desmoslock_v2.staff_audit_events as e where e.id = $4) then
    result.code := 'test_revision_conflict'; return next result; return;
  end if;
  if target_test.revision <> $3 then result.code := 'test_revision_conflict'; return next result; return; end if;
  if target_test.lifecycle <> 'open' then result.code := 'test_transition_rejected'; return next result; return; end if;
  if $3 = 9007199254740991 then return next result; return; end if;
  delete from desmoslock_v2.student_join_materials as m where m.test_id = $2 and m.material_kind = 'initial';
  insert into desmoslock_v2.student_join_materials
    (issuance_request_id, workspace_id, test_id, join_material_digest, material_kind, issued_test_revision, expires_at)
  values ($4, $1, $2, $5, 'initial', $3 + 1, changed_at + interval '15 minutes') returning * into material;
  update desmoslock_v2.tests set revision = revision + 1 where id = $2;
  insert into desmoslock_v2.staff_audit_events (id, occurred_at, event_type, result_code,
    workspace_id, actor_profile_id, session_id, test_id, previous_test_revision, new_test_revision,
    previous_test_lifecycle, new_test_lifecycle)
  values ($4, changed_at, 'join_code_issued', 'join_code_issued', $1, authorization_result.profile_id,
    authorization_result.session_id, $2, $3, $3 + 1, 'open', 'open');
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    raise exception using errcode = 'PSS02', message = 'staff authority changed';
  end if;
  result := row('join_code_issued', $2, null, null, $3 + 1, null,
    desmoslock_v2.internal_student_timestamp(material.expires_at));
  return next result;
exception when sqlstate 'PSS02' then
  result.code := authorization_result.code; return next result;
when unique_violation then
  result := row('test_revision_conflict', null, null, null, null, null, null); return next result;
end;
$$;

-- Shared staff transition body is private and has only two fixed callers.
create function desmoslock_v2.internal_student_staff_transition(
  workspace_id uuid, test_id uuid, student_session_id uuid, expected_session_revision bigint,
  issuance_request_id uuid, join_material_digest text, prepare boolean
) returns setof desmoslock_v2.staff_student_mutation_row
language plpgsql security definer set search_path = '' as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  before_session desmoslock_v2.student_sessions%rowtype;
  after_session desmoslock_v2.student_sessions%rowtype;
  material desmoslock_v2.student_join_materials%rowtype;
  result desmoslock_v2.staff_student_mutation_row;
  changed_at timestamptz;
begin
  result.code := 'invalid_request';
  if $1 is null or $2 is null or $3 is null or $4 is null or $4 not between 1 and 9007199254740991
    or ($7 and ($5 is null or $6 is null or $6 !~ '^[0-9a-f]{64}$')) then return next result; return; end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  select t.* into target_test from desmoslock_v2.tests as t
    join desmoslock_v2.workspaces as w on w.id = t.workspace_id
    where t.workspace_id = $1 and t.id = $2 and t.seed_key is null and w.seed_key is null and w.kind = 'school'
    for share of t;
  select s.* into before_session from desmoslock_v2.student_sessions as s
    where s.workspace_id = $1 and s.test_id = $2 and s.id = $3 and s.seed_key is null and s.state <> 'created' for update;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
  if target_test.id is null then result.code := 'test_unavailable'; return next result; return; end if;
  if before_session.id is null then result.code := 'student_session_unavailable'; return next result; return; end if;
  changed_at := clock_timestamp();
  if $7 then
    select m.* into material from desmoslock_v2.student_join_materials as m where m.issuance_request_id = $5 for update;
    -- Material lock can wait; check live provider authority again after it.
    select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
    if authorization_result.code <> 'ok' then result.code := authorization_result.code; return next result; return; end if;
    changed_at := clock_timestamp();
    if material.issuance_request_id is not null then
      if material.student_session_id <> $3 or material.material_kind <> 'readmission'
        or material.join_material_digest <> $6 or material.prepared_session_revision <> $4 + 1
        or material.prepared_session_revision <> before_session.revision or material.prepared_epoch <> before_session.epoch
        or material.expires_at <= changed_at or material.consumed_at is not null
        or before_session.state <> 'readmitted' then
        result.code := 'student_session_revision_conflict'; return next result; return;
      end if;
      if target_test.lifecycle <> 'open' then result.code := 'student_session_transition_rejected'; return next result; return; end if;
      result := row('student_readmission_already_prepared', $2, $3, before_session.revision, null, before_session.epoch,
        desmoslock_v2.internal_student_timestamp(material.expires_at)); return next result; return;
    end if;
    if exists (select 1 from desmoslock_v2.staff_audit_events as e where e.id = $5) then
      result.code := 'student_session_revision_conflict'; return next result; return;
    end if;
  end if;
  if before_session.revision <> $4 then result.code := 'student_session_revision_conflict'; return next result; return; end if;
  if target_test.lifecycle <> 'open' then result.code := 'student_session_transition_rejected'; return next result; return; end if;
  if not $7 and before_session.state = 'removed' then
    result := row('student_session_already_removed', $2, $3, before_session.revision, null, before_session.epoch, null);
    return next result; return;
  end if;
  if $7 and before_session.state = 'active' and before_session.reconnect_expires_at > changed_at then
    result.code := 'student_session_transition_rejected'; return next result; return;
  end if;
  if before_session.revision = 9007199254740991 or before_session.epoch = 9007199254740991 then
    return next result; return;
  end if;
  delete from desmoslock_v2.student_join_materials as m where m.student_session_id = $3;
  update desmoslock_v2.student_sessions set state = case when $7 then 'readmitted' else 'removed' end,
    revision = revision + 1, epoch = epoch + 1, device_session_id = null, device_public_key = null,
    last_accepted_proof_counter = 0, maintenance_accepted_at = '{}', capability_digest = null,
    capability_issued_at = null, capability_expires_at = null, reconnect_digest = null, reconnect_expires_at = null,
    join_request_id = null, join_operation_digest = null, join_admission_mode = null, join_material_digest = null,
    rotation_request_id = null, rotation_operation_digest = null, previous_reconnect_digest = null
  where id = $3 returning * into after_session;
  if $7 then
    insert into desmoslock_v2.student_join_materials
      (issuance_request_id, workspace_id, test_id, join_material_digest, material_kind,
        student_session_id, prepared_session_revision, prepared_epoch, expires_at)
    values ($5, $1, $2, $6, 'readmission', $3, after_session.revision, after_session.epoch,
      changed_at + interval '15 minutes') returning * into material;
  end if;
  perform desmoslock_v2.internal_student_audit(
    case when $7 then 'student_readmission_prepared' else 'student_session_removed' end,
    before_session, after_session, authorization_result.profile_id, authorization_result.session_id, null, changed_at,
    case when $7 then $5 else null end);
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    raise exception using errcode = 'PSS02', message = 'staff authority changed';
  end if;
  result := row(case when $7 then 'student_readmission_prepared' else 'student_session_removed' end,
    $2, $3, after_session.revision, null, after_session.epoch,
    case when $7 then desmoslock_v2.internal_student_timestamp(material.expires_at) else null end);
  return next result;
exception when sqlstate 'PSS02' then
  result.code := authorization_result.code; return next result;
when unique_violation then
  result := row('student_session_revision_conflict', null, null, null, null, null, null); return next result;
end;
$$;
create function desmoslock_v2.remove_student_session(
  workspace_id uuid, test_id uuid, student_session_id uuid, expected_session_revision bigint
) returns setof desmoslock_v2.staff_student_mutation_row
language sql security definer set search_path = '' as $$
  select * from desmoslock_v2.internal_student_staff_transition($1, $2, $3, $4, null, null, false);
$$;
create function desmoslock_v2.prepare_student_readmission(
  workspace_id uuid, test_id uuid, student_session_id uuid, expected_session_revision bigint,
  issuance_request_id uuid, join_material_digest text
) returns setof desmoslock_v2.staff_student_mutation_row
language sql security definer set search_path = '' as $$
  select * from desmoslock_v2.internal_student_staff_transition($1, $2, $3, $4, $5, $6, true);
$$;

create function desmoslock_v2.commit_student_session_join(
  admission_mode text, request_id uuid, device_session_id uuid, verified_public_key text,
  key_thumbprint text, join_material_digest text, capability_digest text, reconnect_digest text,
  logical_operation_digest text, challenge_id uuid, challenge_expires_at bigint
) returns setof desmoslock_v2.student_admission_row
language plpgsql security definer set search_path = '' as $$
declare
  target_test desmoslock_v2.tests%rowtype;
  before_session desmoslock_v2.student_sessions%rowtype;
  after_session desmoslock_v2.student_sessions%rowtype;
  material desmoslock_v2.student_join_materials%rowtype;
  challenge desmoslock_v2.student_bootstrap_challenges%rowtype;
  result desmoslock_v2.student_admission_row;
  resolved_test uuid;
  resolved_session uuid;
  checked_at timestamptz;
  receipt boolean;
  provisional boolean;
  attempt integer;
begin
  result.code := 'student_session_denied';
  if $1 is null or $1 not in ('initial', 'readmission') or $2 is null or $3 is null or $4 is null
    or desmoslock_v2.internal_student_key_thumbprint($4) is distinct from $5
    or $6 is null or $6 !~ '^[0-9a-f]{64}$' or $7 is null or $7 !~ '^[0-9a-f]{64}$'
    or $8 is null or $8 !~ '^[0-9a-f]{64}$' or $10 is null or $11 is null
    or $9 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('join', $1, $2, $3, $6, $7, $8)) then return next result; return; end if;
  -- A unique insert may wait for a concurrent exact first admission. Roll back
  -- the provisional attempt and resolve its now-committed canonical row once.
  for attempt in 1..2 loop
    begin
      resolved_test := null; resolved_session := null; before_session := null; material := null;
      select s.test_id, s.id into resolved_test, resolved_session
        from desmoslock_v2.student_sessions as s where s.join_request_id = $2;
      if resolved_test is null then
        select m.test_id, m.student_session_id into resolved_test, resolved_session
          from desmoslock_v2.student_join_materials as m where m.join_material_digest = $6;
      end if;
      if resolved_test is null then raise exception using errcode = 'PSS01', message = 'student session denied'; end if;
      select t.* into target_test from desmoslock_v2.tests as t
        join desmoslock_v2.workspaces as w on w.id = t.workspace_id
        where t.id = resolved_test and t.seed_key is null and w.seed_key is null and w.kind = 'school'
        for share of t;
      if target_test.id is null or target_test.lifecycle <> 'open' then
        raise exception using errcode = 'PSS01', message = 'student session denied';
      end if;
      if resolved_session is null then
        select b.student_session_id into resolved_session from desmoslock_v2.student_device_bindings as b
          where b.test_id = resolved_test and b.device_session_id = $3;
      end if;
      if resolved_session is not null then
        select s.* into before_session from desmoslock_v2.student_sessions as s
          where s.id = resolved_session and s.test_id = resolved_test for update;
      end if;
      receipt := coalesce(before_session.id is not null and before_session.join_request_id = $2, false);
      provisional := before_session.id is null;
      -- No material/challenge lock precedes an existing session UPDATE lock.
      if not receipt then
        select m.* into material from desmoslock_v2.student_join_materials as m
          where m.test_id = resolved_test and m.join_material_digest = $6 for update;
      end if;
      select c.* into challenge from desmoslock_v2.student_bootstrap_challenges as c where c.id = $10 for update;
      checked_at := clock_timestamp();
      if challenge.id is null or challenge.consumed_at is not null or challenge.expires_at <= checked_at
        or challenge.request_id <> $2 or challenge.device_session_id <> $3 or challenge.public_key <> $4
        or challenge.key_thumbprint <> $5 or challenge.logical_operation_digest <> $9
        or desmoslock_v2.internal_student_milliseconds(challenge.expires_at) <> $11 then
        raise exception using errcode = 'PSS01', message = 'student session denied';
      end if;
      if receipt then
        if before_session.state <> 'active' or before_session.device_session_id <> $3
          or before_session.device_public_key <> $4 or before_session.join_admission_mode <> $1
          or before_session.join_operation_digest <> $9 or before_session.join_material_digest <> $6
          or before_session.capability_digest <> $7 or before_session.reconnect_digest <> $8
          or before_session.rotation_request_id is not null or before_session.reconnect_expires_at <= checked_at then
          raise exception using errcode = 'PSS01', message = 'student session denied';
        end if;
        after_session := before_session;
      else
        if material.issuance_request_id is null or material.material_kind <> $1
          or material.expires_at <= checked_at or material.consumed_at is not null then
          raise exception using errcode = 'PSS01', message = 'student session denied';
        end if;
        if $1 = 'initial' then
          if not provisional then raise exception using errcode = 'PSS01', message = 'student session denied'; end if;
          resolved_session := gen_random_uuid();
        insert into desmoslock_v2.student_sessions (
          id, workspace_id, test_id, state, seed_key, synthetic_display_name, created_at,
          epoch, revision, device_session_id, device_public_key, capability_digest, capability_issued_at,
          capability_expires_at, reconnect_digest, reconnect_expires_at, join_request_id,
          join_operation_digest, join_admission_mode, join_material_digest
        ) values (resolved_session, target_test.workspace_id, resolved_test, 'active', null,
          'Student ' || upper(left(replace(resolved_session::text, '-', ''), 12)), checked_at,
          1, 1, $3, $4, $7, checked_at, checked_at + interval '300 seconds', $8,
          checked_at + interval '900 seconds', $2, $9, $1, $6) returning * into after_session;
        insert into desmoslock_v2.student_device_bindings
          (workspace_id, test_id, device_session_id, student_session_id, key_thumbprint, first_epoch)
        values (target_test.workspace_id, resolved_test, $3, resolved_session, $5, 1);
        else
          if before_session.id is null or material.student_session_id <> before_session.id
            or before_session.state <> 'readmitted' or material.prepared_session_revision <> before_session.revision
            or material.prepared_epoch <> before_session.epoch or before_session.revision = 9007199254740991
            or exists (select 1 from desmoslock_v2.student_device_bindings as b
              where b.test_id = resolved_test and b.device_session_id = $3) then
            raise exception using errcode = 'PSS01', message = 'student session denied';
          end if;
          update desmoslock_v2.student_sessions set state = 'active', revision = revision + 1,
            device_session_id = $3, device_public_key = $4, last_accepted_proof_counter = 0, maintenance_accepted_at = '{}',
            capability_digest = $7, capability_issued_at = checked_at, capability_expires_at = checked_at + interval '300 seconds',
            reconnect_digest = $8, reconnect_expires_at = checked_at + interval '900 seconds',
            join_request_id = $2, join_operation_digest = $9, join_admission_mode = $1, join_material_digest = $6,
            rotation_request_id = null, rotation_operation_digest = null, previous_reconnect_digest = null
          where id = resolved_session returning * into after_session;
          insert into desmoslock_v2.student_device_bindings
            (workspace_id, test_id, device_session_id, student_session_id, key_thumbprint, first_epoch)
          values (target_test.workspace_id, resolved_test, $3, resolved_session, $5, after_session.epoch);
          update desmoslock_v2.student_join_materials set consumed_at = checked_at where issuance_request_id = material.issuance_request_id;
        end if;
        perform desmoslock_v2.internal_student_audit(
          case when provisional then 'student_session_admitted' else 'student_session_claimed' end,
          before_session, after_session, null, null, $3, checked_at, $2);
      end if;
      -- Unique-index waits may occur during insertion/rotation even after all
      -- explicit row locks. Recheck the final live clock before publishing.
      checked_at := clock_timestamp();
      if challenge.expires_at <= checked_at
        or (not receipt and material.expires_at <= checked_at)
        or (receipt and after_session.reconnect_expires_at <= checked_at) then
        raise exception using errcode = 'PSS01', message = 'student session denied';
      end if;
      update desmoslock_v2.student_bootstrap_challenges set consumed_at = checked_at where id = $10;
      result := row('ok', $2, $9, after_session.workspace_id, after_session.test_id, after_session.id,
        after_session.device_session_id, after_session.epoch, after_session.revision, after_session.synthetic_display_name,
        desmoslock_v2.internal_student_milliseconds(checked_at),
        desmoslock_v2.internal_student_milliseconds(after_session.capability_issued_at),
        desmoslock_v2.internal_student_milliseconds(after_session.capability_expires_at),
        desmoslock_v2.internal_student_milliseconds(after_session.reconnect_expires_at), null);
      return next result; return;
    exception
      when unique_violation then
        if attempt = 2 then return next result; return; end if;
      when sqlstate 'PSS01' then return next result; return;
    end;
  end loop;
end;
$$;

create function desmoslock_v2.internal_student_locked_session(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint
) returns desmoslock_v2.student_sessions
language plpgsql security definer set search_path = '' as $$
declare
  target_test desmoslock_v2.tests%rowtype;
  target_session desmoslock_v2.student_sessions%rowtype;
begin
  select t.* into target_test from desmoslock_v2.tests as t
    join desmoslock_v2.workspaces as w on w.id = t.workspace_id
    where t.workspace_id = $1 and t.id = $2 and t.seed_key is null and w.seed_key is null and w.kind = 'school'
    for share of t;
  if target_test.id is null or target_test.lifecycle <> 'open' then return null; end if;
  select s.* into target_session from desmoslock_v2.student_sessions as s
    where s.workspace_id = $1 and s.test_id = $2 and s.id = $3 for update;
  if target_session.id is null or target_session.state <> 'active'
    or target_session.device_session_id is distinct from $4 or target_session.epoch is distinct from $5 then return null; end if;
  return target_session;
end;
$$;

create function desmoslock_v2.read_student_maintenance_key(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  operation text, request_id uuid, logical_operation_digest text, credential_digest text
) returns table (code text, public_key text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  target_session desmoslock_v2.student_sessions%rowtype;
  checked_at timestamptz;
begin
  target_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  checked_at := clock_timestamp();
  if target_session.id is null or $6 is null or $6 not in ('read', 'reconnect', 'forfeit') or $7 is null or $8 is null or $8 !~ '^[0-9a-f]{64}$'
    or $9 is null or $9 !~ '^[0-9a-f]{64}$' or (
      ($6 in ('read', 'forfeit') and target_session.capability_digest = $9 and target_session.capability_expires_at > checked_at)
      or ($6 = 'reconnect' and target_session.reconnect_expires_at > checked_at
        and (target_session.reconnect_digest = $9 or (target_session.previous_reconnect_digest = $9
          and target_session.rotation_request_id = $7 and target_session.rotation_operation_digest = $8)))) is not true then
    return query select 'student_session_denied'::text, null::text; return;
  end if;
  return query select 'ok'::text, target_session.device_public_key;
end;
$$;

create function desmoslock_v2.internal_student_next_allowance(accepted_at timestamptz[], checked_at timestamptz)
returns timestamptz[] language plpgsql immutable set search_path = '' as $$
declare retained timestamptz[];
begin
  select coalesce(array_agg(entry.at order by entry.at), '{}'::timestamptz[]) into retained
    from unnest($1) as entry(at) where entry.at > $2 - interval '60 seconds';
  if cardinality(retained) >= 12 then return null; end if;
  return array_append(retained, $2);
end;
$$;

create function desmoslock_v2.commit_student_session_read(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  request_id uuid, logical_operation_digest text, capability_digest text, verified_public_key text, proof_counter bigint
) returns setof desmoslock_v2.student_current_row
language plpgsql security definer set search_path = '' as $$
declare
  target_session desmoslock_v2.student_sessions%rowtype;
  result desmoslock_v2.student_current_row;
  checked_at timestamptz;
  allowance timestamptz[];
begin
  result.code := 'student_session_denied';
  if $6 is null or $8 is null or $8 !~ '^[0-9a-f]{64}$' or $10 is null or $10 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('read', $6, jsonb_build_array($1, $2, $3, $4, $5), $8)) then return next result; return; end if;
  target_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  checked_at := clock_timestamp();
  if target_session.id is null or target_session.device_public_key is distinct from $9
    or target_session.capability_digest is distinct from $8 or target_session.capability_expires_at <= checked_at
    or target_session.last_accepted_proof_counter >= $10 then return next result; return; end if;
  allowance := desmoslock_v2.internal_student_next_allowance(target_session.maintenance_accepted_at, checked_at);
  if allowance is null then return next result; return; end if;
  update desmoslock_v2.student_sessions set last_accepted_proof_counter = $10, maintenance_accepted_at = allowance where id = $3;
  result := row('ok', $6, $10, $1, $2, $3, $4, $5, target_session.revision, target_session.synthetic_display_name,
    desmoslock_v2.internal_student_milliseconds(checked_at),
    desmoslock_v2.internal_student_milliseconds(target_session.capability_expires_at));
  return next result;
end;
$$;

create function desmoslock_v2.commit_student_session_reconnect(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  request_id uuid, logical_operation_digest text, expected_session_revision bigint, reconnect_digest text,
  next_capability_digest text, next_reconnect_digest text, verified_public_key text, proof_counter bigint
) returns setof desmoslock_v2.student_admission_row
language plpgsql security definer set search_path = '' as $$
declare
  before_session desmoslock_v2.student_sessions%rowtype;
  after_session desmoslock_v2.student_sessions%rowtype;
  result desmoslock_v2.student_admission_row;
  checked_at timestamptz;
  allowance timestamptz[];
  receipt boolean;
begin
  result.code := 'student_session_denied';
  if $6 is null or $8 is null or $8 not between 1 and 9007199254740991
    or $9 is null or $9 !~ '^[0-9a-f]{64}$' or $10 is null or $10 !~ '^[0-9a-f]{64}$'
    or $11 is null or $11 !~ '^[0-9a-f]{64}$' or $13 is null or $13 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('reconnect', $6, jsonb_build_array($1, $2, $3, $4, $5), $8, $9, $10, $11)) then return next result; return; end if;
  before_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  checked_at := clock_timestamp();
  if before_session.id is null or before_session.device_public_key is distinct from $12
    or before_session.last_accepted_proof_counter >= $13 or before_session.reconnect_expires_at <= checked_at then
    return next result; return;
  end if;
  receipt := before_session.rotation_request_id = $6;
  if coalesce(receipt, false) then
    if before_session.rotation_operation_digest <> $7 or before_session.previous_reconnect_digest <> $9
      or before_session.capability_digest <> $10 or before_session.reconnect_digest <> $11
      or before_session.revision <> $8 + 1 then return next result; return; end if;
  else
    if before_session.revision <> $8 or before_session.reconnect_digest <> $9
      or before_session.revision = 9007199254740991 or $10 = before_session.capability_digest
      or $11 = before_session.reconnect_digest then return next result; return; end if;
  end if;
  allowance := desmoslock_v2.internal_student_next_allowance(before_session.maintenance_accepted_at, checked_at);
  if allowance is null then return next result; return; end if;
  if coalesce(receipt, false) then
    update desmoslock_v2.student_sessions set last_accepted_proof_counter = $13, maintenance_accepted_at = allowance
      where id = $3 returning * into after_session;
  else
    update desmoslock_v2.student_sessions set revision = revision + 1, capability_digest = $10,
      capability_issued_at = checked_at, capability_expires_at = checked_at + interval '300 seconds',
      reconnect_digest = $11, reconnect_expires_at = checked_at + interval '900 seconds',
      rotation_request_id = $6, rotation_operation_digest = $7, previous_reconnect_digest = $9,
      last_accepted_proof_counter = $13, maintenance_accepted_at = allowance
    where id = $3 returning * into after_session;
    perform desmoslock_v2.internal_student_audit('student_session_reconnected', before_session, after_session,
      null, null, $4, checked_at, $6);
  end if;
  checked_at := clock_timestamp();
  if before_session.reconnect_expires_at <= checked_at then
    raise exception using errcode = 'PSS01', message = 'student session denied';
  end if;
  result := row('ok', $6, $7, $1, $2, $3, $4, $5, after_session.revision, after_session.synthetic_display_name,
    desmoslock_v2.internal_student_milliseconds(checked_at),
    desmoslock_v2.internal_student_milliseconds(after_session.capability_issued_at),
    desmoslock_v2.internal_student_milliseconds(after_session.capability_expires_at),
    desmoslock_v2.internal_student_milliseconds(after_session.reconnect_expires_at), $13);
  return next result;
exception when unique_violation or sqlstate 'PSS01' then
  result := row('student_session_denied', null, null, null, null, null, null, null, null, null, null, null, null, null, null);
  return next result;
end;
$$;

create type desmoslock_v2.student_forfeit_row as (code text, request_id uuid, accepted_proof_counter bigint);

create function desmoslock_v2.commit_student_session_forfeit(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  request_id uuid, logical_operation_digest text, expected_session_revision bigint,
  capability_digest text, verified_public_key text, proof_counter bigint
) returns setof desmoslock_v2.student_forfeit_row
language plpgsql security definer set search_path = '' as $$
declare
  before_session desmoslock_v2.student_sessions%rowtype;
  after_session desmoslock_v2.student_sessions%rowtype;
  checked_at timestamptz;
  allowance timestamptz[];
begin
  if $6 is null or $8 is null or $8 not between 1 and 9007199254740991
    or $9 is null or $9 !~ '^[0-9a-f]{64}$' or $11 is null or $11 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('forfeit', $6, jsonb_build_array($1, $2, $3, $4, $5), $8, $9)) then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  before_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  checked_at := clock_timestamp();
  if before_session.id is null or before_session.device_public_key is distinct from $10
    or before_session.capability_digest is distinct from $9 or before_session.capability_expires_at <= checked_at
    or before_session.revision <> $8 or before_session.revision = 9007199254740991 or before_session.epoch = 9007199254740991
    or before_session.last_accepted_proof_counter >= $11 then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  allowance := desmoslock_v2.internal_student_next_allowance(before_session.maintenance_accepted_at, checked_at);
  if allowance is null then return query select 'student_session_denied'::text, null::uuid, null::bigint; return; end if;
  update desmoslock_v2.student_sessions as s set state = 'forfeited', revision = s.revision + 1, epoch = s.epoch + 1,
    device_session_id = null, device_public_key = null, last_accepted_proof_counter = 0, maintenance_accepted_at = '{}',
    capability_digest = null, capability_issued_at = null, capability_expires_at = null,
    reconnect_digest = null, reconnect_expires_at = null, join_request_id = null, join_operation_digest = null,
    join_admission_mode = null, join_material_digest = null, rotation_request_id = null,
    rotation_operation_digest = null, previous_reconnect_digest = null
  where id = $3 returning * into after_session;
  delete from desmoslock_v2.student_join_materials as m where m.student_session_id = $3;
  perform desmoslock_v2.internal_student_audit('student_session_forfeited', before_session, after_session,
    null, null, $4, checked_at, $6);
  if before_session.capability_expires_at <= clock_timestamp() then
    raise exception using errcode = 'PSS01', message = 'student session denied';
  end if;
  return query select 'ok'::text, $6, $11;
exception when sqlstate 'PSS01' then
  return query select 'student_session_denied'::text, null::uuid, null::bigint;
end;
$$;

create function desmoslock_v2.internal_guard_student_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new is not distinct from old then return new; end if;
  if old.state = 'created' or old.seed_key is not null or new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id or new.test_id is distinct from old.test_id
    or new.seed_key is distinct from old.seed_key or new.created_at is distinct from old.created_at
    or new.synthetic_display_name is distinct from old.synthetic_display_name then
    raise exception using errcode = '55000', message = 'Student attribution is immutable';
  end if;
  if new.revision = old.revision then
    if old.state = 'active' and new.last_accepted_proof_counter > old.last_accepted_proof_counter
      and (to_jsonb(new) - 'last_accepted_proof_counter' - 'maintenance_accepted_at')
        = (to_jsonb(old) - 'last_accepted_proof_counter' - 'maintenance_accepted_at') then return new; end if;
    raise exception using errcode = '55000', message = 'Student proof-only transition is invalid';
  end if;
  if old.revision = 9007199254740991 or new.revision <> old.revision + 1 then
    raise exception using errcode = '55000', message = 'Student revision must advance exactly once';
  end if;
  if (old.state = 'readmitted' and new.state = 'active' and new.epoch = old.epoch
      and new.last_accepted_proof_counter = 0 and cardinality(new.maintenance_accepted_at) = 0)
    or (old.state = 'active' and new.state = 'active' and new.epoch = old.epoch
      and new.device_session_id is not distinct from old.device_session_id
      and new.device_public_key is not distinct from old.device_public_key
      and new.join_request_id is not distinct from old.join_request_id
      and new.join_operation_digest is not distinct from old.join_operation_digest
      and new.join_admission_mode is not distinct from old.join_admission_mode
      and new.join_material_digest is not distinct from old.join_material_digest
      and new.capability_digest is distinct from old.capability_digest
      and new.reconnect_digest is distinct from old.reconnect_digest
      and new.previous_reconnect_digest = old.reconnect_digest
      and new.rotation_request_id is not null
      and new.last_accepted_proof_counter > old.last_accepted_proof_counter)
    or (old.epoch < 9007199254740991 and new.epoch = old.epoch + 1
      and ((new.state = 'removed' and old.state in ('active', 'readmitted', 'forfeited'))
        or (new.state = 'readmitted' and old.state in ('active', 'removed', 'readmitted', 'forfeited'))
        or (new.state = 'forfeited' and old.state = 'active'))) then return new; end if;
  raise exception using errcode = '55000', message = 'Student transition is invalid';
end;
$$;
create trigger student_sessions_immutable_transition before update on desmoslock_v2.student_sessions
  for each row execute function desmoslock_v2.internal_guard_student_transition();

revoke all on type desmoslock_v2.staff_student_session_row, desmoslock_v2.staff_student_mutation_row,
  desmoslock_v2.student_admission_row, desmoslock_v2.student_current_row, desmoslock_v2.student_forfeit_row
  from public, anon, authenticated, service_role;
revoke all on function
  desmoslock_v2.internal_student_milliseconds(timestamptz),
  desmoslock_v2.internal_student_timestamp(timestamptz),
  desmoslock_v2.internal_student_key_thumbprint(text),
  desmoslock_v2.internal_student_operation_digest(jsonb),
  desmoslock_v2.internal_student_audit(text, desmoslock_v2.student_sessions, desmoslock_v2.student_sessions, uuid, uuid, uuid, timestamptz, uuid),
  desmoslock_v2.internal_student_staff_transition(uuid, uuid, uuid, bigint, uuid, text, boolean),
  desmoslock_v2.internal_student_locked_session(uuid, uuid, uuid, uuid, bigint),
  desmoslock_v2.internal_student_next_allowance(timestamptz[], timestamptz),
  desmoslock_v2.internal_guard_student_transition(),
  desmoslock_v2.create_student_bootstrap_challenge(uuid, uuid, text, text, text),
  desmoslock_v2.charge_student_join_attempt(text),
  desmoslock_v2.commit_student_session_join(text, uuid, uuid, text, text, text, text, text, text, uuid, bigint),
  desmoslock_v2.read_student_maintenance_key(uuid, uuid, uuid, uuid, bigint, text, uuid, text, text),
  desmoslock_v2.commit_student_session_read(uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, bigint),
  desmoslock_v2.commit_student_session_reconnect(uuid, uuid, uuid, uuid, bigint, uuid, text, bigint, text, text, text, text, bigint),
  desmoslock_v2.commit_student_session_forfeit(uuid, uuid, uuid, uuid, bigint, uuid, text, bigint, text, text, bigint),
  desmoslock_v2.current_test_student_sessions(uuid, uuid, text, uuid),
  desmoslock_v2.issue_test_join_code(uuid, uuid, bigint, uuid, text),
  desmoslock_v2.remove_student_session(uuid, uuid, uuid, bigint),
  desmoslock_v2.prepare_student_readmission(uuid, uuid, uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  desmoslock_v2.create_student_bootstrap_challenge(uuid, uuid, text, text, text),
  desmoslock_v2.charge_student_join_attempt(text),
  desmoslock_v2.commit_student_session_join(text, uuid, uuid, text, text, text, text, text, text, uuid, bigint),
  desmoslock_v2.read_student_maintenance_key(uuid, uuid, uuid, uuid, bigint, text, uuid, text, text),
  desmoslock_v2.commit_student_session_read(uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, bigint),
  desmoslock_v2.commit_student_session_reconnect(uuid, uuid, uuid, uuid, bigint, uuid, text, bigint, text, text, text, text, bigint),
  desmoslock_v2.commit_student_session_forfeit(uuid, uuid, uuid, uuid, bigint, uuid, text, bigint, text, text, bigint)
  to service_role;
grant execute on function
  desmoslock_v2.current_test_student_sessions(uuid, uuid, text, uuid),
  desmoslock_v2.issue_test_join_code(uuid, uuid, bigint, uuid, text),
  desmoslock_v2.remove_student_session(uuid, uuid, uuid, bigint),
  desmoslock_v2.prepare_student_readmission(uuid, uuid, uuid, bigint, uuid, text)
  to authenticated;

-- The integration owner computes this normalized self-reference only after
-- every eleventh-migration source byte is fixed; predecessors are immutable.
-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text language sql immutable set search_path = '' as $$
  select 'aa32ed754c87e7987199dbd6c5f685ae65236ba3f94921157fc6cb07ce67b308'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256() from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256() where id = 1;
