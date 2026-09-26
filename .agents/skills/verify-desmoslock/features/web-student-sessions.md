# Teacher student-session management and client reports

Surface: apps/web. Verification status on the Mac Mini: **not exercised**.

Teacher-side coordination for an open Test: issue the join code students type into the desktop app, see and remove sessions, prepare private re-admission codes, and read protection reports sent by desktop clients (teacher/AAC coordination).

Source: `apps/web/src/student-sessions/student-session-view.ts`, `apps/web/src/student-sessions/student-session-controller.ts`, `apps/web/src/student-sessions/student-session-port.ts`.

## Sub-features

- `Join code issuance`: `Issue join code` → `Review join code issuance` → `Issued join code` (`Copy code`, `Hide code`); `Code issuance unconfirmed` → `Retry same issuance` (RPC `issue_test_join_code`).
- `Sessions in this Test` / `Refresh sessions` (RPC `current_test_student_sessions`); `Remove session` → `Session removal` (RPC `remove_student_session`).
- `Prepare private re-admission` → `Issued private re-admission code` / `Replace private re-admission code` (RPC `prepare_student_readmission`).
- `View client reports` → `Client reports` (RPC `current_student_protection_events`), with labels such as `Protection start reported`, `Prohibited application reported`, and `Emergency exit requested`; paging with `Newest reports` / `Older reports`.
- Handle: `data-student-session-action`.

## How to get to it (user POV)

Signed-in staff → an open Test → Student sessions.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Cross-surface interop: `tests/acceptance/student-session-interop.test.mjs` (local Supabase).

## Gotchas

- Roles allowed: teacher, administrator, and owner; roles other than teacher need `aal2` (`student-session-controller.ts` ~L578–583).
