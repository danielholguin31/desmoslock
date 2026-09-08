# Disposable synthetic restore acceptance

This source tranche adds a required real backup/restore gate for the internal
baseline. Runtime execution is pending; source review and helper tests alone
do not establish a successful export, restore, TLS connection or health check.
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
tmpfs. A separate PostgreSQL-user command reloads that disposable server's SSL
configuration. Only the public CA reaches host tmpfs and the client container.
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
target. Audit protection is never disabled and audit rows are never deleted.

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
The other executable imports and all CI hooks retain their reviewed hashes.
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

Actual disposable runtime acceptance remains pending until the required CI job
passes at the reviewed source. A passing local roundtrip will not prove hosted
staging migration/export, delivered hosted email or packaged desktop staging
acceptance.

Primary implementation references: [pinned CLI image list](https://raw.githubusercontent.com/supabase/cli/v2.115.0/apps/cli-go/pkg/config/templates/Dockerfile),
[exact PostgreSQL image build](https://raw.githubusercontent.com/supabase/postgres/17.6.1.159/Dockerfile-17),
[libpq root-certificate handling](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/interfaces/libpq/fe-secure-openssl.c),
[psql connection-failure exit](https://raw.githubusercontent.com/postgres/postgres/REL_17_6/src/bin/psql/startup.c),
and [OpenSSL certificate reason](https://raw.githubusercontent.com/openssl/openssl/openssl-3.5.0/crypto/x509/x509_err.c).
