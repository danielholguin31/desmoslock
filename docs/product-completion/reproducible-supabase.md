# Reproducible synthetic Supabase baseline

## Scope and safety boundary

This is the generation-4 internal-release backend for local development and
approved synthetic staging. Its nine versioned migrations include the staff
authentication lifecycle, Membership administration, and School display-name settings.
Student Session capabilities and calculator isolation remain later work.

Generation 4 preserves the synthetic fixture across these follow-on migrations.
Repository implementation and migration
attestations alone do not establish operational staff-auth readiness. Delivered
invitations, completed callbacks, and cross-browser session revocation require
separate runtime evidence; health and the local schema verification lane do not
claim those journeys.

Membership administration enforces authority separately for each School.
Owners can invite and revoke Admins or Teachers and change those Membership
roles; Admins can invite and revoke Teachers; Teachers cannot administer staff.
Owner Memberships and self-directed Membership changes are protected. Role
changes and revocations require the expected target revision and recheck live
authority after locking the target. Manageable invitations come from durable
database state, including pending delivery and acceptance, rather than a
browser's previous submissions. These are versioned source contracts; this
document does not claim the Membership browser journeys have run or that hosted
staging matches the current source.

The baseline contains exactly the generation-2 foundation marker, two fictional
Schools, six fictional staff profiles and memberships, two Tests, and two
Student Sessions. The canonical fixture contains no Auth users, email addresses,
passwords, invitations, application-session revocations, audit events, join
codes, billing data, real School data, or real student data. Its seeded profiles
are explicitly unbound and its seeded Memberships are active at revision one
with no acceptance or revocation fields set.
The database tables remain default-deny. Authenticated callers can execute the
no-argument `desmoslock_v2.current_school_summary()` read model and the reviewed
staff lifecycle RPCs, which enforce caller identity, session generation,
membership state, and role at their function boundaries. The service role alone
can execute `desmoslock_v2.internal_baseline_status()` for the public health
function. It has no direct table privilege on the foundation, fixture, or
attestation tables.

Do not replay Ticket 04 or any recovered MacBook implementation. Its unfinished
auth lifecycle is negative evidence only. The versioned migration, seed, tests,
health function, and operator modules in this repository are the authority.

## Versioned inputs

- `supabase/migrations/20260824000100_v2_foundation.sql`
- `supabase/migrations/20260828000100_internal_release_backend.sql`
- `supabase/migrations/20260903000100_staff_auth_lifecycle.sql`
- `supabase/migrations/20260903000200_staff_auth_generation_4.sql`
- `supabase/migrations/20260907000100_staff_auth_callback_completion.sql`
- `supabase/migrations/20260907000200_runtime_owner_bootstrap.sql`
- `supabase/migrations/20260907000300_membership_revocation_authority.sql`
- `supabase/migrations/20260907000400_membership_administration.sql`
- `supabase/migrations/20260908000100_school_display_name.sql`
- `supabase/seed.sql`
- `supabase/config.toml`
- `supabase/functions/deno.json`
- `supabase/functions/_shared/http.ts`
- `supabase/functions/_shared/supabase-http.ts`
- `supabase/functions/account-recovery/index.ts`
- `supabase/functions/health/index.ts`
- `supabase/functions/staff-invitations/index.ts`
- `scripts/synthetic-backup/operator.mjs`
- `scripts/synthetic-backup/publication-worker.mjs`
- `scripts/synthetic-backup/postgres-adapter.mjs`

