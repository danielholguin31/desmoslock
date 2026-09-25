# Protection evidence delivery

Surface: apps/desktop + supabase/functions/student-session-evidence. Verification status on the Mac Mini: **not exercised**.

Every 15 s, the main process refreshes protection when needed and flushes queued protection evidence to `student-session-evidence`. Teachers read that evidence as client reports.

Source: `apps/desktop/src/main.ts`, `apps/desktop/src/main/student-session-transport.ts`, `supabase/functions/student-session-evidence/index.ts`, `supabase/functions/_shared/student-protection-evidence.ts`.

## Sub-features

- Timer: `maintenanceTimer` in `main.ts` (`student.flushEvidence()`).
- Transport: `${origin}/functions/v1/student-session-evidence`, 16 KiB request cap (`main/student-session-transport.ts` ~L193–204).
- Server verification: Ed25519 device proof (`supabase/functions/_shared/student-protection-evidence*.ts`).

## How to get to it (user POV)

Not user-visible. It surfaces on the web as `View client reports`.

## Driving it with verify-desmoslock

Not driven: no admitted session and no local Supabase. Coverage: `apps/desktop/tests/student-session-transport.test.ts` and `supabase/functions/student-session-evidence/index.test.ts` (`npm run test:edge`, which needs Deno).

## Gotchas

- A persistence failure during flush forces a local end (`persistence_unavailable`).
