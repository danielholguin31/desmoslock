# Email callback safety: primary-source evidence

Research cutoff: 2026-09-04. Repository baseline: `544fc02`. Client versions inspected: `@supabase/supabase-js` and `@supabase/auth-js` 2.115.0. Provider behavior was checked against the current stable Supabase Auth tag, v2.195.0, and its first-party tests. No hosted configuration was read or changed.

## Decision

Do **not** use a custom `TokenHash` template plus `verifyOtp` for Supabase verification or recovery when the security contract requires PKCE verifier proof. Although Supabase's documentation presents that recipe for PKCE/SSR, the provider implementation shows that `POST /verify` consumes the one-time hash and directly issues a session without a verifier. It is click-gateable, but it is not PKCE-preserving.

Use a non-consuming application intermediary for Supabase-owned verification and recovery email instead:

1. A version-controlled custom email template points to an application callback and carries the untouched provider `ConfirmationURL` as an opaque credential.
2. Before creating the Supabase client, rendering, health calls, or any other network work, the application synchronously extracts all callback query/fragment material into a private closure/controller and calls `history.replaceState` with the clean root route.
3. The DOM/view model receives only non-sensitive kind/status data. It renders a neutral button, not a credential-bearing link. No provider request or navigation occurs until the user explicitly clicks.
4. That click navigates to the exact provider `ConfirmationURL`. Provider `GET /verify` consumes the mail token, redirects with an authorization code, and the code exchange requires the originating PKCE verifier.
5. A reload before the click necessarily loses the memory-only credential and displays “reopen the email.” The callback route must load no analytics or third-party resource.

Supabase's documented intermediary example places the provider URL in an application query parameter. That leaks it to the application's HTTP/CDN logs before JavaScript can scrub it. Carrying the opaque value in the URI fragment is the safer application-specific design because fragments are separated before dereference ([RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5)); exact template escaping, link rewriting, and email-client fragment preservation remain hosted human-test gates.

The DesmosLock staff invitation is a separate flow. The Edge function calls `admin/generate_link`, extracts the invite hash, and constructs its own direct application callback (`auth=invite&token_hash=…`) for the injected mail transport (`supabase/functions/staff-invitations/index.ts:336-340,562-588`). It is not a Supabase verification/recovery `ConfirmationURL`, and the future Resend transport does not change its credential semantics. Keep that callback inert and memory-only, then call `verifyOtp({ token_hash, type: "invite" })` only on an explicit human click.

## Verified evidence

