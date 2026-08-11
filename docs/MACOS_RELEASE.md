# macOS signing and release runbook

This runbook is for Daniel, the product and repository owner. The proposed v1.0.1
pipeline is prepared but not released: no signed and notarized v1.0.1 has been
published or accepted on customer machines. Keep the customer Gatekeeper issue open
until every automated and human gate below passes.

## Confirmed v1.0.0 root cause

The v1.0.0 DMG downloads and filesystems are intact. The Apple-silicon app has only
an invalid ad-hoc linker signature, the Intel app is unsigned, neither has a stapled
notarization ticket, and both fail `syspolicy_check distribution` with exit 70. The
v1.0.0 workflow caused this by setting `mac.identity` to `null` and exporting
`CSC_IDENTITY_AUTO_DISCOVERY=false`.

This draft configures v1.0.1 to require Developer ID signing, hardened runtime,
notarization, stapling, and Gatekeeper verification. Windows remains unsigned and is
outside this repair. Do not replace v1.0.0; ship the repair as v1.0.1 only after the
gates below pass.

## Authority boundary before credentials

GitHub warns that a collaborator with write access can use repository-level Actions
secrets by changing a workflow. Nicky currently has write access, so do **not** store
Apple credentials or release tokens as unrestricted repository secrets.

Before adding any credential, Daniel must configure these controls himself:

1. Create active source-repository rulesets for `main` and `release/1.0`. Require
   pull requests and Daniel's approval; block direct updates, force-pushes, and
   deletion. Configure Daniel as the only bypass actor.
2. Create an active tag ruleset targeting `v*`. Restrict tag creation, update, and
   deletion to Daniel through a Daniel-only bypass.
3. Create three dedicated GitHub Actions environments. Do not reuse Vercel's
   `Preview` or `Production` environments:
   - `macos-signing`: allow only branches `release/1.0` and `main`, plus tags `v*`;
   - `public-releases-read`: allow only tags `v*`;
   - `public-releases-write`: allow only tags `v*`.
4. Confirm the GitHub plan before adding credentials. Private environment secrets,
   deployment branch/tag policies, and private branch/tag rulesets require GitHub
   Pro, Team, or Enterprise. GitHub Free is not an adequate private-source boundary.
5. Required environment reviewers for private repositories are unavailable on Free,
   Pro, and Team. If private reviewer approval must persist, use an appropriate
   Enterprise organization/plan. Where reviewers are supported, make Daniel the only
   required reviewer and the only administrator allowed to bypass; do not prohibit
   self-review if Daniel will dispatch and approve the same run.
6. Confirm every selected protection remains effective after the source repository
   becomes private.

If the private plan has Pro-or-better environment ref policies and rulesets but lacks
private required reviewers, remove **all** non-Daniel write access and rely on the
Daniel-only ref/ruleset boundary. Otherwise move signing to a Daniel-only repository
or signing service. Upgrading to a plan with the required protections is also valid.
Do not add credentials to a private workflow boundary that the active plan ignores.

The workflow also fails closed before any environment-secret job starts. A manual
hotfix run must come from `refs/heads/release/1.0`; the forward-port accepts manual
runs only from `refs/heads/main`. A tag must match `desktop/package.json`, use strict
stable SemVer, and point to a commit contained in the workflow's fetched protected
branch. The external rulesets remain essential because a write collaborator could
otherwise change or remove an in-workflow check.

## Public releases repository

Before merging either PR:

1. Create public repository `danielholguin31/desmoslock-releases` with a minimal
   README and `main` default branch. Keep proprietary source and workflow files out.
2. Limit write/admin access to Daniel and protect its `main` branch and release tags.
3. Create a v1.0.0 release with these exact stable assets:
   - `DesmosLock-mac.dmg`
   - `DesmosLock-mac-intel.dmg`
   - `DesmosLock-setup.exe`
   - `DesmosLock.AppImage`
   - `SHA256SUMS.txt`
4. Record SHA-256 values before and after the mirror. Verify every tag-specific URL
   while logged out of GitHub.
5. Leave the current website and Vercel production deployment unchanged. The v1.0.0
   macOS artifacts remain unsigned; mirroring them does not repair them.

## Protected environment secrets

Add all eight values as **environment secrets**, never repository secrets. Environment
names and contents must match the job bindings in the workflow.

