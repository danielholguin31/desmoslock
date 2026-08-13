# Cloudflare Pages deployment and Vercel transition

The website is a static Direct Upload Pages project. Its deployable root is `web/`;
there is no build command, Pages Function, Worker, binding, analytics integration, or
server-side secret. The preferred project is `desmoslock`, whose production URL is
`https://desmoslock.pages.dev`.

The concrete release target is `desmoslock/desmoslock-releases`; the organization,
public repository, Pages project, and `https://desmoslock.pages.dev` hostname now
exist. Do not deploy a placeholder, personal-repository URL, or fallback slug.

## Static contract

`web/_redirects` defines five temporary external redirects:

| Route | Stable target |
| --- | --- |
| `/download/mac` | `DesmosLock-mac.dmg` from the latest release |
| `/download/mac-intel` | `DesmosLock-mac-intel.dmg` from the latest release |
| `/download/windows` | `DesmosLock-setup.exe` from the latest release |
| `/download/linux` | `DesmosLock.AppImage` from the latest release |
| `/releases` | the latest release page |

`web/_headers` preserves the existing `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin` policy for static responses.
Cloudflare processes redirects before static header rules, so verify the two headers
on normal site pages and separately verify every redirect's status and location.

The deployable tree contains exactly 13 files: 11 static assets plus the special
`_headers` and `_redirects` configuration files. `web/404.html` is the custom static
not-found page. `web/robots.txt` asks compliant crawlers not to index `/admin`; it is
advisory and is not an access-control boundary. The bundle intentionally contains no
placeholder dotfile, `_worker.js`, `functions/` directory, or `_routes.json`.

Only browser-public configuration may ship. The tracked website contains a Supabase
project URL and `sb_publishable_` key used under row-level security. A service-role
key, private key, bearer token, password, or other privileged value is a release
blocker. The client configuration's claim must remain precise: the publishable key
authorizes only the anonymous/authenticated operations allowed by Supabase policies;
it is not a secret and it is not unlimited authority.

## Preview deployment

1. Verify the existing `desmoslock` Direct Upload Pages project still has production
   branch `main` and no Functions, bindings, analytics, or paid features. Use the
   authenticated Cloudflare connector; do not export an API credential into the
   repository or a deployment bundle.
2. After the recovery commit exists, generate the bundle and its integrity receipt
   into a new output path outside the source repository. The SHA argument must be the
   exact commit being deployed:

   ```bash
   node scripts/build-pages-manifest.mjs \
     0123456789012345678901234567890123456789 \
     web \
     /safe/receipt/path/desmoslock-pages-0123456789012345678901234567890123456789 \
     /safe/receipt/path/desmoslock-pages-0123456789012345678901234567890123456789.zip \
     /safe/receipt/path/desmoslock-pages-0123456789012345678901234567890123456789.json
   ```

   Replace the example SHA and paths. The generator requires the SHA to equal a
   completely clean checked-out HEAD and requires the executing generator to be the
   repository copy at that commit. It byte-compares the generator with its Git blob,
   rejects tracked/staged/untracked source drift plus ignored `web/` drift, and reads
   the 13-file allowlist directly from committed Git blobs. It scans those blobs for
   credential patterns and rejects Functions/runtime config. It materializes a fresh
   upload directory from those immutable blobs and verifies every written byte.
   It also creates a sorted, fixed-timestamp, uncompressed ZIP with a
   source-SHA-derived filename plus an integrity receipt containing the source
   web-tree object, generator blob/hash, every path/blob/byte size/MIME type/SHA-256
   value, the archive size/hash, and zero bundled
   Function/runtime-config/secret-pattern matches. The requested
   zero bindings/secrets/analytics setting is recorded separately because only the
   Cloudflare connector can verify external project state. Re-run into different
   empty directories using those same canonical basenames and require identical
   upload-directory bytes, ZIP hashes, and receipt hashes. The generator also
   validates the ZIP member bytes/list and prints the receipt's own SHA-256
   separately. Store the ZIP and JSON with the release receipt; do not add any output
   to the repository, which would change the bundle it describes.

   The JSON is a SHA-256 integrity receipt, not the Cloudflare REST API's deployment
   manifest. Wrangler computes its own transport hashes and submits `_headers` and
   `_redirects` as special configuration parts; its JavaScript transport MIME may
   also differ from the human-readable MIME recorded here. Keep those transport
   details distinct from the commit-bound integrity evidence.
