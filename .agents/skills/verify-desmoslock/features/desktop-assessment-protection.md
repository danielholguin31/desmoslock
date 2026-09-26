# Assessment protection (AAC lockdown) and emergency exit

Surface: apps/desktop. Verification status on the Mac Mini: **not exercised; idle state observed**.

`Start assessment` runs preflight, engages native macOS Automatic Assessment Configuration through `aac-protection.node`, registers the emergency shortcut, attaches the calculator, and reports protection events to the backend.

Source: `apps/desktop/src/main/assessment-protection-coordinator.ts`, `apps/desktop/src/main/native-protection-adapter.ts`, `apps/desktop/native/aac-protection.mm`, `apps/desktop/src/assessment-protection-view-state.ts`, `apps/desktop/src/student-session-view.ts`, `apps/desktop/src/main.ts`.

## Sub-features

- Toolbar: `#protection-status` (`Protection not started`, `Checking protection`, `Starting protection`, `Ending protection`, `Assessment protection ended`, `Protection status unconfirmed`); `[data-action="start-assessment"]`; `[data-action="review-emergency"]` (aria `Review emergency exit`).
- Emergency: global shortcut `Control+Alt+Shift+E` (`main.ts`) or the button → `End assessment?` → `End & leave` (`confirm-emergency`) or `Cancel` (`cancel-emergency`).
- Category rows `[data-protection-category]`: `aac`, `shortcuts`, `applications`, `persistence`, `windowNetwork`.
- Local end triggers: minimize, hide, leaving full screen, suspend/resume, display changes, and window loss (`main.ts`).
- Native: `AEAssessmentSession` and an application allowlist via `NSWorkspace` (`apps/desktop/native/aac-protection.mm`).

## How to get to it (user POV)

Desktop app → admitted session (`Session confirmed`) → `Start assessment`.

## Driving it with verify-desmoslock

Not driven. It requires an admitted session, and engaging real AAC would lock this Mac's desktop. `desktop` only observes the idle state: `protection.phase: "idle"` and every category `pending` in `desktop/join-attempt.json`. Whether this unsigned dev build can engage AAC is **unverified**. Coverage: `apps/desktop/tests/assessment-protection-coordinator.test.ts` and `tests/acceptance/desktop-aac-protection.test.mjs` (not run here).

## Gotchas

- Never drive `Start assessment` on a shared machine. It is designed to take over the desktop.
