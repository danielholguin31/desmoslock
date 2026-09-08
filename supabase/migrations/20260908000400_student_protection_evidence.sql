-- Historical, authenticated client reports. These are not OS attestation or
-- admission authority. Published migrations and pristine fixtures stay intact.

create table desmoslock_v2.student_device_proof_state (
  test_id uuid not null,
  device_session_id uuid not null,
  last_accepted_proof_counter bigint not null default 0
    check (last_accepted_proof_counter between 0 and 9007199254740991),
  maintenance_accepted_at timestamptz[] not null default '{}'
    check (cardinality(maintenance_accepted_at) <= 12 and array_position(maintenance_accepted_at, null) is null),
  evidence_accepted_at timestamptz[] not null default '{}'
    check (cardinality(evidence_accepted_at) <= 4 and array_position(evidence_accepted_at, null) is null),
  primary key (test_id, device_session_id),
  foreign key (test_id, device_session_id)
    references desmoslock_v2.student_device_bindings (test_id, device_session_id)
);
alter table desmoslock_v2.student_device_proof_state enable row level security;
revoke all on table desmoslock_v2.student_device_proof_state from public, anon, authenticated, service_role;

-- Active current bindings preserve their accepted counter and maintenance
-- window. Historical bindings have no pre-migration evidence allowance.
insert into desmoslock_v2.student_device_proof_state
  (test_id, device_session_id, last_accepted_proof_counter, maintenance_accepted_at)
select b.test_id, b.device_session_id,
  case when s.state = 'active' and s.device_session_id = b.device_session_id and s.epoch = b.first_epoch
    then s.last_accepted_proof_counter else 0 end,
  case when s.state = 'active' and s.device_session_id = b.device_session_id and s.epoch = b.first_epoch
    then s.maintenance_accepted_at else '{}'::timestamptz[] end
from desmoslock_v2.student_device_bindings b
join desmoslock_v2.student_sessions s on s.id = b.student_session_id;

create function desmoslock_v2.internal_create_student_proof_state()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The existing join transaction inserts its immutable binding only after
  -- Test SHARE and the existing/new Session UPDATE/insert. No extra lock order.
  insert into desmoslock_v2.student_device_proof_state (test_id, device_session_id)
    values (new.test_id, new.device_session_id);
  return new;
end;
$$;
create trigger student_device_bindings_proof_state after insert on desmoslock_v2.student_device_bindings
  for each row execute function desmoslock_v2.internal_create_student_proof_state();

create function desmoslock_v2.internal_guard_student_proof_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'UPDATE' then raise exception using errcode = '55000', message = 'Student proof state is persistent'; end if;
  if new.test_id is distinct from old.test_id or new.device_session_id is distinct from old.device_session_id
    or new.last_accepted_proof_counter <= old.last_accepted_proof_counter then
    raise exception using errcode = '55000', message = 'Student proof counter must advance';
  end if;
  return new;
end;
$$;
create trigger student_device_proof_state_monotonic before update or delete
  on desmoslock_v2.student_device_proof_state for each row
  execute function desmoslock_v2.internal_guard_student_proof_state();
create trigger student_device_proof_state_no_truncate before truncate
  on desmoslock_v2.student_device_proof_state for each statement
  execute function desmoslock_v2.internal_reject_staff_audit_mutation();

create function desmoslock_v2.internal_student_locked_proof(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint, verified_public_key text
) returns desmoslock_v2.student_device_proof_state
language plpgsql security definer set search_path = '' as $$
declare result desmoslock_v2.student_device_proof_state%rowtype;
begin
  -- Caller already owns Test SHARE and Session UPDATE, including historical
  -- ingestion. Immutable lookup is never a grant by itself.
  select p.* into result from desmoslock_v2.student_device_proof_state p
    join desmoslock_v2.student_device_bindings b using (test_id, device_session_id)
    where b.workspace_id = $1 and b.test_id = $2 and b.student_session_id = $3
      and b.device_session_id = $4 and b.first_epoch = $5
      and b.key_thumbprint = desmoslock_v2.internal_student_key_thumbprint($6)
    for update of p;
  return result;
end;
$$;

