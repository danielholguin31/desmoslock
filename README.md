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
├── web/        Cloudflare Pages site — marketing, pricing, quote form, redirects
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

The native screen cover lives in the Electron main process
([desktop/main.js](desktop/main.js)). The renderer requests lock transitions through
the preload bridge; the separate renderer trust caveat is recorded in
[docs/MACOS_RELEASE.md](docs/MACOS_RELEASE.md#separate-renderer-security-follow-up).

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
- **Restores on a later manual launch.** The locked session is written to disk, so a
  manual relaunch after a force-quit or reboot re-engages the saved lock before
  network or calculator loading and restores the autosaved graph. DesmosLock does
  not install a login item or automatically relaunch itself.
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
  is blocked, but the process can be killed; the lock returns when DesmosLock is
  manually launched again.
- **Cmd+Tab** can still move key focus. The other app is *not visible* — our windows
  cover every display in every Space — and focus is taken back within ~300ms with an
  alert to the teacher.
- **A phone or a second computer** is outside what any software lock can see.

Same envelope commercial lockdown browsers work in without a kernel extension.
Managed-device deployment is a separate, unverified workstream and is not part of
the public release claim.

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

## Website and downloads

[web/](web/) is a static Cloudflare Pages site with no Functions, bindings, or
server-side secrets. [`web/_redirects`](web/_redirects) sends the four download routes
and `/releases` to the public
[`desmoslock/desmoslock-releases`](https://github.com/desmoslock/desmoslock-releases)
repository. [`web/_headers`](web/_headers) preserves the site's security headers.
The 13-file deploy tree also includes a static 404 page and an advisory `robots.txt`;
the latter is not an authorization boundary for the public admin console.
The old Vercel project becomes a temporary path-preserving redirect to Pages only
after the Pages production deployment has passed its release checks; it is removed
after a seven-day transition. The exact order is in the
[Cloudflare cutover runbook](docs/CLOUDFLARE_PAGES.md).

The release workflow is a secret-free Windows/Linux builder, not a publisher. It
checks out one explicit 40-character source commit and produces source-bound hosted
artifacts without Apple or GitHub release credentials. The Mac Mini builds and
strictly verifies the arm64 and x64 ad-hoc DMGs from that same clean commit. An
offline local assembler then validates the exact Actions run/artifact evidence,
normalizes the four installers, writes `SHA256SUMS.txt` and
`RELEASE-PROVENANCE.json`, and only then may a separate local publishing step receive
GitHub authority. Start with the
[macOS release runbook](docs/MACOS_RELEASE.md) and the
[provenance contract](docs/RELEASE_PROVENANCE.md).

Promotion also requires the private two-host Gatekeeper aggregate: Safari ARM64 on
the Mac Mini, plus Safari ARM64 and Chrome x64/Rosetta on the distinct MacBook. The
dialog and launch results are witnessed operator attestations; receipts are not
public release assets.

The v1.0.1 Mac builds use an explicit ad-hoc signing identity, retain the hardened
runtime and current entitlements, and are **not notarized**. On first launch, macOS
will block the unidentified developer. Open **System Settings → Privacy & Security**,
click **Open Anyway**, and confirm; later launches work normally. Do not disable
Gatekeeper or remove quarantine metadata. Windows publisher signing is also not yet
in place, so SmartScreen may warn.

The defective v1.0.0 Mac DMGs must not be republished. Do not merge or deploy the
website cutover until immutable public v1.0.1 assets have passed anonymous checksum,
tag/latest, and the fresh quarantined two-host acceptance checks.

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
  meant to ship in clients and authorizes only operations allowed by database grants
  and row-level security. There is no secret key in this app and there must never be
  one — anything holding a service-role key bypasses every row-level security policy.
- `npm --prefix desktop run build:vendor` rebuilds the bundled supabase-js after a
  dependency bump.
- The server speaks plain HTTP, which is fine on a classroom LAN. Put it behind TLS
  before exposing it to the open internet.
