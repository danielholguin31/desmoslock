# Disposable synthetic restore acceptance

This source tranche adds a required real backup/restore gate for the internal
baseline. The corrected eight-migration baseline passed the real TLS/export/
restore checks and full staff suite on both source `5b5722b` and merged main
`73d8b8a`; exact run links and the sanitized receipt are recorded below.
The nine-migration School extension also passed on source `6939c59`, merged as
`d8fadca`. The ten-migration Test extension was runtime-pending at the inherited
checkpoint. The eleven-migration StudentSession source checkpoint below remains
historical. The current twelve-migration native-evidence candidate requires its
own exact-commit runtime run; this source-only update supplies no new test or
runtime result.
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
template. Only the copied project ID and five ports differ. At the original
integration checkpoint the source was the eight-migration Membership baseline,
whose migration-set SHA256 was
`7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56`.
The imported `CURRENT_MIGRATION_FILES` now propagates all twelve migrations.
The selected current aggregate is
`80c2720ff352c721298e5814715374bf9e2a9c1152bbf2d2761ad781265f8701`;
the [versioned input contract](reproducible-supabase.md#versioned-inputs)
retains all historical pins and the ten delimited self-reference normalization.
The eleventh migration preserves its historical aggregate
`aa32ed754c87e7987199dbd6c5f685ae65236ba3f94921157fc6cb07ce67b308`
and raw SHA-256
`448d7697885eae07f04cc3b89531b7b3711e71fa67d56d80ac891df63458fb06`.
Migration 12's raw SHA-256 is
`1543ee8cf236c4c43aa9331ec228eac9f99c68d4460d3023f68ce3a196fa2633`.
Schema generation `4`, fixture digest and seven-table archive remain unchanged.

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
generation or TLS downgrade fallback. The source DB/Auth-only topology was
confirmed by the successful baseline CI runs below; future image or topology
changes still require real execution.

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

The StudentSession extension independently checks both fixed fixture identities
and all 20 added pristine fields in the source, restored target and after marker
retirement. The current Student `COPY` has exactly 25 columns; creation time is
`2000-01-01T00:00:00.000000Z`, epoch/revision are one, proof counter is zero,
allowance is an empty timestamp array, and every added name/device/credential/
receipt field is null. Source and target use distinct session timezones; explicit
UTC export and the restored local timestamp are both required. The target must
have no StudentSession rows before restore. All six runtime stores
(`student_join_materials`, `student_device_bindings`,
`student_bootstrap_challenges`, `student_bootstrap_limits`,
`student_device_proof_state`, `student_protection_events`) must be empty in
source and target, after restore, and after marker retirement. These tables
never enter the archive. New static receipt fields
`studentMetadataPreserved: true` and `studentRuntimeStoresEmpty: true` are
required by both the controller and roundtrip assertion; missing or non-Boolean
evidence fails before the staff suite.

A valid-CA TLS query brackets the negative CA probe. That probe accepts only
native psql exit 2, empty stdout, and the exact expected root-file rejection for
`127.0.0.1:55322` and `/dev/null`. Its combined output is limited to 8 KiB and
classified only in memory. Docker/connection errors, unknown diagnostics,
unexpected success, timeout, cancellation and overflow fail the gate.

After restore, the complete `test:staff-auth` suite runs without reset or reseed.
The StudentSession acceptance groups must extend that same chain, preserving
SQL/RLS, stack/public-health, authorization-lock, Edge, unit, real-provider and
Membership/School/Test browser checks on the restored fixture. A separately
reset Student stack cannot satisfy this gate.
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
`synthetic-backup-runtime.test.mjs` SHA256 at that historical checkpoint was
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
new retirement SQL; at that checkpoint this correction still required CI execution.

Actual disposable runtime acceptance was pending at this second-run checkpoint.
The completed run below supersedes that status while preserving these historical
observations.

## Corrected source and merged-main acceptance

[Source verification run 34189874469](https://github.com/danielholguin31/desmoslock/actions/runs/34189874469)
and [source security run 34189874479](https://github.com/danielholguin31/desmoslock/actions/runs/34189874479)
passed at exact commit `5b5722b20a87961663f6680efe34a0497e739ea1`.
[PR 56](https://github.com/danielholguin31/desmoslock/pull/56) merged as
`73d8b8ade195db445bbd5e0d5877b00ede9a2683`, with the identical tree
`eb6eea68514ed08c2b53f91349ee48c24c1ec0d8`.
[Merged-main verification 34190379428](https://github.com/danielholguin31/desmoslock/actions/runs/34190379428)
and [merged-main security 34190379415](https://github.com/danielholguin31/desmoslock/actions/runs/34190379415)
also passed, including the complete restored-target suite. All twelve jobs
passed on both source and main.

The source run emitted this bounded nonsecret receipt:

```json
{
  "status": "restored",
  "artifactSha256": "91216153b214209a0f81af206118d7f2cbf13cf4d9f5e7ae49b2c90d9c1b09dd",
  "manifestSha256": "1acc86336a8b0c860f134e4cfb25ca9e4250c0ca3c9039473a354dab8e21638b",
  "migrationSetSha256": "7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56",
  "fixtureDigest": "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
  "tlsVerified": true,
  "invalidCaRejected": true,
  "distinctClusters": true,
  "secondRestoreRefused": true,
  "restoreMarkerRetired": true,
  "staffAuthSuiteOnRestoredTarget": true
}
```

The complete unchanged staff suite passed on the restored target without reset
or reseed. Nested output is deliberately withheld, so no unobserved restored
subtest counts are claimed. The separate fresh database job reported 509 tests
across eight files. Cleanup completed without a failure suffix.

These receipts attest the eight-migration Membership baseline. The School
settings branch retains that runtime harness and adds a ninth migration whose
current aggregate is
`9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538`.
That School extension subsequently passed all 12 required source jobs in
[verification 34194857958](https://github.com/danielholguin31/desmoslock/actions/runs/34194857958)
and [security 34194857978](https://github.com/danielholguin31/desmoslock/actions/runs/34194857978)
on `6939c59724d3c5e98478defc1399b40166f0c199`, then merged with identical source
tree as [`d8fadca`](https://github.com/danielholguin31/desmoslock/commit/d8fadcafe8aa5fbc7ef6ca6717d61899677b49fc).
The fresh database job passed 599 assertions across nine files. The real
roundtrip confirmed all six success observations, including the full staff
suite on the restored target, and cleanup passed. Nested per-group counters
remain withheld. The selected repair updated the current SQL attestation pins
and enforced the exact six-column pristine School archive; earlier candidate
checkpoints remain historical.

At the inherited Test checkpoint, new exact-commit ten-migration evidence was
still required for its strict eleven-column Test archive and timezone roundtrip.
That statement and every receipt above describe their recorded source versions.
The inherited eleven-migration StudentSession source checkpoint added the exact
25-column Student archive and four empty runtime-store checks, with real roundtrip
and complete restored-target staff/Student acceptance still unverified at that
recorded checkpoint. Migration 12 adds two runtime-only tables,
`student_device_proof_state` and `student_protection_events`, to every empty-source
and target guard. The seven archived tables, COPY layouts, fixture framing and
fixture digest remain unchanged. The twelve-migration candidate requires its own
real roundtrip and complete restored-target staff/Student/evidence suite.
No historical receipt acquires new checks or Boolean fields retroactively.
None of these local/source CI gates proves hosted staging
migration/export, delivered hosted email or packaged desktop staging acceptance.

Primary implementation references: [pinned CLI image list](https://raw.githubusercontent.com/supabase/cli/v2.115.0/apps/cli-go/pkg/config/templates/Dockerfile),
[exact PostgreSQL image build](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/Dockerfile-17),
[libpq root-certificate handling](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/interfaces/libpq/fe-secure-openssl.c),
[psql connection-failure exit](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/bin/psql/startup.c),
and [OpenSSL certificate reason](https://raw.githubusercontent.com/openssl/openssl/openssl-3.5.0/crypto/x509/x509_err.c).
