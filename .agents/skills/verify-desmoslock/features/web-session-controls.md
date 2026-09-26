# Staff session controls (sign out)

Surface: apps/web. Verification status on the Mac Mini: **not exercised**.

Signed-in staff can end this session or every session.

Source: `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/staff-auth-controller.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`.

## Sub-features

- `Session controls` region: `Sign out here` (RPC `revoke_current_staff_session`) and `Sign out everywhere` (RPC `revoke_all_current_user_staff_sessions`).
- States: `Signing out`, `Revoking all sessions`, `Sign out unconfirmed`, `Session revoked`, and `Session expired`.

## How to get to it (user POV)

Any signed-in staff view.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Unit coverage: `apps/web/tests/staff-auth-logout-sdk.test.ts`.

## Gotchas

- `Sign out unconfirmed` is a deliberate fail-closed state when revocation cannot be confirmed.
