# Web shell and backend status badge

Surface: apps/web. Verification status on the Mac Mini: **exercised (`web`)**.

The static staff web app served from `apps/web/dist`. On boot it scrubs callback credentials from the address bar in an inline bootstrap script, then mounts the staff auth application and probes backend health.

Source: `apps/web/src/index.html`, `apps/web/src/main.ts`, `apps/web/src/backend-status.ts`, `apps/web/src/public-config.ts`, `scripts/serve-static.mjs`.

## Sub-features

- Inline bootstrap scrubs `access_token|auth|code|error*|flow|refresh_token|sb_flow_id|state|token(_hash)|type` from the query and fragment before any other network request (`apps/web/src/index.html`).
- Backend status badge `[data-v2-status]` with `data-backend-status` (`apps/web/src/backend-status.ts`).
- Public build-time configuration: environment, backend URL, web origin, publishable key (`apps/web/src/public-config.ts`, `scripts/build-app.mjs`).
- Lifecycle: pagehide/pageshow suspend and resume, plus a 15 s membership refresh while the page is visible (`registerWebApplicationLifecycle` in `apps/web/src/main.ts`).

## How to get to it (user POV)

Open the web origin root `/`. The only route is the path `/`. Every view is state-driven inside `[data-staff-auth-root]` and `[data-protected-school-data]`.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs web` step 01 waits for `[data-v2-status][data-backend-status="ready"]`; the text is "Synthetic backend ready". Evidence: `web/01-staff-sign-in.png` and `web/network.json`.

## Gotchas

- The health fixture (`scripts/serve-backend-health-fixture.mjs`) serves only `GET /functions/v1/health`. Every other path returns 404.
- `vercel.json` hosting config is not exercised.
