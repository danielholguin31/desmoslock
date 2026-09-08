# Disposable synthetic restore acceptance

This source tranche adds a required real backup/restore gate for the internal
baseline. CI has completed the real TLS/export/restore checks, then stopped in
the staff suite because the fixture retained its temporary restore marker.
The marker-retirement correction and full runtime acceptance remain pending.
The existing hosted staging project and legacy deployment restrictions remain
separate from this disposable CI lane.

## Source and execution

`npm run test:backup:roundtrip` is the outer harness of the existing required
`staff-auth-lifecycle` job. It requires fresh Linux GitHub Actions, exact Node
24.20.0, pinned Supabase CLI 2.115.0, and no existing Supabase containers or
volumes. The job retains Chromium setup and unconditional cleanup. It does not
add a workflow, dependency, provider setting or product migration.

The harness creates a full target stack without seed and a distinct source
PostgreSQL/GoTrue project with the pristine seed. Source inputs are explicit:
the versioned configuration, current operator migration list, seed and recovery
template. Only the copied project ID and five ports differ. At integration the
source is the eight-migration Membership baseline, whose migration-set SHA256 is
`7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56`.

The existing operator and default bounded adapter run on host Node/Python.
Three temporary executable wrappers invoke actual PostgreSQL clients from one
read-only container, pinned to the same verified image ID as both database
containers. Wrappers preserve arguments, native exit status and binary streams;
only allowlisted environment variable names are passed to Docker. No injected
adapter runner or fabricated native output is used.

The source generates ephemeral CA/server keys as root only within its own
tmpfs. A separate command runs as OS user `postgres` and connects through the
explicit `/var/run/postgresql` socket, port 5432, as DB role `supabase_admin` to
reload that disposable server's SSL configuration. Only the public CA reaches
host tmpfs and the client container.
The staging-profile export uses `verify-full`, the exact numeric-loopback
endpoint and explicit CA path; the local restore profile retains its existing
loopback/SSL contract. Numeric-loopback harness endpoints do not imply that the
CLI's published listeners bind only to loopback.

The exact pinned PostgreSQL image uses Alpine/Nix and does not guarantee a host
Node loader, Python or discoverable OpenSSL CLI. Keeping Node/Python on the host
resolves the former mismatch. An absent in-image OpenSSL executable fails the
TLS-generation stage; there is no installation, extra image, host private-key
generation or TLS downgrade fallback. The source DB/Auth-only topology also
requires real CI confirmation.

## Acceptance observations

The native worker must prove distinct real cluster identities, empty Auth user
tables, an empty migrated target, and a fresh target attestation. It runs the
existing real export/publication/validation/restore operations, then requires
the exact seven-table fixture counts, fixture digest and current migration
attestation. A second restore must be refused without changing the observed
target. After that proof, the harness retires only its own temporary restore
marker, requires the marker table to be empty and independently rechecks the
live fixture counts/digest and migration attestation. Audit protection is never
disabled and audit rows are never deleted.

A valid-CA TLS query brackets the negative CA probe. That probe accepts only
native psql exit 2, empty stdout, and the exact expected root-file rejection for
`127.0.0.1:55322` and `/dev/null`. Its combined output is limited to 8 KiB and
classified only in memory. Docker/connection errors, unknown diagnostics,
unexpected success, timeout, cancellation and overflow fail the gate.

After restore, the unchanged complete `test:staff-auth` suite runs without reset
or reseed. This retains SQL/RLS, stack/public-health, authorization-lock, Edge,
unit, real-provider and Membership browser checks on the restored fixture.
Successful receipts contain only hashes and static booleans. Raw database,
provider, CLI and TLS diagnostics are withheld; synthetic credentials and
callback material are not written to files or artifacts by this harness.

Every normal success/failure path tears down the exact owned client container,
stops both projects without backup and removes identity-bound temporary
directories. Cleanup failures preserve the primary failure and the source
configuration needed to identify the run. Uncatchable runner termination relies
on the ephemeral runner lifecycle; the job also retains its final target-stop
step. No broader resource cleanup is attempted.

## Imported candidate and integration receipt

