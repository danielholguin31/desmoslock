# Test workspace

The Test workspace lets verified active staff create Tests, edit draft/open
titles, open a draft, and end an open Test in their School. Teacher access uses
the verified provider session's current assurance; Owner and Administrator
operations require AAL2. Colleagues in the same School can operate a Test even
after its creator loses Membership. Every backend operation checks live staff
authority; writes recheck it after waiting on the target lock.

This document describes the source contract. Validation belongs to the exact
commit's associated pull request, required checks, and linked acceptance
receipts; source implementation alone does not establish runtime completion. It adds
no StudentSession handler, student credential, native lockdown or device-unlock
guarantee. Ending a Test closes its backend lifecycle; later StudentSession
operations must obey the same live parent predicate and parent-before-child
lock order. Source-only lock probes do not establish those future handlers.

The product has its own controller and sibling mount beside School settings,
with one shared provider and the existing visible-page authority refresh. Test
refresh does not recursively invoke the outer data cycle. A paused or obsolete
authority read cannot authorize a Test request. Quiet School label changes
preserve unrelated drafts and pending Membership review. Actual authority loss
discards private intent; same-authority temporary pauses retain it.

Captured requests bind the verified account and canonical provider session ID,
so a same-account replacement session cannot inherit an earlier intent while an
auth notification is delayed. A renewed token for the same session remains
acceptable when no intervening notification/generation invalidation occurred.
Existing conservative provider-notification revalidation, including token
refresh notifications, remains in place; this adds no event-ignore behavior or
provider-cache cleanup scheme.

The shared authority-read and MFA publication boundary, including the explicit
local session cutover, is defined in
[Staff session publication](staff-session-publication.md).

Titles reject control characters and malformed UTF-16 before trimming, then
allow at most 160 UTF-8 bytes. Lists show at most 50 Tests, with one lookahead
row. Native timestamp/UUID ordering retains all six fractional UTC digits; the
50th displayed row supplies the next cursor. A selected Test outside the page
uses the targeted reader. No timestamp ordering value is normalized through
JavaScript milliseconds.

Create retries use one private immutable creation key, title and initiating
authority, only after an explicit retry. A lost response is unconfirmed;
refresh never silently resends. Title/Open/End actions bind the selected Test
revision, and ending requires fresh review. A stale dirty title must be
explicitly reconciled. Confirmed-action copy does not assert that a later
concurrent operation left the Test unchanged.

The tenth forward migration preserves all nine historical migrations and the
generation-4 synthetic fixture identity/framing/digest. Only the two pinned seed
Tests receive fixed `2000-01-01T00:00:00.000000Z` creation metadata, draft
lifecycle, revision one and null transition timestamps/creation keys. Existing
nonseed creation times mean migration-recorded time; new runtime Tests use the
server mutation time. The synthetic backup adapter must accept only the exact
eleven-column current Test archive and pinned pristine metadata. Real
cross-timezone dump/restore verification is an explicit CI gate.

Implementation boundaries are the named contracts in
`packages/contracts/src/test-workspace.ts`, the existing Supabase port, the
separate `apps/web/src/test-workspace/` controller/view, and
`supabase/migrations/20260908000200_test_workspace.sql`. Acceptance extends the
existing final staff-auth suite and production-entrypoint browser without a
second stack, reset, provider client or poller. The associated pull request and
acceptance receipts distinguish source, rendered, and runtime evidence and
identify any pending gates.