The fixture contract is generation `4`, version `internal-baseline-v2`, with
SHA-256
`f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201`.
The exact discovered migration file set has normalized SHA-256
`9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538`.
The published generation-3 migration retains its contemporaneous digest
`06f171a1ac02819e947bbcc92ba8040eaf55fa63b3183a805f4bc3254897dc49`;
the original generation-4 migration likewise retains
`ce79427901195258897e0b75c80acfb7b50699eb223af5289cf5d5d59958f2b7`.
The callback-completion migration retains its five-file digest
`1b499b73aca1ff812cbc244f9eb9908e8dad839ecc6befbcb1a496865a2d5f52`
and raw SHA-256
`79ab31e822b4f04f4148c50bb98446210a37d975a646119b42d78fe1349a8862`.
The runtime-Owner-bootstrap migration retains its six-file digest
`8d5fd99304ce8bbf9524dfb788080f890ab84565c096a8e6d4faf437a9b734dc`
and raw SHA-256
`43527d889ae0823057bba8ab7b4ed97eb9603220658c59c56cfda70889af75c9`.
The Membership revocation authority migration retains its seven-file digest
`e1a9a879948a685a263f24fad98e7fc9a30817fe6ce9461e32fc121080d00a4a`
and raw SHA-256
`9c59c0192b4f960f925db8c64be1c7b2aa6843591d6214a98b29c2bac5a326ad`.
The Membership administration migration retains its eight-file digest
`7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56`
and raw SHA-256
`078a886cc923b0d9349eca992ebf1d74b06e4bbd302ee165828b4003ca3326a5`.
Only the School display-name migration records the current aggregate.
Its raw SHA-256 is
`96febd78bbec6859771cb26ae095458553e19ddd75dbc438e99b54ee86549e18`.
The repository contract pins each attested migration's raw SHA-256 and literal
independently, then zeroes only those seven delimited self-references when deriving
the nine-file aggregate. The follow-on migration updates the existing singleton
attestation without changing schema generation `4` or the seven-table fixture;
the upgrade path does not depend on rewriting or replaying historical migrations.
The seed takes a transaction advisory lock, refuses altered or partial targets,
and verifies this digest plus the exact generation-2 foundation marker after
insertion. The fixture digest length-frames every seeded identity and content
field plus the new profile Auth binding and Membership lifecycle fields. A
replay is accepted only when the existing fixture is already exact; runtime
rows with null seed keys do not change health attestation.

## Local bootstrap and verification

Use exactly Node.js 24.20.0, npm 11.12.1, Docker, and the repository-pinned
Supabase CLI.

```bash
npm ci
npm run db:start
npm run db:reset
npm run test:db
npm run db:stop
```

The full staff-auth CI lane enables the pinned CLI's disposable Mailpit service
for actual PKCE recovery mail capture. The harness uses the numeric loopback
Mailpit API and only its run-owned recipient, retaining message bodies, PKCE
verifiers and provider credentials in memory. This is a local test mail sink,
not hosted SMTP or external delivery evidence. A loopback client URL does not
by itself prove that Docker publishes the service only on a loopback interface.

The Edge and client suites do not require the live stack:

```bash
npm run test:edge
npm run test:web
npm run test:electron
```

`db:start` is the database-only verification profile. The staff Auth schema and
local-prerequisite lane requires the full disposable stack:

```bash
npm run db:start:full
npm run db:reset
npm run test:staff-auth
npm run db:stop
```

The web and desktop tests build against a credential-free loopback health
fixture and verify the same public contract through their rendered status. The
dedicated staff-auth CI lane starts the full disposable stack, resets it, runs
all pgTAP schema/RPC lifecycle contracts, performs credential-free local Auth,
PostgREST, and health prerequisite probes, runs Edge handler and unit behavior
suites, and always attempts stack shutdown. It does not exercise delivered
email or a complete callback in two browser contexts, so passing the lane is
not operational staff-auth evidence.
The versioned Auth configuration is intentionally fail-closed for this ticket:
it uses a non-routable placeholder origin and disables global and anonymous
signup. It also explicitly preserves the hosted-safe Auth settings that differ
from Supabase CLI defaults: email confirmations remain required, email resend
frequency remains one minute, email OTPs remain eight digits, and TOTP
enrollment and verification remain enabled. These values must be explicit
because `supabase config push` includes defaults for omitted supported fields.
Completing issue 31 on hosted staging still requires replacing the placeholder
only through the separately reviewed identity, callback, and session rollout.
The local generation-4 contract does not authorize that hosted change.

The web build configuration has exactly four public fields:

- `DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT`: `local` or `staging`
- `DESMOSLOCK_PUBLIC_BACKEND_URL`: a numeric-loopback HTTP origin for local, or
  a root-path HTTPS DNS origin for staging
- `DESMOSLOCK_PUBLIC_WEB_ORIGIN`: the exact browser origin allowed to run the
  web application
