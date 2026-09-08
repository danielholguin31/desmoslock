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
