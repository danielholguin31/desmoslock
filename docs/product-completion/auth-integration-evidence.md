# Staff authentication composed source candidate

This September 7 candidate builds on `544fc0250617d2482173c55ddc44c52d3f240693` in the existing integration worktree. It is a local proposal, not a merged or hosted release. The callback import identity and unchanged-source check are recorded in `auth-integration-source-receipt.json`; the September 4 callback document describes that earlier snapshot and is superseded by this integration contract where they differ.

The check table below records the initial local source gate. Later exact-commit CI results, discovered defects and repairs are recorded in [auth-integration-ci-evidence.md](auth-integration-ci-evidence.md), which supersedes the affected status claims and source hashes. In particular, CI has since executed the database suite and two real-provider journey groups; the current PKCE recovery and lock-wait repairs still require their next exact-commit run.

## Selected behavior

- The existing database invitation acceptance transaction owns Membership, invitation state and one audit event. Provider password setup follows acceptance independently. Lost acceptance responses reconcile against authoritative context and may replay the identical nonsecret acceptance intent once. Replayed acceptance cannot reactivate revoked Membership.
- A verified no-Membership session can reconstruct its live invitation using `current_staff_invitations`; it does not replay the emailed credential. Password updated, rejected and unknown are distinct outcomes. Accepted Membership remains accepted even when password setup or its response fails.
- Password mutations use a private port-owned authority captured before mutation. The same captured token binds invitation acceptance or recovery begin, password PUT, recovery finish and cleanup. Handles expire after 60 seconds, allow one password PUT, are released after the operation, and never enter browser storage or public state. Ordinary Supabase session persistence remains SDK-owned.
- SDK authentication notifications revalidate the original recovery binding before projecting the password form, without querying protected School context. A lost binding retains a recovery restart state. Reset, completion and a new authentication entry clear the continuation, and stale asynchronous probes cannot restore it.
- Recovery submission must match the original recovery exchange's private session binding. The binding expires after five minutes. A page reload, token refresh or account switch that loses or changes that binding requires a new recovery flow; a delayed cross-tab authentication event is not considered sufficient authority evidence.
- Recovery isolation applies to provider-identified PKCE recovery sessions. A generic verified OTP session with an existing active Membership remains ordinary email-identity authentication: it cannot create Membership or cross School boundaries, privileged actions still require AAL2, and backend revocations still apply. The implicit provider recovery-link path does not establish the PKCE recovery marker and is not the application's selected callback flow.
- Recovery begin returns the canonical nonsecret operation for the verified recovery session and installs a revocation cutoff. Finish proves cleanup, never a provider password change. Unknown provider or cleanup responses produce a usable sign-in/recovery path without claiming success. Recovery AMR, concrete revocations, expiry, Membership and MFA remain backend gates. The cutoff and cleanup guarantee applies to the supported application RPC flow, not every direct provider endpoint.
- Prepared invitation bindings remain usable by their exact verified recipient after delivery uncertainty. The existing request key is the nonsecret attempt identity, the row status and bounded reason describe dispatch, and no token or raw message payload is stored. Only bounded retries within the same invocation reuse the exact in-memory bytes and provider idempotency key. Cross-request resend remains outside this tranche.
- Recovery email source uses the versioned inert fragment template in `recovery-email-template.md`. The explicit-click provider return accepts GoTrue's query ordering while rejecting duplicate keys and encoded routing aliases. Direct PKCE fetch plus response-body reading is bounded to five seconds; subsequent SDK installation is a separate operation.

## Verification boundaries

The callback, adapter, controller, port, contracts, Edge handler and transport tests are focused source evidence. Browser QA uses synthetic provider replies and may retain synthetic screenshots. Real provider tests do not enable Playwright traces, video, HAR or screenshots.

`npm run test:staff-auth:composed` requires a freshly reset exact local Supabase/GoTrue stack and fails when it is absent. It exercises the real provider, PostgREST and the source invitation handler with an in-memory mail transport. It runs last in `test:staff-auth`, because its durable audit fixtures must remain append-only until the disposable stack is stopped/reset. The recovery journey now also consumes the actual provider message from a disposable local Mailpit sink. This is not deployed Edge, external email delivery or actual browser acceptance. Startup/reset/stop wrappers retain raw CLI output only in memory and expose bounded failure categories, avoiding disposable key output in CI.

No local PostgreSQL or Docker runtime was available for the initial source gate. At that point, SQL execution, concurrent database races, live GoTrue journeys, hosted sender/template configuration, delivered email and packaged physical-Mac acceptance were unverified. Subsequent CI evidence is reported in the linked continuation document; it does not establish hosted or packaged-Mac acceptance. Exact source hashes and final executed-check receipts accompany this candidate; green source tests do not replace these gates.

## Executed source checks

| Check                                                  | Result                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Focused web, authentication contracts and domain tests | 691 passed in 12 files                                            |
| All Edge tests                                         | 102 passed; Deno lint and three deployed entrypoint checks passed |
| Full repository/workspace TypeScript check             | Passed, including desktop, web, packages and test configuration   |
| Synthetic local web production build                   | Passed with explicit nonsecret local configuration                |
| Repository contract verifier                           | Passed                                                            |
| Focused CI and migration contract tests                | Passed                                                            |
| Synthetic backup operator tests                        | 43 passed                                                         |
| Sanitized local CLI output tests                       | 3 passed                                                          |
| Scoped ESLint, formatting and whitespace               | Passed                                                            |
| Real composed provider/database command                | Failed at missing disposable Docker prerequisite; no journey ran  |
| SQL regression suite                                   | 284 assertions authored and statically reviewed; not executed     |

Independent reviews closed the accepted account-switch, callback deadline, delivery and post-wait SQL authority findings. Browser QA also reproduced a queued SDK sign-in notification that replaced the recovery form with a dependency failure. Six added application/adapter regressions now cover that event sequence, retained restart behavior and stale continuation results; the affected source was rebuilt for browser revalidation. Synthetic browser QA is recorded by the Astra orchestrator in its separate integration-preview evidence; this document does not preempt that result.

## In-place rollout prerequisite

Any future in-place upgrade must drain and quiesce legacy authentication RPCs before applying the cutoff backfill and replacing the unfinished-recovery guard. A legacy begin operation committing after the backfill snapshot could otherwise escape its cutoff. The current disposable test path starts from a fresh reset; it does not establish concurrent live-upgrade safety. Before proposing a hosted migration, inventory the exact schema and any experimental protocol already present, then prepare the exact authorized rollout and rollback boundary. No hosted changes were made in this tranche.