- `DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the browser-safe Supabase
  publishable key for the selected backend

All four fields are mandatory. The build rejects absent or partial configuration,
unknown fields, URL credentials, paths, query strings, fragments, numeric
hosts, the entire special-use `.localhost` namespace (including subdomains and
trailing-dot forms), local staging hosts, and non-TLS staging origins before
bundling. The publishable key is intentionally browser-public; no database URL,
service-role key, secret key, or operator credential is a public build input.
The desktop renderer never receives the web origin or publishable key and
observes health directly; no backend IPC channel or new privileged bridge
authority is added.

Example local build:

```bash
DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=local \
DESMOSLOCK_PUBLIC_BACKEND_URL=http://127.0.0.1:54321 \
DESMOSLOCK_PUBLIC_WEB_ORIGIN=http://localhost:43174 \
DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc \
npm run build
```

Example staging build after the remote gate has been approved:

```bash
DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=staging \
DESMOSLOCK_PUBLIC_BACKEND_URL=https://PROJECT_REF.supabase.co \
DESMOSLOCK_PUBLIC_WEB_ORIGIN=https://APP_ORIGIN.example \
DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE_KEY \
npm run build
```

`PROJECT_REF`, `APP_ORIGIN`, and `PUBLISHABLE_KEY` are placeholders, not
repository values. Hosted values remain a separately approved rollout gate.

## Health contract

`GET /functions/v1/health` is public and credential-free. Its generation-4
ready response includes exactly the `auth`, `database`, and `rest` capabilities.
The separate `schemaGeneration: 4`, fixture version, and fixture digest fields
attest the schema foundation; `staff-auth` is deliberately absent from the
operational capability list until delivery and full browser acceptance exist.
Clients require that exact distinction and reject a response that adds the
unproven capability. Health returns `200` only when Auth responds and the
service-only database RPC verifies the exact migration generation and fixture
digest. Client reads omit credentials, reject redirects, bypass caches, and
time out after five seconds. Missing runtime configuration, dependency errors,
invalid fixtures, and incompatible responses fail closed without returning
internal diagnostics, project identifiers, or credentials. The Edge function
also bounds its Auth and database dependency probes to five seconds and maps a
timeout to the same sanitized unavailable response.

The Edge runtime receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
Supabase platform. It must also receive
`DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN`, independently set to the exact root
origin of `SUPABASE_URL` in every hosted runtime. Local development permits HTTP
only for exactly pinned `127.0.0.1`, `[::1]`, `host.docker.internal`, or `kong`
origins. The sole absent-pin exception is the Supabase CLI's byte-exact internal
`http://kong:8000` gateway; host-side callers continue to use
`http://127.0.0.1:54321`. Hosted use additionally requires the exact
`https://<20-character-project-ref>.supabase.co` shape and matching independent
pin. Arbitrary HTTPS origins, ports in hosted origins, paths, credentials,
missing hosted pins, mismatched pins, and local near-misses fail before any
request. The service-role value is never a client build input and is never
returned by the function.

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
  `PGUSER`, `PGPASSWORD`, and `PGSSLROOTCERT`
- restore reads only `DESMOSLOCK_LOCAL_RESTORE_PGHOST`, `PGPORT`,
  `PGDATABASE`, `PGUSER`, and `PGPASSWORD`

Restore also requires `DESMOSLOCK_LOCAL_RESTORE_MARKER`, an opaque 32–128
character local-target marker containing only letters, digits, `.`, `_`, or
`-`. It is not read during export.

Supply them through an approved credential-injection mechanism.
`DESMOSLOCK_STAGING_PGSSLROOTCERT` must be the absolute path to the operator's
explicitly provisioned PEM CA bundle for the staging PostgreSQL certificate.
The staging profile passes that path to libpq as `PGSSLROOTCERT` and fixes
`PGSSLMODE=verify-full`, so both the certificate chain and the configured
`DESMOSLOCK_STAGING_PGHOST` name must authenticate. A missing path, a relative
path, or the filesystem root is rejected before a PostgreSQL subprocess runs;
an absent, unreadable, malformed, or non-matching CA bundle is refused by
libpq. The operator does not inherit a home-directory certificate or ambient
system trust configuration. The local restore profile remains numeric loopback,
passes `PGSSLMODE=disable`, and does not read or pass the staging CA path.
PostgreSQL client executables must be absolute paths. Backup publication is
POSIX-only and requires the system `/usr/bin/python3` launcher; it runs in
isolated mode only long enough to `fchdir` the already-open root descriptor and
immediately exec the exact current Node runtime.

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
system-identifier collisions, and targets whose seven managed tables or any of
the five runtime-only staff lifecycle tables are nonempty. Those runtime-only
tables are `application_session_revocation_cutoffs`,
`application_session_revocations`, `staff_audit_events`, `staff_invitations`,
and `staff_password_recovery_operations`. The archive allowlist is exactly the
seven synthetic tables, including `foundation_seed`; Auth, invitation,
application revocation, password-recovery, and audit data are never added. The
PostgreSQL adapter rejects every archive-rendered statement except an exact
allowlist of harmless dump scaffolding and the seven validated `COPY` blocks.
The generation-4 profile and Membership layouts accept PostgreSQL null markers
only in their exact nullable positions. Seeded profiles must be unbound, and
seeded Memberships must be active at revision one with every acceptance and
revocation field null.
It rebuilds a private dependency-ordered `COPY` plan from those validated rows;
raw `pg_restore` SQL is never executed. The adapter then rechecks the cluster
system identifier, exact database name, server-side local marker, normalized
migration-set digest attestation, exact migration versions, and seven-table
emptiness and applies the plan in one serializable transaction. It verifies the
fixture and foundation marker before commit. Immediately before restore, the
operator re-hashes the held archive bytes. After commit, it directly re-observes
the target through PostgreSQL and emits a scoped local synthetic-fixture receipt
only when the expected generation-4 seven-table fixture matches. This receipt is
not evidence of the public health or web/desktop smoke journey; that remains
part of the remote staging acceptance gate below.

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