| Environment | Secret | Required format |
| --- | --- | --- |
| `macos-signing` | `CSC_LINK` | One-line base64 of the password-protected Developer ID Application `.p12`. |
| `macos-signing` | `CSC_KEY_PASSWORD` | Raw password used to export the `.p12`. |
| `macos-signing` | `APPLE_API_KEY_B64` | One-line base64 of the App Store Connect `.p8`. |
| `macos-signing` | `APPLE_API_KEY_ID` | 10-character uppercase-alphanumeric App Store Connect key ID. |
| `macos-signing` | `APPLE_API_ISSUER` | App Store Connect issuer UUID. |
| `macos-signing` | `APPLE_TEAM_ID` | 10-character uppercase-alphanumeric Apple team ID. |
| `public-releases-read` | `RELEASES_REPO_READ_TOKEN` | Raw fine-grained PAT, limited to `desmoslock-releases`, with Contents read only. Do not base64, quote, or add a newline. |
| `public-releases-write` | `RELEASES_REPO_TOKEN` | Separate raw fine-grained PAT, limited to `desmoslock-releases`, with Contents read/write. Do not base64, quote, or add a newline. |

Daniel should own both PATs. The identity behind `RELEASES_REPO_READ_TOKEN` must have
enough repository standing to view draft releases even though the token itself has
only Contents read permission. The read token is used only by fresh-runner draft
verification. `RELEASES_REPO_TOKEN` is reserved for draft staging, prerelease
publication, and stable/latest promotion; it never reaches a Gatekeeper runner.

The workflow decodes `APPLE_API_KEY_B64` to a mode-600 file under `$RUNNER_TEMP`,
exports its path as `APPLE_API_KEY`, and deletes it after the macOS job. Never put a
credential value in Git, an issue, a pull request, a log, or chat.

## Required rollout order

The order is mandatory because Vercel automatically deploys merges to `main`, and
PR #1 contains both the new public-repository redirects and copy describing signed
macOS installers.

1. Complete Apple enrollment and create the Developer ID Application certificate,
   password-protected `.p12`, App Store Connect API key, and one-time `.p8`.
2. Create and protect the public releases repository, mirror v1.0.0, configure the
   source rulesets and the three protected environments, then add the eight
   environment secrets.
3. Review and merge **hotfix PR #2 only** into protected `release/1.0`. Record its
   exact merge SHA. Keep **PR #1 draft and unmerged**.
4. Run `Build installers` with `workflow_dispatch` from the exact trusted
   `release/1.0` state. Approve only the `macos-signing` environment. Both macOS
   verifier invocations must pass.
5. Independently verify the dry-run artifacts on another supported Mac. If anything
   fails, stop and correct the cause through reviewed code; never weaken
   `forceCodeSigning` or the verifier.
6. Create `v1.0.1` at that exact tested `release/1.0` commit and push the new tag.
7. Let the tag workflow publish and verify v1.0.1 directly in the public releases
   repository. Complete fresh Chrome/Safari and Apple-silicon/Intel human tests.
8. Only after signed v1.0.1 is public, stable/latest, and verified may Daniel mark
   **PR #1** ready and merge it. That merge triggers Vercel's production deployment.
9. Wait for Vercel production to report PR #1's exact merge SHA. While logged out,
   test `/download/mac`, `/download/mac-intel`, `/download/windows`,
   `/download/linux`, and `/releases`, and compare downloads with the published
   checksum manifest.
10. Only then make the proprietary source repository private. Repeat the logged-out
    download tests and confirm all source rulesets and environments remain effective.

PR #1 must remain unmerged until signed v1.0.1 is publicly available and verified.
Merging both PRs before the dry run would deploy redirects to an unavailable target
and copy that does not describe the still-latest unsigned v1.0.0 macOS release.

## Exact workflow sequencing

For either a manual run or tag push, `trusted-source` runs first without custom
secrets. It validates the exact ref, package version, protected-branch ancestry, public
releases repository, and—for tags—the monotonic version against the unauthenticated
`releases/latest` API. A static repository-wide concurrency group serializes all
versions and reruns.

A manual dispatch builds and locally verifies artifacts only. It never creates or
changes a public release.

Tag runs pause at the `macos-signing`, `public-releases-read`, and
`public-releases-write` gates. Daniel must approve each expected job as it appears and
reject any unexpected ref or job. The write environment is used at multiple distinct
staging and promotion steps, so it may require more than one approval in a run.

