# Staff TOTP second factor

Surface: apps/web. Verification status on the Mac Mini: **not exercised**.

Privileged staff need `aal2`. The staff auth controller drives TOTP enrollment (QR shown as an object URL) and verification.

Source: `apps/web/src/auth/staff-auth-controller.ts`, `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/supabase-staff-auth-adapter.ts`.

## Sub-features

- Enrollment: `Set up authenticator` → `Preparing authenticator` → `Scan and confirm authenticator` (img `Authenticator enrollment QR code`) → `Verify setup`.
- Challenge: `Choose an authenticator` / `Select authenticator` → `Authenticator code` → `Verifying authenticator`; rejection is `totp_rejected`.
- `Additional verification required` gates product views for roles other than teacher (`test-workspace-controller.ts` ~L468, `student-session-controller.ts` ~L578).

## How to get to it (user POV)

Reached automatically after sign-in when the account needs a second factor.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Unit coverage: `apps/web/tests/staff-auth-mfa-sdk.test.ts`.

## Gotchas

- The QR is ephemeral and never shows the provider enrollment URI (`TotpEnrollmentPresentation`, `staff-auth-controller.ts` ~L133).
