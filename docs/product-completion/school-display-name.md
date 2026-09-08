# School display name

Owner and Administrator staff with verified AAL2 may change the display name of
their own runtime School. Teachers read the current name through their existing
School context and cannot edit it. School identity, slug, Memberships, Tests,
provider configuration and canonical fixture rows remain unchanged.

## Wire and database

The ninth forward migration adds positive-safe-integer `settings_revision` to
workspaces and extends the existing `current_staff_context()` result with
`school_settings_revision`. All nine context fields are required. Denied context
rows retain their code and eight null payload fields. No second settings read
RPC is introduced.

```sql
update_school_display_name(
  workspace_id uuid, display_name text, expected_settings_revision bigint
) returns table (code text);
```

The browser trims surrounding whitespace after rejecting raw C0/C1 controls and
unpaired surrogates. The wire requires a canonical, nonempty plain-text name of
at most 160 UTF-8 bytes. Both parsers reject malformed shapes and unsafe revisions.
SQL independently validates the canonical input.

The mutation authorizes, locks the runtime School, then rechecks live actor,
Membership, provider/application session and MFA authority after any lock wait.
It checks expected revision before checking for a no-op. A matching-revision
no-op returns `school_display_name_unchanged` and writes nothing. An authorized
stale revision returns `school_settings_revision_conflict`. A change increments
the revision once and returns `school_display_name_updated`.

The change and typed append-only audit insert are atomic. The audit contains
School, actor, session and previous/new settings revisions, without retaining
School names. An audit failure rolls back the update. The eight published
migrations, current fixture digest and restricted direct-table grants remain
intact. Recreating the context RPC uses explicit restricted grants; unexpected
upgrade dependencies fail safely instead of being removed with `CASCADE`.

## Application lifecycle

School settings uses a separate product controller and view. The application
creates one provider client and reuses its bounded context reads, visible-page
Membership timer, focus refresh and lifecycle disposal. Its nonsecret product
projection contains verified authority and School presentation. A pre-save read
must return `fresh_authorized`; a paused, skipped, failed or obsolete read cannot
authorize a write from an old snapshot.

Save captures the visible initiating account, authority generation, School,
name and expected revision before awaiting. A short-lived `school_settings`
handle binds the write to the captured provider token and purpose. Missing,
expired or replacement authority fails closed. Handles are released on every
exit; ordinary provider session persistence remains provider-owned.

A save stays busy through verification, submission and authoritative refresh.
Its own synchronous context publication may update presentation but cannot
create a false conflict or enable a second Save. Dirty drafts reconcile only
when idle: users explicitly choose the current name or retain their draft
against the newly observed revision. Lost responses are shown as unconfirmed,
and never cause automatic write replay.

School labels and revisions are presentation, not account identity. Monotonic
verified presentation cannot revert to an older label, and a rename preserves
unchanged Membership confirmations and unrelated form drafts. Existing durable
invitations remain bound to School identity across a rename. Actual authority
loss still clears protected data and private intent.

During an explicitly verified same-authority Membership pause, the settings
view detaches while the private draft is retained. A completed fresh read resumes
it even when the unchanged auth snapshot intentionally does not publish. Loss,
account replacement, suspension and disposal discard it. Throwing view cleanup
and late operation responses cannot restore a discarded generation.

## Verification boundaries

Focused contract, controller, view, actual-application composition and
installed-SDK tests cover validation, purpose/account binding, deadlines,
revision conflicts, uncertainty and lifecycle ordering. The database candidate
adds 90 SQL assertions and nine observed School-lock scenarios while preserving
all twelve Membership lock scenarios.

The existing final composed CI suite retains its nine auth/Membership journeys
and adds two School groups using real provider sessions across two Schools.
They cover Owner/Administrator writes, Teacher and foreign-scope denial,
same-session downgrade/revocation, two observed competing PostgREST writes and
one attributable audit. Its existing actual-entrypoint browser also exercises
UI Save, external rename, dirty draft and pending Membership preservation
without reload. Credentials and browser bundles remain in memory; no real-auth
traces or screenshots are retained.

Source and synthetic checks do not prove disposable SQL/provider/browser
execution. Exact local checks and reviews are recorded in the candidate receipt;
rendered acceptance follows the restore integration and final build, and actual
runtime remains an exact-commit CI gate. Hosted inventory/application, Test
operations and Student Session work remain separate tasks.
