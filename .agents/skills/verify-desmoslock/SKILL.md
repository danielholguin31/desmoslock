---
name: verify-desmoslock
description: "Verify DesmosLock v2 by driving the real staff web app (apps/web) in Chromium and the real built Electron desktop app (apps/desktop) through Playwright, local and synthetic only, with evidence in .verify-evidence/. Use after changes to apps/web, apps/desktop, or the Electron harness to prove user-visible behavior."
---

# Verify DesmosLock v2

`scripts/verify-desmoslock.mjs` builds the v2 apps with synthetic local configuration, drives them the way a user would, and writes evidence to `.verify-evidence/<run-id>/<surface>/` at the repo root. That directory is gitignored. Never commit evidence.

Boundaries: loopback only (`127.0.0.1`), synthetic credentials, no hosted Supabase or Vercel, no `.env` reads, no signing, packaging, or release. Legacy top-level `desktop/`, `server/`, and `web/` are v1 and must never be run.

## What was proven on this Mac

Mac Mini, macOS 26.3 arm64, Node 24.20.0, npm 11.12.1, Electron devDependency `^43.7.0`. `all` passed end to end on 2026-09-25.

| Surface                                                                                          | Command          | Proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                        |
| ------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Staff web (`apps/web/dist` in headless Chromium)                                                 | `web`            | Boot and health badge "Synthetic backend ready"; password sign-in → `Verify your email` → `Resend verification email` → `Verification email sent`; invitation callback scrubbed to `/` with the token absent from the DOM → `Continue securely` → `Invitation unavailable`. Zero non-loopback requests.                                                                                                                                                                                                            | `web/01…06-*.png`, `web/network.json`, `web/console.log`, `web/steps.json`                      |
| Desktop (real built `apps/desktop`, launched by Playwright `_electron`)                          | `desktop`        | Trusted shell at `desmoslock-app://shell/index.html` with contextIsolation, sandbox, and no nodeIntegration; renderer has no `process`/`require`; preload bridge keys; legacy lock request refused `native-protection-unavailable`; fresh profile in `entry` (native durable store opened); malformed code rejected in the renderer and at the bridge; a synthetic well-formed code goes over IPC to the loopback fixture and fails closed back to `entry` with no admission. Zero non-loopback renderer requests. | `desktop/01…03-*.png`, `desktop/shell.json`, `desktop/bridge.json`, `desktop/join-attempt.json` |
| Repo Electron suite (`playwright.electron.config.ts`, `tests/e2e/electron/**` with its fixtures) | `electron-suite` | 9/9 passed: foundation, session-denial policy, calculator isolation (5), calculator startup, calculator close.                                                                                                                                                                                                                                                                                                                                                                                                     | `electron-suite/playwright.log`                                                                 |

Not proven here: anything behind a staff session (MFA, staff management, school settings, Tests, teacher student-session management), successful Student admission, `Start assessment` / AAC lockdown / emergency exit, evidence delivery, and the real edge functions. Each needs a local Supabase (Docker) or would lock the machine's desktop. [features/README.md](features/README.md) marks each feature exercised or not.

## Launch

From the repo root:

```bash
export PATH="$HOME/.hermes/cache/scratch/node24/node-v24.20.0-darwin-arm64/bin:$PATH"   # Node 24.20.0
npm ci                                                   # once
S=.agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs
node $S doctor          # read-only readiness check
node $S build           # packages + web + desktop with synthetic local config
node $S web             # or: desktop | electron-suite
node $S all             # build, then web + desktop + electron-suite
```

`build` uses the same synthetic public configuration as `npm run test:web` and `npm run test:electron`:

- **web:** backend `http://127.0.0.1:43174`, origin `http://127.0.0.1:43173`, and the repo's placeholder publishable key.
- **desktop:** backend `http://127.0.0.1:43175`.

Ready signals:

- **web:** `[data-v2-status][data-backend-status="ready"]`.
- **desktop:** heading `DesmosLock` and `.student-session[data-phase="entry"]`.

The exit code is 0 only when every selected surface passes. Each run writes `summary.json`.

## Doctor

`node $S doctor` is read-only. It checks:

- Node `v24.20.0` and npm 11.x
- `@playwright/test` importable and its Chromium installed
- the Electron devDependency is present
- built `apps/web/dist` and `apps/desktop/dist`, including the native addons
- the platform is darwin
- ports 43173–43175 are free

A busy port means another instance is running. The drives refuse to start rather than drive an instance they did not start.

## Drive

- **web:** starts `scripts/serve-static.mjs apps/web/dist 43173` and `scripts/serve-backend-health-fixture.mjs 43174`, then drives Chromium by role, label, and data handle. A context-wide route guard aborts every non-loopback request and answers every `/auth/v1/*` call with a synthetic stub:
  - `token?grant_type=password` returns 400 `email_not_confirmed`
  - `resend` returns 200
  - `verify` returns 400 `otp_expired`
  - anything else returns 500

  Nothing is forwarded.

- **desktop:** starts the health fixture on 43175 and launches `apps/desktop` with `createElectronLaunchProfile()` (minimal env: HOME and TMPDIR) and a temporary `--user-data-dir`, through `acquireReadyElectronApplication` from `scripts/production-desktop-resource-safety.mjs`. It uses the same launch boundary as `tests/e2e/electron/foundation.spec.ts`. On any platform other than darwin it fails closed: the native durable store is macOS-only, and the shell would open in `recovery_required`.
- **electron-suite:** `npx playwright test --config playwright.electron.config.ts --output <evidence>/test-results`.

The selectors and IPC channels for every feature are in `features/`.

## Evidence

Proof standard: drive the real user path, not internal setters. Capture each action and the state it produced, and check side effects: `network.json` lists every request and every blocked one. Mocks are used only at the Supabase Auth boundary. Evidence survives cleanup.

## Cleanup

The CLI stops only the fixture processes it spawned (by pid), closes Electron with `closeElectronApplicationCooperatively`, and deletes its temporary user-data directory. It never kills by process name. Delete old runs with `rm -rf .verify-evidence/run-*` when they are no longer needed.

## Feature map

See [features/README.md](features/README.md): 22 features across apps/web, apps/desktop, and supabase/functions, with source paths and exercised or not-exercised status.
