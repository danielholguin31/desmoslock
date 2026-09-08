# Operation-bound logout repair

This source repair follows the green exact-commit verification of `ef19f43d8dbd0ee4be3ad3d1d8f8e415202cc9f7`. Final cumulative review found a normal-logout account-switch race; the prior green run remains valid for that earlier snapshot and does not attest this repair. No database migration, provider configuration, dependency, or hosted state changes are included.

## Reproduction and selected behavior

An intercepted, synthetic run using the installed Supabase SDK and actual adapter/port showed three distinct races. If account B replaced browser storage while account A's application-revocation RPC was pending, the later shared SDK global logout targeted B. If B arrived while A's provider logout was pending, SDK cleanup erased B's stored session. An expired A account read through SDK `getUser` likewise erased B when B arrived before the provider's `session_not_found` response. The ordinary unchanged-A control completed and cleared the SDK cache. All credentials were synthetic, generated only in memory, and no provider was contacted.

Normal logout now requires the account identity already established for the visible application state. A missing identity requires authoritative re-entry rather than selecting whatever account storage contains. One bounded transient authority captures that account's session token and verifies the returned provider user against the snapshot identity. The same handle supplies both the application revocation RPC and the provider logout request, and is released in `finally`. Local and global scopes remain distinct. A handle completed after an application reset is released without starting revocation.

A failed or unknown logout attempt leaves an existing operation-ID tombstone requiring re-entry. It cannot recapture a replacement account or session on replay. The controller offers **Start again**, not automatic logout retry. Uncertain logout is presented as **Sign out unconfirmed** with the message “We couldn’t confirm sign-out. Start again to check your session.” Only a successful provider response after confirmed application revocation permits scoped completion; an expired current token does not prove global provider revocation.

**Back to sign in** and **Start again** are application navigation. They discard callback and private continuation state, presentations, and application authority without provider logout or factor deletion, returning a neutral reset completion. Explicit TOTP cancellation retains its separate existing behavior.

Account validation now uses a bounded GET with one snapshotted token, and verifies that the returned user ID matches that snapshot. Only exact `session_not_found` or `session_expired` responses with HTTP 401/403 project an ended session. Generic rejection, malformed data, HTTP 400/429/5xx, stalled responses, and network errors stay unavailable. An already-ended session returns to sign-in without claiming every session was revoked.

Provider persistence remains SDK-owned. This repair adds no raw storage deletion, SDK private-method call, custom lock, fetch broker, or durable marker. A successful direct logout may leave an obsolete A token cached until ordinary SDK validation/refresh or a fresh sign-in replaces it. The application does not claim cache erasure; a reload validates the token and displays an ended session. A valid retained session after an inert reset may be rediscovered on reload. The SDK's ordinary session loading and refresh behavior is otherwise unchanged.

## Source verification

- All 611 web tests across 11 files passed, including 78 focused port cases and 14 installed-SDK regressions. The latter includes a control reproducing SDK cache erasure and 13 actual adapter/port composition cases with fully intercepted synthetic HTTP and shared memory storage.
- The regressions cover local/global logout, replacement during application and provider waits, replacement during stale account validation, same-A reload, network/HTTP uncertainty, operation replay after failure, and inert reset.
- Web TypeScript, scoped ESLint/Prettier, the repository contract verifier, and tracked whitespace checks passed.
- The production web build passed with the repository's explicit synthetic local origins and synthetic publishable value. Source inputs are frozen in `auth-integration-logout-web-sha256.json` for independent browser QA.
- Root and Atlas independently reviewed the exact production source and regression snapshot without an outstanding high or medium finding. Port and SDK test authors also received independent scoped review.

Independent rendered QA passed 22 logout/reload/reset cases, eight integrated invitation/recovery runs, and two callback viewport runs at desktop and mobile widths. All 29 frozen production inputs matched; there were no unexpected console/page errors. Root inspected representative screenshots. The final browser receipt is referenced in the accompanying source receipt.

The next exact-commit CI run is still required for this repaired snapshot. Earlier actual CI on `ef19f43` passed 409 database assertions, four observed lock-wait scenarios, all three real-provider journey groups, and six sets of baseline/source/public-health observations. Those results are documented separately; synthetic SDK tests do not replace actual provider, external email, hosted configuration, or physical-Mac acceptance.
