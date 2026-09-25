# Edge function: account-recovery

Surface: supabase/functions/account-recovery. Verification status on the Mac Mini: **not exercised**.

`POST /functions/v1/account-recovery` starts staff password recovery (PKCE S256 challenge, flow id, state) and sends the recovery email.

Source: `supabase/functions/account-recovery/index.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`.

## Sub-features

- OPTIONS preflight, POST only, origin checked; `verify_jwt = false`.
- Input: `codeChallenge`, `email`, `flowId`, `state` (`AccountRecoveryInput`).

## How to get to it (user POV)

Web → `Forgot password?`.

## Driving it with verify-desmoslock

Not driven. Tested by `supabase/functions/account-recovery/index.test.ts` (`npm run test:edge`); not run here.

## Gotchas

- The response does not reveal whether the email exists.
