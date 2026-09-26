# Staff password recovery

Surface: apps/web + supabase/functions/account-recovery. Verification status on the Mac Mini: **not exercised**.

"Forgot password?" requests a recovery email through the `account-recovery` edge function. The emailed callback `/?auth=recovery&flow=<id>&state=<s>#token_hash=<h>&type=recovery` leads to `Set a new password`.

Source: `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/staff-recovery-flow-store.ts`, `apps/web/src/auth/staff-auth-callback.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`, `supabase/functions/account-recovery/index.ts`.

## Sub-features

- Request: action `request_recovery` (label `Forgot password?`) → `Requesting recovery` → notice "If that address can receive recovery email, instructions are on the way."
- Flow state is held in `staff-recovery-flow-store.ts` (uses `navigator.locks`).
- Completion: `New password` → `Update password` → `Password updated` / `Password not updated`, through the RPCs `begin_staff_password_recovery` and `finish_staff_password_recovery`.

## How to get to it (user POV)

Staff sign in → `Forgot password?`.

## Driving it with verify-desmoslock

Not driven by the CLI. Its request step POSTs to `/functions/v1/account-recovery` on the configured backend, and the loopback fixture would return 404. Adding it would need a stub for that function. Unit coverage: `apps/web/tests/staff-recovery-flow-store.test.ts` and `apps/web/tests/supabase-staff-password-authority.test.ts`.

## Gotchas

- The recovery callback shape is strict. Any extra query key is rejected (`staff-auth-callback.ts` ~L261–305).
