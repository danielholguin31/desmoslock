# Membership administration

This source tranche extends the existing staff-authentication boundary. A
Membership remains the pair of School and staff profile, with storage roles
`owner`, `admin`, and `teacher`, an `active` or `revoked` state, and a positive
role revision. Product interfaces display `administrator` for storage `admin`.

## Permissions

| Current actor                                  | Same-School staff administration                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Owner with verified AAL2                       | Invite, inspect and revoke Administrators and Teachers; change an active Administrator to Teacher or Teacher to Administrator |
| Administrator with verified AAL2               | Invite, inspect and revoke Teachers and Teacher invitations                                                                   |
| Privileged actor without AAL2                  | Complete current MFA before management                                                                                        |
| Teacher, uninvited account or anonymous caller | No staff administration                                                                                                       |

The backend evaluates the actor's Membership in each target School. An Owner
Membership in one School does not widen an Administrator Membership elsewhere.
Self-management, Owner targets, foreign targets and reactivation of revoked
Memberships are excluded. The browser continues to reject ambiguous multiple
current-School contexts; it does not silently select a School.

## Revision and audit contract

The forward migration adds these authenticated-only RPCs:

```sql
change_membership_role(
  workspace_id uuid, profile_id uuid, role text,
  expected_role_revision bigint
) returns table (code text);

revoke_membership(
  workspace_id uuid, profile_id uuid,
  expected_role_revision bigint
) returns table (code text);
```

Requests require the revision of the target shown during review. The exact
public parsers accept positive JavaScript safe integers; SQL retains `bigint`
storage and rejects unsupported revisions or increments. Management lists
include `role_revision`, mapped to the product's `roleRevision` number.

Each mutation authorizes before looking up its target, locks the exact target,
then rechecks live actor, session and MFA authority after any wait. It evaluates
the locked target's role, active state and expected revision before changing
anything. A stale authorized target returns `membership_revision_conflict`.
Successful role change returns `membership_role_changed`; successful revocation
returns `membership_revoked`. Replaying an obsolete revision never applies a
second mutation or writes a second success audit event.

Role changes increment revision once and retain active state. Their audit row
records the School, actor, subject, session, previous and new role, and previous
and new revision. Typed constraints restrict these four transition fields to
the role-change event. The Membership update and append-only audit insert use
the same fresh timestamp and transaction. An audit failure rolls back the
Membership update. Administrator revocation records `administrator_action`;
historical `owner_action` records are preserved.

The migration drops the obsolete two-argument revocation RPC without `CASCADE`.
Old callers cannot bypass confirmation revisions. It also recreates the staff
selector with its extended return shape and explicit restricted grants. The
seven published migrations and canonical synthetic fixture rows remain
unchanged. Unexpected in-place dependencies must be reconciled explicitly; they
are not silently removed.

## Invitation lifetime

An invitation whose authorized begin operation committed remains a School grant
until its own revocation or expiry. Later inviter downgrade or revocation blocks
new requests and authenticated begin replay, while service delivery and verified
recipient acceptance may finish the existing grant. There is no cascading
invalidation or issuer-version protocol. Explicit invitation revocation still
prevents subsequent acceptance.

Administrator Teacher-only restrictions apply to every invitation authorization
check, management-list row, target revocation check and expired-invitation
cleanup. An Administrator cannot inspect or expire a hidden Administrator
invitation through a Teacher request. Existing uncertain delivery, recipient
binding and exactly-once Membership acceptance behavior remain in force.

## Browser authority and freshness

Invitation, invitation revocation, Membership revocation and role change each
capture the visible initiating account before awaiting. The port holds its
verified token in a short-lived, purpose-restricted handle. Every management
write uses that token; an account switch cannot redirect the action to the new
account. Missing, expired or wrong-purpose handles fail closed and are released
after the operation. No provider cache cleanup or persistent authority marker is
introduced.

Role and revocation confirmations retain the selected target and revision in
private controller state. The browser refreshes authority before confirmation,
while visible at a fifteen-second cadence, and on refocus. Unchanged reads do
not republish the view. Changed target facts cancel stale confirmation; changed
actor authority removes obsolete controls and protected data. Quiet refreshes
do not interrupt callback, password, recovery, MFA or mutation ceremonies.
Read-only authority operations have bounded waits; provider-owned SDK refresh
and cancellation semantics remain separate from application result handling.

Unknown mutation outcomes offer a fresh read, never an automatic mutation
replay. A confirmed role-change receipt describes the completed action in past
tense: a subsequent legitimate mutation may already have changed or revoked the
target by the time the refreshed list arrives. A target denial does not imply
that the still-authorized actor lost School access.

## Acceptance evidence

The candidate contains focused contracts, controller, view, installed-SDK and
port regressions; SQL permission, revision, audit and post-lock checks; and a
two-connection lock suite. The existing full-stack CI job also contains real
provider journeys across two Schools and an actual browser using the current
application entrypoint against that disposable backend. The browser signs in
through the real UI, performs MFA, and observes downgrade and revocation without
reloading. Its bundle and disposable credentials remain in memory; provider
traces and screenshots are not retained.

Those database, competing-commit and actual-backend browser checks require CI's
disposable stack. Source inspection and synthetic HTTP tests do not establish
their execution. Exact local checks, independent reviews and rendered synthetic
preview evidence are recorded in the candidate receipt; actual CI results must
be attached to the reviewed commit before merge.

Hosted schema inventory, migration application and deployment remain separate
gates. This slice does not implement School settings, Teacher Test operations,
ownership transfer, Membership reactivation or general multiple-School browser
selection. Existing PKCE recovery isolation and bound logout guarantees remain
documented in [auth integration evidence](auth-integration-evidence.md).
