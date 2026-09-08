# Staff authentication CI continuation

The reviewed source candidate was committed as `5e6ab4d9b15aa5af5ceac93c7f05b2ed542de8c0` and pushed only to `codex/desmoslock-auth-integration`. The original source receipt records that pre-CI snapshot. Subsequent CI repairs and evidence are recorded here; they do not retroactively turn unexecuted local checks into passes.

## Initial exact-commit run

[Required v2 verification run 34174574311](https://github.com/danielholguin31/desmoslock/actions/runs/34174574311) was explicitly dispatched with the deliberate-failure input disabled. Static, unit/evidence, Edge, Electron, supply-chain and required-check plumbing jobs passed. The two database jobs and the web job failed. The final required check correctly failed.

The new callback-completion pgTAP file executed and passed all 36 assertions. The complete database suite did not pass, and the composed GoTrue journeys were not reached because the earlier SQL suite stopped the command chain.

Sanitized SQL failure evidence:

| Test                                                 | Observed                                                                                                                                                                          | Expected                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Internal backend assertion 11: migration attestation | `(1,4,1b499b73aca1ff812cbc244f9eb9908e8dad839ecc6befbcb1a496865a2d5f52)`                                                                                                          | `(1,4,ce79427901195258897e0b75c80acfb7b50699eb223af5289cf5d5d59958f2b7)` |
| Internal backend assertion 19: baseline status       | Generation 4, fixture `internal-baseline-v2`, fixture hash `f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201`, current migration hash `1b499b73...`, valid `true` | Same values except historical migration hash `ce794279...`               |
| Internal backend assertions 36–37: School read model | No row for either test actor                                                                                                                                                      | Alpha Owner and Beta Admin rows                                          |
| Generation 4 test, line 68                           | PostgreSQL error: could not determine which collation to use for string comparison                                                                                                | Test continues; it stopped after 2 of 23 assertions                      |
| Lifecycle assertion 248: baseline after runtime rows | Fixture hash `f1ecc4d4...`, validity `false`                                                                                                                                      | Same fixture hash, validity `true`                                       |

Web failure evidence:

- The email-verification test timed out waiting for an exchange after navigation. The current callback contract requires an explicit confirmation before the exchange; the test had not clicked it.
- The history-scrub failure test waited for page load. The inline fail-closed path intentionally calls `window.stop()` before loading application resources, so page-load completion is not the relevant boundary.

The repair review must identify the actual fixture or product contract responsible for every failure. No assertion may be skipped, no authority check weakened, and no historical migration rewritten merely to make CI pass.

## Browser test repair

Both failing browser tests were reproduced locally before the repair. The test now clicks the explicit confirmation for email verification, asserts zero Auth requests before that click, and checks that the callback code is absent from the URL, DOM and browser storage before the exact PKCE exchange. The pending exchange displays its processing state while School data remains hidden.

For a deliberately denied history scrub, the test observes navigation commit rather than load completion. It asserts that the entire document is hidden and that no application backend, script or stylesheet request occurs. This preserves the fail-closed contract even when `window.stop()` prevents body parsing.

All six browser tests then passed against the production web artifact using the existing local Chromium installation. Scoped test TypeScript, lint, formatting and whitespace checks passed. No production web source changed in this repair.

## Bootstrap defect and selected forward repair

The lifecycle baseline failure exposed a production contract conflict. The existing initial Owner binder required nonnull seed keys on its School, profile and Membership, while the canonical health digest includes every row with a nonnull seed key and includes the profile's Auth binding. Both binding a canonical fixture Owner and provisioning extra rows with `composed.*` seed keys invalidate health. Merely changing the final assertion to expect an invalid fixture would conceal the setup defect; that proposed expectation-only change was withdrawn.

The selected forward migration retains the existing service-only three-UUID binder and its identity, locking, idempotence, uniqueness and audit guarantees. It accepts a runtime scaffold only when all three seed keys are null and rejects pinned or mixed-seed targets. The canonical digest and historical migrations remain unchanged. The setup and in-place reconciliation boundaries are in [runtime-owner-bootstrap.md](runtime-owner-bootstrap.md).

The lifecycle SQL tests use separate runtime School and staff fixtures, keep the original successful access and denial contracts, and retain the final `fixture_valid = true` expectation. The internal backend read-model tests now provide valid synthetic SQL Auth-table identity/session fixtures, with negative controls; these are database authorization tests, not GoTrue-created session evidence. Exact migration-hash expectations are advanced to the selected current migration set. Explicit matching collations repair the generation-4 catalog comparison without changing production SQL or the expected constraint names.

The actual-provider suite provisions null-seed runtime rows. Its six health checkpoints each read the real baseline RPC, run the current source dependency probe against actual Auth/PostgREST, and fetch public `GET /functions/v1/health`. Checkpoints surround provisioning, binding and all three invitation/recovery/revocation groups. Provider data remains memory-only. This source change still requires the next CI run; successful syntax or mocked checks are not substituted for runtime execution.

## Repair source verification

The reviewed repair passed the full repository contract verifier, four focused migration/data-plane tests, 106 synthetic backup and PostgreSQL-adapter tests, 13 cached-only health tests, all six repository browser tests, and scoped syntax/import, TypeScript, lint, formatting and whitespace checks. Atlas independently reviewed the new binder, database assertions, actual-provider test changes and bootstrap documentation; the six-migration pin review was also clear.

The five historical migrations and 29 production web QA inputs remain unchanged. The new migration set retains schema generation 4 and the seven-table fixture. The repair receipt is based on published commit `5e6ab4d9b15aa5af5ceac93c7f05b2ed542de8c0` and supersedes the affected hashes in the earlier source receipt. Its SQL repairs and added real-health checkpoints still require the next exact-commit CI run.

## Second exact-commit run

[PR verification run 34176046359](https://github.com/danielholguin31/desmoslock/actions/runs/34176046359) tested `2a0d6cfee334df5cbe62d9f5fe53fe9efbed19f1`. The actual database suite passed all 389 assertions in six files. Public health and the other two stack prerequisites passed. Static, unit/evidence, Edge, Electron, browser, supply-chain and required-check plumbing jobs passed; the separate Security required workflow also passed.

The composed provider suite reached all three journey groups. Real TOTP, invitation acceptance/lost-response replay and nonmember denial passed. Independent real sessions, Membership revocation and acceptance replay denial passed. The recovery group stopped at the assertion `Actual provider session lacks recovery AMR`, so recovery completion and password-response-loss acceptance were not established.

The failing helper used an admin-generated implicit recovery link. In pinned GoTrue 2.195.0, implicit verification creates generic OTP authentication; only the PKCE verification branch preserves the provider's recovery authentication method through code exchange. The SDK preserves an unexpired supplied token, so installing the implicit session cannot supply the missing marker. The repair uses an actual PKCE recovery request and the provider-generated message captured by the disposable local Mailpit service. Its credential and verifier stay in memory through the untouched verification link and same-client code exchange. No Auth claims or flow-state rows are fabricated.

The selected policy isolates provider-identified PKCE recovery sessions. It does not blanket-deny every generic verified OTP session: existing Membership, tenancy, MFA and revocation checks still govern ordinary email-identity authentication. The backend recovery guard remains unchanged. Cutoff installation and cleanup guarantees describe the supported application RPC flow; direct provider endpoints do not independently invoke those application revocation RPCs. The Mailpit boundary is a disposable local service with no external relay; the harness pins its container/project, numeric loopback provider and Mailpit APIs, and the exact inert callback destination, which it inspects without fetching. A loopback harness URL alone does not establish a loopback-only Docker listener. No hosted SMTP configuration is changed.

## Revocation authority after a lock wait

Independent source review also found that `revoke_membership` authorized an Owner before waiting for the target Membership lock and then reused that result. The seventh forward migration repeats the same live Owner/AAL2 authorization after obtaining the lock, before exposing target state or mutating it, and uses a fresh mutation timestamp. It preserves the public RPC, lock order, result codes, audit contract and grants; the six already published migrations remain unchanged.

Dedicated SQL regressions change actual actor authority after the first genuine authorization result and require denial with unchanged target tuple and audit state. A separate two-connection runtime test observes the actual target-row block with `pg_blocking_pids` before changing actor authority. It includes an unchanged-authority success control and rolls the actor transaction back after inspecting results. Owned fixture cleanup preserves the fresh-Auth prerequisite for the following composed suite; it does not delete audit events or disable protections. The new lock command runs in the existing full-stack CI job before the provider suite.
