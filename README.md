# DesmosLock

The real Desmos graphing calculator, locked to the screen during a test.

The teacher signs in, starts a test, and reads out a 6-character class code. Students
open the app, type the code and their name — no accounts. When the teacher hits
**Lock all devices**, every joined machine is frozen full-screen on the calculator
and the teacher gets a live feed of anyone who tries to get out.

```
desmoslock/
├── server/     Node + Express + WebSocket. The offline-capable classroom server.
├── desktop/    Electron app. One binary, both roles (teacher console / student calculator).
├── web/        desmoslock.vercel.app — marketing site, pricing calculator, quote form
│   └── admin/  the school admin console
├── supabase/   schema.sql (core) + enterprise.sql (schools, seats, roles, quotes)
└── docs/       SUPABASE.md · OPERATIONS.md
```

The app ships **two backends** and remembers which you picked (landing screen →
*change*, then type `cloud` or a server address):

- **cloud** (default) — Supabase. Auth, Postgres + row-level security, realtime.
- **local** — the Node server in `server/`. Works on a classroom LAN with the
  internet down, which is why it still exists.

## Run it

```bash
npm run install:all     # once

npm run server          # terminal 1 — prints the LAN address students need
npm run app             # terminal 2 — the Electron app
```

The server prints something like `http://192.168.1.20:4000`. That's what students
put in the **Server address** field, and it's also where the landing page lives.
Everyone must be on the same network.

> On macOS, if you launch the app from a terminal inside VS Code, unset
> `ELECTRON_RUN_AS_NODE` first (`env -u ELECTRON_RUN_AS_NODE npm start`) — VS Code
> exports it and it makes Electron boot as plain Node.

## Using it

**Teacher** — Create an account (email + password), click **New test**, name it. The
page shows the class code, a live roster, and an activity feed. **Lock all devices**
freezes everyone; **Unlock all** or **End test** frees them. Individual students can
be released or removed from the roster.

**Student** — Enter the code and your name, and you get the calculator. When the
teacher locks, the window takes over every screen and stays there.

## What "locked" actually does

The lock lives in the Electron main process ([desktop/main.js](desktop/main.js)), not
in the page, so the renderer can't talk itself out of it.

- **Covers every display.** The calculator fills its display's full frame — menu bar
  and dock included. Every *other* monitor gets its own opaque blocker window at the
  same level, rebuilt automatically if a display is plugged in or unplugged mid-test.
- **Follows across Spaces.** All lock windows set "can join all Spaces", so swiping
  to another desktop shows the same lock rather than a clean screen.
- **Sits above everything** at `screen-saver` window level. Even if another app
  grabs key focus, none of it is visible or clickable underneath.
- **Watchdog every 300ms** re-focuses, re-covers, un-minimizes, and drags the window
  back out of native fullscreen if the OS pulls it in.
- **Swallows shortcuts** system-wide (`globalShortcut`) and again at the window
  (`before-input-event`): quit/close/hide, Cmd+Tab, Alt+Tab, **Ctrl+Arrow and F3
  (Spaces and Mission Control)**, Spotlight, screenshots, dev tools, F1–F12.
- **Refuses to quit or close** — window `close` and app `before-quit` are both
  cancelled, and each attempt is reported.
- **Blocks screen capture** via `setContentProtection(true)`.
- **Blocks all network** except `desmos.com` and the DesmosLock server.
- **Survives a force-quit.** The locked session is written to disk, so killing the
  app or rebooting reopens straight back into the locked calculator — with the
  student's graph restored, since work autosaves every few seconds.
- **Refuses to start on a busy machine.** Before a student can join, the app
  enumerates every open application and will not continue until all of them are
  quit. Anything launched mid-test is reported to the teacher by name.

Anything the OS lets through is *reported* rather than silently ignored, so the
teacher's feed shows: switched away, tried to quit, pressed a blocked shortcut,
locked the screen, changed displays, lost connection, used the override, exited
early. Each of those adds a flag next to that student's name.

### macOS specifics, and one thing that doesn't work

Coverage uses **simple fullscreen**, not kiosk mode. Kiosk (and native fullscreen)
parks the window in its own Space, which a three-finger swipe walks straight out of
— that was the hole in the first version.

I also tried entering kiosk purely to borrow its presentation options
(`DisableProcessSwitching` kills Cmd+Tab, `DisableForceQuit` kills Cmd+Opt+Esc) and
then dropping out of fullscreen. **It does not work**: measured on macOS 15, the
options are released on the way out of fullscreen (the display's `workArea` stays
949 of 982 rows), so it bought nothing but a two-second animation. It's removed.

What that leaves genuinely open:

- **Force Quit** and killing the app from the Dock or Activity Monitor. The hotkey
  is blocked and the app reboots back into the lock, but the process can be killed.
- **Cmd+Tab** can still move key focus. The other app is *not visible* — our windows
  cover every display in every Space — and focus is taken back within ~300ms with an
  alert to the teacher.
- **A phone or a second computer** is outside what any software lock can see.

Same envelope commercial lockdown browsers work in without a kernel extension. For
airtight, pair it with an MDM-managed kiosk profile.

### Getting out

Three ways, all of them loud:

1. **The ✕ Exit test button.** The only student-initiated exit from a live lock. It
   warns them that their test ends there, then marks them **forfeited** on the
   teacher's roster with a timestamp.