After a trusted `v*` tag, the jobs run in this order:

1. Build unsigned Windows/Linux installers and separately build, sign, notarize,
   staple, and locally verify both macOS DMGs.
2. With `RELEASES_REPO_TOKEN`, stage the four stable filenames and
   `SHA256SUMS.txt` in a **draft prerelease**.
3. On fresh macOS, use only `RELEASES_REPO_READ_TOKEN` to download the draft, verify
   all checksums, rerun both Gatekeeper verifiers, and output the verified manifest's
   SHA-256 digest.
4. With the write token, publish the verified draft as a **public prerelease** with
   `make_latest=false`.
5. Without authentication, download `SHA256SUMS.txt` from
   `/releases/download/${GITHUB_REF_NAME}/`, require its digest to equal the verified
   draft digest, then download and verify every tag-specific asset.
6. Recheck that the version is newer than the current stable latest. Only then use
   the write token to set `prerelease=false` and `make_latest=true`.
7. Without authentication, require the GitHub `releases/latest` API to report
   `tag_name == GITHUB_REF_NAME`. Then download the manifest and all four assets from
   `/releases/latest/download/`, require the manifest digest to equal the verified
   draft digest, and verify every customer-facing download.

An older queued tag fails the monotonic guard and cannot replace a newer latest
release. If anonymous verification fails, the candidate remains a visible non-latest
prerelease; do not delete or overwrite it automatically. Resume only through a
reviewed, auditable recovery.

## Human acceptance

Before calling the customer issue fixed, preserve browser quarantine and test fresh
Chrome and Safari downloads. Test Apple silicon and Intel (real Intel hardware or
Rosetta where appropriate), normal drag-to-Applications and double-click launch,
Desmos loading, teacher login, student join, other-app scanning, lock/unlock, restart
recovery, and multiple-display coverage.

For an additional local verifier run:

```bash
desktop/scripts/verify-macos-dmg.sh DesmosLock-mac.dmg arm64
desktop/scripts/verify-macos-dmg.sh DesmosLock-mac-intel.dmg x86_64
```

`xattr -dr com.apple.quarantine /Applications/DesmosLock.app` is a diagnostic bypass
only. It removes a security control, does not repair signing or notarization, and must
never be given to customers or used for release acceptance.

## Rotation and revocation

- Revoke and replace a compromised Developer ID certificate, then update `CSC_LINK`
  and `CSC_KEY_PASSWORD` together.
- Revoke and replace a compromised App Store Connect key, then update
  `APPLE_API_KEY_B64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` together.
- Revoke and replace either PAT independently with the same single-repository,
  least-privilege scope. Never substitute the write PAT into the read environment.
- Remove obsolete secrets after rotation and audit workflow runs and repository
  access. Never retain decoded keys longer than needed.

## Daniel-owned release checklist

- [ ] Apple enrollment, certificate, `.p12`, API key, and `.p8` completed.
- [ ] Public releases repository created, protected, and v1.0.0 mirrored and checked.
- [ ] Source `main`, `release/1.0`, and `v*` rulesets active with Daniel-only bypass.
- [ ] Three dedicated environments restricted to the documented branches and tags.
- [ ] Private plan supports environment secrets/ref policies and rulesets (Pro+); if
  private reviewer approval is required, use Enterprise. Otherwise remove every
  non-Daniel writer and rely on the supported ref/ruleset boundary, or move signing.
- [ ] Eight environment secrets added in the documented least-privilege split.
- [ ] PR #2 reviewed and merged alone; PR #1 still draft and unmerged.
- [ ] Signed `workflow_dispatch` from exact protected `release/1.0` passes both DMGs.
- [ ] v1.0.1 tagged at that tested commit only after the dry run.
- [ ] Draft, fresh-macOS, public-prerelease, tag-specific anonymous, promotion,
  unauthenticated latest-API, and latest customer-download gates all pass.
- [ ] Chrome/Safari and Apple-silicon/Intel human acceptance passes.
- [ ] PR #1 merged only now; exact Vercel production deployment verified logged out.
- [ ] Source made private only after every redirect and checksum passes; protections
  rechecked afterward.

References: [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use),
[GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), and
[electron-builder notarization](https://www.electron.build/docs/features/code-signing/notarization/).
