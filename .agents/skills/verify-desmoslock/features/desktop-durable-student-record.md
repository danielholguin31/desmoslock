# Durable local Student record

Surface: apps/desktop. Verification status on the Mac Mini: **indirectly exercised (`desktop`)**.

Student session state lives in an owned directory `<userData>/student-session`, backed by a native store (`durable-record.node`) and encrypted with Electron `safeStorage`. It supports macOS only. On other platforms the shell opens in `recovery_required`.

Source: `apps/desktop/src/main/student-session-store.ts`, `apps/desktop/native/durable-record.c`, `apps/desktop/src/main.ts`.

## Sub-features

- Store: `createStudentSessionStore` / `openNativeStudentRecordStore` (`main/student-session-store.ts`), native `apps/desktop/native/durable-record.c`.
- Encryption: `safeStorage.encryptString` / `decryptString` (`main.ts` `initializeStudentSession`).

## How to get to it (user POV)

Not user-visible. It shows up as the starting phase: `entry` on macOS with a fresh profile.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs desktop` uses a fresh temporary `--user-data-dir` and asserts `admission.phase === "entry"`, which is only reachable when the native store opened (`tests/e2e/electron/foundation.spec.ts` asserts the same). The directory is deleted in cleanup.

## Gotchas

- Durability and crash semantics are covered by `npm run test:desktop:durability`. That suite was not run here.
