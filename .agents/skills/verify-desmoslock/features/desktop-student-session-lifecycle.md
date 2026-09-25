# Student session retry, refresh, leave, and re-admission

Surface: apps/desktop. Verification status on the Mac Mini: **not exercised**.

After admission, a student can refresh or retry an unconfirmed attempt, leave (forfeit) the session, or restore one with a teacher's private re-admission code.

Source: `apps/desktop/src/student-session-view.ts`, `apps/desktop/src/main/student-session-coordinator.ts`, `apps/desktop/src/main/student-session-transport.ts`.

## Sub-features

- Buttons `[data-action]`: `retry` (`Retry saved attempt`), `refresh` (`Refresh session`), `review-forfeit` (`Leave session`) → review `Leave this session?` → `confirm-review`/`cancel-review`.
- Recovery: `open-recovery` (`Use private re-admission code`) → label `Private re-admission code` → `Review recovery` → `Restore session`; `cancel-recovery`.
- Backend calls: `student-session-read`, `student-session-reconnect`, `student-session-forfeit`.

## How to get to it (user POV)

Desktop app with a saved session (after a join).

## Driving it with verify-desmoslock

Not driven: needs an admitted session from a local Supabase. Unit coverage: `apps/desktop/tests/student-session-view.test.ts` and `student-session-coordinator.test.ts`.

## Gotchas

- Every review is bound to the snapshot `revision`. A stale review disables confirm ("The session changed…").
