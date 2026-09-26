# Desktop preload bridge and IPC channels

Surface: apps/desktop. Verification status on the Mac Mini: **exercised (`desktop`), in part**.

The preload exposes one frozen API, `window.desmoslockDesktop` (version `2.0.0`). Every call is shape-checked in the renderer and again in main (`student-session-ipc.ts`) before it reaches the coordinator.

Source: `apps/desktop/src/preload.ts`, `apps/desktop/src/trusted-bridge.ts`, `apps/desktop/src/main/student-session-ipc.ts`, `apps/desktop/src/main.ts`.

## Sub-features

- IPC channels (`trusted-bridge.ts`): `desmoslock:assessment:request-lock` (always answers `{ok:false, reason:"native-protection-unavailable"}`), `desmoslock:student:read-view`, `:join`, `:targeted-readmission`, `:retry`, `:refresh`, `:forfeit`, `desmoslock:assessment:start`, `:emergency-review`, `:emergency-cancel`, `:emergency-confirm`; push channel `desmoslock:student:view-changed`.
- Bridge methods: `readStudentSessionView`, `joinTest`, `beginTargetedReadmission`, `retryStudentSession`, `refreshStudentSession`, `forfeitStudentSession`, `startAssessment`, `reviewEmergencyEnd`, `cancelEmergencyEnd`, `confirmEmergencyEnd`, `onStudentSessionViewChanged`, `requestAssessmentLock`.
- Main-side sender checks: only the current trusted frame and generation may call (`student-session-ipc.ts`, `isTrustedWindow` in `main.ts`).

## How to get to it (user POV)

Not user-visible. The renderer UI calls it.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs desktop` reads the bridge keys, confirms `process`/`require` are undefined in the renderer, calls `requestAssessmentLock` (expects the refusal), `readStudentSessionView` (expects `entry`), and `joinTest({code:"not-a-code"})` (expects `null`). Evidence: `desktop/bridge.json`.

## Gotchas

- `startAssessment`, the emergency channels, readmission, retry, refresh, and forfeit were **not** driven. They need an admitted session.
