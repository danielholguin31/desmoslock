# macOS signing and release runbook

This runbook is for Daniel, the product and repository owner. The workflow is
configured to fail closed: it will not produce a macOS release without a valid
Developer ID signature, hardened runtime, secure timestamp, notarization ticket,
and successful Gatekeeper distribution assessment.

## Confirmed v1.0.0 root cause

The download route, DMG transport, and DMG filesystem are not the failure. Both
released v1.0.0 DMGs match GitHub's recorded hashes and pass `hdiutil verify`.
The Apple-silicon app has only an invalid ad-hoc linker signature, the Intel app
is unsigned, and neither has a stapled notarization ticket. Both fail
`syspolicy_check distribution` with exit 70.

The v1.0.0 release configuration caused that result by setting `mac.identity` to
`null` and exporting `CSC_IDENTITY_AUTO_DISCOVERY=false`. The repaired pipeline
instead requires Developer ID signing and notarization. Do not replace the
immutable v1.0.0 release; ship the repair as v1.0.1.

## External prerequisites

These steps are intentionally not automated and must be completed by Daniel or
the appropriate Apple Account Holder:

1. Choose Organization or Individual Apple Developer Program enrollment.
2. Enroll Daniel's business team in the Apple Developer Program.
3. Have the Account Holder create a Developer ID Application certificate.
4. Export the certificate together with its private key as a password-protected
   `.p12`. Never commit or attach it to an issue or pull request.
5. Create an App Store Connect API key and retain its one-time `.p8` download.
6. Create the public repository `danielholguin31/desmoslock-releases` with a
   minimal README on its `main` branch. It must contain public binaries and
   release notes only, never proprietary source.
7. Create a fine-grained personal access token limited to Contents read/write on
   only `danielholguin31/desmoslock-releases`.

## Required GitHub Actions secrets

Add these repository Actions secrets yourself. Values must never appear in Git,
workflow logs, pull request text, or support messages.

| Secret | Expected format |
| --- | --- |
| `CSC_LINK` | Base64-encoded contents of the password-protected Developer ID Application `.p12`, as one line |
| `CSC_KEY_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_API_KEY_B64` | Base64-encoded contents of the App Store Connect `.p8`, as one line |
| `APPLE_API_KEY_ID` | 10-character uppercase-alphanumeric App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID in UUID form |
| `APPLE_TEAM_ID` | 10-character uppercase-alphanumeric Apple Developer team identifier |
| `RELEASES_REPO_TOKEN` | Fine-grained token with Contents read/write on only `danielholguin31/desmoslock-releases` |

The workflow decodes `APPLE_API_KEY_B64` to a mode-600 file under
`$RUNNER_TEMP`, exports that filesystem path as `APPLE_API_KEY`, and deletes the
file after the macOS job. electron-builder 25.1.8 expects the path, not the key
contents. Apple credentials are scoped only to the macOS build job. The releases
token is scoped only to draft staging, draft verification, and publication.

## Prepare the public binary repository

Before changing the website destination, mirror the existing v1.0.0 release into
`danielholguin31/desmoslock-releases` under a v1.0.0 release. Preserve these
stable filenames exactly:

- `DesmosLock-mac.dmg`
- `DesmosLock-mac-intel.dmg`
- `DesmosLock-setup.exe`
- `DesmosLock.AppImage`

Record SHA-256 values before and after the mirror and require them to match. The
source repository must remain public until unauthenticated downloads from the
new repository have been tested. Do not deploy `vercel.json`'s redirect changes
until the v1.0.0 mirror exists and the signed v1.0.1 release is ready.

## Signed dry run

Only run signing workflows from reviewed, trusted, merged code. After the Apple
and GitHub prerequisites are complete:

1. Confirm all seven named secrets exist without printing their values.
2. Run the `Build and verify installers` workflow with `workflow_dispatch` from
   the trusted `release/1.0` branch for the v1.0.1 hotfix.
3. Confirm both macOS artifacts build with Developer ID signing and notarization.
4. Confirm both invocations of `desktop/scripts/verify-macos-dmg.sh` pass.
5. Download the workflow artifacts and repeat verification on a separate Mac:

   ```bash
   desktop/scripts/verify-macos-dmg.sh /path/to/DesmosLock-mac.dmg arm64
   desktop/scripts/verify-macos-dmg.sh /path/to/DesmosLock-mac-intel.dmg x86_64
   ```

