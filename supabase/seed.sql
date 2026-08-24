insert into desmoslock_v2.foundation_seed (id, schema_generation, fixture_namespace)
values (1, 2, 'desmoslock-v2-foundation')
on conflict (id) do update
set
  schema_generation = excluded.schema_generation,
  fixture_namespace = excluded.fixture_namespace;
