# Reproducible synthetic Supabase baseline

## Scope and safety boundary

This is the generation-3 internal-release backend for local development and a
future synthetic staging project. It is deliberately smaller than the future
identity, role-policy, Student Session capability, and calculator-isolation
work in issues 31–34.

The baseline contains exactly the generation-2 foundation marker, two fictional
Schools, six fictional staff profiles and memberships, two Tests, and two
Student Sessions. It contains no Auth users, email addresses, passwords,
invitations, join codes, billing data, real School data, or real student data.
The database tables remain default-deny; an authenticated caller can use only
the no-argument
`desmoslock_v2.current_school_summary()` read model. The service role alone can
execute `desmoslock_v2.internal_baseline_status()` for the public health
function. It has no direct table privilege on the foundation, fixture, or
attestation tables.

Do not replay Ticket 04 or any recovered MacBook implementation. Its unfinished
auth lifecycle is negative evidence only. The versioned migration, seed, tests,
health function, and operator modules in this repository are the authority.

## Versioned inputs

- `supabase/migrations/20260824000100_v2_foundation.sql`
- `supabase/migrations/20260828000100_internal_release_backend.sql`
- `supabase/seed.sql`
- `supabase/config.toml`
- `supabase/functions/health/index.ts`
- `scripts/synthetic-backup/operator.mjs`
- `scripts/synthetic-backup/publication-worker.mjs`
- `scripts/synthetic-backup/postgres-adapter.mjs`

The fixture contract is generation `3`, version `internal-baseline-v1`, with
SHA-256
`7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca`.
The exact discovered migration file set has normalized SHA-256
`06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49`;
the generation-3 migration records that same digest in its singleton database
attestation. The only normalization is the migration's one delimited copy of
that digest, which makes the self-attestation reproducible without excluding
any other migration byte.
The seed takes a transaction advisory lock, refuses altered or partial targets,
and verifies this digest plus the exact generation-2 foundation marker after
insertion. A replay is accepted only when the existing fixture is already
exact.

## Local bootstrap and verification

Use Node.js 24, npm 11.12.1, Docker, and the repository-pinned Supabase CLI.

```bash
npm ci
npm run db:start
npm run db:reset
npm run test:db
npm run test:edge
npm run test:web
npm run test:electron
```

`db:start` is the database-only verification profile. Use
`npm run db:start:full` when exercising Auth, REST, and the Edge health function.
The web and desktop tests build against a credential-free loopback health
fixture and verify the same public contract through their rendered status.
The versioned Auth configuration is intentionally fail-closed for this ticket:
it uses a non-routable placeholder origin and disables global and anonymous
signup. It also explicitly preserves the hosted-safe Auth settings that differ
from Supabase CLI defaults: email confirmations remain required, email resend
frequency remains one minute, email OTPs remain eight digits, and TOTP
enrollment and verification remain enabled. These values must be explicit
because `supabase config push` includes defaults for omitted supported fields.
Issue 31 must replace the placeholder only as part of its separately reviewed
identity and session design.

The public build configuration has exactly two fields:

- `DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT`: `local` or `staging`
- `DESMOSLOCK_PUBLIC_BACKEND_URL`: a numeric-loopback HTTP origin for local, or
  a root-path HTTPS DNS origin for staging

Both fields are mandatory. The build rejects absent or partial configuration,
unknown fields, URL credentials, paths, query strings, fragments, numeric
hosts, the entire special-use `.localhost` namespace (including subdomains and
trailing-dot forms), local staging hosts, and non-TLS staging origins before
bundling. No API key, database URL, service-role key, or operator credential is
a public build input. The desktop renderer observes health directly; no
backend IPC channel or new privileged bridge authority is added.

Example local build:

```bash
DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=local \
DESMOSLOCK_PUBLIC_BACKEND_URL=http://127.0.0.1:54321 \
npm run build
```

Example staging build after the remote gate has been approved:

```bash
DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=staging \
DESMOSLOCK_PUBLIC_BACKEND_URL=https://PROJECT_REF.supabase.co \
npm run build
```

`PROJECT_REF` is a placeholder, not a repository value.

## Health contract

`GET /functions/v1/health` is public and credential-free. It returns `200` only
when Auth responds and the service-only database RPC verifies the exact
migration generation and fixture digest. Client reads omit credentials, reject
redirects, bypass caches, and time out after five seconds. Missing runtime
configuration, dependency errors, invalid fixtures, and incompatible responses
fail closed without returning internal diagnostics, project identifiers, or
credentials. The Edge function also bounds its Auth and database dependency
probes to five seconds and maps a timeout to the same sanitized unavailable
response.