A manual dispatch builds and verifies only. It never creates or publishes a
release. If any signing or Gatekeeper check fails, keep the pull request in draft
and fix the cause; never disable `forceCodeSigning` or weaken the verifier.

## Publish v1.0.1

After the signed dry run passes, tag the tested `release/1.0` commit as v1.0.1
and push that new tag. Do not move or replace v1.0.0.

On a `v*` tag push, the workflow:

1. Rebuilds macOS separately from unsigned Windows and Linux builds.
2. Verifies both mounted macOS apps before uploading build artifacts.
3. Stages the four stable customer filenames plus `SHA256SUMS.txt` in a draft
   release in `danielholguin31/desmoslock-releases`.
4. Records the private source commit SHA in the release body.
5. Downloads the draft assets on a fresh macOS runner, checks the SHA-256 file,
   and repeats both full Gatekeeper verifications.
6. Publishes the draft only after those checks pass.
7. Downloads every published asset without authentication and checks the hashes
   again.

The acceptance boundary is the mounted `DesmosLock.app`. For each architecture,
the verifier requires:

- a valid DMG filesystem;
- exactly one `DesmosLock.app` with the expected executable architecture;
- `codesign --verify --deep --strict` success;
- a Developer ID Application leaf authority, TeamIdentifier, hardened-runtime
  flag, and secure timestamp;
- a valid stapled notarization ticket;
- `syspolicy_check distribution` exit 0; and
- a successful secondary `spctl` assessment.

The expected final policy result includes:

```text
App passed all pre-distribution checks and is ready for distribution.
```

## Customer installation and smoke test

The supported macOS installation is ordinary: open the DMG, drag DesmosLock to
Applications, and double-click DesmosLock in Applications. A fresh browser
download must keep its quarantine attribute; passing Gatekeeper with quarantine
preserved is part of release acceptance.

Test both arm64 and Intel builds, using real Intel hardware or Rosetta where
appropriate. The final human smoke test covers:

- fresh Chrome and Safari downloads with quarantine preserved;
- drag to Applications and ordinary double-click launch;
- Desmos loading;
- teacher login;
- student join;
- other-app scanning;
- lock and unlock;
- restart recovery; and
- multiple-display coverage.

`xattr -dr com.apple.quarantine /Applications/DesmosLock.app` is a diagnostic
bypass only. It may help confirm that Gatekeeper is the failing layer in an old
or test build, but it removes a security control and must never be given to
customers as the fix or used to accept a release.

After v1.0.1 passes, deploy the website redirect change and test every route while
logged out of GitHub. Confirm each download matches the published SHA-256 value.
Only then may the proprietary source repository be made private.

## Rotation and revocation

- Rotate the public-repository token on Daniel's normal credential schedule and
  immediately after suspected exposure. Revoke the old token, create another
  least-privilege token, update only `RELEASES_REPO_TOKEN`, and run a trusted dry
  run before the next tag.
- Revoke a compromised App Store Connect API key in App Store Connect, create a
  replacement, and update `APPLE_API_KEY_B64`, `APPLE_API_KEY_ID`, and
  `APPLE_API_ISSUER` together.
- Revoke a compromised Developer ID certificate in the Apple developer account,
  create and export a replacement, then update `CSC_LINK` and
  `CSC_KEY_PASSWORD` together.
- Remove obsolete secrets after rotation. Never retain decoded keys on runners or
  developer machines longer than needed.

## Daniel-owned release checklist

1. Choose Organization or Individual Apple enrollment.
2. Enroll the business team in the Apple Developer Program.
3. Have the Account Holder create a Developer ID Application certificate.
4. Export the certificate and private key as a password-protected `.p12`.
5. Create an App Store Connect API key and retain its one-time `.p8`.
6. Create public repository `danielholguin31/desmoslock-releases` with only a
   minimal README.
7. Mirror the existing v1.0.0 assets there before changing website redirects.
8. Create a fine-grained PAT limited to Contents read/write on only the public
   releases repository.
9. Add the seven named GitHub Actions secrets himself.
10. Review and merge the draft pull requests only after the public repository
    exists.
11. Run `workflow_dispatch` from trusted merged code and approve the signed dry
    run.
12. Tag v1.0.1 from `release/1.0` only after the dry run passes.
13. Verify fresh Chrome and Safari downloads.
14. Deploy the redirect change and test downloads while logged out.
15. Only then make the proprietary source repository private.

## References

- [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder notarization](https://www.electron.build/docs/features/code-signing/notarization/)
- [GitHub release assets](https://docs.github.com/en/rest/releases/assets)
