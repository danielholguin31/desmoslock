# Zero-cost v1.0.1 recovery release

This runbook replaces the paid Developer ID, notarization, protected-environment,
and cross-repository-token design. The v1.0.1 macOS builds use an explicit ad-hoc
identity. They retain hardened runtime and the existing Electron entitlements, but
they are **not Developer ID signed and are not notarized**.

The expected first-launch path is a macOS unidentified-developer block followed by
the one-time **System Settings > Privacy & Security > Open Anyway** action. A build
that says it is damaged, fails strict signature verification, or cannot launch after
Open Anyway is defective. Do not weaken Gatekeeper or give customers a quarantine
removal command.

The public release target is `desmoslock/desmoslock-releases`. Never republish the
defective v1.0.0 Mac DMGs and never merge the obsolete PR #3.

The v1.0.1 recovery build itself comes from the reviewed `release/1.0` replacement.
Afterward, `main` carries the same validated builder and offline assembly code, with
its manual workflow bound to the exact `main` head instead. The forward-port must
not be used to bypass or replace the recorded `release/1.0` build used for v1.0.1.

## Trust and cost boundary

- The private source workflow has `contents: read` permission and no custom secrets,
  environments, release token, tag trigger, or publishing job.
- The private source repository may not have paid branch/ruleset controls. Use
  reviewed pull requests only, record full commit SHAs, keep an independent backup,
  and make every build prove its exact `release/1.0` source.
- The v1.0.1 recovery run on `release/1.0` is accepted only from
  `refs/heads/release/1.0`, only when the required `source_repository` equals the
  actual workflow/event/runner repository identity, only when the 40-character
  `source_sha` equals both the dispatch commit and fetched branch HEAD, and only when
  `desktop/package.json` is exactly version 1.0.1. The forward-ported workflow on
  `main` applies the same contract to `refs/heads/main` and fetched `main`; it is not
  a substitute source for the v1.0.1 release.
- Every build job checks out that output SHA rather than an ambient branch or tag.
  Tag pushes—including tag deletions and their fallback SHAs—are not workflow
  triggers. The preflight also rejects an event explicitly marked deleted if the
  trigger configuration ever regresses.
- Windows and Linux artifacts embed the actual source/workflow repository name and
  numeric ID, source SHA, run attempt, UTC build time, exact Node/npm/electron-builder
  versions, stable hosted-runner attributes, installer hash and size, platform,
  target architecture, and version metadata. The Windows build
  also uploads and hashes its unpacked application payload so offline assembly can
  independently prove AMD64 (`0x8664`) while recording the expected 32-bit NSIS
  wrapper machine (`0x014c`).
- Fetch GitHub run JSON, artifact JSON, and artifact ZIPs in a separate read step.
  The assembler consumes those explicit files offline, invokes no network client,
  and rejects GitHub or release-token environment variables.
- Spend $0: do not purchase Apple membership, certificates, hosted runners, GitHub
  plan upgrades, or other release services.
- The workflow uses only the included GitHub Free Actions allowance for short
  Windows and Linux jobs, with one-day artifact retention. If included capacity is
  unavailable, stop and wait; never buy minutes or increase a plan. macOS builds run
  only on the Mac Mini, not on a hosted macOS runner.
- Official checkout, Node setup, and artifact-upload actions are pinned to reviewed
  full v4 commit SHAs. Project scripts run on Node 22, matching the locked Supabase
  package engines, and hosted builds install the explicit npm 10.9.9 release.

## macOS build contract

`desktop/package.json` explicitly sets:

```json
{
  "forceCodeSigning": true,
  "hardenedRuntime": true,
  "notarize": false,
  "identity": "-",
  "sign": "./scripts/sign-macos-adhoc.js",
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.inherit.plist"
}
```

The `-` identity is the explicit ad-hoc signing identity. The locked electron-builder
25 release does not resolve that sentinel through its certificate lookup, so the
small configured hook passes it directly to the locked `@electron/osx-sign` API and
refuses profiles or non-macOS bundles. Both entitlement files retain `allow-jit`,
`allow-unsigned-executable-memory`, and
`disable-library-validation`; the last entitlement is required for Electron's
pre-signed frameworks to launch under hardened runtime with an ad-hoc identity.

For each thin arm64 and x86_64 DMG,
`desktop/scripts/verify-macos-dmg.sh` must:

1. pass `hdiutil verify`;
2. mount read-only at a private temporary path and find exactly one app;
3. find exactly the requested executable architecture;
4. pass `codesign --verify --deep --strict`;
5. report `Signature=adhoc`, no certificate authority, and the runtime flag; and
6. extract and confirm all three required entitlements.