The Edge runtime receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
Supabase platform. It must also receive
`DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN`, independently set to the exact root
origin of `SUPABASE_URL` in every runtime. Local development permits HTTP only
for `127.0.0.1`, `[::1]`, `host.docker.internal`, or `kong`, and still requires
that exact independent origin pin. Hosted use additionally requires the exact
`https://<20-character-project-ref>.supabase.co` shape. Arbitrary HTTPS origins,
ports in hosted origins, paths, credentials, missing pins, and mismatched pins
fail before any request. The service-role value is never a client build input
and is never returned by the function.

## Synthetic backup and restore operator

The operator accepts symbolic aliases only: `staging` for read-only export and
`local-restore` for restore. Connection values are loaded from explicit process
configuration, passed to PostgreSQL child processes only through their minimal
environment, and never placed in argv, manifests, receipts, or error output.
Do not store these values in the repository or a local configuration file.

Required executable-path fields are command-scoped:

- export reads `DESMOSLOCK_PSQL_PATH`, `DESMOSLOCK_PG_DUMP_PATH`, and
  `DESMOSLOCK_PG_RESTORE_PATH`
- restore reads only `DESMOSLOCK_PSQL_PATH` and
  `DESMOSLOCK_PG_RESTORE_PATH`

Connection fields are also command-scoped:

- export reads only `DESMOSLOCK_STAGING_PGHOST`, `PGPORT`, `PGDATABASE`,
  `PGUSER`, and `PGPASSWORD`
- restore reads only `DESMOSLOCK_LOCAL_RESTORE_PGHOST`, `PGPORT`,
  `PGDATABASE`, `PGUSER`, and `PGPASSWORD`

Restore also requires `DESMOSLOCK_LOCAL_RESTORE_MARKER`, an opaque 32–128
character local-target marker containing only letters, digits, `.`, `_`, or
`-`. It is not read during export.

Supply them through an approved credential-injection mechanism. The staging
profile requires TLS. The local restore profile requires numeric loopback and
disables TLS. PostgreSQL client executables must be absolute paths. Backup
publication is POSIX-only and requires the system `/usr/bin/python3` launcher;
it runs in isolated mode only long enough to `fchdir` the already-open root
descriptor and immediately exec the exact current Node runtime.

Before export, independently obtain and record the non-secret PostgreSQL cluster
`system_identifier` for the intended staging project. Then use an absolute,
pre-created backup root outside the repository whose final component is not a
symlink. The directory must be owned by the operator's effective user and have
exact private POSIX mode `0700`:

```bash
npm run backup:export:synthetic -- \
  /absolute/private/backup-root \
  staging-baseline \
  EXPECTED_STAGING_SYSTEM_IDENTIFIER
```

The export receipt includes the manifest and artifact hashes. Preserve the
manifest hash out of band. Export uses a serializable-deferrable PostgreSQL
snapshot, derives the fixture and digest again from the resulting archive, and
requires those archive contents to match both source observations around the
dump. Keep the synthetic staging project write-quiescent as an additional
operational control.

Create a migrated, unseeded local restore target whose seven managed synthetic
tables contain no rows:

```bash
npm run db:reset:empty
```

Before restore, an authorized local operator must bind that exact target to the
configured marker by inserting the singleton row in
`desmoslock_v2.local_restore_target_attestation`. The row must record
`current_database()` and the current `pg_control_system().system_identifier`;
the versioned migration intentionally leaves it empty so hosted or unintended
databases are never local-attested by default. Perform this one local mutation
through an approved PostgreSQL credential channel, then independently re-read
all three values. Do not copy this row from staging or include it in an archive.

Independently obtain that local database's `system_identifier`, then restore:

```bash
npm run backup:restore:synthetic -- \
  /absolute/private/backup-root \
  staging-baseline \
  EXPECTED_LOCAL_SYSTEM_IDENTIFIER \
  EXPECTED_MANIFEST_SHA256
```

