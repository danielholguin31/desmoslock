# Edge functions: student-session-*

Surface: supabase/functions/student-session-{challenge,join,read,reconnect,forfeit,evidence}. Verification status on the Mac Mini: **not exercised**.

Six thin handlers behind the desktop Student flow. All `verify_jwt = false`. Callers authenticate with device proofs, not staff JWTs.

Source: `supabase/functions/student-session-challenge/index.ts`, `supabase/functions/student-session-join/index.ts`, `supabase/functions/student-session-read/index.ts`, `supabase/functions/student-session-reconnect/index.ts`, `supabase/functions/student-session-forfeit/index.ts`, `supabase/functions/student-session-evidence/index.ts`, `supabase/functions/_shared/student-session-service.ts`.

## Sub-features

- `student-session-challenge`, `student-session-join`: admission (`handleStudentChallengeRequest`, `handleStudentJoinRequest` in `_shared/student-session-service.ts`).
- `student-session-read`, `student-session-reconnect`, `student-session-forfeit`: maintenance.
- `student-session-evidence`: protection evidence (`_shared/student-protection-evidence.ts`).

## How to get to it (user POV)

Desktop → Join Test and everything after.

## Driving it with verify-desmoslock

The CLI only proves the desktop fails closed when these endpoints are missing (see `desktop-student-join`). Tested by each `index.test.ts` (`npm run test:edge`) and `tests/acceptance/student-session-interop.test.mjs`; not run here.

## Gotchas

- The route names are fixed in the service. Public callers cannot choose which RPC runs (`student-session-service.ts` ~L305).