| Question                                                | Primary-source finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Can mail prefetch consume `ConfirmationURL`?            | Yes. Supabase warns that a prefetched confirmation link can be consumed before the user reaches the application, and recommends either typed OTP or an intermediary page with a user-clicked confirmation button. It also recommends disabling provider email-link tracking. [Email Templates guide](https://supabase.com/docs/guides/auth/auth-email-templates) · [first-party guide source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/auth-email-templates.mdx) · [2025 clarification](https://github.com/supabase/supabase/commit/1431ee8ff763f27e0ba480f4b737e01920b95842)      |
| What does normal PKCE require?                          | Supabase documents `GET /verify → ?code=… → exchange`, with both authorization code and verifier required; the code is five-minute and single-use. Flow IDs disambiguate concurrent verifier slots. [PKCE guide](https://supabase.com/docs/guides/auth/sessions/pkce-flow) · [guide source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/sessions/pkce-flow.mdx)                                                                                                                                                                                                                       |
| Does `TokenHash + verifyOtp` preserve PKCE?             | No. `GET /verify` selects PKCE for a `pkce_`-prefixed mail token and issues an auth code, while `POST /verify` validates the hash and directly returns access/refresh tokens. The POST schema has no verifier, challenge, or flow-ID field. [Auth v2.195.0 `verify.go`](https://github.com/supabase/auth/blob/v2.195.0/internal/api/verify.go#L113-L292) · [OpenAPI](https://github.com/supabase/auth/blob/v2.195.0/openapi.yaml#L211-L294)                                                                                                                                                                              |
| Does the POST preserve exact authentication provenance? | No. `POST /verify` hard-codes the provider authentication method to `otp`; `IssueRefreshToken` records that method in session AMR. Passing `type: "recovery"` makes auth-js emit a `PASSWORD_RECOVERY` client event, but does not turn the provider session AMR into the exact `recovery` method. [POST verification](https://github.com/supabase/auth/blob/v2.195.0/internal/api/verify.go#L216-L292) · [token issuance service](https://github.com/supabase/auth/blob/v2.195.0/internal/api/tokens/service.go) · [authentication methods](https://github.com/supabase/auth/blob/v2.195.0/internal/models/factor.go)    |
| Is the actual code exchange verifier-bound?             | Yes. `/token?grant_type=pkce` rejects a missing code or verifier, verifies the pair, and only then issues a session. [Auth v2.195.0 `token.go`](https://github.com/supabase/auth/blob/v2.195.0/internal/api/token.go#L198-L265)                                                                                                                                                                                                                                                                                                                                                                                          |
| What path does Supabase test?                           | The first-party recovery test requests mail with a challenge, follows `GET /verify` using the prefixed token, and receives a redirect code. No first-party test was found in this release proving that `POST /verify` with `token_hash` retains verifier proof. [Auth v2.195.0 `verify_test.go`](https://github.com/supabase/auth/blob/v2.195.0/internal/api/verify_test.go#L62-L138)                                                                                                                                                                                                                                    |
| How are mail tokens constructed?                        | Signup/confirmation and recovery add the PKCE flow prefix when a challenge is present, and template data exposes both `ConfirmationURL` and `TokenHash`. Built-in/admin invitation generation has no code-challenge input and does not establish this PKCE path. [Auth `mail.go`](https://github.com/supabase/auth/blob/v2.195.0/internal/api/mail.go#L303-L410) · [template data](https://github.com/supabase/auth/blob/v2.195.0/internal/mailer/templatemailer/templatemailer.go#L182-L223)                                                                                                                            |
| Why not follow the docs' TokenHash recipe?              | Supabase's passwordless/password guides recommend a custom `TokenHash` route that calls `verifyOtp`, including under PKCE-oriented guidance. That proves the recipe is documented, not that it preserves a verifier: the provider's two route implementations above contradict the stronger characterization. [Passwordless email guide](https://supabase.com/docs/guides/auth/auth-email-passwordless) · [password guide source](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/passwords.mdx) · [`verifyOtp` reference](https://supabase.com/docs/reference/javascript/auth-verifyotp) |

## Pinned SDK consequences

- In auth-js 2.115.0, public `exchangeCodeForSession(authCode, { flowId? })` has no explicit verifier parameter. Its internal implementation retrieves a verifier from SDK storage and posts `{ auth_code, code_verifier }`. After synchronous URL scrubbing, an SDK-created flow must retain both the code and validated `sb_flow_id` privately and pass `{ flowId }`; otherwise the SDK can fall back to the latest verifier slot. [Public method](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/GoTrueClient.ts#L1562-L1575) · [internal exchange](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/GoTrueClient.ts#L2008-L2061) · [flow helpers](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/lib/helpers.ts#L309-L349)
- A server-created verifier therefore cannot be supplied through `exchangeCodeForSession`. The source-supported bridge is an application-controlled direct request to `/token?grant_type=pkce`, followed by `auth.setSession({ access_token, refresh_token })`; `setSession` validates and installs the returned session. This still requires application-level AMR and exact-operation gating because `setSession` emits generic signed-in state, not recovery intent. [`setSession`](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/GoTrueClient.ts#L3583-L3637)
- `verifyOtp({ token_hash, type })` posts directly to `/verify` and exposes no verifier/flow input. If a session is returned it installs it, emitting recovery-specific state only for `type: "recovery"`. [`verifyOtp`](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/GoTrueClient.ts#L2469-L2505) · [parameter types](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/lib/types.ts#L840-L866)
- Use literal `detectSessionInUrl: false`. In this version a function returning `false` suppresses only implicit callback detection; a truthy function object still permits the later PKCE consumption branch. Scrubbing must precede client construction because built-in cleanup occurs only after exchange and error paths can leave callback material. [Initialization/URL handling](https://github.com/supabase/supabase-js/blob/v2.115.0/packages/core/auth-js/src/GoTrueClient.ts#L3836-L4010)

## DesmosLock implications and proof limits

The baseline already configures literal `detectSessionInUrl: false` and PKCE flow IDs (`apps/web/src/auth/supabase-staff-auth-port.ts:970-992`), but startup immediately dispatches invitation inspection or verification/recovery consumption (`apps/web/src/auth/staff-auth-application.ts:225-241`). That immediate dispatch is the scanner-triggered consumption defect; synchronous scrubbing alone is insufficient.

Recovery initiation currently creates an S256 challenge and asks Supabase to send its standard `ConfirmationURL` (`supabase/functions/account-recovery/index.ts:99-120`). The new intermediary must preserve that exact provider URL until the human click. Invitation remains the app-owned hash callback described above. Verification/recovery commit resumption is a separate database-lane contract: this research does not infer any RPC signature. The web implementation must consume only the exact authenticated same-session receipt/operation and use trusted current AAL/authentication-method evidence; a generic signed-in session must not imply recovery.

The following are residual hosted human gates, not source-only claims:

- apply and record the reviewed versioned verification/recovery templates;
- disable email-link tracking and validate redirect allowlists;
- inspect the rendered messages and prove fragment/escaping behavior through real supported email clients and configured mail infrastructure;
- exercise normal click, link-prefetch, JavaScript-capable scanner, reload-before-click, expired/replayed, and concurrent-flow cases without exposing credentials to logs or third parties;
- confirm the hosted Supabase Auth version preserves the source-reviewed behavior before relying on it.

Until those gates pass, no claim should be made that hosted delivery is scanner-safe. In particular, `TokenHash + verifyOtp` must not be described as PKCE-preserving.

## Source checkpoint: 2026-09-04 callback reconciliation

The callback worktree now uses a private inline dynamic-import continuation: the
raw incoming URL never appears on `window`, `document`, history state, a DOM
attribute, or a view snapshot. It is scrubbed before stylesheet/module loading.
History retains only a non-sensitive pending marker, so reload before the click
shows the explicit reopen/restart path. BFCache suspension discards the pending
credential and rebuilds the application after return.

The coordinated invitation producer/receiver contract is now exactly
`/?auth=invite#token_hash=<56 lowercase hexadecimal characters>`. Legacy
query-token links, mixed query/fragment material, extra fields, and encoded
fragment forms are rejected. This removes the invitation bearer credential from
the initial application HTTP request.

Recovery uses the existing direct provider PKCE exchange. The application owns
an explicit temporary verifier/state store in origin-scoped `localStorage`,
serialized with browser Web Locks across tabs. This is **not SDK-managed flow
storage**. It retains at most sixteen records; flows expire logically after five
minutes and expired records are removed on the next store operation. Consuming a
flow removes its verifier/state before provider exchange and preserves only a
bounded replay tombstone. A first-hop preflight rejects a missing, expired, or
consumed flow before navigating to the provider. Another browser cannot recover
the verifier; it must restart the flow. Supabase continues to own normal provider
session persistence and email-verification PKCE slots.

The recovery first-hop shape is exactly
`/?auth=recovery&flow=<flow>&state=<state>#token_hash=pkce_<56 lowercase hex>&type=recovery`.
After explicit confirmation the application constructs the configured provider's
`/auth/v1/verify` URL and exact application redirect. Its code-return shape is
`/?auth=recovery&flow=<flow>&state=<state>&code=<provider code>`. Versioned mail
configuration and real provider/browser/mail-client verification remain gates;
this source checkpoint is not a hosted delivery claim.

No database password-commit receipt integration was added in this tranche. The
separate receipt prototype must not be assumed compatible with these web RPCs,
and its marker must not be passed to `auth.updateUser` where SDK persistence
could retain it. The orchestrator is selecting the smallest accepted database
contract separately. The pre-existing SDK password update remains unchanged.

The isolated browser QA pass exercised the frozen local synthetic preview at
1440×900 and 360×740. It confirmed inert pre-click invitation handling, clean
application URL/referrer/DOM/global/storage boundaries, no horizontal overflow,
and no unexpected JavaScript errors. A synthetic provider HTTP 400 exposed a
reset loop: the pending callback marker and lost-link flags survived explicit
restart, so auth revalidation returned to the reopen-email screen. Explicit
restart now discards the callback command, clears the real history marker, and
clears both the controller and BFCache callback intent before provider reset.
The independent rerun confirmed Start again and Back to sign in reach one
sign-in form; reload and persisted pagehide/pageshow after escape remain there.
Reload before choosing restart still shows the intended reopen-email state.

The existing e2e lifecycle assertion now requires the auth root to be hidden on
persisted pagehide and visible again only after persisted pageshow. The standard
full e2e suite was not run in this tranche; the successful browser gate used an
isolated synthetic preview, with no hosted mail, real credentials, deployment,
or Electron packaging. Screenshots and the final machine-readable QA result
are recorded by the orchestrator's callback-preview evidence bundle.
