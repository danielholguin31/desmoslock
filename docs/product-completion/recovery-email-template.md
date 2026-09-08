# Recovery email template v1

This is a source implementation for the internal v2 recovery flow. It does not
change a hosted template or establish delivered-email acceptance.

`supabase/templates/recovery-v1.html` is selected by the local CLI configuration
in `[auth.email.template.recovery]`. The existing non-routable `site_url`, empty
redirect allowlist, and disabled local SMTP remain unchanged. An explicitly
configured synthetic local test environment must supply the approved callback
origin and allowlist before testing delivery; the source configuration itself
continues to fail closed.

## Producer and receiver contract

The account-recovery function constructs the exact absolute redirect:

```text
https://<approved-web-origin>/?auth=recovery&flow=<22 base64url characters>&state=<43 base64url characters>
```

Supabase must preserve this accepted request redirect in `.RedirectTo` and supply
the untouched recovery `.TokenHash`. The only link in the template is:

```html
<a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=recovery">
  Continue to DesmosLock
</a>
```

The mail renderer escapes the URL as an HTML attribute. The email client decodes
`&amp;` to `&`, producing this application first hop:

```text
/?auth=recovery&flow=<flow>&state=<state>#token_hash=pkce_<56 lowercase hexadecimal characters>&type=recovery
```

The credential appears only in the fragment of the application's first-hop URL.
The app scrubs the URL before loading its modules and requires explicit
confirmation. It checks the originating browser's temporary verifier/state
record before navigating to the configured provider's `GET /auth/v1/verify`
with `token`, `type=recovery`, and the exact `redirect_to`.

The provider GET route recognizes the `pkce_` prefix and returns an authorization
code. Its query serializer sorts parameters, so the real code return is:

```text
/?auth=recovery&code=<provider code>&flow=<flow>&state=<state>
```

The receiver must accept exactly those four unique keys independent of ordering.
The subsequent direct PKCE POST proves possession of the originating verifier.
One five-second deadline bounds the complete request and response body. A timeout
aborts the request, cancels the reader where possible, returns an unavailable
result, and never installs tokens from a late response. Because the temporary
verifier has already been consumed, the application must offer a fresh recovery
request rather than retrying the same code.

After successful SDK session installation, the port privately retains the
original recovery access token for at most five minutes. Password submission
must capture that exact session before beginning the bound recovery operation;
a session selected later by another tab cannot replace it. The operation uses
its captured token for the password write, product RPCs, and logout, with a
separate short lifetime and final release. Reload/remount, token refresh,
expiration, or account replacement can lose this private binding and require a
new recovery link. The application exposes that restart path. The five-second
provider deadline does not bound the subsequent SDK `setSession` call; a stalled
SDK installation remains a separate limitation.

Do not replace the first hop with `.ConfirmationURL`, put the token in the
application query, strip the `pkce_` prefix, or exchange the hash using
`verifyOtp`. The last approach uses the provider POST verification branch,
which issues a session without the PKCE verifier.

The recovery function accepts exactly the installed SDK's two preflight header
sets: `apikey, content-type, x-client-info` when a new-format publishable key has
no session token, and that same set plus `authorization` when a session exists.
Unknown, duplicated, or missing required headers are rejected. Invitation CORS
and the shared strict preflight implementation are unchanged.

## Evidence and remaining acceptance

Focused synthetic tests cover the versioned template/receiver contract, inert
pre-click behavior, SDK-generated request header sets, both exact server
preflight variants, and timeouts for hung headers and hung success/error bodies.
A separate synthetic probe using the installed native Go `html/template`
renderer verified the checked-in template renders one exact callback link,
correctly decodes its HTML attribute, and keeps the credential exclusively in
the fragment. This required no downloaded dependencies. These checks do not
execute the hosted mail renderer or a real email client.

The following provider sources establish the design:

- [Supabase local template configuration](https://supabase.com/docs/guides/local-development/customizing-email-templates)
  documents the `content_path` wiring.
- [Supabase Auth recovery template data](https://github.com/supabase/auth/blob/v2.195.0/internal/mailer/templatemailer/templatemailer.go)
  supplies `RedirectTo` and `TokenHash`.
- [Supabase Auth redirect selection](https://github.com/supabase/auth/blob/v2.195.0/internal/utilities/request.go)
  validates the request redirect before selecting a fallback. A missing or
  incompatible allowlist is a delivery configuration failure; do not work around
  it with a provider link that bypasses application confirmation.
- [Supabase Auth renderer](https://github.com/supabase/auth/blob/v2.195.0/internal/mailer/templatemailer/template.go)
  uses Go `html/template` for HTML attribute escaping.
- [Supabase Auth recovery token generation](https://github.com/supabase/auth/blob/v2.195.0/internal/api/mail.go)
  prefixes PKCE recovery tokens, and
  [hash generation](https://github.com/supabase/auth/blob/v2.195.0/internal/crypto/crypto.go)
  uses SHA-224 lowercase hexadecimal output.
- [Supabase Auth GET and POST verification branches](https://github.com/supabase/auth/blob/v2.195.0/internal/api/verify.go)
  distinguish PKCE code returns from direct session issuance and sort the
  callback query using `url.Values.Encode`.

Before a hosted acceptance claim, verify the deployed Auth version, apply the
reviewed versioned template through an authorized operator step, verify the exact
redirect allowlist, disable email-provider link tracking, and test delivery in
the relevant clients. Confirm fragments survive delivery, scanner prefetch does
not consume the provider token, explicit confirmation completes same-browser
PKCE, and another browser or an expired/consumed flow offers a restart. Do not
retain incoming callback URLs, provider links, or tokens in logs or screenshots.
