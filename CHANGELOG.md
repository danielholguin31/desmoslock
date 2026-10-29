# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Version 2 is a rewrite as a single npm workspace. It has not been released.

### Added

- Typed v2 workspace with `apps/desktop`, `apps/web`, and the `domain`,
  `contracts`, and `test-support` packages, pinned to Node.js 24.20.0 and
  npm 11.12.1.
- Reproducible Supabase backend built from versioned migrations and a
  synthetic seed, with SQL tests and a synthetic export and restore round
  trip.
- Staff authentication in the web app: sign-in, invitations, PKCE password
  recovery, signup confirmation, MFA binding, and logout tied to the
  initiating session.
- Owner bootstrap and staff membership administration with Owner-only
  revocation.
- School settings and a staff Test workspace.
- Accountless student admission with join codes, removal, re-admission,
  forfeit, and reconnect after a crash or restart.
- Isolated calculator view in the Electron desktop app, with process-tree
  supervision and verified teardown.
- macOS assessment protection through a native Automatic Assessment
  Configuration addon, with a durable local record of protection events.
- Tooling to build unsigned, universal, and signed macOS desktop artifacts
  and verify their launch policy and Electron fuses.
- Staff web app configuration for Vercel.
- CI and security workflows, a repository contract verifier, and lint rules
  that guard import boundaries and lint suppressions.
- AGPL-3.0 license and the project site in `site/`.

### Changed

- Electron upgraded to 43.7.0.

### Deprecated

- The v1 apps, server, and SQL are frozen as historical evidence and are
  being removed from `main`. Their packaging and release workflows refuse to
  run.

## [1.0.0] - 2026-08-08

Legacy release. Unmaintained and superseded by v2. The source is kept at the
`v1.0.0` tag for reference only.

### Added

- Electron desktop app that held the Desmos graphing calculator on screen
  during a test: fullscreen over every display, a focus watchdog, blocked
  shortcuts and screen capture, a network allowlist, and relaunch after a
  force-quit.
- Teacher-controlled lock, override code, activity feed, and forfeit on
  early exit.
- Supabase backend with row-level security and a LAN server alternative.
- Check that refuses to start a test while other apps are open.
- Landing page with installer downloads and Vercel hosting.

[Unreleased]: https://github.com/danielholguin31/desmoslock/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/danielholguin31/desmoslock/releases/tag/v1.0.0
