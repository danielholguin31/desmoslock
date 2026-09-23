# DesmosLock

DesmosLock v2 is an **internal, pre-release** product. The root npm workspace on
the `main` branch of `danielholguin31/desmoslock` is the only development,
integration, and future release source.

There is currently no supported public download, deployment, price, purchase
flow, or generally available release. The legacy `desktop/`, `server/`, `web/`,
standalone SQL, Vercel configuration, and v1 release material are retained only
as historical audit evidence. They must not be run, deployed, packaged,
published, or presented as current product behavior.

## Maintainer handoff

See [Daniel’s takeover checklist](docs/product-completion/daniel-handoff.md) for the
latest completed work, retained evidence, and remaining GitHub release tickets.
System-level Apple assessment protection remains required.

## Canonical source contract

- Repository: `danielholguin31/desmoslock`
- Integration branch: `main`
- Product source: `apps/`, `packages/`, `supabase/config.toml`,
  `supabase/functions/`, `supabase/migrations/`, `supabase/seed.sql`,
  `supabase/templates/`, and `supabase/tests/database/`
- Operations source: `scripts/synthetic-backup/` for the synthetic-only backup
  and local-restore boundary
- Dependency source: the root `package.json` and root `package-lock.json`
- Required verification: `.github/workflows/ci.yml` and
  `.github/workflows/security.yml`
- Release status: no v2 release workflow exists yet; the legacy workflow is a
  manual, always-failing tombstone

Every future artifact must be built from a reviewed commit contained in `main`,
with root, workspace, internal-dependency, and lockfile versions in agreement.
Creating that signed, immutable v2 pipeline is later work; no legacy workflow or
branch may substitute for it.

These exact Supabase and operator paths are canonical only for the reviewed v2
internal baseline. They do not confer authority on legacy standalone SQL,
including `supabase/enterprise.sql`, or on any legacy deployment/operator path.

This local reconciliation does not complete issue 29. Downstream v2 behavior,
CI evidence for the exact merged head, remote pull-request and branch cleanup,
branch protection, and artifact provenance remain open gates.

GitHub branch/ruleset enforcement is still an owner/admin gate. The current
private/free repository plan cannot enforce the intended required checks. Until
that gate is resolved, this documented contract and the repository verifier are
the available controls; they are not represented as server-side protection.

## Develop and verify v2

Use exactly Node.js 24.20.0 and npm 11.12.1 from the repository root.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT=local \
DESMOSLOCK_PUBLIC_BACKEND_URL=http://127.0.0.1:54321 \
DESMOSLOCK_PUBLIC_WEB_ORIGIN=http://localhost:43174 \
DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc \
  npm run build
```

All four public web values are mandatory. An absent or partial configuration
fails before bundling; there is no implicit loopback, staging target, or
publishable key. The synthetic key above is test-only and is never a hosted
credential.

The disposable v2 database starts from `supabase/migrations/` and
`supabase/seed.sql`. It does not import legacy users or product rows. The
generation-4 seed creates only the fixed two-School synthetic internal
baseline. Its six profiles remain unbound to Auth identities, and its six
Memberships remain active, revision-one fixtures with no acceptance or
revocation state.

```bash
npm run db:start
npm run db:reset
npm run test:db
npm run db:stop
```

For the disposable staff-auth schema and local-prerequisite verification lane:

```bash
npm run db:start:full
npm run db:reset
npm run test:staff-auth
npm run db:stop
```

CI now runs that complete lane inside the disposable
[`test:backup:roundtrip` harness](docs/product-completion/synthetic-restore-acceptance.md),
which first exports and restores the pristine fixture across distinct fresh
clusters, then runs the staff-auth suite without reseeding. The eight-migration
baseline passed this real roundtrip on both
[source `5b5722b`](https://github.com/danielholguin31/desmoslock/actions/runs/34189874469)
and [merged main `73d8b8a`](https://github.com/danielholguin31/desmoslock/actions/runs/34190379428).
The nine-migration School settings extension passed all 12 required source jobs,
599 fresh SQL assertions and the full restored-target staff suite on
[source `6939c59`](https://github.com/danielholguin31/desmoslock/actions/runs/34194857958),
then merged as [`d8fadca`](https://github.com/danielholguin31/desmoslock/commit/d8fadcafe8aa5fbc7ef6ca6717d61899677b49fc).
The ten-migration [Test workspace candidate](docs/product-completion/test-workspace.md)
requires its own exact-commit runtime run. CI owns startup and unconditional shutdown. The command verifies
database schema/RPC lifecycle contracts, local Auth/PostgREST/health prerequisites,
observed two-connection authorization races, Edge handler behavior, unit tests,
then real-provider invitation, PKCE recovery and revocation journeys. The final
composed suite requires a freshly reset stack;
its append-only audit fixtures remain until the disposable stack is stopped or
reset. CLI startup output is sanitized so generated local keys are not printed.
The School settings gate included its actual-entrypoint browser against the
disposable backend. Nested restored-suite counters are withheld; no separate
unobserved browser/provider counts are claimed. The Test workspace extension
has not executed its new database/provider/browser journeys locally.
Hosted email and configuration remain separate acceptance gates. See
[`auth-integration-evidence.md`](docs/product-completion/auth-integration-evidence.md)
for the selected contract, evidence limits and in-place rollout prerequisite.

See
[`docs/product-completion/reproducible-supabase.md`](docs/product-completion/reproducible-supabase.md)
for the public health/configuration contract, synthetic-only export and
seven-table local restore operator, and the remote staging human gate.

The repository contract can also be checked directly:

```bash
npm run verify:repository
```

## Historical evidence boundaries

The divergent `release/1.0` line is frozen evidence, not an alternate release
source. A tracked immutable fixture records the exact historical commit, tree,
test-file identities, and 9 recovery, 13 release-provenance, and 15 Gatekeeper
contract IDs. `npm run test:evidence` verifies that fixture and executes only
the tracked v2 expected-red contracts. It does not require the historical Git
object or branch at runtime.

The legacy enterprise-administration files under `web/admin`,
`supabase/enterprise.sql`, and `docs/OPERATIONS.md` likewise remain historical
evidence only; they are not a supported v2 administration surface.

| Evidence contract | Exact count |
| --- | ---: |
| Fail-closed lock recovery | 9 |
| Release provenance | 13 |
| Gatekeeper acceptance | 15 |

The corresponding 37 v2 public-seam contracts remain executable expected
failures until later tickets deliberately port each behavior. A green legacy
evidence run does not mean the v2 behavior is implemented.

The unpublished v1.0.1 draft release is quarantined evidence and must never be
published. Existing legacy deployment and download surfaces are unsupported and
must not be used as release instructions.

The sanitized MacBook archive is also reconstruction evidence only. It contains
no original unpublished commit objects and intentionally omits all `.env*`
content. No archived product implementation is accepted merely because it was
preserved.

See
[`docs/product-completion/source-reconciliation.md`](docs/product-completion/source-reconciliation.md)
for the human-readable boundary and
[`docs/product-completion/source-reconciliation.json`](docs/product-completion/source-reconciliation.json)
for the machine-enforced ledger covering every divergent release commit and the
sanitized recovery identity.

## Legacy tree policy

Legacy directories remain in place only so audit and fail-closed tests can prove
what was considered and what was rejected. Their packaging scripts, Vercel
build, and release workflow refuse to produce artifacts. Do not copy legacy
files into `apps/` or `packages/` wholesale; future work must start from an
accepted v2 contract and port only the required behavior with focused tests.

Draft PRs and non-`main` branches are proposals or evidence. They are not
integration or release sources, even while remote cleanup is pending.
