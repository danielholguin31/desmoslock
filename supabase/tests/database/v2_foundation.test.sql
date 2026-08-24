begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(10);

select has_schema('desmoslock_v2', 'v2 schema exists');
select has_table('desmoslock_v2', 'foundation_seed', 'foundation seed table exists');
select col_is_pk('desmoslock_v2', 'foundation_seed', 'id', 'foundation seed id is the primary key');
select col_type_is('desmoslock_v2', 'foundation_seed', 'id', 'smallint', 'foundation seed id is bounded');
select ok(
  (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'desmoslock_v2'
      and c.relname = 'foundation_seed'
  ),
  'foundation seed enables RLS'
);
select results_eq(
  $$select fixture_namespace from desmoslock_v2.foundation_seed order by id$$,
  array['desmoslock-v2-foundation'::text],
  'deterministic seed is loaded'
);
select hasnt_table('desmoslock_v2', 'teachers', 'legacy teachers are not imported');
select hasnt_table('desmoslock_v2', 'students', 'legacy students are not imported');
select hasnt_table('desmoslock_v2', 'schools', 'legacy schools are not imported');
select results_eq(
  $$select count(*)::bigint from auth.users$$,
  array[0::bigint],
  'clean reset imports no legacy authentication users'
);

select * from finish();
rollback;