These checks prove structural integrity and the intended ad-hoc signature. They do
not claim notarization or ordinary Gatekeeper acceptance.

## Build one exact source commit

Merge the reviewed replacement PR into `release/1.0` and record the resulting full
commit SHA:

```bash
SOURCE_REPOSITORY=danielholguin31/desmoslock
TRUSTED_BRANCH=release/1.0
SOURCE_SHA=$(git rev-parse HEAD)
test "${#SOURCE_SHA}" -eq 40
test "$(git status --short)" = ""
test "$(git remote get-url origin)" = \
  "https://github.com/$SOURCE_REPOSITORY.git"
```

`SOURCE_REPOSITORY` is the repository that actually hosts this source and workflow
run, not the intended future owner. Before Daniel transfers, it is
`danielholguin31/desmoslock`. After a completed transfer, first update `origin` to
the organization URL and only then use `desmoslock/desmoslock`. If a transfer happens
mid-cycle, discard the candidate and rebuild; GitHub's redirect from the old remote
URL is not source-identity evidence.

Choose one existing, operator-controlled work root outside the source checkout. All
generated Mac output, downloaded evidence, and final assembly paths must be outside
the checkout or the exact-source clean gate will reject them:

```bash
SOURCE_ROOT=$(git rev-parse --show-toplevel)
RELEASE_WORK_ROOT=<absolute-existing-directory-outside-source-checkout>
case "$RELEASE_WORK_ROOT/" in "$SOURCE_ROOT/"*) exit 1 ;; esac
MAC_BUILD_DIR="$RELEASE_WORK_ROOT/macos-$SOURCE_SHA"
EVIDENCE_DIR="$RELEASE_WORK_ROOT/evidence-$SOURCE_SHA"
OUTPUT_DIR="$RELEASE_WORK_ROOT/release-$SOURCE_SHA"
test ! -e "$MAC_BUILD_DIR"
test ! -e "$EVIDENCE_DIR"
test ! -e "$OUTPUT_DIR"
```

From the Actions page, select **Build v1.0.1 recovery installers**, choose the exact
`release/1.0` branch, paste that same full SHA into `source_sha`, and paste the same
actual `SOURCE_REPOSITORY` into `source_repository`. The preflight compares it with
the workflow, event, runner, checkout-origin, and numeric repository identities. The
run must finish with all three jobs successful:

1. `Bind the run to exact release/1.0 source`
2. `Build Windows installer`
3. `Build Linux AppImage`

Build the final Mac inputs on the Mac Mini from the same clean SHA, with no release
credential present:

```bash
desktop/scripts/build-macos-adhoc.sh \
  --source-sha "$SOURCE_SHA" \
  --source-repository "$SOURCE_REPOSITORY" \
  --trusted-branch "$TRUSTED_BRANCH" \
  --output-dir "$MAC_BUILD_DIR"
```

This creates two versioned DMGs plus `MACOS-BUILD-METADATA.json`; it does not publish.

Record the Actions run ID and the numeric Windows/Linux artifact IDs. They can be
listed without downloading the assets:

```bash
RUN_ID=<successful-workflow-run-id>
WINDOWS_RUN_ID=$RUN_ID
LINUX_RUN_ID=$RUN_ID
gh api "repos/$SOURCE_REPOSITORY/actions/runs/$RUN_ID/artifacts" \
  --jq '.artifacts[] | [.name, .id, .expired] | @tsv'
```

The expected names are `installer-windows-$SOURCE_SHA` and
`installer-linux-$SOURCE_SHA`. Never select artifacts by a friendly name alone;
record their immutable numeric IDs. In a separate authenticated read step, save the
exact API responses and ZIP bytes used for assembly:

```bash
mkdir "$EVIDENCE_DIR"
gh api "repos/$SOURCE_REPOSITORY/actions/runs/$WINDOWS_RUN_ID" \
  > "$EVIDENCE_DIR/windows-run.json"
gh api "repos/$SOURCE_REPOSITORY/actions/artifacts/$WINDOWS_ARTIFACT_ID" \
  > "$EVIDENCE_DIR/windows-artifact.json"
gh api "repos/$SOURCE_REPOSITORY/actions/artifacts/$WINDOWS_ARTIFACT_ID/zip" \
  > "$EVIDENCE_DIR/windows-artifact.zip"
gh api "repos/$SOURCE_REPOSITORY/actions/runs/$LINUX_RUN_ID" \
  > "$EVIDENCE_DIR/linux-run.json"
gh api "repos/$SOURCE_REPOSITORY/actions/artifacts/$LINUX_ARTIFACT_ID" \
  > "$EVIDENCE_DIR/linux-artifact.json"
gh api "repos/$SOURCE_REPOSITORY/actions/artifacts/$LINUX_ARTIFACT_ID/zip" \
  > "$EVIDENCE_DIR/linux-artifact.zip"
```

