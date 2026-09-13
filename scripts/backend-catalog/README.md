# Two-migration catalog reference

The disposable backup-roundtrip CI harness captures this fixed `pg_catalog`
projection after a local reset through `20260828000100` with no seed. It validates
the projection, emits a separate `DESMOSLOCK_CATALOG_PREFIX_V1` diagnostic, then
runs the ordinary full reset and complete roundtrip. The restore acceptance
receipt and its flags are unchanged. No new workflow or hosted connection exists.

`catalog.sql` and `validate.py` are pinned reviewed inputs. The helper checks their
exact bytes, the source expectations, and both migration files before the prefix
reset. Query, validator and source changes require deliberate pin review.

- Query SHA256: `d4c00e6330577e42aa0268f113f3d8a2b37e7e9b8f2c50b7c726bf2c0340c1d9`.
- Validator SHA256: `fd326031c53815b51d8ac56202ec320f505323f1629daa74d4b8d718a9fb4e54`.
- Prefix: `20260824000100`, `20260828000100`.

The SQL reads catalog metadata only. It emits names, structure, owners, explicit
and effective privileges, membership/default-ACL context, and hashes. It returns
no application rows, comments, routine bodies, expression text, passwords or
arbitrary configuration values. No server deparser runs: deparsers can invoke a
custom type output routine while rendering a constant. Raw catalog-node hashes
can vary across equivalent databases because of embedded OIDs or locations;
every mismatch remains unresolved evidence and is never normalized away.

The source expectations are necessary checks, not an observed database baseline.
A reference is usable only after the exact CI commit's full reset, pinned-image
checks, roundtrip and cleanup all pass. This projection does not establish
fixture-row, Auth/API, global-platform or rollout readiness. Hosted use requires
its own reviewed execution boundary; this harness supports disposable CI only.

## Bounds and transport

The query rejects more than 2,048 records, 1 MiB aggregate record text, or 16 KiB
per record. The client caps combined command output at 1,100,000 bytes, uses a
30-second deadline, and does not relay stderr. Its read-only transaction fixes
`search_path=pg_catalog`, statement timeout 10 seconds, and lock timeout 1 second.
The pinned Python standard-library validator rejects malformed or duplicate JSON,
extra fields, invalid types/hashes/identities, overflow and missing linked ACLs.

The independent diagnostic is one newline-terminated line, at most 1,104,096
UTF-8 bytes, with the fixed prefix followed by exactly `observation_version`,
`query_sha256`, `source_commit`, `source_files`, `prefix_versions`, and `projection`.
Version is 1. Retrieval must reject missing/duplicate records and unexpected
fields; any known test-runner log prefix must be removed explicitly. Preserve the
CI run identity and complete-job verdict alongside the observation.

## Pure local checks

From this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_validate.py
python3 validate.py validate reference.json --expectations catalog-source-expectations.json
python3 validate.py compare reference.json target.json --expectations catalog-source-expectations.json
```

From the repository root, the ordinary Node harness unit tests also exercise the
capture and real cleanup boundary with inert commands. They start no databases.
The separate `npm run test:backup:roundtrip` execution remains restricted to its
fresh disposable Linux GitHub CI environment.
