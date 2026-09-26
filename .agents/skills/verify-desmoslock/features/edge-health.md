# Edge function: health

Surface: supabase/functions/health. Verification status on the Mac Mini: **fixture only**.

`GET /functions/v1/health` reports whether the backend baseline is ready. Both apps call it at boot to set their status badge.

Source: `supabase/functions/health/index.ts`, `scripts/serve-backend-health-fixture.mjs`, `supabase/config.toml`.

## Sub-features

- GET only (405 otherwise); `verify_jwt = false` (`supabase/config.toml`).
- Response fields in the fixture: `service`, `status`, `schemaGeneration`, `fixtureVersion`, `fixtureDigest`, `fixtureValid`, `capabilities`.

## How to get to it (user POV)

Automatic on app boot.

## Driving it with verify-desmoslock

The CLI serves `scripts/serve-backend-health-fixture.mjs`, which mimics the ready response, not the real function. The real handler is tested by `supabase/functions/health/index.test.ts` (`npm run test:edge`, which needs Deno); not run here.

## Gotchas

- The fixture proves the client contract only. It does not show that the real function probes Postgres correctly.
