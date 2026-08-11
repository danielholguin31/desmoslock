# macOS release runbook

DesmosLock macOS releases must be signed with Daniel's Developer ID Application
identity, notarized by Apple, stapled, and accepted by Gatekeeper before customers
receive them. A release is not successful merely because a DMG builds or opens.

## Confirmed v1.0.0 failure

The v1.0.0 release workflow deliberately disabled signing with `mac.identity: null`
and `CSC_IDENTITY_AUTO_DISCOVERY=false`. The Apple-silicon app has only an invalid
ad-hoc linker signature, the Intel app is unsigned, and neither app has a notarization
ticket. Both DMGs are intact, but `syspolicy_check distribution DesmosLock.app`
exits 70 for both builds. This is a signing and notarization failure, not a download or DMG
integrity problem.

The v1.0.1 hotfix enables macOS-only forced code signing and hardened runtime, applies
explicit Electron entitlements, and notarizes with an App Store Connect API key.
Windows remains unsigned and is outside this repair.

## Daniel-owned prerequisites

Daniel owns the signing identity, Apple account, public binary repository, and
repository settings. Complete these steps without sending credential material to a
contributor or putting it in an issue, commit, pull request, log, or chat:

1. Choose Organization or Individual Apple Developer Program enrollment.
2. Enroll the business team in the Apple Developer Program.
3. Have the Account Holder create a **Developer ID Application** certificate.
4. Export that certificate and its private key as a password-protected `.p12`.
5. Create an App Store Connect API key and retain its one-time-download `.p8` file.
6. Create the public repository `danielholguin31/desmoslock-releases` with only a
   minimal README and a `main` default branch.
7. Mirror the existing v1.0.0 assets there before changing website redirects.
8. Create a fine-grained personal access token with **Contents: read and write** on
   only `danielholguin31/desmoslock-releases`.
9. Add every GitHub Actions secret named below himself.
10. Review and merge the release PRs only after the public repository exists.
11. Run `workflow_dispatch` from trusted, merged code and approve the signed dry run.
12. Tag v1.0.1 from `release/1.0` only after the dry run passes.
13. Verify fresh Chrome and Safari downloads on macOS.
14. Deploy the redirect change and test every download while logged out of GitHub.
15. Only then make the proprietary source repository private.

## GitHub Actions secrets

Configure these secrets in the private source repository's Actions settings. Store
only the encoded or textual value described here—never the labels or examples below
as placeholder secret values.

| Secret | Required format |
| --- | --- |
| `CSC_LINK` | Base64-encoded bytes of the password-protected Developer ID Application `.p12`, as one line. |
| `CSC_KEY_PASSWORD` | The `.p12` export password. |
| `APPLE_API_KEY_B64` | Base64-encoded bytes of the App Store Connect `.p8`, as one line. |
| `APPLE_API_KEY_ID` | The 10-character App Store Connect key ID. |
| `APPLE_API_ISSUER` | The App Store Connect issuer ID in UUID form. |
| `APPLE_TEAM_ID` | The 10-character Apple Developer team ID that owns the certificate. |
| `RELEASES_REPO_TOKEN` | A fine-grained PAT limited to Contents read/write on `danielholguin31/desmoslock-releases`. |

For example, Daniel can encode either binary credential locally with `base64` and
remove line breaks before pasting the result into GitHub. Do not add encoded
credentials to shell history. The workflow decodes `APPLE_API_KEY_B64` to a mode-600
file under `$RUNNER_TEMP` and exports its path as `APPLE_API_KEY`, which is the input
format expected by electron-builder 25.1.8. Apple secrets are scoped only to the
macOS build job; the cross-repository token is scoped only to release jobs.

## Set up the public releases repository

1. Create `danielholguin31/desmoslock-releases` as a public repository with a minimal
   README committed on `main`.
2. Create a v1.0.0 release there and upload the existing stable assets:
   `DesmosLock-mac.dmg`, `DesmosLock-mac-intel.dmg`, `DesmosLock-setup.exe`, and
   `DesmosLock.AppImage`.
3. Generate and upload `SHA256SUMS.txt`, then confirm each public download matches it
   in a logged-out browser session.
4. Keep the website routes pointed at the current source repository until the mirror
   is complete and independently verified.
5. Add the repository-scoped token to the private source repository as
   `RELEASES_REPO_TOKEN`; do not add Apple credentials to the public repository.

