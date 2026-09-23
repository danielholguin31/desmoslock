# Daniel takeover: DesmosLock v2

Handoff recorded 2026-09-22 America/New_York (2026-09-23 UTC).

## Decision and starting point

Nicky requested that Daniel take over and explicitly retained **system-level assessment protection**. Do not replace Apple Automatic Assessment Configuration (AAC) with a weaker kiosk mode or bypass native success gates. The earlier zero-cost website/GitHub download plan does not supply Apple's restricted entitlement. Hosting can remain free; Apple authorization and the signed internal release path remain separate prerequisites.

Canonical implementation is `main` at `61ec25e6e69c43f30be38c95a96efcdcd56d8ec3`, tree `0e5c1cd6234b7cf64f86d9850cc350133001b78a`, through [PR #70](https://github.com/danielholguin31/desmoslock/pull/70). This handoff changes documentation/evidence only. The product is still internal and pre-release. No working protected public download has been produced.

Start with [Daniel’s checklist #74](https://github.com/danielholguin31/desmoslock/issues/74), [the baseline #28](https://github.com/danielholguin31/desmoslock/issues/28), the remaining-work table below, and the existing `docs/product-completion/` implementation documents. Credentials, raw sessions, dependency trees, and generated app binaries are not source handoff material. Existing local files are retained; no user worktree is discarded.

## Completed and verified

- Canonical v2 source, reproducible migrations/fixtures, staff authentication/callback/recovery, Owner bootstrap, Membership/School/Test administration, accountless Student admission, isolated calculator, native AAC coordination, durable recovery/evidence, and unsigned/universal/signed artifact tooling are on main. Individual documents distinguish automated source contracts from hosted or physical acceptance.
- Exact-main [verification](https://github.com/danielholguin31/desmoslock/actions/runs/35811678106) and [security](https://github.com/danielholguin31/desmoslock/actions/runs/35811678043) passed. Latest executable-mode fix had 86 focused tests and 763 repository tests passing, with one skipped; independent spec and standards reviews were clean. These are retained results, not a new test run at handoff.
- Synthetic Supabase staging was upgraded to generation4, 13 migrations, 21 baseline rows including the release attestation, zero Auth users, and empty runtime stores. Subsequent maintenance rollout preserved the pristine observation. Recheck before writing: these observations are not a current writer lock.
- `health` and `student-session-read`, `student-session-reconnect`, `student-session-forfeit`, `student-session-evidence` were deployed. All four maintenance functions passed GET rejection and empty unauthenticated POST denial; this proves boundary behavior, not a valid hosted Student journey. Challenge/join and staff mail/Auth rollout remain unfinished.
- Staff web was deployed and visually checked on desktop/mobile, with callback URL scrubbing, matching public asset hashes, no observed browser errors, and expected 404 behavior. It is a working shell/health milestone, not completed staff enrollment.
- A universal engineering candidate was collected from `61ec25e`: both architectures/native addons and disabled diagnostic fuses verified, strict ad-hoc signature passed, collection/readback matched, and 19 prohibited launch switches plus a sandbox-disabling environment control were rejected. Local arm64 process survival was observed. Visual shell inspection timed out; x64 execution and actual AAC protection were not established.

## Environment handoff

| Surface           | Last verified selection                                                  | Limits / next action                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source            | `danielholguin31/desmoslock`, private, canonical `main`                  | Do not use legacy release branches or v1 draft assets.                                                                                           |
| Supabase          | `adlhhdbglpamaftcbmce`, synthetic staging                                | Complete pristine export/restore before Owner creation and runtime journeys.                                                                     |
| Staff web         | <https://project-1zcn9.vercel.app>                                       | Vercel project `desmoslock-v2-staging`, team `nicolasdmolinas-projects`; selected Google login. Former account's Vercel integration is obsolete. |
| Toolchain         | Node 24.20.0, npm 11.12.1; Electron 43.7.0 candidate                     | Reassess runtime support at release freeze; review dependency PRs.                                                                               |
| Desktop candidate | Build `3318d38c5f17ad35c20db81ac4f272a57f08f63e1f214797bd112ccc473eee76` | Ad-hoc, no Team ID/AAC entitlement, backend `http://127.0.0.1:43175`; **do not distribute**.                                                     |

Daniel needs access through the repository/service owners; credentials are deliberately absent. No account transfer, role grant, new purchase or credential rotation was performed during handoff. Do not depend on temporary local task tokens.

## Remaining tickets and execution order

Existing tickets have fresh handoff comments with concrete remaining criteria; their original acceptance checkboxes have not been falsely closed.

| Ticket                                                                                                                         | Remaining outcome                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#71](https://github.com/danielholguin31/desmoslock/issues/71)                                                                 | Obtain approved Apple AAC provisioning/team/bundle identity and prove actual system protection. Start this external dependency early.            |
| [#30](https://github.com/danielholguin31/desmoslock/issues/30)                                                                 | Real pristine generation4 hosted export and isolated restore, then full hosted configuration/smoke.                                              |
| [#31](https://github.com/danielholguin31/desmoslock/issues/31)                                                                 | Sender domain/provider, remaining Edge/Auth configuration, synthetic Owner bootstrap and delivered-mail/MFA/recovery/revocation journeys.        |
| [#32](https://github.com/danielholguin31/desmoslock/issues/32)                                                                 | Real hosted two-School role/authorization matrix.                                                                                                |
| [#33](https://github.com/danielholguin31/desmoslock/issues/33)                                                                 | Challenge/join deployment and valid hosted Student lifecycle, expiry/removal/reconnect/rate-limit/tenancy proof.                                 |
| [#73](https://github.com/danielholguin31/desmoslock/issues/73)                                                                 | Dependency PRs #48–#52, Electron support at freeze, obsolete Vercel check, owner branch-control decision.                                        |
| [#29](https://github.com/danielholguin31/desmoslock/issues/29)                                                                 | Finish source/branch enforcement and classify preserved proposals; keep one canonical release line.                                              |
| [#72](https://github.com/danielholguin31/desmoslock/issues/72)                                                                 | Rebuild universal desktop for verified HTTPS staging, with measured public configuration and exact source identity.                              |
| [#36](https://github.com/danielholguin31/desmoslock/issues/36)                                                                 | Execute controlled Developer ID/hardened-runtime/notarization/stapling pipeline and verify final DMG, install/uninstall and compatible rollback. |
| [#34](https://github.com/danielholguin31/desmoslock/issues/34), [#35](https://github.com/danielholguin31/desmoslock/issues/35) | Exact-package calculator containment, native lock/recovery and acknowledged Teacher evidence under adverse conditions.                           |
| [#37](https://github.com/danielholguin31/desmoslock/issues/37)                                                                 | Same final artifact on clean native arm64 and Intel Macs, all physical acceptance cases.                                                         |

Run #71 and access/dependency planning alongside #30. Preserve pristine backup eligibility until export completes; only then create Owner/Auth/runtime fixtures. Hosted acceptance and signing converge at the final artifact. Rebuilding/re-signing changes evidence binding and requires the corresponding acceptance again.

## Operator details that must survive takeover

For #30 use the existing `scripts/synthetic-backup/run.mjs` operator, not a new exporter. It exports seven synthetic tables/20 rows; the 21st hosted row is migration-owned attestation. Require `verify-full`, explicit CA, a TLS-capable PostgreSQL client, opaque connection injection, and independently observed distinct cluster identities. The locally built PG 17.6 client lacked TLS and is not suitable for hosted export. Restore into a fresh migrated target **without seed**, verify second-restore refusal, and stop only the owned target. Do not delete hosted rows to regain pristine eligibility. Management API login does not establish libpq authentication. See [reproducible Supabase](reproducible-supabase.md) and [restore acceptance](synthetic-restore-acceptance.md).

For #36 reuse [the universal collector](universal-artifact-collector.md) and [signed runner](signed-artifact-runner.md). Keep source/tree, lockfile, toolchain, build identity and final app/DMG hashes. The current candidate is about 523 MB and remains locally retained as evidence, not uploaded as a misleading release. Its collector tree digest is `0e0acab8fa52cdf8714de8f8e3509bb4a7ff22bcd84d31cfea0e53761ac836a7`; runner inventory digest is `b70e0b7c1ebf5ca1ce22e1df0f6a6aae6684639eeef54143443dc9cccbb670be` (605 entries).

For #37 retain all 14 pending case IDs in [the candidate receipt](handoff-evidence/universal-candidate.json). Use two clean physical hosts, native arm64 and Intel, at least one without a checkout/prior state. Actual AAC begin/end and all five categories are required. Use a locally present operator and external-camera evidence where AAC blocks screenshots; do not add protection exceptions for automation. Include protected graphing, privileged-content attacks, Teacher evidence/release/Test end, finite network-loss deadline, crash/reboot/corruption, display/prohibited applications and emergency exit. Prior-process unfinished attempts remain detached `recovery_required`; no automatic relock or deletion of uncertain state. Rollback needs a verified compatible predecessor or reviewed controlled baseline, not legacy v1.

## Evidence and unfinished proposals

[Evidence manifest](handoff-evidence/manifest.json) records both original receipt hashes and the committed copies’ hashes (JSON formatting only; values unchanged). They contain historical timestamps and local evidence paths; a local path reference does not mean the underlying raw artifact is uploaded or freshly verified. Read the results and limits above together. The old packet header at `f9...` is superseded by the `61ec...` candidate receipt.

[Recovery snapshots](handoff-evidence/recovery/README.md) preserve local unintegrated branches and dirty worktree changes with exact bases and hashes. They are **unreviewed historical proposals, not part of the accepted product**. Custom PKCE brokers, password-receipt and raw-token outbox approaches were parked. Do not apply the snapshots wholesale. Review only a specific necessary change against current main and rerun its tests.

Passing internal release acceptance authorizes planning External Readiness. Desmos API/naming rights, public distribution/download site, privacy/support documentation, pricing and School outreach remain a separate future scope; this handoff does not authorize them. The earlier free-hosting preference remains useful for that later distribution decision, without weakening assessment protection.
