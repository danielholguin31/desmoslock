# Staff session publication

Authority reads use one captured provider token. Its successful direct user
verification establishes the account and canonical provider session ID; the
same token supplies assurance claims, the verified user supplies factors, and
context/list requests use that token. The read cannot publish authority if its
captured storage generation, version or session value changed while awaiting
results. This prevents a response for one account from becoming a ceremony
backed by another account's assurance or factor list.

TOTP enrollment and verification retain the initiating account, session and
factor in private receipts. Each action captures that expected identity before
factor egress. Enrollment, challenge, verification and owned-factor cleanup use
the captured token directly; they never select a later shared SDK session.
Reset, replacement and expired authority cannot fall back to the current
account. Presentation cleanup remains inert when authority has changed.

The existing single Supabase client uses a public SupportedStorage adapter
backed by IndexedDB. MFA token publication compares the captured store
generation, monotonic version and exact session value in one read/write
transaction. The port first verifies the candidate's account, session,
assurance and expiry. A successful transaction stores the normal SDK session
shape; a failed comparison leaves the replacement session and version intact.
Removal retains a version tombstone. Recreating the store changes its generation,
so neither removal/reinsertion nor database recreation revives an old capture.

Only transaction completion can confirm publication. Unavailable, blocked,
closed or failed storage has no localStorage or in-memory fallback. A lost
commit outcome remains unconfirmed. Metadata notifications request fresh
application reads after publication; they do not carry tokens or impersonate
SDK authentication events. The SDK continues to read and refresh its own
session through this store. Its ordinary login, refresh and callback writes
retain their existing SDK behavior; conditional publication applies to the
direct MFA operation, not every SDK operation.

## Local session cutover

The new deterministic namespace is scoped to the exact normalized backend URL;
the browser origin supplies local origin isolation. This prerelease internal
baseline intentionally imports nothing from the previous localStorage session
or PKCE namespace. Existing cached data is left untouched. An upgraded app
requires a fresh sign-in or newly initiated callback. Old-bundle tabs must
reload to join the new store; mixed-version tabs do not share a supported
session store. This is not provider logout, session revocation, credential
rotation or a hosted authentication-setting change.

Validation belongs to the exact commit's associated pull request and acceptance
receipts. The original mixed-account rendered failure and earlier green CI
receipts remain historical evidence. Required repair gates include installed
SDK behavior with intercepted synthetic HTTP, native IndexedDB transactions in
independent browser contexts, held-response replacement, successful AAL2
publication/reload/refresh, and the existing login/logout/invitation/PKCE
recovery paths in the new namespace. Source and unit checks alone do not
establish those browser or real-provider outcomes.