create function desmoslock_v2.internal_evidence_exact(value jsonb, keys text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof($1) = 'object' and $1 ?& $2 and ($1 - $2) = '{}'::jsonb, false);
$$;
create function desmoslock_v2.internal_evidence_integer(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof($1) is distinct from 'number' then return false; end if;
  return ($1::text)::numeric between 1 and 9007199254740991 and trunc(($1::text)::numeric) = ($1::text)::numeric;
end;
$$;
create function desmoslock_v2.internal_evidence_scope_array(value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare key text;
begin
  if not desmoslock_v2.internal_evidence_exact($1, array['schoolId','testId','studentSessionId','deviceSessionId','epoch'])
    or not desmoslock_v2.internal_evidence_integer($1->'epoch') then return null; end if;
  foreach key in array array['schoolId','testId','studentSessionId','deviceSessionId'] loop
    if jsonb_typeof($1->key) is distinct from 'string' or ($1->>key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return null; end if;
  end loop;
  return jsonb_build_array($1->>'schoolId',$1->>'testId',$1->>'studentSessionId',$1->>'deviceSessionId',($1->>'epoch')::numeric::bigint);
end;
$$;
create function desmoslock_v2.internal_evidence_build_array(value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare identity jsonb; key text;
begin
  if desmoslock_v2.internal_evidence_exact($1, array['kind']) and ($1->>'kind') in ('unverified_build','legacy_unknown') then
    return jsonb_build_array($1->>'kind');
  end if;
  if not desmoslock_v2.internal_evidence_exact($1, array['kind','identity']) or ($1->>'kind') is distinct from 'build' then return null; end if;
  identity := $1->'identity';
  if not desmoslock_v2.internal_evidence_exact(identity, array['schemaVersion','sourceRepository','sourceCommit','sourceTree','packageLockSha256','buildId'])
    or identity->'schemaVersion' is distinct from '1'::jsonb
    or identity->>'sourceRepository' is distinct from 'danielholguin31/desmoslock' then return null; end if;
  foreach key in array array['sourceCommit','sourceTree','packageLockSha256','buildId'] loop
    if jsonb_typeof(identity->key) is distinct from 'string'
      or (identity->>key) !~ (case when key in ('sourceCommit','sourceTree') then '^[0-9a-f]{40}$' else '^[0-9a-f]{64}$' end)
      or (identity->>key) ~ '^0+$' then return null; end if;
  end loop;
  return jsonb_build_array('build',1,'danielholguin31/desmoslock',identity->>'sourceCommit',identity->>'sourceTree',identity->>'packageLockSha256',identity->>'buildId');
end;
$$;
create function desmoslock_v2.internal_evidence_categories_array(value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare key text; observation jsonb; status text; code text; allowed text[]; result jsonb := '[]';
begin
  if not desmoslock_v2.internal_evidence_exact($1, array['aac','shortcuts','applications','persistence','windowNetwork']) then return null; end if;
  foreach key in array array['aac','shortcuts','applications','persistence','windowNetwork'] loop
    observation := $1->key;
    if not desmoslock_v2.internal_evidence_exact(observation, array['status','code'])
      or jsonb_typeof(observation->'status') is distinct from 'string'
      or jsonb_typeof(observation->'code') is distinct from 'string' then return null; end if;
    status := observation->>'status'; code := observation->>'code';
    allowed := case key
      when 'aac' then array['native_unavailable','native_inactive']
      when 'shortcuts' then array['emergency_shortcut_unavailable']
      when 'applications' then array['prohibited_application','application_observation_unavailable']
      when 'persistence' then array['durability_unavailable','evidence_capacity']
      else array['window_unavailable','network_policy_unavailable','backend_unavailable'] end;
    if not ((status = 'confirmed' and code = 'none')
      or (status = 'pending' and (code = 'none' or (key = 'aac' and code = 'awaiting_native_begin')))
      or (status in ('failed','unavailable') and code = any(allowed))) then return null; end if;
    result := result || jsonb_build_array(jsonb_build_array(status,code));
  end loop;
  return result;
end;
$$;
create function desmoslock_v2.internal_evidence_fact_array(value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare categories jsonb; slot text; phase text; native_event text; native_sequence bigint; cause text; key text;
begin
  if not desmoslock_v2.internal_evidence_exact($1, array['sequence','eventId','attemptId','scope','policyVersion','slot','phase','nativeEvent','nativeSequence','categories','cause'])
    or not desmoslock_v2.internal_evidence_integer($1->'sequence')
    or $1->'policyVersion' is distinct from '1'::jsonb
    or desmoslock_v2.internal_evidence_scope_array($1->'scope') is null then return null; end if;
  foreach key in array array['eventId','attemptId'] loop
    if jsonb_typeof($1->key) is distinct from 'string' or ($1->>key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return null; end if;
  end loop;
  categories := desmoslock_v2.internal_evidence_categories_array($1->'categories');
  if categories is null or jsonb_typeof($1->'slot') is distinct from 'string'
    or jsonb_typeof($1->'phase') is distinct from 'string' or jsonb_typeof($1->'cause') is distinct from 'string' then return null; end if;
  slot := $1->>'slot'; phase := $1->>'phase'; native_event := $1->>'nativeEvent'; cause := $1->>'cause';
  if slot not in ('engaging','began','locked','end_requested','failure','native_terminal','cleanup','abandoned')
    or phase not in ('engaging','locked','ending','ended','failed','recovery_required')
    or cause not in ('none','backend_unavailable','admission_changed','capability_expired','native_interrupted','native_failure',
      'observation_timeout','application_policy','shortcut_unavailable','persistence_unavailable','window_lost','renderer_lost',
      'suspend','display_changed','emergency_abandonment','application_quit')
    or ($1->'nativeEvent' <> 'null'::jsonb and (jsonb_typeof($1->'nativeEvent') <> 'string'
      or native_event not in ('did_begin','failed_to_begin','interrupted','did_end')))
    or ($1->'nativeSequence' <> 'null'::jsonb and not desmoslock_v2.internal_evidence_integer($1->'nativeSequence')) then return null; end if;
  native_sequence := ($1->>'nativeSequence')::numeric::bigint;
  if (native_event is not null and native_sequence is null)
    or (slot = 'began' and native_event is distinct from 'did_begin')
    or (slot = 'native_terminal' and coalesce(native_event not in ('did_end','failed_to_begin'),true))
    or (slot = 'failure' and native_event is not null and native_event <> 'interrupted')
    or (slot not in ('began','native_terminal','failure') and native_event is not null)
    or (slot in ('failure','end_requested','abandoned') and cause = 'none')
    or (slot = 'engaging' and (phase <> 'engaging' or native_sequence is not null or $1#>>'{categories,aac,status}' = 'confirmed'))
    or (slot = 'locked' and (phase <> 'locked' or native_sequence is null
      or exists (select 1 from jsonb_array_elements(categories) c where c->>0 <> 'confirmed'))) then return null; end if;
  return jsonb_build_array(1,($1->>'sequence')::numeric::bigint,$1->>'eventId',$1->>'attemptId',slot,phase,
    native_event,native_sequence,categories,cause);
end;
$$;

create function desmoslock_v2.internal_student_evidence_content_bytes(
  api_origin text, key_thumbprint text, scope jsonb, origin_build jsonb, fact jsonb
) returns bytea language plpgsql immutable set search_path = '' as $$
declare scope_array jsonb; build_array jsonb; fact_array jsonb; origin_port text; hostname text;
begin
  -- Edge validates the configured canonical URL. Restrict SQL to ASCII origin
  -- grammar too; JSON separator compaction cannot alter any accepted string.
  if $1 is null or $1 !~ '^(http://(127\.0\.0\.1|\[::1\])(:[1-9][0-9]{0,4})?|https://[a-z0-9._-]+)$'
    or $2 is null or $2 !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then return null; end if;
  if left($1,7) = 'http://' then
    origin_port := substring($1 from ':([0-9]+)$');
    if origin_port is not null and (origin_port::integer > 65535 or origin_port::integer = 80) then return null; end if;
  else
    hostname := rtrim(substring($1 from 9),'.');
    if hostname = 'localhost' or hostname like '%.localhost' or hostname ~ '^[0-9.]+$' then return null; end if;
  end if;
  scope_array := desmoslock_v2.internal_evidence_scope_array($3);
  build_array := desmoslock_v2.internal_evidence_build_array($4);
  fact_array := desmoslock_v2.internal_evidence_fact_array($5);
  if scope_array is null or build_array is null or fact_array is null or $5->'scope' is distinct from $3 then return null; end if;
  return convert_to('desmoslock/native-protection-fact/v1','UTF8') || decode('00','hex') ||
    convert_to(replace(jsonb_build_array(1,$1,$2,scope_array,build_array,fact_array)::text, ', ', ','),'UTF8');
end;
$$;
create function desmoslock_v2.internal_student_evidence_content_digest(
  api_origin text, key_thumbprint text, scope jsonb, origin_build jsonb, fact jsonb
) returns text language sql immutable set search_path = '' as $$
  select encode(sha256(desmoslock_v2.internal_student_evidence_content_bytes($1,$2,$3,$4,$5)),'hex');
$$;
create function desmoslock_v2.internal_student_evidence_batch_bytes(
  api_origin text, key_thumbprint text, scope jsonb, origin_build jsonb, facts jsonb
) returns bytea language plpgsql immutable set search_path = '' as $$
declare fact jsonb; digest text; entries jsonb := '[]'; attempt text;
  previous_sequence bigint := 0; native_sequence bigint := 0; slots text[] := '{}'; ids text[] := '{}';
begin
  if jsonb_typeof($5) is distinct from 'array' then return null; end if;
  if jsonb_array_length($5) not between 1 and 8 then return null; end if;
  attempt := $5->0->>'attemptId';
  for fact in select value from jsonb_array_elements($5) loop
    digest := desmoslock_v2.internal_student_evidence_content_digest($1,$2,$3,$4,fact);
    if digest is null or fact->>'attemptId' is distinct from attempt
      or (fact->>'sequence')::numeric::bigint <= previous_sequence or fact->>'eventId' = any(ids)
      or fact->>'slot' = any(slots) or (previous_sequence = 0 and fact->>'slot' <> 'engaging')
      or (fact->>'slot' = 'locked' and not ('began' = any(slots)))
      or (fact->>'nativeSequence')::numeric::bigint < native_sequence
      or (fact->>'nativeEvent' is not null and (fact->>'nativeSequence')::numeric::bigint <= native_sequence) then return null; end if;
    previous_sequence := (fact->>'sequence')::numeric::bigint;
    native_sequence := coalesce((fact->>'nativeSequence')::numeric::bigint,native_sequence);
    slots := array_append(slots,fact->>'slot'); ids := array_append(ids,fact->>'eventId');
    entries := entries || jsonb_build_array(jsonb_build_array(fact->>'eventId',digest));
  end loop;
  return convert_to('desmoslock/native-protection-batch/v1','UTF8') || decode('00','hex') ||
    convert_to(replace(jsonb_build_array(1,$1,$2,desmoslock_v2.internal_evidence_scope_array($3),
      desmoslock_v2.internal_evidence_build_array($4),attempt,entries)::text, ', ', ','),'UTF8');
end;
$$;
create function desmoslock_v2.internal_student_evidence_batch_digest(
  api_origin text, key_thumbprint text, scope jsonb, origin_build jsonb, facts jsonb
) returns text language sql immutable set search_path = '' as $$
  select encode(sha256(desmoslock_v2.internal_student_evidence_batch_bytes($1,$2,$3,$4,$5)),'hex');
$$;

create table desmoslock_v2.student_protection_events (
  event_id uuid primary key,
  workspace_id uuid not null,
  test_id uuid not null,
  student_session_id uuid not null,
  device_session_id uuid not null,
  epoch bigint not null check (epoch between 1 and 9007199254740991),
  attempt_id uuid not null,
  fact_sequence bigint not null check (fact_sequence between 1 and 9007199254740991),
  slot text not null,
  api_origin text not null,
  key_thumbprint text not null,
  origin_build jsonb not null,
  fact jsonb not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null,
  unique (test_id, device_session_id, fact_sequence),
  unique (test_id, device_session_id, attempt_id, slot),
  foreign key (workspace_id, test_id, student_session_id)
    references desmoslock_v2.student_sessions (workspace_id, test_id, id),
  foreign key (test_id, device_session_id)
    references desmoslock_v2.student_device_proof_state (test_id, device_session_id),
  check (received_at >= '0001-01-01T00:00:00Z'::timestamptz and received_at < '10000-01-01T00:00:00Z'::timestamptz),
  check (coalesce(desmoslock_v2.internal_student_evidence_content_digest(api_origin,key_thumbprint,
    jsonb_build_object('schoolId',workspace_id,'testId',test_id,'studentSessionId',student_session_id,
      'deviceSessionId',device_session_id,'epoch',epoch),origin_build,fact) = content_digest
    and fact->>'eventId' = event_id::text and fact->>'attemptId' = attempt_id::text
    and (fact->>'sequence')::numeric = fact_sequence and fact->>'slot' = slot, false))
);
create index student_protection_events_history on desmoslock_v2.student_protection_events
  (workspace_id, test_id, student_session_id, received_at desc, event_id desc);
alter table desmoslock_v2.student_protection_events enable row level security;
revoke all on table desmoslock_v2.student_protection_events from public, anon, authenticated, service_role;
create trigger student_protection_events_immutable before update or delete on desmoslock_v2.student_protection_events
  for each row execute function desmoslock_v2.internal_reject_staff_audit_mutation();
create trigger student_protection_events_no_truncate before truncate on desmoslock_v2.student_protection_events
  for each statement execute function desmoslock_v2.internal_reject_staff_audit_mutation();

create function desmoslock_v2.read_student_evidence_key(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint
) returns table (code text, key_thumbprint text)
language plpgsql volatile security definer set search_path = '' as $$
declare thumb text;
begin
  select b.key_thumbprint into thumb from desmoslock_v2.student_device_bindings b
    join desmoslock_v2.student_sessions s on s.id = b.student_session_id and s.workspace_id = b.workspace_id and s.test_id = b.test_id
    join desmoslock_v2.tests t on t.id = b.test_id and t.workspace_id = b.workspace_id
    join desmoslock_v2.workspaces w on w.id = b.workspace_id
    where b.workspace_id = $1 and b.test_id = $2 and b.student_session_id = $3 and b.device_session_id = $4
      and b.first_epoch = $5 and s.seed_key is null and t.seed_key is null and w.seed_key is null and w.kind = 'school';
  if thumb is null then return query select 'student_session_denied'::text,null::text; return; end if;
  return query select 'ok'::text,thumb;
end;
$$;

create type desmoslock_v2.student_evidence_row as (
  code text, scope jsonb, batch_digest text, accepted_proof_counter bigint, acknowledged jsonb
);
revoke all on type desmoslock_v2.student_evidence_row from public, anon, authenticated, service_role;

create function desmoslock_v2.commit_student_protection_evidence(
  api_origin text, school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  origin_build jsonb, facts jsonb, batch_digest text, verified_public_key text, proof_counter bigint
) returns setof desmoslock_v2.student_evidence_row
language plpgsql security definer set search_path = '' as $$
declare
  target_test desmoslock_v2.tests%rowtype;
  target_session desmoslock_v2.student_sessions%rowtype;
  proof desmoslock_v2.student_device_proof_state%rowtype;
  bound_scope jsonb; thumb text; fact jsonb; digest text; attempt uuid; checked_at timestamptz;
  allowance timestamptz[]; existing desmoslock_v2.student_protection_events%rowtype;
  acknowledgments jsonb := '[]'; new_count integer := 0; total_count integer; attempt_count integer;
  prior_max bigint; requested_max bigint; is_existing_attempt boolean;
begin
  bound_scope := jsonb_build_object('schoolId',$2,'testId',$3,'studentSessionId',$4,'deviceSessionId',$5,'epoch',$6);
  thumb := desmoslock_v2.internal_student_key_thumbprint($10);
  if $11 is null or $11 not between 1 and 9007199254740991 or $9 is null or $9 !~ '^[0-9a-f]{64}$'
    or $9 is distinct from desmoslock_v2.internal_student_evidence_batch_digest($1,thumb,bound_scope,$7,$8) then
    raise exception using errcode = 'PSE01', message = 'student session denied';
  end if;
  select t.* into target_test from desmoslock_v2.tests t join desmoslock_v2.workspaces w on w.id = t.workspace_id
    where t.workspace_id = $2 and t.id = $3 and t.seed_key is null and w.seed_key is null and w.kind = 'school' for share of t;
  if target_test.id is null then raise exception using errcode = 'PSE01', message = 'student session denied'; end if;
  select s.* into target_session from desmoslock_v2.student_sessions s
    where s.workspace_id = $2 and s.test_id = $3 and s.id = $4 and s.seed_key is null for update;
  if target_session.id is null then raise exception using errcode = 'PSE01', message = 'student session denied'; end if;
  proof := desmoslock_v2.internal_student_locked_proof($2,$3,$4,$5,$6,$10);
  checked_at := clock_timestamp();
  if proof.test_id is null or proof.last_accepted_proof_counter >= $11 then
    raise exception using errcode = 'PSE01', message = 'student session denied';
  end if;
  select coalesce(array_agg(at order by at),'{}'::timestamptz[]) into allowance
    from unnest(proof.evidence_accepted_at) entry(at) where at > checked_at - interval '60 seconds';
  if cardinality(allowance) >= 4 then raise exception using errcode = 'PSE01', message = 'student session denied'; end if;
  attempt := ($8->0->>'attemptId')::uuid;
  requested_max := ($8->(jsonb_array_length($8)-1)->>'sequence')::numeric::bigint;
  select count(*),count(distinct e.attempt_id) into total_count,attempt_count
    from desmoslock_v2.student_protection_events e where e.test_id = $3 and e.device_session_id = $5;
  select max(e.fact_sequence) into prior_max from desmoslock_v2.student_protection_events e
    where e.test_id = $3 and e.device_session_id = $5 and e.attempt_id = attempt;
  is_existing_attempt := prior_max is not null;
  -- Every known preceding slot must recur exactly. A retry may be an earlier
  -- complete prefix; an append may not insert new facts before accepted facts.
  if exists (select 1 from desmoslock_v2.student_protection_events e
      where e.test_id = $3 and e.device_session_id = $5 and e.attempt_id = attempt
      and (e.origin_build <> $7 or e.api_origin <> $1 or e.key_thumbprint <> thumb
        or (e.fact_sequence <= requested_max and not exists
          (select 1 from jsonb_array_elements($8) f where f->>'eventId' = e.event_id::text)))) then
    raise exception using errcode = 'PSE01', message = 'student session denied';
  end if;
  for fact in select value from jsonb_array_elements($8) loop
    digest := desmoslock_v2.internal_student_evidence_content_digest($1,thumb,bound_scope,$7,fact);
    select e.* into existing from desmoslock_v2.student_protection_events e where e.event_id = (fact->>'eventId')::uuid;
    if existing.event_id is not null then
      if existing.content_digest <> digest or existing.fact <> fact or existing.origin_build <> $7
        or existing.workspace_id <> $2 or existing.test_id <> $3 or existing.student_session_id <> $4
        or existing.device_session_id <> $5 or existing.epoch <> $6 then
        raise exception using errcode = 'PSE01', message = 'student session denied';
      end if;
    else
      if (fact->>'sequence')::numeric::bigint <= prior_max then
        raise exception using errcode = 'PSE01', message = 'student session denied';
      end if;
      insert into desmoslock_v2.student_protection_events
        (event_id,workspace_id,test_id,student_session_id,device_session_id,epoch,attempt_id,fact_sequence,slot,
          api_origin,key_thumbprint,origin_build,fact,content_digest,received_at)
      values ((fact->>'eventId')::uuid,$2,$3,$4,$5,$6,attempt,(fact->>'sequence')::numeric::bigint,fact->>'slot',
        $1,thumb,$7,fact,digest,checked_at) returning * into existing;
      new_count := new_count + 1;
    end if;
    acknowledgments := acknowledgments || jsonb_build_array(jsonb_build_object('eventId',existing.event_id,
      'contentDigest',existing.content_digest,'receivedAt',desmoslock_v2.internal_student_timestamp(existing.received_at)));
  end loop;
  if total_count + new_count > 256 or (not is_existing_attempt and attempt_count >= 32) then
    raise exception using errcode = 'PSE01', message = 'student session denied';
  end if;
  update desmoslock_v2.student_device_proof_state p set last_accepted_proof_counter = $11,
    evidence_accepted_at = array_append(allowance,checked_at) where p.test_id = $3 and p.device_session_id = $5;
  if target_session.state = 'active' and target_session.device_session_id = $5 and target_session.epoch = $6 then
    update desmoslock_v2.student_sessions s set last_accepted_proof_counter = $11 where s.id = $4;
  end if;
  return query select 'ok'::text,bound_scope,$9,$11,acknowledgments;
exception when unique_violation or check_violation or invalid_text_representation or numeric_value_out_of_range or sqlstate 'PSE01' then
  -- The exception subtransaction rolls back every insert and proof/allowance
  -- update. Generic denial discloses no event or receipt existence.
  return query select 'student_session_denied'::text,null::jsonb,null::text,null::bigint,null::jsonb;
end;
$$;

-- Live commit signatures and domain checks are unchanged. Their existing
-- Test/Session locks precede proof UPDATE, and time is sampled after that wait.

create or replace function desmoslock_v2.commit_student_session_read(
  school_id uuid, test_id uuid, student_session_id uuid, device_session_id uuid, epoch bigint,
  request_id uuid, logical_operation_digest text, capability_digest text, verified_public_key text, proof_counter bigint
) returns setof desmoslock_v2.student_current_row
language plpgsql security definer set search_path = '' as $$
declare
  target_session desmoslock_v2.student_sessions%rowtype;
  result desmoslock_v2.student_current_row;
  checked_at timestamptz;
  allowance timestamptz[];
  proof desmoslock_v2.student_device_proof_state%rowtype;
begin
  result.code := 'student_session_denied';
  if $6 is null or $8 is null or $8 !~ '^[0-9a-f]{64}$' or $10 is null or $10 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('read', $6, jsonb_build_array($1, $2, $3, $4, $5), $8)) then return next result; return; end if;
  target_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  if target_session.id is null then return next result; return; end if;
  proof := desmoslock_v2.internal_student_locked_proof($1, $2, $3, $4, $5, $9);
  checked_at := clock_timestamp();
  if target_session.id is null or proof.test_id is null or target_session.device_public_key is distinct from $9
    or target_session.capability_digest is distinct from $8 or target_session.capability_expires_at <= checked_at
    or proof.last_accepted_proof_counter >= $10 then return next result; return; end if;
  allowance := desmoslock_v2.internal_student_next_allowance(proof.maintenance_accepted_at, checked_at);
  if allowance is null then return next result; return; end if;
  update desmoslock_v2.student_device_proof_state p set last_accepted_proof_counter = $10, maintenance_accepted_at = allowance
    where p.test_id = $2 and p.device_session_id = $4;
  update desmoslock_v2.student_sessions set last_accepted_proof_counter = $10, maintenance_accepted_at = allowance where id = $3;
  result := row('ok', $6, $10, $1, $2, $3, $4, $5, target_session.revision, target_session.synthetic_display_name,
    desmoslock_v2.internal_student_milliseconds(checked_at),
    desmoslock_v2.internal_student_milliseconds(target_session.capability_expires_at));
  return next result;
end;
$$;

create or replace function desmoslock_v2.commit_student_session_reconnect(
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
  proof desmoslock_v2.student_device_proof_state%rowtype;
  receipt boolean;
begin
  result.code := 'student_session_denied';
  if $6 is null or $8 is null or $8 not between 1 and 9007199254740991
    or $9 is null or $9 !~ '^[0-9a-f]{64}$' or $10 is null or $10 !~ '^[0-9a-f]{64}$'
    or $11 is null or $11 !~ '^[0-9a-f]{64}$' or $13 is null or $13 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('reconnect', $6, jsonb_build_array($1, $2, $3, $4, $5), $8, $9, $10, $11)) then return next result; return; end if;
  before_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  if before_session.id is null then return next result; return; end if;
  proof := desmoslock_v2.internal_student_locked_proof($1, $2, $3, $4, $5, $12);
  checked_at := clock_timestamp();
  if before_session.id is null or proof.test_id is null or before_session.device_public_key is distinct from $12
    or proof.last_accepted_proof_counter >= $13 or before_session.reconnect_expires_at <= checked_at then
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
  allowance := desmoslock_v2.internal_student_next_allowance(proof.maintenance_accepted_at, checked_at);
  if allowance is null then return next result; return; end if;
  update desmoslock_v2.student_device_proof_state p set last_accepted_proof_counter = $13, maintenance_accepted_at = allowance
    where p.test_id = $2 and p.device_session_id = $4;
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

create or replace function desmoslock_v2.commit_student_session_forfeit(
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
  proof desmoslock_v2.student_device_proof_state%rowtype;
begin
  if $6 is null or $8 is null or $8 not between 1 and 9007199254740991
    or $9 is null or $9 !~ '^[0-9a-f]{64}$' or $11 is null or $11 not between 1 and 9007199254740991
    or $7 is distinct from desmoslock_v2.internal_student_operation_digest(
      jsonb_build_array('forfeit', $6, jsonb_build_array($1, $2, $3, $4, $5), $8, $9)) then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  before_session := desmoslock_v2.internal_student_locked_session($1, $2, $3, $4, $5);
  if before_session.id is null then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  proof := desmoslock_v2.internal_student_locked_proof($1, $2, $3, $4, $5, $10);
  checked_at := clock_timestamp();
  if before_session.id is null or proof.test_id is null or before_session.device_public_key is distinct from $10
    or before_session.capability_digest is distinct from $9 or before_session.capability_expires_at <= checked_at
    or before_session.revision <> $8 or before_session.revision = 9007199254740991 or before_session.epoch = 9007199254740991
    or proof.last_accepted_proof_counter >= $11 then
    return query select 'student_session_denied'::text, null::uuid, null::bigint; return;
  end if;
  allowance := desmoslock_v2.internal_student_next_allowance(proof.maintenance_accepted_at, checked_at);
  if allowance is null then return query select 'student_session_denied'::text, null::uuid, null::bigint; return; end if;
  update desmoslock_v2.student_device_proof_state p set last_accepted_proof_counter = $11, maintenance_accepted_at = allowance
    where p.test_id = $2 and p.device_session_id = $4;
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

-- Reports are historical statements. An absent report is not a successful
-- protection observation, and the latest receipt may describe an older epoch.
create function desmoslock_v2.internal_student_evidence_summary(workspace_id uuid, test_id uuid, student_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'reportCount',count(*),
    'failureCount',count(*) filter (where e.slot = 'failure' or exists
      (select 1 from jsonb_each(e.fact->'categories') c where c.value->>'status' in ('failed','unavailable'))),
    'latestReceivedAt',desmoslock_v2.internal_student_timestamp(max(e.received_at)),
    'latestReportedEpoch',(array_agg(e.epoch order by e.received_at desc,e.event_id desc))[1])
  from desmoslock_v2.student_protection_events e
  where e.workspace_id = $1 and e.test_id = $2 and e.student_session_id = $3;
$$;
alter type desmoslock_v2.staff_student_session_row add attribute evidence_summary jsonb;

create or replace function desmoslock_v2.current_test_student_sessions(
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
    desmoslock_v2.internal_student_timestamp(s.created_at),
    desmoslock_v2.internal_student_evidence_summary(s.workspace_id,s.test_id,s.id)
  from desmoslock_v2.student_sessions as s
  where s.workspace_id = $1 and s.test_id = $2 and s.seed_key is null and s.state <> 'created'
    and ($3 is null or (s.created_at, s.id) < (cursor_time, $4))
  order by s.created_at desc, s.id desc limit 51;
end;
$$;

create function desmoslock_v2.current_student_protection_events(
  workspace_id uuid, test_id uuid, student_session_id uuid, before_received_at text, before_event_id uuid
) returns table (code text, fact jsonb, origin_build jsonb, content_digest text, received_at text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  authorization_result record;
  target_test desmoslock_v2.tests%rowtype;
  target_session desmoslock_v2.student_sessions%rowtype;
  cursor_time timestamptz;
begin
  if $1 is null or $2 is null or $3 is null or (($4 is null) <> ($5 is null)) then
    return query select 'invalid_request'::text,null::jsonb,null::jsonb,null::text,null::text; return;
  end if;
  if $4 is not null then
    cursor_time := desmoslock_v2.internal_parse_test_timestamp($4);
    if cursor_time is null then
      return query select 'invalid_request'::text,null::jsonb,null::jsonb,null::text,null::text; return;
    end if;
  end if;
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code::text,null::jsonb,null::jsonb,null::text,null::text; return;
  end if;
  select t.* into target_test from desmoslock_v2.tests t
    join desmoslock_v2.workspaces w on w.id = t.workspace_id
    where t.workspace_id = $1 and t.id = $2 and t.seed_key is null and w.seed_key is null and w.kind = 'school'
    for share of t;
  select s.* into target_session from desmoslock_v2.student_sessions s
    where target_test.id is not null and s.workspace_id = $1 and s.test_id = $2 and s.id = $3
      and s.seed_key is null and s.state <> 'created' for share of s;
  -- Live provider session, Membership, assurance and School are all rechecked
  -- after both waits. Ended Tests intentionally remain available to staff.
  select * into authorization_result from desmoslock_v2.internal_authorize_test_staff($1);
  if authorization_result.code <> 'ok' then
    return query select authorization_result.code::text,null::jsonb,null::jsonb,null::text,null::text; return;
  end if;
  if target_test.id is null then
    return query select 'test_unavailable'::text,null::jsonb,null::jsonb,null::text,null::text; return;
  end if;
  if target_session.id is null then
    return query select 'student_session_unavailable'::text,null::jsonb,null::jsonb,null::text,null::text; return;
  end if;
  return query select 'ok'::text,e.fact,e.origin_build,e.content_digest,
    desmoslock_v2.internal_student_timestamp(e.received_at)
    from desmoslock_v2.student_protection_events e
    where e.workspace_id = $1 and e.test_id = $2 and e.student_session_id = $3
      and ($4 is null or (e.received_at,e.event_id) < (cursor_time,$5))
    order by e.received_at desc,e.event_id desc limit 51;
end;
$$;

revoke all on function
  desmoslock_v2.internal_create_student_proof_state(),
  desmoslock_v2.internal_guard_student_proof_state(),
  desmoslock_v2.internal_student_locked_proof(uuid,uuid,uuid,uuid,bigint,text),
  desmoslock_v2.internal_evidence_exact(jsonb,text[]),
  desmoslock_v2.internal_evidence_integer(jsonb),
  desmoslock_v2.internal_evidence_scope_array(jsonb),
  desmoslock_v2.internal_evidence_build_array(jsonb),
  desmoslock_v2.internal_evidence_categories_array(jsonb),
  desmoslock_v2.internal_evidence_fact_array(jsonb),
  desmoslock_v2.internal_student_evidence_content_bytes(text,text,jsonb,jsonb,jsonb),
  desmoslock_v2.internal_student_evidence_content_digest(text,text,jsonb,jsonb,jsonb),
  desmoslock_v2.internal_student_evidence_batch_bytes(text,text,jsonb,jsonb,jsonb),
  desmoslock_v2.internal_student_evidence_batch_digest(text,text,jsonb,jsonb,jsonb),
  desmoslock_v2.internal_student_evidence_summary(uuid,uuid,uuid),
  desmoslock_v2.read_student_evidence_key(uuid,uuid,uuid,uuid,bigint),
  desmoslock_v2.commit_student_protection_evidence(text,uuid,uuid,uuid,uuid,bigint,jsonb,jsonb,text,text,bigint),
  desmoslock_v2.current_student_protection_events(uuid,uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  desmoslock_v2.read_student_evidence_key(uuid,uuid,uuid,uuid,bigint),
  desmoslock_v2.commit_student_protection_evidence(text,uuid,uuid,uuid,uuid,bigint,jsonb,jsonb,text,text,bigint)
  to service_role;
grant execute on function desmoslock_v2.current_student_protection_events(uuid,uuid,uuid,text,uuid)
  to authenticated;

-- Normalize only this delimited digest when hashing the migration inventory.
-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text language sql immutable set search_path = '' as $$
  select 'a1c671760f91c131241216daae7df908a42f4b26a867efdc8676169d9b2df778'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256() from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256() where id = 1;