## Disposable restore CI gate

The required staff-auth CI lane now invokes `npm run test:backup:roundtrip`.
It exports the pristine fixture from one fresh cluster through the real
`verify-full` staging-profile adapter, restores a separate empty migrated
cluster, refuses a second restore, and runs the unchanged complete staff-auth
suite without reseeding. This lane requires a fresh disposable CI runner and
must not target an existing local or hosted database. Actual execution is
pending; see [source, operation and evidence boundaries](synthetic-restore-acceptance.md)
for the exact imported candidate, TLS prerequisites and cleanup contract.

## Remote staging acceptance gate

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

The generation-4 integration work makes no hosted call and does not provide
evidence for a database migration, seed, function deployment, backup, restore,
email delivery, callback completion, or two-browser revocation journey. An
agent carries the implementation, verification and receipt collection through
the unresolved gates within the authorized scope. Human input is required for
an actual authority boundary or unresolved material choice, not for checks the
agent can perform.

The existing approved target is `adlhhdbglpamaftcbmce`. Its last recorded public
health response was generation 3, which is evidence of a version gap, not proof
that the target is empty or ready for these migrations. Recheck its current
inventory and identity before planning an upgrade; the local nine-migration
foundation does not establish hosted state or require a replacement project.

1. Verify and reuse an approved empty synthetic-only staging target when one is
   already available. Create a new project only when the reviewed requirements
   call for it. Independently record the target identity and PostgreSQL
   `system_identifier`.
2. Confirm the target is not production and contains no real School or student
   data.
3. Link the Supabase CLI using an approved account and credential channel, then
   independently read back the linked project identity.
4. Review the versioned `supabase/config.toml`: the API schema allowlist must
   include `desmoslock_v2`, `health` must remain public, and every explicit Auth
   value above must remain unchanged until the separately approved hosted issue
   31 callback and identity configuration replaces it.
5. Before any future `supabase config push`, inspect the complete diff and
   obtain explicit approval for every proposed setting. That command has no
   dry-run mode. Reject a bundled diff that changes an unapproved setting.
   Afterward, read back and record the hosted API, Auth, and function settings
   instead of treating the local file as proof of remote state.
6. Review `supabase db push --linked --include-seed --skip-vault --dry-run`.
7. After explicit approval, run the corresponding non-dry-run migration and seed.
8. Set `DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN` through the approved hosted secret
   channel to the independently recorded exact project origin. Deploy only the
   reviewed versioned functions with their exact JWT policies declared in
   `supabase/config.toml`.
9. Observe the exact generation-4 public health response from outside the
   project network and build both clients with only the approved public staging
   configuration.
10. Complete delivered-email invitation and recovery callbacks with disposable
    identities, then prove membership and session revocation from an already-open
    second browser context.
11. Export the synthetic backup, restore it into a clean local project with the
    operator above, and repeat the public health plus web/desktop smoke checks.

Actual hosted bootstrap, credential provisioning, function deployment, email
delivery, callback, multi-context revocation, backup, and restore receipts remain
this acceptance gate. They must not be represented as complete from local tests
alone. Initial Owner provisioning must follow the separate
[runtime bootstrap contract](runtime-owner-bootstrap.md), preserving the
immutable synthetic fixture and proving health after the operational lifecycle.
