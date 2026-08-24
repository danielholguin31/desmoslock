# v2 workspace and verification foundation

## Scope

Ticket 03 establishes an internal, typed v2 build and a disposable data plane beside
legacy v1. It does not enable customer flows, production credentials, packaging, or
publication.

The only v2 npm workspaces are:

- `apps/desktop`
- `apps/web`
- `packages/contracts`
- `packages/domain`
- `packages/test-support`

Legacy `desktop/`, `server/`, and `web/` remain historical evidence outside the
workspace. The legacy release workflow has no tag trigger and always rejects a manual
run. Vercel skips legacy builds, and a direct legacy build command fails.

## Local verification

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:edge
npm run test:web
npm run test:electron
npm run test:dependencies
npm run test:secrets
npm run test:workflows
npm run verify:locks
npm run build
npm run sbom
npm run verify:licenses
npm run verify:packages
npm run verify:repository
```

With Docker available, reset and test the clean local data plane:

```bash
npm run db:start
npm run db:reset
npm run test:db
npm run db:stop
```

`db:start` launches the database-only CI profile; use `db:start:full` when local
Auth, REST, Realtime, Studio, or Edge Runtime services are needed.

The reset applies only versioned files under `supabase/migrations/` and the
deterministic `supabase/seed.sql`. The legacy mutable SQL snapshots are not migration
inputs.

## Required GitHub checks

Protect `main` with pull requests, required CODEOWNER review, dismissal of stale
approvals, no force pushes, and these exact required contexts:

- `Required v2 verification`
- `Security required`

The repository owner must apply those settings in GitHub; versioned workflow files
cannot configure branch protection themselves.

As verified on 2026-08-23, the private canonical repository has no `main` protection,
and GitHub's rulesets API returns `403 Upgrade to GitHub Pro or make this repository
public to enable this feature.` The workflow graph and deliberate failure probe are
ready, but actual merge blocking remains a paid-plan General Availability blocker.

The `Required v2 verification` aggregate rejects a failed, cancelled, or skipped
dependency. To prove the failure path, dispatch `Required v2 verification` with
`run_required_check_failure=true`. The `required-check-probe` job and aggregate must
both fail. The ordinary pull-request path runs the same probe in self-test mode and
must pass.

## Audited release evidence

`npm run test:evidence` verifies the exact
`release/1.0@ddcfce456f3cf015ab77d207310140a311c945ab` tree and runs its 9 recovery,
13 provenance, and 15 Gatekeeper tests in a temporary directory. The matching v2
contracts live in `tests/evidence/audited-release.contract.test.ts` as an executable
expected-failure harness bound to v2 public seams. They may become passing v2 tests
only when those seams implement the retained behavior.