Leave that authenticated shell before assembly. The evidence files are not release
assets; retain their SHA-256 values in provenance for the audit trail.

## Assemble exactly six stable files

Use a clean checkout whose `HEAD` is the recorded source SHA and an output directory
that does not yet exist. Run with an empty environment except for the executable and
temporary-directory paths; do not pass GitHub or publisher credentials.

```bash
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
desktop/scripts/assemble-release.sh \
  --source-sha "$SOURCE_SHA" \
  --source-repository "$SOURCE_REPOSITORY" \
  --trusted-branch "$TRUSTED_BRANCH" \
  --mac-arm64-dmg "$MAC_BUILD_DIR/DesmosLock-1.0.1-arm64.dmg" \
  --mac-x64-dmg "$MAC_BUILD_DIR/DesmosLock-1.0.1-x64.dmg" \
  --mac-build-metadata "$MAC_BUILD_DIR/MACOS-BUILD-METADATA.json" \
  --windows-run-id "$WINDOWS_RUN_ID" \
  --windows-artifact-id "$WINDOWS_ARTIFACT_ID" \
  --windows-run-json "$EVIDENCE_DIR/windows-run.json" \
  --windows-artifact-json "$EVIDENCE_DIR/windows-artifact.json" \
  --windows-artifact-zip "$EVIDENCE_DIR/windows-artifact.zip" \
  --linux-run-id "$LINUX_RUN_ID" \
  --linux-artifact-id "$LINUX_ARTIFACT_ID" \
  --linux-run-json "$EVIDENCE_DIR/linux-run.json" \
  --linux-artifact-json "$EVIDENCE_DIR/linux-artifact.json" \
  --linux-artifact-zip "$EVIDENCE_DIR/linux-artifact.zip" \
  --output-dir "$OUTPUT_DIR"
```

The local builder installs the locked dependencies, including the platform-resolved
`7zip-bin` executable used later for offline NSIS inspection. Because a fresh npm
archive can lose its executable bit on macOS, the assembler first requires that the
resolved binary is a regular, non-symlink file inside that exact locked package and
then applies mode 0755 to that one file. The assembler makes no network request. It
validates both successful workflow runs, their actual source/workflow repository
name and ID and trusted branch, run attempts, artifact repository IDs, artifact IDs,
GitHub API artifact digests and byte counts, embedded source/workflow repository,
UTC build-time, exact tool-version, and stable runner metadata, actual installer
hashes and sizes, the
uploaded Windows payload hash and machine, Windows wrapper machine, Linux
architecture, and also extracts the installer's own `DesmosLock.exe` and
`resources/app.asar`. The embedded executable must be AMD64, and the embedded
`app.asar` must byte-match the separately uploaded unpacked copy. It also validates
local Mac source/OS/Xcode-or-CLT/tool metadata, strict Mac signatures, DMG containers,
and source SHAs. It then
creates exactly:

```text
DesmosLock-mac.dmg
DesmosLock-mac-intel.dmg
DesmosLock-setup.exe
DesmosLock.AppImage
SHA256SUMS.txt
RELEASE-PROVENANCE.json
```

`SHA256SUMS.txt` covers the four installers and `RELEASE-PROVENANCE.json`. Check it
again from outside the script:

```bash
(cd "$OUTPUT_DIR" && shasum -a 256 --check SHA256SUMS.txt)
```

The provenance schema and validation rules are defined in
[RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md).

## Separate renderer security follow-up

The remotely loaded Desmos calculator script currently runs in the same renderer
main world as the preload bridge, which includes privileged lock-control methods.
The focused force-quit recovery fix does not isolate that remote script or narrow
the bridge. Treat this as a separate material security follow-up outside the focused
v1.0.1 packaging and restore correction: recovery tests prove startup ordering and
error handling, not that remote calculator code is unable to request a lock release.
Do not claim that the renderer is isolated or that this follow-up is fixed.

## Pre-publication acceptance

Do not expose a public-release write credential until assembly and independent file
inspection pass. Require exactly six regular files and no symlinks, re-run the strict
DMG verifier, verify `SHA256SUMS.txt`, and compare every provenance field with the
recorded source, Actions run, artifact IDs, evidence files, and installer bytes.

Open one separate publishing session and perform only one public release operation at
a time. In that session:

