# Signup confirmation resend

This source change closes the consuming first hop in the staff email-verification
resend flow. Previously, the provider's default confirmation template linked
directly to its verification endpoint. The application required confirmation
before exchanging the returned code, but an email-link fetch could already have
confirmed the identity and consumed the emailed token.

The versioned `supabase/templates/confirmation-v1.html` now links to the existing
application root with `auth=email-verification`, the SDK's `sb_flow_id`, and an
opaque `pkce_` token in the fragment. Application startup scrubs the complete URL
synchronously, before constructing provider services, and retains the original
link only in a private one-shot callback. Loading or previewing that link does not
navigate to Auth or exchange a code. The existing **Continue securely** action is
required first.

After that click, the callback constructs exactly `/auth/v1/verify` on the
configured backend origin, with `type=signup`, the unchanged token, and the
canonical application redirect carrying the unchanged SDK flow ID. The provider
returns a code to the same application route. That return is scrubbed again and
uses the existing confirmation and SDK PKCE exchange. Each private command can be
used once; failed navigation, Back, lifecycle disposal, or reloading the scrubbed
page requires reopening the email. Invalid origins, URL credentials, duplicate or
unknown routing fields, encoded routing aliases, mixed callback kinds, and
non-PKCE confirmation tokens are rejected before provider navigation.

The SDK continues to own the S256 verifier and ordinary session persistence. This
does not add a server verifier broker, password-commit receipt, raw-token outbox,
or an email-only Membership grant. A different browser or a missing SDK verifier
can still require restarting the flow; the application does not claim cross-device
PKCE recovery. This boundary prevents automatic application navigation and ordinary
email-link prefetch from consuming the token. It cannot prevent an actor that
extracts the token from the email and deliberately calls the provider itself.

`supabase/templates/` is part of the canonical product source in the README,
source-reconciliation ledger, and repository enforcement. Both active templates
are covered by the source contract. The change does not enable signup or change
email frequency, confirmation requirements, MFA, Membership, recovery, or session
revocation policy.

## Verification and rollout

Focused callback and application tests cover synchronous scrubbing, inert loading,
explicit one-shot navigation and exchange, hostile URLs, Back, and unavailable
navigation. The existing disposable `test:staff-auth:composed` lane also contains
a genuine local SMTP signup-resend journey: an unconfirmed run-owned identity,
the real SDK resend request, the delivered versioned Mailpit message, provider
verification, exact SDK flow exchange, and confirmed identity without Membership.
This journey is a required CI check, not a locally simulated delivery receipt.

Local tests and a synthetic production-entrypoint browser check establish only
their exercised boundaries. Exact-commit CI must pass before integration. Hosted
template/config rollout and delivered hosted email remain separate operational
actions; this source change does not perform them. Emails already issued with the
old provider-direct template retain that old link and are not retroactively made
inert.
