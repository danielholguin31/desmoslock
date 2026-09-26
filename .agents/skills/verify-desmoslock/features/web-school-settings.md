# School settings

Surface: apps/web. Verification status on the Mac Mini: **not exercised**.

View and rename the School. Staff who cannot edit see the read-only state.

Source: `apps/web/src/school-settings/school-settings-view.ts`, `apps/web/src/school-settings/school-settings-controller.ts`, `apps/web/src/auth/staff-product-access.ts`.

## Sub-features

- Section `School settings` with the field `School name`, button `Save`, and button `Refresh School details`.
- Conflict handling: `Review the updated School name`, `Keep my draft`, and `Use current name`.
- Handles: `data-school-settings-action`, `data-school-settings-status` (`read_only`).
- Edit permission: `canEdit` in `school-settings-controller.ts` ~L564.

## How to get to it (user POV)

Signed-in staff → product area `[data-protected-school-data]`.

## Driving it with verify-desmoslock

Needs an authenticated staff session with a school membership. The CLI has no local Supabase stack, so it cannot reach this view. The existing harness is `npm run test:staff-auth` (`tests/acceptance/staff-auth-composed.test.mjs`, `tests/acceptance/staff-membership-browser.mjs`), which requires Docker and a local Supabase. It was not run for this skill. Unit coverage: `apps/web/tests/school-settings-*.test.ts`.

## Gotchas

- All product data is cleared when authority changes (`protectedSchoolData.clear`, `staff-auth-application.ts`).