Private GitHub release assets require authentication. The source repository must not
be made private until the website points to the public releases repository and every
route works without a GitHub session.

## Signed dry run

After the hotfix is merged into `release/1.0` and all prerequisites and secrets are
in place:

1. In the private source repository, open **Actions → Build installers → Run
   workflow** and select `release/1.0`.
2. Confirm the macOS job uses Node 20/npm 10, imports the Developer ID certificate,
   signs both architectures with hardened runtime, and completes Apple notarization.
3. Confirm both invocations of `desktop/scripts/verify-macos-dmg.sh` pass. The final
   Apple acceptance command is `syspolicy_check distribution DesmosLock.app`; it
   must exit 0 and report that the app passed all pre-distribution checks and is ready
   for distribution.
4. Download the workflow's internal artifacts for review. A manual dispatch never
   creates, changes, or publishes a public release.
5. Do not weaken `forceCodeSigning` if the job fails. Correct the certificate,
   secret, entitlement, or notarization problem and run the dry run again.

## Tag and release v1.0.1

Only after the signed dry run passes, Daniel may create `v1.0.1` at the reviewed
`release/1.0` commit and push that tag. The tag workflow then:

1. Builds Windows and Linux without Apple credentials and builds, signs, notarizes,
   and locally verifies both macOS DMGs in the macOS-only job.
2. Stages the customer filenames `DesmosLock-mac.dmg`,
   `DesmosLock-mac-intel.dmg`, `DesmosLock-setup.exe`, and `DesmosLock.AppImage`, plus
   `SHA256SUMS.txt`.
3. Creates a **draft** v1.0.1 release in
   `danielholguin31/desmoslock-releases`, recording the private source commit SHA.
4. Downloads all draft assets on a fresh macOS runner, verifies every checksum, and
   reruns the full Gatekeeper verifier against both DMGs.
5. Publishes the draft only if all checks pass, then downloads every public asset
   again without authentication and rechecks the SHA-256 values.

For an additional local check on a supported macOS host:

```bash
desktop/scripts/verify-macos-dmg.sh DesmosLock-mac.dmg arm64
desktop/scripts/verify-macos-dmg.sh DesmosLock-mac-intel.dmg x86_64
```

The verifier requires exactly one `DesmosLock.app`, the expected thin executable
architecture, a valid Developer ID Application signature and TeamIdentifier,
hardened-runtime flags, a secure timestamp, a valid stapled notarization ticket, and
successful `syspolicy_check` and `spctl` assessments.

## Human acceptance test

Before calling the customer issue fixed, test fresh Chrome and Safari downloads with
quarantine preserved. On both Apple silicon and Intel (real Intel hardware or Rosetta
where appropriate), drag the app to Applications and launch it by ordinary
double-click. Exercise Desmos loading, teacher login, student join, other-app
scanning, lock and unlock, restart recovery, and multiple-display coverage.

After any source-visibility change, repeat every website download while logged out of
GitHub and confirm its SHA-256 value matches the published checksum file.

## Credential rotation and revocation

- If the `.p12` or its password is exposed, revoke the Developer ID certificate in
  the Apple Developer portal, issue a replacement, export a new `.p12`, and replace
  both `CSC_LINK` and `CSC_KEY_PASSWORD`.
- If the `.p8`, key ID, or issuer ID is exposed, revoke that API key in App Store
  Connect, create a replacement, retain its new one-time `.p8`, and replace the three
  corresponding secrets.
- If the fine-grained PAT is exposed or its scope is no longer minimal, revoke it,
  create a repository-limited replacement, and update `RELEASES_REPO_TOKEN`.
- Remove obsolete secrets after a successful rotation. Review Actions logs and
  repository access, and invalidate any artifact built with untrusted credentials.

## Diagnostic bypass warning

`xattr -dr com.apple.quarantine /Applications/DesmosLock.app` is only a diagnostic
bypass. It removes evidence needed to exercise the normal Gatekeeper path, does not
repair an invalid signature or add a notarization ticket, and must never be given to
customers as an installation step. Preserve quarantine for release acceptance tests.

Official references: [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[electron-builder notarization](https://www.electron.build/docs/features/code-signing/notarization/),
and [GitHub release assets](https://docs.github.com/en/rest/releases/assets).
