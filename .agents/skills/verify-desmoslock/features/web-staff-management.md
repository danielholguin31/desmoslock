# Staff management (invitations, roles, revocation)

Surface: apps/web + supabase/functions/staff-invitations. Verification status on the Mac Mini: **not exercised**.

Owners and administrators manage school staff: invite, revoke pending invitations, change roles, and revoke access. The UI presents roles as Administrator and Teacher. Storage uses `owner | admin | teacher` (`StorageStaffRole`) and the controller maps them to `owner | administrator | teacher` (`StaffRole`, `staff-auth-controller.ts` L20–24).

Source: `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/staff-auth-controller.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`, `supabase/functions/staff-invitations/index.ts`.

## Sub-features

- `Manage staff access` / `Manage staff invitations` → `Invite Administrator` / `Invite Teacher` (`Staff email`, `Your name`) → POST `/functions/v1/staff-invitations` → `Invitation created` / `Invitation not created` / `Email dispatch unconfirmed` / `Email provider rejected dispatch`.
- `Revoke pending invitation` → `Review pending invitation revocation` → `Confirm pending invitation revocation` (RPC `revoke_staff_invitation`).
- `Review role change` → `Confirm staff role change` (RPC `change_membership_role`).
- `Revoke staff access` → `Confirm staff access revocation` (RPC `revoke_membership`).
- `Refresh staff`; the list comes from the RPC `current_manageable_staff_invitations`.

## How to get to it (user POV)

Signed-in owner or administrator at `aal2` → staff management section.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Unit coverage: `apps/web/tests/staff-membership-controller.test.ts` and `apps/web/tests/staff-membership-sdk-authority.test.ts`; DB lock test `npm run test:staff-auth:locks`.

## Gotchas

- An administrator may manage only teachers. An owner may also manage administrators (`staff-auth-view.ts` ~L530–541, `staff-auth-controller.ts` ~L3684–3703).