1. Reconfirm that `desmoslock/desmoslock-releases` is public, its `main` and `v*`
   rulesets still block force-push/deletion to the extent supported by GitHub Free,
   immutable releases are enabled, and no `v1.0.1` tag or release already exists.
2. Create an annotated `v1.0.1` tag at the exact `SOURCE_SHA` in the private source
   repository. Read the remote tag back, dereference it, and require the same full SHA.
   Never move or reuse that tag.
3. Create a **draft** `v1.0.1` release in the public releases repository, targeted at
   its reviewed `main`, and upload only the six assembled files.
4. Authenticated-redownload that draft into a new empty directory. Require exactly the
   six stable filenames, compare every byte with the accepted local candidate, and
   verify the redownloaded checksum manifest before any human test.
5. From fresh Safari and Chrome downloads of those exact draft DMGs, preserve browser
   quarantine and test Apple silicon plus x64 under Rosetta. A real Intel Mac is
   preferable; record physical Intel as unavailable if none exists.

The draft release notes must say:

> macOS builds are ad-hoc signed, not notarized, and require a one-time System
> Settings > Privacy & Security > Open Anyway action. Windows publisher signing is
> not yet in place. Build provenance and SHA-256 values are attached.

The first Mac launch must show the unidentified-developer/Open Anyway path, never a
damaged-app message. Open Anyway must launch the app and subsequent normal launches
must work.

Complete the product smoke suite on the candidate:

- teacher login and student join;
- Desmos load and graph interaction;
- other-app scanning;
- lock and unlock;
- after force-quitting or rebooting, manually launch the app and verify restoration
  of a still-active locked session and the most recently autosaved graph; automatic
  relaunch is not supported;
- blocked shortcuts; and
- multi-display coverage and display changes.

Stop on any failure. Replace source through a reviewed PR and generate a new candidate;
never weaken the verifier or Gatekeeper.

## Publish and verify the immutable release

Only after automated and human acceptance passes, recheck the unauthenticated latest
release immediately before promotion. Stop if any stable release is already
`v1.0.1` or newer; an older queued release must never replace a newer latest release.
Then publish the existing draft as the stable/latest immutable v1.0.1 release. Do not
replace or delete an asset after publication. Use a logged-out browser and an
unauthenticated shell to redownload all six tag-specific assets and all six latest
assets. Verify:

1. the release API reports `v1.0.1` as both the requested tag and latest;
2. the asset set is exactly the six documented filenames;
3. both downloaded manifests match the accepted `SHA256SUMS.txt` byte-for-byte;
4. both asset sets pass `shasum -a 256 --check SHA256SUMS.txt`; and
5. the release reports immutable in GitHub.

Publication, Cloudflare production, and Vercel changes are intentionally outside
this source workflow.

## Website, Vercel, and ownership order

The exact deployment commands and checks are in
[CLOUDFLARE_PAGES.md](CLOUDFLARE_PAGES.md). In order:

1. Use this main replacement PR's exact committed Pages bundle for preview and pass
   the pre-release desktop/mobile, public-config, header, and asset checks.
2. Confirm the public release repository is prepared, issue Daniel's organization
   owner invitation, and verify both the requested owner role and live invitation
   URL. Once the Cloudflare preview works, send the exact checkpoint email in
   [CLOUDFLARE_PAGES.md](CLOUDFLARE_PAGES.md), substituting only that actual URL.
   Continue release and site work if Daniel is delayed.
3. Only after v1.0.1 is stable/latest, immutable, and anonymously verified—and the
   accepted preview's five release routes pass—may that same bundle deploy to Pages
   production.
4. Verify Pages production, then merge the main replacement PR so the existing Vercel
   project deploys its path-preserving temporary redirect to Pages.
5. Leave the Vercel redirect in place for seven full days; Daniel deletes the old
   Vercel project only after the healthy transition window.

A delayed source transfer does not block an already verified customer repair; it
leaves only source co-ownership pending. Close obsolete PR #3 only after the
superseding release and site have shipped, and never merge it.

## Optional managed-Mac identity

A stable self-signed identity and `SystemPolicyRule` are a separate, Mini-local MDM
experiment documented in [MACOS_MDM.md](MACOS_MDM.md). Do not store that identity in
GitHub, substitute it into this public release, or advertise MDM support until an
enrolled managed Mac passes acceptance.

References: [electron-builder macOS configuration](https://www.electron.build/mac/),
[Apple Open Anyway guidance](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac), and
[GitHub Actions artifact API](https://docs.github.com/en/rest/actions/artifacts).
