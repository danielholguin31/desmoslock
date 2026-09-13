-- Admit only finite failure-first preflight reports through the existing
-- authenticated historical-evidence path. Existing engaging bytes, signer and
-- scope binding, locks, counters, throttling and capacity remain unchanged.

create or replace function desmoslock_v2.internal_student_evidence_batch_bytes(
  api_origin text, key_thumbprint text, scope jsonb, origin_build jsonb, facts jsonb
) returns bytea language plpgsql immutable set search_path = '' as $$
declare fact jsonb; digest text; entries jsonb := '[]'; attempt text;
  previous_sequence bigint := 0; native_sequence bigint := 0; slots text[] := '{}'; ids text[] := '{}';
  preflight boolean;
begin
  if jsonb_typeof($5) is distinct from 'array' then return null; end if;
  if jsonb_array_length($5) not between 1 and 8 then return null; end if;
  attempt := $5->0->>'attemptId';
  preflight := $5->0->>'slot' = 'failure';
  if preflight and jsonb_array_length($5) > 2 then return null; end if;
  for fact in select value from jsonb_array_elements($5) loop
    digest := desmoslock_v2.internal_student_evidence_content_digest($1,$2,$3,$4,fact);
    if digest is null or fact->>'attemptId' is distinct from attempt
      or (fact->>'sequence')::numeric::bigint <= previous_sequence or fact->>'eventId' = any(ids)
      or fact->>'slot' = any(slots) or (previous_sequence = 0 and fact->>'slot' <> 'engaging' and not preflight)
      or (fact->>'slot' = 'locked' and not ('began' = any(slots)))
      or (fact->>'nativeSequence')::numeric::bigint < native_sequence
      or (fact->>'nativeEvent' is not null and (fact->>'nativeSequence')::numeric::bigint <= native_sequence) then return null; end if;
    if preflight then
      -- Historical client statements only. No engaging or native observation
      -- is invented for an application/shortcut error before native begin.
      if fact->>'phase' is distinct from 'failed'
        or fact->'nativeEvent' is distinct from 'null'::jsonb
        or fact->'nativeSequence' is distinct from 'null'::jsonb
        or fact#>'{categories,aac}' is distinct from '{"status":"pending","code":"awaiting_native_begin"}'::jsonb
        or (previous_sequence > 0 and (fact->>'slot' <> 'cleanup' or fact->>'cause' <> 'none')) then return null; end if;
      if previous_sequence = 0 then
        if fact->>'cause' = 'application_policy' then
          if fact#>'{categories,applications}' not in (
            '{"status":"failed","code":"prohibited_application"}'::jsonb,
            '{"status":"unavailable","code":"application_observation_unavailable"}'::jsonb
          ) then return null; end if;
        elsif fact->>'cause' = 'shortcut_unavailable' then
          if fact#>'{categories,shortcuts}' not in (
            '{"status":"failed","code":"emergency_shortcut_unavailable"}'::jsonb,
            '{"status":"unavailable","code":"emergency_shortcut_unavailable"}'::jsonb
          ) then return null; end if;
        else return null;
        end if;
      end if;
    end if;
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
revoke all on function desmoslock_v2.internal_student_evidence_batch_bytes(text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;

-- Normalize only this delimited digest when hashing the migration inventory.
-- desmoslock-migration-set-sha256:begin
create or replace function desmoslock_v2.expected_migration_set_sha256()
returns text language sql immutable set search_path = '' as $$
  select '2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b'::text;
$$;
-- desmoslock-migration-set-sha256:end
revoke all on function desmoslock_v2.expected_migration_set_sha256() from public, anon, authenticated, service_role;
update desmoslock_v2.internal_release_attestation
set migration_set_sha256 = desmoslock_v2.expected_migration_set_sha256() where id = 1;