3. Deploy the verified upload directory as a non-production preview from the
   authenticated, authorized Mini. Wrangler is not installed globally; the approved
   pinned Wrangler 4.121.0 device OAuth completed with only `account:read`,
   `user:read`, and `pages:write`, with encrypted Wrangler state backed by macOS
   Keychain. `whoami` and the exact `desmoslock` Direct Upload project preflight both
   passed, and no deployment has run. Re-run those read-only checks immediately
   before deployment. If the session has expired, repeat only the least-privilege
   device flow and stop for browser authorization; never create or export an API
   token:

   ```bash
   npx --yes wrangler@4.121.0 login \
     --device --browser=false --use-keyring \
     --scopes account:read user:read pages:write
   ```

   After the read-only preflight succeeds, deploy the exact generated directory:

   ```bash
   npx --yes wrangler@4.121.0 pages deploy \
     "/safe/receipt/path/desmoslock-pages-$SOURCE_SHA" \
     --project-name desmoslock \
     --branch preview \
     --commit-hash "$SOURCE_SHA" \
     --commit-message "DesmosLock v1.0.1 recovery preview" \
     --commit-dirty=false
   ```

   Upload the generated directory directly; never recopy from a mutable working
   directory and do not submit the integrity receipt as a raw REST manifest. Record
   the deployment ID, preview URL, exact source SHA, ZIP hash, and integrity-receipt
   hash. Use the Cloudflare connector to confirm zero Functions, bindings, secrets,
   and analytics.
4. At desktop and narrow mobile viewports, verify the homepage and `/admin`: no
   horizontal overflow, broken assets, console errors, or misleading macOS signing
   copy. Exercise pricing controls and validate the quote form without submitting a
   production quote.
5. Verify that the preview contains no `_worker.js` or `functions/` tree and has no
   configured bindings.
6. Verify the two security headers on `/`, `/admin`, CSS, and JavaScript responses.
7. Confirm `desmoslock/desmoslock-releases` is prepared. Issue Daniel's
   `desmoslock` organization-owner invitation and verify both the requested owner
   role and its live invitation URL. Because the Cloudflare preview now works, send
   the exact checkpoint email below from Nicky's connected Gmail account to
   `dholguines@gmail.com`, substituting only the actual invitation URL. Continue the
   release and site work if Daniel is delayed; do not wait for the source transfer.
8. Once public v1.0.1 exists, follow all five preview routes while logged out and
   verify the downloaded assets against the published checksum manifest.

If Daniel replies `done` at any point, verify that both partners are `desmoslock`
organization owners, the source is still private at `desmoslock/desmoslock`, the
remotes are correct, and all recorded full SHAs still match. A delayed reply leaves
only source co-ownership pending and does not block the repaired release or site.

Do not deploy production while any route points to a missing repository or asset.

## Production cutover

Production is allowed only after the immutable v1.0.1 release and its tag-specific,
latest, checksum, provenance, and private two-host Gatekeeper aggregate receipt pass.

1. Deploy the identical verified upload directory to the production branch of the
   same Pages project; do not regenerate it after preview acceptance:

   ```bash
   npx --yes wrangler@4.121.0 pages deploy \
     "/safe/receipt/path/desmoslock-pages-$SOURCE_SHA" \
     --project-name desmoslock \
     --branch main \
     --commit-hash "$SOURCE_SHA" \
     --commit-message "DesmosLock v1.0.1 recovery production" \
     --commit-dirty=false
   ```

   Record the production deployment ID and bundle receipt. Production remains gated
   on the public-release and preview checks; documenting the command does not
   authorize an early deployment.
2. Verify `https://desmoslock.pages.dev` from a logged-out browser. Test homepage,
   `/admin`, pricing, the quote form's client validation, Supabase connectivity,
   mobile layout, assets, console output, and the two security headers.
3. Follow all five routes. Require the four stable assets to download and `/releases`
   to reach v1.0.1. Compare every downloaded byte to `SHA256SUMS.txt` and require the
   unauthenticated latest-release API to name v1.0.1.
4. Only now merge the main recovery PR. That merge causes the old Vercel deployment's
   checked-in `vercel.json` to issue one path-preserving temporary redirect from every
   Vercel path to the Pages production URL.
5. Wait for Vercel production to report the exact main merge SHA. Verify `/`,
   `/admin`, all five release routes, query strings, and at least one nested static
   asset through `https://desmoslock.vercel.app`; each must arrive at the equivalent
   Pages path without a loop.
6. Leave the Vercel redirect active for seven full days from its production
   deployment. During that window, Pages is authoritative and Vercel is
   rollback-friendly forwarding only.
7. After seven days of healthy checks, Daniel deletes the old Vercel project. Record
   the deletion time in the release receipt.

Send this exact checkpoint message at preview step 7 only after an owner invitation
has been issued and its live URL has been verified. Replace the bracketed gate with
that exact URL before sending; the current zero-invitation state is not sufficient:

```text
Subject: DesmosLock: one GitHub transfer step

Hey Daniel — the no-cost DesmosLock release setup is ready. Please:

1. Accept this GitHub organization invitation: [actual invitation URL].
2. Open the DesmosLock repository’s Settings → General.
3. Scroll to Danger Zone → Transfer ownership.
4. Enter desmoslock as the new owner and desmoslock as the repository name, then confirm.
5. Reply “done.”

Please don’t merge PR #3, change the releases, buy Apple membership, or alter Vercel yet—I’ll handle the remaining release work.
```

Never merge the Vercel catch-all redirect before Pages production passes: doing so
would replace the current failure with a new unavailable destination.

References: [Cloudflare Pages redirects](https://developers.cloudflare.com/pages/configuration/redirects/),
[Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/), and
[Vercel redirects](https://vercel.com/docs/project-configuration/vercel-json#redirects).