Restore refuses absolute or traversing artifact paths, noncanonical manifests,
unknown fields, hash mismatches, links, oversized files, unexpected archive
entries or rows, a changed migration set, a target that fails the exact
database/system-identifier/server-side-local-marker attestation, source/target
system-identifier collisions, and targets whose seven managed tables are
nonempty. The archive allowlist is exactly the seven synthetic tables, including
`foundation_seed`. The
PostgreSQL adapter rejects every archive-rendered statement except an exact
allowlist of harmless dump scaffolding and the seven validated `COPY` blocks.
It rebuilds a private dependency-ordered `COPY` plan from those validated rows;
raw `pg_restore` SQL is never executed. The adapter then rechecks the cluster
system identifier, exact database name, server-side local marker, normalized
migration-set digest attestation, exact migration versions, and seven-table
emptiness and applies the plan in one serializable transaction. It verifies the
fixture and foundation marker before commit. Immediately before restore, the
operator re-hashes the held archive bytes. After commit, it directly re-observes
the target through PostgreSQL and emits a scoped local synthetic-fixture receipt
only when the expected generation-3 seven-table fixture matches. This receipt is
not evidence of the public health or web/desktop smoke journey; that remains
part of the remote staging human gate below.

Backup publication opens and verifies the canonical root descriptor, binds the
new backup directory as the worker's current directory, and performs every file
operation relative to that bound inode. Before success it opens the absolute
root with `O_DIRECTORY|O_NOFOLLOW`, requires that handle to be the same fsynced
root descriptor, then opens the backup name relative to both root descriptors
and requires both handles to be the bound backup inode. It retains those
handles while rechecking the root path and both child names. Publication is
sealed by fsyncing the archive and private directory, hard-linking the fully
synced pending manifest into its final name, fsyncing the directory again, and
fsyncing the bound backup-root descriptor.
Both `manifest.pending` and `manifest.json` remain as the canonical two-link
manifest; no publication pathname is unlinked. A backup without exactly
`data.pgcustom`, `manifest.pending`, and `manifest.json`, with both manifest
names bound to the same two-link inode, is unsealed and cannot be restored.
PostgreSQL and publication subprocesses have fixed input/output/time bounds; on
timeout or overflow the operator kills the detached POSIX process group,
destroys all pipes, and returns only a stable refusal.
Failed publications are retained as private, unreceipted quarantine. The
operator performs no failure-path unlink or recursive cleanup, so a concurrent
path replacement cannot make it delete an unowned inode. Never restore or
reuse a refused backup name; an operator must inspect and move the quarantine
through a separate approved cleanup procedure.

## Remote staging human gate

The guarded Supabase CLI 2.115.0 configuration pass applied only the intended
API schema allowlist change. Its bundled Auth diff was declined because the
previous local file omitted supported fields and would have disabled TOTP
enrollment and verification, disabled email confirmations, reduced email
resend frequency from one minute to one second, and shortened email OTPs from
eight digits to six. The approved non-routable `site_url` and global
`enable_signup = false` settings were then applied individually through the
dashboard; none of the unsafe Auth changes were applied.

The repository now pins the corresponding supported CLI fields as
`auth.email.enable_confirmations = true`, `auth.email.max_frequency = "1m"`,
`auth.email.otp_length = 8`,
`auth.mfa.totp.enroll_enabled = true`, and
`auth.mfa.totp.verify_enabled = true`. The repository contract rejects removal
or regression of any of these fields as well as the fail-closed site URL,
global signup, anonymous sign-in, and redirect allowlist settings.

This regression-fix follow-up made no further hosted call and does not provide
evidence for a database migration, seed, function deployment, backup, or
restore. An authorized operator must complete or provide the missing receipts
for the unresolved gates:

1. Select a newly created, empty, synthetic-only staging project and independently
   record its project identity and PostgreSQL `system_identifier`.
2. Confirm the target is not production and contains no real School or student
   data.
3. Link the Supabase CLI using an approved account and credential channel, then
   independently read back the linked project identity.
4. Review the versioned `supabase/config.toml`: the API schema allowlist must
   include `desmoslock_v2`, `health` must remain public, and every explicit Auth
   value above must remain unchanged for issue 30.
5. Before any future `supabase config push`, inspect the complete diff and
   obtain explicit approval for every proposed setting. That command has no
   dry-run mode. Reject a bundled diff that changes an unapproved setting.
   Afterward, read back and record the hosted API, Auth, and function settings
   instead of treating the local file as proof of remote state.
6. Review `supabase db push --linked --include-seed --skip-vault --dry-run`.
7. After explicit approval, run the corresponding non-dry-run migration and seed.
8. Set `DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN` through the approved hosted secret
   channel to the independently recorded exact project origin. Deploy only the
   versioned `health` function with JWT verification disabled as declared in
   `supabase/config.toml`.
9. Observe the exact public health response from outside the project network and
   build both clients with only the staging public origin.
10. Export the synthetic backup, restore it into a clean local project with the
    operator above, and repeat the public health plus web/desktop smoke checks.

Actual hosted bootstrap, credential provisioning, function deployment, backup,
and restore receipts remain this human gate. They must not be represented as
complete from local tests alone.
