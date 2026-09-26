# Student join with a Test code

Surface: apps/desktop. Verification status on the Mac Mini: **exercised (`desktop`), failure path only**.

A student types the 12-character Test join code from the teacher. The app registers the device and asks the backend to admit it (`student-session-challenge`, then `student-session-join`).

Source: `apps/desktop/src/student-session-view.ts`, `apps/desktop/src/main/student-session-coordinator.ts`, `apps/desktop/src/main/student-session-transport.ts`, `apps/desktop/src/main/student-session-crypto.ts`.

## Sub-features

- Form: label `Test join code`, input `#student-session-code`, submit `[data-action="submit-code"]` (`Join Test`).
- Validation: `parseStudentJoinCode`; the renderer error in `#student-session-code-error` reads "Enter the exact 12-character code. Use uppercase letters and numbers; I, L, O and U are not used."
- Phases (`.student-session[data-phase]`): `entry`, `joining`, `active`, `unconfirmed`, `unavailable`, `recovery_required`, `forfeited`.
- Success shows `Session confirmed` and the synthetic display name in `[data-session-identity]`.

## How to get to it (user POV)

Launch the desktop app → `Join a Test`.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs desktop` submits `bad` (renderer rejection) and then the synthetic `ABCDEFGHJKMN`, which goes through IPC to the loopback fixture on :43175. The fixture has no Student endpoints, so the view returns to `entry` with `pendingOperation: "join"` and "No session was joined…". Evidence: `desktop/02-malformed-code-rejected.png`, `desktop/03-join-against-local-fixture.png`, and `desktop/join-attempt.json`.

## Gotchas

- Successful admission needs the Student edge functions and a local Supabase (`tests/acceptance/desktop-student-session.test.mjs`, `npm run test:desktop:durability`). Not run.
