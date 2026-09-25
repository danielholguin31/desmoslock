# Staff password sign-in and email verification

Surface: apps/web. Verification status on the Mac Mini: **exercised (`web`), with synthetic Auth stubs**.

Email and password sign-in through supabase-js. An unconfirmed email routes to "Verify your email" with a resend action.

Source: `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/staff-auth-controller.ts`, `apps/web/src/auth/supabase-staff-auth-adapter.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`, `apps/web/src/auth/staff-auth-callback.ts`, `tests/e2e/web/foundation.spec.ts`.

## Sub-features

- Form: `getByLabel("Email")`, `getByLabel("Password")`, and the button `Sign in`.
- Unconfirmed email → heading `Verify your email` → button `Resend verification email` → heading `Verification email sent`.
- The resend `redirect_to` is `/?auth=email-verification&sb_flow_id=<id>`, and the PKCE callback is parsed in `staff-auth-callback.ts`.
- The PKCE exchange on return (`Checking verification link` → terminal states) is covered by `tests/e2e/web/foundation.spec.ts`, not by this CLI.

## How to get to it (user POV)

Land on `/` → "Staff sign in" → enter email and password → Sign in.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs web` steps 02–04. The stubs answer `POST /auth/v1/token?grant_type=password` with 400 `email_not_confirmed` and `POST /auth/v1/resend` with 200. Evidence: `web/02-credentials-filled.png`, `web/03-verify-your-email.png`, and `web/04-verification-email-sent.png`.

## Gotchas

- Without the stubs, a sign-in would go to the loopback health fixture and get a 404, not a hosted service.
- A successful sign-in, a membership read, and product access are not reachable without a local Supabase.
