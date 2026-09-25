# Test workspace (create, open, end Tests)

Surface: apps/web. Verification status on the Mac Mini: **not exercised**.

Staff create a Test (assessment), set its title, open it for students, and end it.

Source: `apps/web/src/test-workspace/test-workspace-view.ts`, `apps/web/src/test-workspace/test-workspace-controller.ts`, `apps/web/src/auth/supabase-staff-auth-port.ts`.

## Sub-features

- `Tests` list: `Newest Tests`, `Older Tests`, `Refresh Tests`, `Open Test`; action `select_test`.
- `Create a Test` / `Start a new Test` with `New Test title` → `Create Test` (RPC `create_school_test`); `Creation unconfirmed` → `Retry same creation`.
- `Test details`: `Test title` → `Save title` (RPC `update_test_title`); `Open` (RPC `open_test`); `End Test` → `Confirm end` (RPC `end_test`).
- States: `Draft`, `Opening`, `Open`, `Ending`, and `Ended`.
- Handles: `data-test-workspace-action`, `data-test-workspace-heading`, `data-test-workspace-status`, `data-test-workspace-tone`.

## How to get to it (user POV)

Signed-in staff (a teacher, or another role at `aal2`) → Tests.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Unit coverage: `apps/web/tests/test-workspace-*.test.ts`.

## Gotchas

- Reads use the RPCs `current_school_tests` and `current_school_test`.
