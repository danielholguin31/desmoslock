# Desktop trusted shell window

Surface: apps/desktop. Verification status on the Mac Mini: **exercised (`desktop`, `electron-suite`)**.

A single hardened Electron `BrowserWindow` that loads `desmoslock-app://shell/index.html` from an in-memory static protocol with a strict CSP and deny-by-default session policy.

Source: `apps/desktop/src/main.ts`, `apps/desktop/src/main/hardened-web-preferences.ts`, `apps/desktop/src/main/static-protocol.ts`, `apps/desktop/src/main/session-denial-policy.ts`, `apps/desktop/src/main/packaged-launch-policy.ts`, `apps/desktop/src/main/electron-protection-window.ts`.

## Sub-features

- Window: 1080×720 (min 860×560), shown only after load (`createWindow`, `apps/desktop/src/main.ts`).
- Hardened web preferences: contextIsolation, sandbox, and no nodeIntegration (`main/hardened-web-preferences.ts`).
- Static protocol and CSP: `connect-src` limited to the configured backend (`main/static-protocol.ts`, `main.ts`).
- Deny-by-default permissions, popups, navigation, and external protocols (`main/session-denial-policy.ts`).
- Single-instance lock; a second launch focuses the window or ends active protection (`app.on("second-instance")`).
- Packaged launch policy rejects forbidden switches with exit 78 (`main/packaged-launch-policy.ts`).
- View menu zoom: `CommandOrControl+0`, `CommandOrControl+Plus`, `CommandOrControl+-` (`main/electron-protection-window.ts` ~L461–480). **Not exercised.**

## How to get to it (user POV)

Launch the DesmosLock desktop app.

## Driving it with verify-desmoslock

`node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs desktop` launches `apps/desktop` via Playwright `_electron`, using `scripts/electron-launch-profile.mjs` and an isolated `--user-data-dir`. It asserts the shell URL and hardened preferences and records renderer requests that are not loopback (must be none). Evidence: `desktop/shell.json` and `desktop/01-student-entry.png`. `node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs electron-suite` runs `tests/e2e/electron/foundation.spec.ts` and `session-denial-policy.spec.ts`.

## Gotchas

- The packaged launch policy applies only when `app.isPackaged`. This skill runs the unpackaged dev build and never signs or packages.
- Close with `closeElectronApplicationCooperatively`, never by process name.