The three executable files were imported byte-for-byte from the independently
reviewed September 8 candidate. Atlas's accepted negative-CA classification
finding was repaired and source-reviewed clean before import. Integration base:
`a2143701541303293ca2c93ffcdf0e035218305f`, tree
`40396dfabb1f056f16bd4b550d2279331b97d93e`.

| Candidate                                              | SHA256                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `tests/acceptance/synthetic-backup-runtime.mjs`        | `85a453a626ccefe4102046fda82c3dc49d654666f8d60ab4a659f5fba56c29a7` |
| `tests/acceptance/synthetic-backup-runtime.test.mjs`   | `4680194209e920b6eb889313830841df79ca527341400d172d46bc9dca8456bc` |
| `tests/acceptance/synthetic-backup-roundtrip.test.mjs` | `1b26b7571662c60a4389f519e7eabdcd16b3142d3d4360d1cdb62381ed615854` |
| Applied CI/package/contract proposal                   | `cad023582f63c47c79cb0c86d3427ee54dc5994a8d16c69e305a7bd68a5e57b3` |

The table records the original imported candidate, which remains unchanged as
historical source-review evidence. Before commit, scoped Secretlint identified
a credential-shaped literal containing only synthetic test values. The
integrated helper test now builds that same URL from a credential-free endpoint
and separately assigned synthetic username/password. Parser inputs and all
rejection assertions remain unchanged; scanner rules were not weakened. The
current `synthetic-backup-runtime.test.mjs` SHA256 is
`0b07cd695de978c7eb307a902021feb9365a448e5f3537fc7bc82896625a91ed`.
At that checkpoint, the other executable imports and all CI hooks retained
their reviewed hashes.
Scoped Secretlint, the ten affected helper tests, formatting and ESLint passed
again after this fixture-only repair.

Local integration verification on September 8 passed all 135 focused
repository/operator/adapter/helper cases, the standalone repository verifier,
scoped ESLint and Prettier, all three workflow files under actionlint, and
TypeScript no-emit checks for web, desktop and e2e configuration. No web build or
runtime stack was started. Atlas's final integrated-source review found no high
or medium findings before the fixture-only Secretlint repair described above.

This sparse checkout initially omitted `tsconfig.tests.json`, `vercel.json` and
`web/admin/admin.css`. Only those exact-HEAD, nonsecret verifier prerequisites
were materialized, without executing legacy code or changing their contents;
the original skip-worktree flags are preserved. Initial missing-file failures
were resolved by that materialization and the affected checks were rerun. The
OpenClaw change guard does not support this external repository; its scope
refusal was explicitly acknowledged under the assigned repository task, with no
guard-root changes or verifier bypass.

## First CI execution and scoped reload correction

