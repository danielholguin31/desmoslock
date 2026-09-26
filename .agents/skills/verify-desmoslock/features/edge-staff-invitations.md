# Edge function: staff-invitations

Surface: supabase/functions/staff-invitations. Verification status on the Mac Mini: **not exercised**.

`POST /functions/v1/staff-invitations` creates a staff invitation and dispatches the invite email through Resend. The function checks that the action link is a `/auth/v1/verify?type=invite` link on the backend origin.

Source: `supabase/functions/staff-invitations/index.ts`, `supabase/functions/_shared/resend-invitation-transport.ts`.

## Sub-features

- `verify_jwt = true`; bearer JWT required (401 `authentication_required`); origin checked (403).
- Email transport: `supabase/functions/_shared/resend-invitation-transport.ts`.

## How to get to it (user POV)

Web → Manage staff invitations → Invite Administrator / Invite Teacher.

## Driving it with verify-desmoslock

Not driven. Tested by `supabase/functions/staff-invitations/index.test.ts` (`npm run test:edge`); not run here.

## Gotchas

- Dispatch outcomes map to the web states `Email dispatch unconfirmed` and `Email provider rejected dispatch`.
