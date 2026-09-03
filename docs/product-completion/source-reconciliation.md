# Source reconciliation and release custody

## Decision

`danielholguin31/desmoslock` `main` is the only integration branch and the only
source from which a future DesmosLock artifact may be built. The root npm
workspace is the v2 product. Legacy directories, non-`main` branches, draft pull
requests, archived patches, and the divergent `release/1.0` line are not
alternate product or release sources.

Ticket 29 records the reconciliation baseline as
`388170e94418d20ad205812553e1c9fdf5de9139`, tree
`95a00a77f84962248523f38a8c554216270cc23d`. That immutable identity describes
the source reviewed by this reconciliation; `main` will advance when the ticket
is merged.

The machine-readable authority for the identities and per-commit decisions is
[`source-reconciliation.json`](source-reconciliation.json). The repository
verifier contains an independent expected inventory and fails when the ledger,
release tombstone, evidence counts, or package-version contract drifts.

Within that sole canonical line, v2 product authority is narrow: `apps/`,
`packages/`, `supabase/config.toml`, `supabase/functions/deno.json`,
`supabase/functions/health/`, `supabase/migrations/`, `supabase/seed.sql`, and
`supabase/tests/database/`. The only issue-30 operations source is
`scripts/synthetic-backup/`. These paths do not make any sibling legacy SQL,
deployment surface, or operator code authoritative.

The legacy enterprise-administration surface remains visible on the canonical
line at `web/admin`, `supabase/enterprise.sql`, and `docs/OPERATIONS.md` only as
historical evidence. It is excluded from the v2 workspaces and every legacy
deployment path is fail-closed. Its presence does not make the old admin console
a supported v2 capability.

## Classification model

Every commit reachable from `release/1.0` but not from the reconciliation
baseline is listed exactly once in the ledger.

- **integrated** means the change is implemented in v2 production source with
  its accepted validation.
- **rejected** means the change is intentionally not carried into the canonical
  product or release path. The ledger records why.

There are 17 divergent commits. All 17 code changes are rejected; none is
integrated. For 11 validated historical anchors, the ledger separately records
the recovery, provenance, or Gatekeeper contract IDs retained as evidence. That
mapping is not a third code disposition and does not accept any release-line
implementation. The final audited line is
`release/1.0@ddcfce456f3cf015ab77d207310140a311c945ab`, tree
`ab352dea9a5cdde409d2ff93d61dd62283005cbe`, with merge base
`3883f4234923c0bc250dc41649ba3801144c3f58`.

The release commit, tree, source-file blobs, sizes, and content digests are
historical metadata. Canonical CI does not resolve or execute the off-main
commit, and the `release/1.0` ref need not remain reachable for evidence tests.
Reachability would not confer release authority. The v1.0.1 GitHub draft,
release ID `370225506`, is unpublished quarantine evidence and must never be
published or promoted.

## Preserved executable evidence

`tests/evidence/release-1.0-evidence.fixture.json` freezes the audited
commit/tree, the historical source-file blob/size/SHA-256 identities, and each
contract ID. `npm run test:evidence` verifies that tracked fixture and the
tracked expected-red source digest, then executes only canonical main-line
files. It has no runtime dependency on an off-main Git object. The fixture
preserves these exact contracts:

| Contract                                                                          | Tests | Audited source test                          |
| --------------------------------------------------------------------------------- | ----: | -------------------------------------------- |
| Lock recovery fails closed through unavailable or indeterminate restore           |     9 | `desktop/test/force-quit-recovery.test.js`   |
| Build and release provenance remains bound to exact source/tool identity          |    13 | `desktop/test/release-provenance.test.js`    |
| Gatekeeper receipts remain bound to exact draft assets and physical-host evidence |    15 | `desktop/test/gatekeeper-acceptance.test.js` |

The same 37 behaviors are executable expected failures in
`tests/evidence/audited-release.contract.test.ts`. A green legacy evidence run
is proof that the record is intact, not proof that those v2 seams work. Later
tickets must start with the relevant v2 public-seam contract, port only accepted
behavior, and retain the evidence count until an explicit superseding receipt is
reviewed.

## Sanitized MacBook recovery boundary

The private archive
`nicolasdmolina/desmoslock-recovery-20260827-1835-sanitized` ref
`recovery/macbook-20260827-1835/sanitized-evidence` is non-authoritative
reconstruction input. Its orphan root is
`c523743601ce75cfab4edcc6e4fd040d60730446`, tree
`d2a11a84a54a0185890020fba684dbe2bf1e47c6`. The ledger binds its patch
inventory and environment-exclusion digests.

The archive transferred no original unpublished commit object, has zero tree
overlap with the original histories, and intentionally excludes every `.env*`
byte and delta. It cannot recreate byte-identical source commits or complete
trees. Preservation does not constitute review: code from the archive must be
reconstructed on the accepted dependency line and independently verified before
it can enter v2.

The comparison verdict is **selective reconstruction only**:

- Ticket 04 at `5d4c34cdd4958e5f40ac5c367462ad76fd39355a` is
  rejected incomplete negative evidence. Its lifecycle work received repeated
  rework and no final lifecycle-v4 acceptance receipt.
- Ticket 11a at `c5fa74231ba5c645c8dcb8d72e77dbee1a19c269` is
  selective-salvage-only because it is based on the rejected cumulative
  `1038ca4d5bd963e97f5c0c4de31e9234eb54d661` line. The sanitized preflight
  salvage patch is bound by SHA-256
  `084d6075c04cc0deedce9ff3cc6cd949ed4b4e5b5dc7ba0ba2cafb5ed408a8c9`;
  that identity records evidence, not acceptance.
- The legacy planning repository and local tracker are non-authoritative
  evidence only.

The archive must never be executed in place, overlaid, cherry-picked, treated
as a branch, or merged. A later ticket may reconstruct a narrowly reviewed
behavior from first principles on its true accepted dependencies.

## Current release and enforcement state

`.github/workflows/release.yml` is a manual, least-privilege tombstone whose only
job fails. It has no tag trigger, write permission, environment, action, artifact
transfer, signing, packaging, publication, or deployment path. The legacy
desktop packaging scripts and Vercel build remain independently fail-closed.

No v2 artifact can be produced until a later ticket establishes a reviewed,
signed, immutable pipeline bound to a commit contained in `main` and to
consistent root/workspace/internal-dependency versions. No public deployment,
download, pricing, general-availability claim, or school outreach is authorized
by this reconciliation.

Server-side branch protection is still unresolved. The repository is private on
a plan that cannot apply the intended ruleset, and the current operator lacks
the required owner/admin authority. This is recorded as an external human gate,
not misrepresented as active enforcement. Required CI and security workflows
remain the local and pull-request verification baseline in the meantime.

Open draft PRs and obsolete remote branches are non-canonical immediately by
this contract. Their remote closure or preservation is follow-up repository
maintenance after this change is independently verified and merged; no remote
state is changed by the local reconciliation itself.

This local reconciliation is not full completion of issue 29. Five gates remain
open: downstream v2 behavior, exact-head CI evidence after merge, remote PR and
branch cleanup, enforceable branch protection, and artifact provenance through
a reviewed v2 release pipeline.
