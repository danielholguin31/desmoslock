# Staff invitation callback

Surface: apps/web. Verification status on the Mac Mini: **exercised (`web`), failure path only**.

Invitation links land on `/?auth=invite#token_hash=<hash>`. The URL is scrubbed to `/` and the page stays inert until the human clicks `Continue securely`. Then the SDK verifies the token, and a valid invitation leads to `Accept invitation` / `Create password`.

Source: `apps/web/src/index.html`, `apps/web/src/auth/staff-auth-callback.ts`, `apps/web/src/auth/staff-auth-view.ts`, `apps/web/src/auth/staff-auth-application.ts`.

## Sub-features

- Scrub and inert confirmation: heading and button `Continue securely`.
- In-flight heading: `Checking invitation`.
- Terminal failure headings: `Invitation unavailable` (mapped `otp_expired`), `Authentication temporarily unavailable`, and `Authentication link unavailable`.
- The success path (`Accept invitation`, `Accepting invitation`, `Invitation accepted`) calls the RPC `accept_staff_invitation` and is **not exercised**.

## How to get to it (user POV)

Click the invitation email link. It is built by `supabase/functions/staff-invitations` with `redirect_to` set to the app root.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs web` steps 05–06 use a fresh browser context with a synthetic 56-char token hash. They assert that the URL is `/` and the hash is absent from the DOM, click `Continue securely`, and expect `Invitation unavailable` from a stubbed `POST /auth/v1/verify` returning 400 `otp_expired`. Evidence: `web/05-invite-callback-scrubbed.png` and `web/06-invite-verify-failed-closed.png`.

## Gotchas

- Run this in a context with no prior sign-in state. Reusing the signed-in context left the view in another state and timed out.
- Reloading before confirmation loses the bearer by design (`Reopen your email`).