2. **The override code.** Six characters, shown only on the teacher's console.
   `Cmd/Ctrl+Alt+Shift+U`, enter it, and that one device unlocks — the teacher is
   told which student used it. Re-locking clears all releases.
3. **The teacher** — Unlock all, End test, or release one student from the roster.

If the server has been unreachable for 90 seconds, the override dialog also offers
**Force exit**, which releases the lock and queues a flagged report delivered as soon
as the connection is back. This exists so a dead server or a Wi-Fi outage can't leave
a student stuck on a frozen screen with no way out.

### Closing everything else

The gate uses `ps` on macOS/Linux and PowerShell on Windows rather than scripting the
window server, because the AppleScript route needs an Automation permission that a
student can simply decline — and a check you can decline is not a check. On a typical
machine it filters ~134 running `.app` processes down to the ~10 the student actually
has to quit, dropping system apps and per-app helpers.

It never kills anything. Terminating another app risks destroying unsaved work that
isn't ours to lose, so it refuses to start and names what's in the way.

## desmoslock.vercel.app

[web/](web/) is the landing page, deployed on Vercel from `vercel.json`
(`outputDirectory: web`, no build step). `/download/mac`, `/download/mac-intel`,
`/download/windows` and `/download/linux` redirect to the newest GitHub Release asset,
hosted in the public
[`danielholguin31/desmoslock-releases`](https://github.com/danielholguin31/desmoslock-releases)
repository, so customer downloads stay public if this source repository becomes
private.

The release workflow builds macOS separately from Windows and Linux. A manual run
builds and verifies without publishing. A `v*` tag stages a draft in the public
binary repository, redownloads and verifies both macOS builds on a fresh runner,
then publishes only after every Gatekeeper check passes. Start with the
[macOS release runbook](docs/MACOS_RELEASE.md); a release tag is the final step,
not the first one.

The macOS job requires Developer ID signing, hardened runtime, notarization, and a
stapled ticket. It refuses to build an unsigned fallback. Install a published Mac
release by opening the DMG, dragging DesmosLock to Applications, and launching it
normally from Applications.

Windows publisher signing is outside this macOS repair, so SmartScreen may still
warn for the Windows installer.

Do not deploy the redirect changes until Daniel has created the public repository,
mirrored the v1.0.0 assets, and approved a signed v1.0.1 dry run. Do not make this
source repository private until every website route works without GitHub
authentication and the downloaded files match the published SHA-256 values.

## Pricing and licensing

**$8 per student per year**, billed to the school. Teachers never see a bill and
students never make an account. A student counts once per licence year however
many tests they sit.

| | Per student / year |
| --- | --- |
| Up to 999 students | $8.00 |
| 1,000 – 4,999 | $7.00 |
| 5,000+ | $6.00 |

2-year terms take 5% off, 3-year terms 10%. The calculator on the site and the
admin console both import [`web/pricing.js`](web/pricing.js), so the number a
district sees on the website is the number their console shows later.

New schools start on a 30-day, 50-seat trial. Quotes land in `quote_requests`,
which nobody can read through the API — see
[docs/OPERATIONS.md](docs/OPERATIONS.md) for reading them and activating a paid
licence.

## Admin console

`/admin` — a browser app for whoever owns the contract.

- **Seats** used against purchased, with the overage called out
- **Teachers** — invite by email, promote to admin, remove; pending invitations
- **Tests** — every test run across the school, read-only
- **Licence & billing** — term, price per student, billing contact, PO number
- **Settings** — school name and the email domains that auto-join

Three roles. Owners and admins manage people and billing; teachers see the
roster and nothing else. Teachers join either by invitation or by signing up
with an address on a verified school domain.

The boundary is the database, not the interface. Hiding the billing tab from a
teacher is a courtesy; the reason they cannot change billing is that
`update_school_profile()` refuses them. Two bugs found while testing this are
worth knowing about if you extend it — both are documented in
[docs/SUPABASE.md](docs/SUPABASE.md).

## Supabase

Live on project `thebestprojectofall`. The schema is applied and the app defaults to it.

**Two dashboard toggles are still needed before students can join**, both under
Authentication → Providers: turn **Anonymous sign-ins on**, and **Confirm email off**
(or configure SMTP). Until then the app says exactly that instead of failing vaguely.
Details, the security model, and the two gotchas that cost real time are in
[docs/SUPABASE.md](docs/SUPABASE.md).

`.mcp.json` configures the Supabase MCP server for this project; authenticate it with
`/mcp` in an interactive terminal.

## Notes

- The Desmos API key in [desktop/renderer/app.js](desktop/renderer/app.js#L6) is
  Desmos's public demo key. For classroom use, request your own free key at
  <https://www.desmos.com/api>.
- Passwords are bcrypt-hashed by the local server, which stores everything in
  `server/data/db.json` — delete that file to reset. In cloud mode, Supabase Auth
  handles it.
- The publishable key in [desktop/renderer/config.js](desktop/renderer/config.js) is
  meant to ship in clients and grants nothing on its own. There is no secret key in
  this app and there must never be one — anything holding a service-role key bypasses
  every row-level security policy.
- `npm --prefix desktop run build:vendor` rebuilds the bundled supabase-js after a
  dependency bump.
- The server speaks plain HTTP, which is fine on a classroom LAN. Put it behind TLS
  before exposing it to the open internet.