[Verification run 34188437645](https://github.com/danielholguin31/desmoslock/actions/runs/34188437645)
ran at exact PR56 source `f4df770aae62d946dda30bf39d1df4470e3624b9`.
The roundtrip step failed with the fixed code
`TLS_RELOAD_FIXTURE_COMMAND_FAILED`. Both disposable stacks initialized and the
source TLS-generation stage completed, including the in-image OpenSSL probe.
Export, restore and the subsequent staff suite were not reached. All other
substantive verification jobs and [security run 34188437624](https://github.com/danielholguin31/desmoslock/actions/runs/34188437624)
passed; the unconditional final stop step also passed. No cleanup-failure suffix
was reported. Raw native diagnostics remain withheld.

The pinned image explicitly [demotes DB role `postgres`](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/migrations/db/migrations/10000000000000_demote-postgres.sql)
and [makes `supabase_admin` a superuser](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/migrations/db/init-scripts/00000000000000-initial-schema.sql).
PostgreSQL 17 requires [superuser or parameter-specific authority for `ALTER SYSTEM`](https://www.postgresql.org/docs/17/sql-altersystem.html).
The image's [local socket rules](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/ansible/files/postgresql_config/pg_hba.conf.j2)
permit `supabase_admin`, while its [build](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/Dockerfile-17)
provides `/usr/lib/postgresql/bin/psql` and configures the socket directory.
The [pinned CLI startup](https://raw.githubusercontent.com/supabase/cli/v2.115.0/apps/cli/src/legacy/shared/db-bootstrap/postgres.service.ts)
retains those image paths and local authentication rules. These sources support
a fixture role mismatch; CI did not expose an observed permission-denied error.

The correction changes only the source fixture reload's native path, explicit
socket/port and DB role. OS user `postgres`, SQL settings, process/output bounds,
TLS assertions, operator roles and cleanup remain unchanged. No grants or
authentication policy are changed. The original candidate hashes above remain
historical evidence. The corrected runtime SHA256 is
`220401b2774066ced89a2f38c0f838975d68ffd97902a987f73fb73e798e3068`.
All ten existing helper tests, scoped ESLint, Prettier, Secretlint and whitespace
checks passed with the exact Node 24.20.0 toolchain. No local stack was started;
the next CI run supplied the runtime result below.

## Second CI execution and restore-marker retirement

[Verification run 34189140883](https://github.com/danielholguin31/desmoslock/actions/runs/34189140883)
ran at exact source `5e4ed76e928541ddd9b78196b02727e9f4f0a5dd` and failed with
`STAFF_SUITE_FIXTURE_COMMAND_FAILED`. Reaching that fixed stage requires the
actual TLS reload, valid/invalid/valid CA probes, distinct cluster identities,
default-adapter export and restore, exact fixture verification, and second
restore refusal with unchanged target observation to have passed. The staff
suite then returned nonzero; it did not time out or exceed its output bound.
All other substantive verification jobs and [security run 34189140983](https://github.com/danielholguin31/desmoslock/actions/runs/34189140983)
passed. Final cleanup passed, with no cleanup-failure suffix. The failed run
does not establish the later staff/provider/health checks or emit a complete
roundtrip receipt.

Source inspection located a deterministic precondition conflict in the first
staff subcommand: `supabase/tests/database/internal_release_backend.test.sql`
requires the local restore marker table to be empty by default. The harness had
intentionally populated that table for restore and retained the row. Native
test diagnostics were not exposed, so the precise failing pgTAP output is not
claimed as observed evidence.

The scoped correction retires the harness's temporary restore authorization
after the successful second-refusal/no-change proof. Its deletion requires id
1, the exact in-memory marker, current database `postgres`, the verified target
cluster identity and a fresh `pg_control_system()` match. A transactional guard
requires exactly one removed row and an empty marker table. A separate real SQL
query then checks the target identity, empty marker table, exact baseline
digest/version/counts and current migration attestation. Fixed
`MARKER_RETIREMENT` and `POST_RETIREMENT_VERIFICATION` stages fail before staff
checks on any uncertainty; success adds only `restoreMarkerRetired: true`.

The seven restored tables, release attestation, audit rows, production adapter
and shared SQL tests remain unchanged. The adapter still refuses observation
through a local restore profile after its marker is absent. The harness retains
one unchanged `npm run test:staff-auth` invocation, with no reset or reseed.
The corrected runtime SHA256 is
`c570c53fab0c3ff84e6ae1cf0f4ac4748e4a592665bd81312b081f1eec044e35`.
All 118 existing focused operator/adapter/helper cases, scoped ESLint, Prettier,
Secretlint and whitespace checks passed. Those local checks do not execute the
new retirement SQL; this correction still requires CI execution.

Actual disposable runtime acceptance remains pending until the required CI job
passes at the corrected source. A passing local roundtrip will not prove hosted
staging migration/export, delivered hosted email or packaged desktop staging
acceptance.

Primary implementation references: [pinned CLI image list](https://raw.githubusercontent.com/supabase/cli/v2.115.0/apps/cli-go/pkg/config/templates/Dockerfile),
[exact PostgreSQL image build](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/Dockerfile-17),
[libpq root-certificate handling](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/interfaces/libpq/fe-secure-openssl.c),
[psql connection-failure exit](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/bin/psql/startup.c),
and [OpenSSL certificate reason](https://raw.githubusercontent.com/openssl/openssl/openssl-3.5.0/crypto/x509/x509_err.c).
