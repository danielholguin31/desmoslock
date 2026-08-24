-- DesmosLock v2 starts from a clean, migration-owned namespace.
-- Legacy public tables remain source evidence and are never imported here.

create schema if not exists desmoslock_v2;

revoke all on schema desmoslock_v2 from public;
revoke all on schema desmoslock_v2 from anon;
revoke all on schema desmoslock_v2 from authenticated;
grant usage on schema desmoslock_v2 to service_role;

create table desmoslock_v2.foundation_seed (
  id smallint primary key,
  schema_generation integer not null,
  fixture_namespace text not null unique,
  constraint foundation_seed_singleton check (id = 1),
  constraint foundation_seed_generation check (schema_generation = 2),
  constraint foundation_seed_namespace check (fixture_namespace = 'desmoslock-v2-foundation')
);

alter table desmoslock_v2.foundation_seed enable row level security;

revoke all on table desmoslock_v2.foundation_seed from public;
revoke all on table desmoslock_v2.foundation_seed from anon;
revoke all on table desmoslock_v2.foundation_seed from authenticated;
grant select on table desmoslock_v2.foundation_seed to service_role;

comment on schema desmoslock_v2 is
  'Clean v2 data plane. Legacy v1 product rows are intentionally not imported.';

comment on table desmoslock_v2.foundation_seed is
  'Deterministic local verification marker; not customer or production data.';
